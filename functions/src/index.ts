import * as admin from "firebase-admin";
import { https, region } from "firebase-functions/v1";

import { assertAdmin, assertSignedIn } from "./domain/adminAuth.js";
import { DomainError } from "./domain/errors.js";
import {
  addCentavos,
  centavosToReais,
  storedReaisToCentavos,
  toCentavos,
} from "./domain/money.js";
import {
  credit,
  debit,
  validateDepositAmount,
  validateEntryFee,
  validatePrizeAmount,
  validateWithdrawalAmount,
} from "./domain/operations.js";
import {
  isFull,
  newTournamentParticipantFields,
  participantIncrementUpdate,
  readParticipantCounts,
} from "./domain/tournamentFields.js";

admin.initializeApp();

const db = admin.firestore();

/**
 * Deployment regions, made EXPLICIT so a deploy targets exactly the region each
 * function already runs in — never the SDK default (us-central1).
 *
 * `onUserCreated` is deployed in `us-east1` in production; leaving it implicit
 * would make a deploy create a SECOND copy in us-central1. Pinning it here means
 * a future `--only functions:onUserCreated` updates the us-east1 function in
 * place. The six callables are pinned to `us-central1`, matching production.
 *
 * These change ONLY the region — not the trigger type, name, casing, arguments,
 * memory, timeout, runtime or generation.
 */
const REGION_CALLABLES = "us-central1";
const REGION_ON_USER_CREATED = "us-east1";

const central = region(REGION_CALLABLES);
const east = region(REGION_ON_USER_CREATED);

/**
 * PHASE 2.5B HARDENING — what changed, and what deliberately did NOT.
 *
 * UNCHANGED (production compatibility — no data migration required):
 *  - every exported function name, with its exact casing;
 *  - callable argument names (`amount`, `externalid`, `pixkey`, `tournamentid`,
 *    `winneruid`, `entry_fee`, `prize`, `max_players`, `game_mode`, ...);
 *  - collection names, document ids, and transaction `category` values;
 *  - Firestore money fields, which remain NUMBERS OF REAIS.
 *
 * CHANGED (internal only):
 *  - all money arithmetic runs on exact integer centavos and is converted back
 *    to reais only when written. Doubles drift; integers do not.
 *  - the admin UID check, previously duplicated inside two functions, is now a
 *    single transitional check that also accepts an `admin: true` custom claim.
 *  - tournament participant counts are read canonically with a legacy fallback,
 *    and both field pairs are advanced together.
 */

/** Converts a domain failure into the HttpsError the client already expects. */
function toHttpsError(error: unknown): https.HttpsError {
  if (error instanceof https.HttpsError) return error;
  if (error instanceof DomainError) {
    return new https.HttpsError(error.code, error.message);
  }
  console.error("Unexpected error:", error);
  return new https.HttpsError("internal", "Erro interno.");
}

function generateExternalId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}

function getExternalId(data: { externalid?: unknown }, prefix: string): string {
  const manualExternalId =
    typeof data.externalid === "string" ? data.externalid.trim() : "";

  if (manualExternalId.length > 0) {
    return manualExternalId;
  }

  return generateExternalId(prefix);
}

function generatePlayerId(): string {
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `PLR-${rand}`;
}

/**
 * Creates the user profile and wallet. UNCHANGED from the deployed version:
 * this trigger remains the authoritative creator of `users/{uid}` and
 * `wallets/{uid}`, and the mobile client writes neither.
 *
 * KNOWN ISSUE (see `docs/username.md`): `username` is seeded empty, and this
 * trigger cannot reliably read a display name the client sets afterwards.
 * Fixing that needs an authenticated callable, deliberately NOT added here.
 */
export const onUserCreated = east.auth.user().onCreate(async (user) => {
  const uid = user.uid;
  const email = user.email ?? "";

  const playerId = generatePlayerId();

  const userRef = db.collection("users").doc(uid);
  const walletRef = db.collection("wallets").doc(uid);

  const userData = {
    email: email,
    username: "",
    player_id: playerId,
    pix_key: "",
    whatsapp: "",
  };

  const walletData = {
    balance: 0,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
    user_ref: userRef,
  };

  try {
    await db.runTransaction(async (transaction) => {
      transaction.set(userRef, userData, { merge: true });
      transaction.set(walletRef, walletData, { merge: true });
    });

    console.log(`onUserCreated: Created user ${uid} and wallet ${uid}`);
  } catch (error) {
    console.error(
      `onUserCreated: Failed to create user/wallet for uid ${uid}`,
      error
    );
  }
});

export const testdeposit = central.https.onCall(async (data, context) => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para fazer depósito.",
      "Apenas admin pode fazer depósito de teste."
    );

    const uid = callerAuth.uid;

    const amountCentavos = validateDepositAmount(data.amount);
    const externalId = getExternalId(data, "deposit");

    const walletRef = db.collection("wallets").doc(uid);
    const userRef = db.collection("users").doc(uid);
    const transactionRef = db.collection("transactions").doc(externalId);

    await db.runTransaction(async (transaction) => {
      const existingTransaction = await transaction.get(transactionRef);

      // Idempotency: the same externalid must never be applied twice.
      if (existingTransaction.exists) {
        throw new DomainError(
          "already-exists",
          "Já existe uma transação com esse externalid."
        );
      }

      const walletSnap = await transaction.get(walletRef);
      const walletData = walletSnap.exists ? walletSnap.data() ?? {} : {};

      const previousBalance = storedReaisToCentavos(
        walletData.balance ?? 0,
        "saldo da carteira"
      );
      const totalDeposited = storedReaisToCentavos(
        walletData.total_deposited ?? 0,
        "total depositado"
      );

      const newBalance = credit(previousBalance, amountCentavos);
      const newTotalDeposited = addCentavos(totalDeposited, amountCentavos);

      transaction.set(
        walletRef,
        {
          balance: centavosToReais(newBalance),
          total_deposited: centavosToReais(newTotalDeposited),
          user_ref: userRef,
        },
        { merge: true }
      );

      transaction.set(transactionRef, {
        amount: centavosToReais(amountCentavos),
        category: "deposit",
        user_ref: userRef,
        display_name: "Test Deposit",
        tournament_ref: null,
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(newBalance),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed",
        external_id: externalId,
      });
    });

    return {
      success: true,
      message: "Depósito de teste realizado com sucesso.",
      externalid: externalId,
      amount: centavosToReais(amountCentavos),
    };
  } catch (error) {
    console.error("testdeposit error:", error);
    throw toHttpsError(error);
  }
});

export const requestwithdrawal = central.https.onCall(async (data, context) => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para solicitar saque."
    );

    const uid = callerAuth.uid;

    // Enforces the R$5,00 minimum and R$10.000,00 maximum, unchanged.
    const amountCentavos = validateWithdrawalAmount(data.amount);

    const pixkey = String(data.pixkey || "").trim();

    if (!pixkey) {
      throw new DomainError("invalid-argument", "A chave PIX é obrigatória.");
    }

    if (pixkey.length < 5 || pixkey.length > 140) {
      throw new DomainError("invalid-argument", "Chave PIX inválida.");
    }

    // Blocks control characters and other invisible junk.
    if (/[\x00-\x1F\x7F]/.test(pixkey)) {
      throw new DomainError(
        "invalid-argument",
        "Chave PIX contém caracteres inválidos."
      );
    }

    const userRef = db.collection("users").doc(uid);
    const walletRef = db.collection("wallets").doc(uid);

    const externalid = generateExternalId("withdrawal");

    const transactionRef = db.collection("transactions").doc(externalid);
    const withdrawalRef = db.collection("withdrawals").doc(externalid);

    await db.runTransaction(async (transaction) => {
      const walletSnap = await transaction.get(walletRef);

      if (!walletSnap.exists) {
        throw new DomainError(
          "failed-precondition",
          "Carteira não encontrada."
        );
      }

      const walletData = walletSnap.data() ?? {};

      const previousBalance = storedReaisToCentavos(
        walletData.balance ?? 0,
        "saldo da carteira"
      );
      const totalWithdrawn = storedReaisToCentavos(
        walletData.total_withdrawn ?? 0,
        "total sacado"
      );

      // Enforces "you cannot withdraw more than you have".
      const balanceAfter = debit(previousBalance, amountCentavos);

      transaction.update(walletRef, {
        balance: centavosToReais(balanceAfter),
        // Computed from the value read inside this transaction rather than
        // FieldValue.increment(): increment() adds floats, which drift.
        total_withdrawn: centavosToReais(
          addCentavos(totalWithdrawn, amountCentavos)
        ),
      });

      transaction.set(transactionRef, {
        amount: centavosToReais(amountCentavos),
        category: "withdrawal",
        user_ref: userRef,
        display_name: "Saque",
        tournament_ref: null,
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(balanceAfter),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "pending",
        external_id: externalid,
      });

      transaction.set(withdrawalRef, {
        amount: centavosToReais(amountCentavos),
        user_ref: userRef,
        status: "pending",
        pix_key_snapshot: pixkey,
        transaction_ref: transactionRef,

        // Reserved for the future PIX provider integration.
        provider: null,
        provider_status: null,
        pix_tx_id: null,
        error_message: null,

        requested_at: admin.firestore.FieldValue.serverTimestamp(),
        paid_at: null,
        failed_at: null,
      });
    });

    return {
      success: true,
      externalid: externalid,
      amount: centavosToReais(amountCentavos),
      status: "pending",
    };
  } catch (error) {
    console.error("requestwithdrawal error:", error);
    throw toHttpsError(error);
  }
});

export const jointournament = central.https.onCall(async (data, context) => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para entrar no torneio."
    );

    const uid = callerAuth.uid;

    const tournamentid = String(data.tournamentid || "").trim();

    if (!tournamentid) {
      throw new DomainError("invalid-argument", "ID do torneio é obrigatório.");
    }

    if (tournamentid.includes("/") || tournamentid.length > 200) {
      throw new DomainError("invalid-argument", "ID do torneio inválido.");
    }

    const userRef = db.collection("users").doc(uid);
    const walletRef = db.collection("wallets").doc(uid);
    const tournamentRef = db.collection("tournaments").doc(tournamentid);

    // Deterministic id — this is what makes double registration impossible.
    const registrationid = `${uid}_${tournamentid}`;
    const registrationRef = db.collection("registrations").doc(registrationid);

    const externalid = generateExternalId("entryfee");
    const transactionRef = db.collection("transactions").doc(externalid);

    await db.runTransaction(async (transaction) => {
      const walletSnap = await transaction.get(walletRef);
      const tournamentSnap = await transaction.get(tournamentRef);
      const registrationSnap = await transaction.get(registrationRef);

      if (!walletSnap.exists) {
        throw new DomainError(
          "failed-precondition",
          "Carteira não encontrada."
        );
      }

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      // Duplicate registration is checked before any money is touched.
      if (registrationSnap.exists) {
        throw new DomainError(
          "already-exists",
          "Você já está inscrito neste torneio."
        );
      }

      const walletData = walletSnap.data() ?? {};
      const tournamentData = tournamentSnap.data() ?? {};

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();

      if (status !== "open") {
        throw new DomainError(
          "failed-precondition",
          "Este torneio não está aberto para inscrições."
        );
      }

      const entryFeeCentavos = validateEntryFee(tournamentData.entry_fee);

      // Canonical-first with a legacy fallback. Throws when the capacity is
      // missing or the two field pairs disagree — never silently zero.
      const counts = readParticipantCounts(tournamentData);

      if (isFull(counts)) {
        throw new DomainError(
          "failed-precondition",
          "Este torneio já está lotado."
        );
      }

      const previousBalance = storedReaisToCentavos(
        walletData.balance ?? 0,
        "saldo da carteira"
      );
      const totalSpent = storedReaisToCentavos(
        walletData.total_spent ?? 0,
        "total gasto"
      );

      // Enforces "you cannot spend what you do not have".
      const balanceAfter = debit(previousBalance, entryFeeCentavos);

      transaction.update(walletRef, {
        balance: centavosToReais(balanceAfter),
        total_spent: centavosToReais(addCentavos(totalSpent, entryFeeCentavos)),
      });

      // Advances BOTH the canonical and the legacy counter together, so the two
      // representations can never drift apart.
      transaction.update(tournamentRef, participantIncrementUpdate(counts));

      transaction.set(registrationRef, {
        user_ref: userRef,
        tournament_ref: tournamentRef,
        entry_fee: centavosToReais(entryFeeCentavos),
        status: "registered",
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.set(transactionRef, {
        amount: centavosToReais(entryFeeCentavos),
        category: "entry_fee",
        user_ref: userRef,
        display_name: "Entrada em torneio",
        tournament_ref: tournamentRef,
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(balanceAfter),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed",
        external_id: externalid,
      });
    });

    return {
      success: true,
      tournamentid: tournamentid,
      registrationid: registrationid,
      externalid: externalid,
      status: "registered",
    };
  } catch (error) {
    console.error("jointournament error:", error);
    throw toHttpsError(error);
  }
});

export const payprize = central.https.onCall(async (data, context) => {
  try {
    assertAdmin(
      context,
      "Você precisa estar logado para pagar prêmio.",
      "Você não tem permissão para pagar prêmio."
    );

    const winneruid = data.winneruid;
    const tournamentid = data.tournamentid;

    if (!winneruid || typeof winneruid !== "string") {
      throw new DomainError("invalid-argument", "Winner UID inválido.");
    }

    if (!tournamentid || typeof tournamentid !== "string") {
      throw new DomainError("invalid-argument", "Tournament ID inválido.");
    }

    const amountCentavos = validatePrizeAmount(data.amount);

    const externalid =
      typeof data.externalid === "string" && data.externalid.trim().length > 0
        ? data.externalid.trim()
        : `prize_${winneruid}_${tournamentid}`;

    const winnerUserRef = db.collection("users").doc(winneruid);
    const winnerWalletRef = db.collection("wallets").doc(winneruid);
    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const transactionRef = db.collection("transactions").doc(externalid);

    const result = await db.runTransaction(async (transaction) => {
      const winnerWalletSnap = await transaction.get(winnerWalletRef);
      const tournamentSnap = await transaction.get(tournamentRef);
      const existingTransactionSnap = await transaction.get(transactionRef);

      // Idempotency: paying the same prize twice must be impossible.
      if (existingTransactionSnap.exists) {
        throw new DomainError(
          "already-exists",
          "Já existe uma transação com esse external ID."
        );
      }

      if (!winnerWalletSnap.exists) {
        throw new DomainError(
          "not-found",
          "Carteira do vencedor não encontrada."
        );
      }

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      const walletData = winnerWalletSnap.data() ?? {};

      const previousBalance = storedReaisToCentavos(
        walletData.balance ?? 0,
        "saldo da carteira"
      );
      const previousTotalWon = storedReaisToCentavos(
        walletData.total_won ?? 0,
        "total ganho"
      );

      const balanceAfter = credit(previousBalance, amountCentavos);
      const totalWonAfter = addCentavos(previousTotalWon, amountCentavos);

      transaction.update(winnerWalletRef, {
        balance: centavosToReais(balanceAfter),
        total_won: centavosToReais(totalWonAfter),
      });

      transaction.set(transactionRef, {
        amount: centavosToReais(amountCentavos),
        category: "prize",
        user_ref: winnerUserRef,
        display_name: "",
        tournament_ref: tournamentRef,
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(balanceAfter),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed",
        external_id: externalid,
      });

      return {
        success: true,
        winner_uid: winneruid,
        tournament_id: tournamentid,
        amount: centavosToReais(amountCentavos),
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(balanceAfter),
        external_id: externalid,
      };
    });

    return result;
  } catch (error) {
    console.error("payprize error:", error);
    throw toHttpsError(error);
  }
});

const createTournamentHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para criar um campeonato."
    );

    const uid = callerAuth.uid;

    const name = String(data.name || "").trim();
    const description = String(data.description || "").trim();

    if (!name) {
      throw new DomainError(
        "invalid-argument",
        "O nome do campeonato é obrigatório."
      );
    }

    // Entry fee and prize may legitimately be zero (a free tournament), but
    // never negative, and never finer than centavos.
    const entryFeeCentavos = toCentavos(data.entry_fee, {
      field: "valor da inscrição",
      allowZero: true,
    });
    const prizeCentavos = toCentavos(data.prize, {
      field: "valor da premiação",
      allowZero: true,
    });

    const maxPlayers = Number(data.max_players);

    if (!Number.isSafeInteger(maxPlayers) || maxPlayers <= 0) {
      throw new DomainError(
        "invalid-argument",
        "O número máximo de jogadores precisa ser maior que zero."
      );
    }

    const gameMode = String(data.game_mode || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");

    let teamSize = 0;
    let gameModeLabel = "";
    let formatType = "";

    if (gameMode === "solo") {
      teamSize = 1;
      gameModeLabel = "Solo";
      formatType = "battle_royale";
    } else if (gameMode === "duo") {
      teamSize = 2;
      gameModeLabel = "Duo";
      formatType = "battle_royale";
    } else if (gameMode === "squad") {
      teamSize = 4;
      gameModeLabel = "Squad";
      formatType = "battle_royale";
    } else if (gameMode === "2v2") {
      teamSize = 2;
      gameModeLabel = "2v2";
      formatType = "versus";
    } else if (gameMode === "4v4") {
      teamSize = 4;
      gameModeLabel = "4v4";
      formatType = "versus";
    } else {
      throw new DomainError(
        "invalid-argument",
        "Modo de jogo inválido. Use solo, duo, squad, 2v2 ou 4v4."
      );
    }

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new DomainError("not-found", "Usuário criador não encontrado.");
    }

    const userData = userSnap.data() ?? {};

    const creatorName =
      userData.display_name ||
      userData.username ||
      userData.name ||
      userData.nickname ||
      context.auth?.token?.email ||
      "Criador";

    const tournamentRef = db.collection("tournaments").doc();

    await tournamentRef.set({
      name,
      description,

      entry_fee: centavosToReais(entryFeeCentavos),
      prize: centavosToReais(prizeCentavos),

      status: "open",

      creator_ref: userRef,
      creator_uid: uid,
      creator_name: creatorName,

      game_mode: gameMode,
      game_mode_label: gameModeLabel,
      team_size: teamSize,
      format_type: formatType,

      // Writes BOTH the canonical (`*_participants`) and the legacy
      // (`*_players`) pairs with identical values. This is the fix for the
      // deployed bug where createTournament wrote one pair and jointournament
      // read the other, and it keeps old clients and queries working.
      ...newTournamentParticipantFields(maxPlayers),

      starts_at: null,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      tournament_id: tournamentRef.id,
      tournament_ref: tournamentRef.path,
      message: "Campeonato criado com sucesso.",
    };
  } catch (error) {
    console.error("createTournament error:", error);
    throw toHttpsError(error);
  }
};

// BOTH export names are preserved, with their exact casing. The previous client
// calls one or the other; renaming or dropping either would break production.
export const createTournament = central.https.onCall(createTournamentHandler);
export const createtournament = central.https.onCall(createTournamentHandler);
