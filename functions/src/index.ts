import * as admin from "firebase-admin";
import { https, region } from "firebase-functions/v1";

import { assertAdmin, assertSignedIn } from "./domain/adminAuth.js";
import { DomainError } from "./domain/errors.js";
import {
  decideRoomAccess,
  registrationId,
  validateGetRoomPayload,
  validateSetRoomPayload,
} from "./domain/room.js";
import {
  addCentavos,
  centavosToReais,
  storedReaisToCentavos,
  subtractCentavos,
  toCentavos,
} from "./domain/money.js";
import {
  BETA_REFUND_CATEGORY,
  canCancelAtomically,
  checkOriginalEntryLedger,
  checkRefundedRegistration,
  checkRefundLedger,
  ENTRY_REFUND_CATEGORY,
  refundTransactionId,
  resolveRefundPlanItem,
  STATUS_CANCELLED,
  sumRefundCentavos,
  type RefundPlanItem,
} from "./domain/cancellation.js";
import {
  credit,
  debit,
  inspectStoredPrize,
  validateDepositAmount,
  validateEntryFee,
  validateWithdrawalAmount,
} from "./domain/operations.js";
import {
  assertExactPayload,
  checkRegistration,
  checkStartPreconditions,
  decideCompletedReplay,
  documentPath,
  gateSettlementStatus,
  gateStartStatus,
  normalizeTournamentId,
  normalizeWinnerUid,
  prizeTransactionId,
} from "./domain/settlement.js";
import {
  isFull,
  newTournamentParticipantFields,
  participantIncrementUpdate,
  readParticipantCounts,
} from "./domain/tournamentFields.js";
import {
  BETA_ECONOMY_TYPE,
  BETA_GRANT_CATEGORY,
  betaGrantTransactionId,
  checkBetaGrantReplay,
  normalizeBetaGrantUid,
  normalizeCampaignId,
  normalizeGrantId,
  normalizeReason,
  validateBetaGrantAmount,
} from "./domain/betaCredit.js";
import {
  BETA_ENTRY_FEE_CATEGORY,
  BETA_PRIZE_CATEGORY,
  checkRegistrationEconomy,
  decideBetaCompletedReplay,
  economyLockMaterialization,
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
  parseRequestedEconomyType,
  resolveTournamentEconomy,
} from "./domain/economy.js";

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
    // Beta Credits (closed beta): non-monetary, never withdrawable, and kept
    // strictly apart from the five cash fields above. Old wallets without this
    // field are READ as zero — no migration writes it retroactively.
    beta_balance: 0,
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

      const walletData = walletSnap.data() ?? {};
      const tournamentData = tournamentSnap.data() ?? {};

      // The bucket comes EXCLUSIVELY from the stored tournament (economy_type
      // + its durable lock); the caller can never choose it. An invalid or
      // diverged persisted economy fails closed BEFORE any money or state.
      const economy = resolveTournamentEconomy(tournamentData);

      // Duplicate registration is checked before any money is touched. A
      // replay must additionally still be economically consistent: if the
      // stored registration's provenance no longer matches the tournament's
      // economy, that is a divergence — failed-precondition, no write.
      if (registrationSnap.exists) {
        const registrationData = registrationSnap.data() ?? {};
        const replayEconomy = checkRegistrationEconomy({
          registrationEconomy: registrationData.economy_type,
          tournamentEconomy: economy,
        });
        if (!replayEconomy.ok) {
          throw new DomainError("failed-precondition", replayEconomy.message);
        }
        throw new DomainError(
          "already-exists",
          "Você já está inscrito neste torneio."
        );
      }

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

      // ── Debit the ONE bucket the tournament's economy names. There is no
      // fallback, no split and no combination: a cash tournament sees only
      // `balance` (even with plenty of beta), a beta tournament sees only
      // `beta_balance` (even with plenty of cash). `debit()` is pure integer
      // math and stays source-agnostic — the ROUTING happens here.
      let transactionData: Record<string, unknown>;
      if (economy === ECONOMY_BETA_CREDIT) {
        const previousBeta = storedReaisToCentavos(
          walletData.beta_balance ?? 0,
          "saldo beta"
        );
        const betaAfter = debit(previousBeta, entryFeeCentavos);

        // ONLY beta_balance moves. The five cash fields are never touched.
        transaction.update(walletRef, {
          beta_balance: centavosToReais(betaAfter),
        });

        transactionData = {
          amount: centavosToReais(entryFeeCentavos),
          category: BETA_ENTRY_FEE_CATEGORY,
          economy_type: ECONOMY_BETA_CREDIT,
          user_ref: userRef,
          display_name: "Entrada em torneio",
          tournament_ref: tournamentRef,
          // Beta-pool stamps — deliberately NOT previous_balance/balance_after,
          // which in every cash transaction refer to the real `balance`.
          beta_previous_balance: centavosToReais(previousBeta),
          beta_balance_after: centavosToReais(betaAfter),
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
          external_id: externalid,
        };
      } else {
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
          total_spent: centavosToReais(
            addCentavos(totalSpent, entryFeeCentavos)
          ),
        });

        transactionData = {
          amount: centavosToReais(entryFeeCentavos),
          category: "entry_fee",
          economy_type: ECONOMY_CASH,
          user_ref: userRef,
          display_name: "Entrada em torneio",
          tournament_ref: tournamentRef,
          previous_balance: centavosToReais(previousBalance),
          balance_after: centavosToReais(balanceAfter),
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
          external_id: externalid,
        };
      }

      // Advances BOTH the canonical and the legacy counter together, so the two
      // representations can never drift apart. On a LEGACY document this same
      // legitimate update also materializes the resolved economy + lock (absent
      // fields only — never a standalone normalization write).
      transaction.update(tournamentRef, {
        ...participantIncrementUpdate(counts),
        ...economyLockMaterialization(tournamentData, economy),
      });

      transaction.set(registrationRef, {
        user_ref: userRef,
        tournament_ref: tournamentRef,
        entry_fee: centavosToReais(entryFeeCentavos),
        status: "registered",
        // Economic provenance + server-authoritative snapshot: which economy
        // paid this entry and exactly how much, plus the ledger reference.
        economy_type: economy,
        entry_fee_snapshot: centavosToReais(entryFeeCentavos),
        transaction_ref: transactionRef,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.set(transactionRef, transactionData);
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

/**
 * ADMIN-ONLY: moves a tournament `open -> in_progress`, the safe pre-state that
 * must exist before a result can be declared. A tournament may only start once
 * its room is genuinely published (valid credentials pointing at it) and its
 * prize is a valid, strictly-positive amount — so the settlement that follows
 * can never run against a broken tournament.
 *
 * Exported for behavioral tests; a plain function with no trigger metadata is
 * NOT a deployable endpoint.
 */
export const startTournamentHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context,
      "Você precisa estar logado para iniciar o torneio.",
      "Apenas admin pode iniciar o torneio."
    );

    // Exactly `{ tournamentid }`; any extra key is invalid-argument.
    assertExactPayload(data, ["tournamentid"]);
    const tournamentid = normalizeTournamentId(data.tournamentid);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const roomRef = db.collection("tournament_rooms").doc(tournamentid);

    await db.runTransaction(async (transaction) => {
      // Reads first — every read before any write.
      const tournamentSnap = await transaction.get(tournamentRef);
      const roomSnap = await transaction.get(roomRef);

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      const tournamentData = tournamentSnap.data() ?? {};

      // No money moves here, but the transition still fails closed on an
      // invalid or diverged persisted economy — a corrupt tournament is never
      // advanced. The payload cannot carry economy_type (exact allowlist
      // above), the type/lock are never rewritten, and the idempotent replay
      // keeps writing nothing.
      resolveTournamentEconomy(tournamentData);

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();

      const gate = gateStartStatus(status);
      if (gate.kind === "fail") {
        // completed or any status other than open/in_progress.
        throw new DomainError("failed-precondition", gate.message);
      }

      // Structural preconditions apply to BOTH the first start and the
      // idempotent replay: a published, matching room and a valid prize.
      const roomData = roomSnap.exists ? roomSnap.data() ?? {} : {};
      const preconditions = checkStartPreconditions({
        tournamentid,
        roomExists: roomSnap.exists,
        roomId: roomData.room_id,
        roomPassword: roomData.room_password,
        roomTournamentRefPath: documentPath(roomData.tournament_ref),
        prize: tournamentData.prize,
      });
      if (!preconditions.ok) {
        throw new DomainError("failed-precondition", preconditions.message);
      }

      // Idempotent replay: already in_progress and still structurally valid.
      // Return success WITHOUT rewriting any field — no timestamp churn.
      if (gate.kind === "replay") {
        return;
      }

      // First execution: open -> in_progress. Only status + updated_at move;
      // created_at and starts_at are deliberately left untouched.
      transaction.update(tournamentRef, {
        status: "in_progress",
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return { success: true };
  } catch (error) {
    console.error("startTournament error:", error);
    throw toHttpsError(error);
  }
};

/**
 * ADMIN-ONLY, CANONICAL settlement: declares the single MVP winner and pays the
 * prize atomically, moving a tournament `in_progress -> completed`.
 *
 * SECURITY: the client supplies ONLY `{ tournamentid, winneruid }`. The prize
 * comes from `tournaments/{id}.prize`, the financial id is the deterministic
 * `prize_{tournamentid}`, and the winner's identity is verified against the
 * canonical registration — nothing financial is ever taken from the caller.
 *
 * IDEMPOTENCY & CONCURRENCY: the tournament and the deterministic prize
 * transaction are read INSIDE the transaction, so Firestore's optimistic retry
 * re-evaluates the state after a concurrent commit. Two identical calls yield two
 * successes and exactly one credit; two different winners yield one success and
 * one failed-precondition.
 *
 * Exported for behavioral tests; not a deployable endpoint (no trigger).
 */
export const declareTournamentResultHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context,
      "Você precisa estar logado para declarar o resultado.",
      "Apenas admin pode declarar o resultado."
    );

    // Exactly `{ tournamentid, winneruid }`. amount/externalid/prize/
    // transactionid/status/refs are NOT accepted keys → invalid-argument.
    assertExactPayload(data, ["tournamentid", "winneruid"]);
    const tournamentid = normalizeTournamentId(data.tournamentid);
    const winneruid = normalizeWinnerUid(data.winneruid);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const winnerUserRef = db.collection("users").doc(winneruid);
    const winnerWalletRef = db.collection("wallets").doc(winneruid);
    const registrationRef = db
      .collection("registrations")
      .doc(registrationId(winneruid, tournamentid));
    const prizeTxRef = db
      .collection("transactions")
      .doc(prizeTransactionId(tournamentid));

    await db.runTransaction(async (transaction) => {
      // ── Reads that gate the decision (before any write) ──
      const tournamentSnap = await transaction.get(tournamentRef);
      const prizeTxSnap = await transaction.get(prizeTxRef);

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      const tournamentData = tournamentSnap.data() ?? {};

      // The prize's economy comes EXCLUSIVELY from the stored tournament
      // (economy_type + durable lock), resolved BEFORE anything can move.
      // Invalid or diverged persisted state fails closed: no credit, no
      // status change, no result.
      const economy = resolveTournamentEconomy(tournamentData);

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();
      const resultExists =
        tournamentData.result !== undefined && tournamentData.result !== null;

      const gate = gateSettlementStatus(
        status,
        resultExists,
        prizeTxSnap.exists
      );

      if (gate.kind === "fail") {
        throw new DomainError("failed-precondition", gate.message);
      }

      // ── Idempotent replay: status === completed ──
      // The replay check is ECONOMY-AWARE: a cash tournament demands the
      // canonical cash settlement shape (category "prize"), a beta tournament
      // demands the beta shape (category "beta_prize" + economy stamps). A
      // settlement persisted under the other economy is a divergence, never
      // an equivalent replay. No timestamp is rewritten on an identical replay.
      if (gate.kind === "replay") {
        const persistedResult = resultExists
          ? (tournamentData.result as Record<string, unknown>)
          : null;
        const persistedTx = prizeTxSnap.exists
          ? prizeTxSnap.data() ?? {}
          : null;

        const replay =
          economy === ECONOMY_BETA_CREDIT
            ? decideBetaCompletedReplay({
                winneruid,
                tournamentid,
                resultExists,
                txExists: prizeTxSnap.exists,
                result: persistedResult
                  ? {
                      winner_uid: persistedResult.winner_uid,
                      winner_ref: documentPath(persistedResult.winner_ref),
                      registration_ref: documentPath(
                        persistedResult.registration_ref
                      ),
                      transaction_ref: documentPath(
                        persistedResult.transaction_ref
                      ),
                      prize: persistedResult.prize,
                      economy_type: persistedResult.economy_type,
                    }
                  : null,
                tx: persistedTx
                  ? {
                      category: persistedTx.category,
                      economy_type: persistedTx.economy_type,
                      external_id: persistedTx.external_id,
                      user_ref: documentPath(persistedTx.user_ref),
                      tournament_ref: documentPath(persistedTx.tournament_ref),
                      amount: persistedTx.amount,
                    }
                  : null,
              })
            : decideCompletedReplay({
                winneruid,
                tournamentid,
                resultExists,
                txExists: prizeTxSnap.exists,
                result: persistedResult
                  ? {
                      winner_uid: persistedResult.winner_uid,
                      winner_ref: documentPath(persistedResult.winner_ref),
                      registration_ref: documentPath(
                        persistedResult.registration_ref
                      ),
                      transaction_ref: documentPath(
                        persistedResult.transaction_ref
                      ),
                      prize: persistedResult.prize,
                    }
                  : null,
                tx: persistedTx
                  ? {
                      category: persistedTx.category,
                      external_id: persistedTx.external_id,
                      user_ref: documentPath(persistedTx.user_ref),
                      tournament_ref: documentPath(persistedTx.tournament_ref),
                      amount: persistedTx.amount,
                    }
                  : null,
              });

        if (!replay.ok) {
          throw new DomainError("failed-precondition", replay.message);
        }
        // Fully equivalent: success with NO credit and NO write.
        return;
      }

      // ── Mutating path: status === in_progress, no result, no transaction ──
      const registrationSnap = await transaction.get(registrationRef);
      const walletSnap = await transaction.get(winnerWalletRef);

      const registrationData = registrationSnap.exists
        ? registrationSnap.data() ?? {}
        : {};
      const registration = checkRegistration({
        exists: registrationSnap.exists,
        status: registrationData.status,
        userRefPath: documentPath(registrationData.user_ref),
        tournamentRefPath: documentPath(registrationData.tournament_ref),
        winneruid,
        tournamentid,
      });
      if (!registration.ok) {
        throw new DomainError("failed-precondition", registration.message);
      }

      // The winner's registration must have been paid under the SAME economy
      // the tournament settles in. A legacy (provenance-less) registration is
      // accepted only on the cash path; a beta tournament with a cash or
      // provenance-less registration — e.g. after an economy flip — fails
      // closed, atomically: no credit, no status change, no result.
      const registrationEconomy = checkRegistrationEconomy({
        registrationEconomy: registrationData.economy_type,
        tournamentEconomy: economy,
      });
      if (!registrationEconomy.ok) {
        throw new DomainError(
          "failed-precondition",
          registrationEconomy.message
        );
      }

      if (!walletSnap.exists) {
        throw new DomainError(
          "not-found",
          "Carteira do vencedor não encontrada."
        );
      }

      // The prize comes from the tournament, never the client.
      const prize = inspectStoredPrize(tournamentData.prize);
      if (!prize.ok) {
        throw new DomainError("failed-precondition", prize.message);
      }
      const prizeCentavos = prize.centavos;

      const walletData = walletSnap.data() ?? {};

      const externalId = prizeTransactionId(tournamentid);
      const prizeReais = centavosToReais(prizeCentavos);
      // ONE server-timestamp sentinel, reused so every stamp written in this
      // commit resolves to the exact same time.
      const stampedAt = admin.firestore.FieldValue.serverTimestamp();

      if (economy === ECONOMY_BETA_CREDIT) {
        // ── BETA settlement: the prize is Beta Credits, credited EXCLUSIVELY
        // to beta_balance. None of the five cash fields (balance,
        // total_deposited, total_won, total_spent, total_withdrawn) moves,
        // and the ledger entry is unmistakably beta — it can never be read
        // as a cash deposit or cash prize, and it stays non-withdrawable.
        const previousBeta = storedReaisToCentavos(
          walletData.beta_balance ?? 0,
          "saldo beta"
        );
        const betaAfter = credit(previousBeta, prizeCentavos);

        transaction.update(winnerWalletRef, {
          beta_balance: centavosToReais(betaAfter),
        });

        transaction.set(prizeTxRef, {
          amount: prizeReais,
          category: BETA_PRIZE_CATEGORY,
          economy_type: ECONOMY_BETA_CREDIT,
          user_ref: winnerUserRef,
          display_name: "",
          tournament_ref: tournamentRef,
          beta_previous_balance: centavosToReais(previousBeta),
          beta_balance_after: centavosToReais(betaAfter),
          timestamp: stampedAt,
          status: "completed",
          external_id: externalId,
        });

        transaction.update(tournamentRef, {
          status: "completed",
          result: {
            placement: 1,
            winner_uid: winneruid,
            winner_ref: winnerUserRef,
            registration_ref: registrationRef,
            prize: prizeReais,
            transaction_ref: prizeTxRef,
            economy_type: ECONOMY_BETA_CREDIT,
            declared_at: stampedAt,
            paid_at: stampedAt,
          },
          updated_at: stampedAt,
        });
        return;
      }

      // ── CASH settlement: preserved integrally from the approved flow. ──
      const previousBalance = storedReaisToCentavos(
        walletData.balance ?? 0,
        "saldo da carteira"
      );
      const previousTotalWon = storedReaisToCentavos(
        walletData.total_won ?? 0,
        "total ganho"
      );

      const balanceAfter = credit(previousBalance, prizeCentavos);
      const totalWonAfter = addCentavos(previousTotalWon, prizeCentavos);

      // 1 + 2. Credit the wallet and stamp its updated_at.
      transaction.update(winnerWalletRef, {
        balance: centavosToReais(balanceAfter),
        total_won: centavosToReais(totalWonAfter),
        updated_at: stampedAt,
      });

      // 3. Deterministic prize transaction — the canonical prize schema. The
      // ONLY changes from the legacy path: the id is prize_{tournamentid}, the
      // external_id is derived internally, and the amount comes from the
      // tournament. No field is added or removed.
      transaction.set(prizeTxRef, {
        amount: prizeReais,
        category: "prize",
        user_ref: winnerUserRef,
        display_name: "",
        tournament_ref: tournamentRef,
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(balanceAfter),
        timestamp: stampedAt,
        status: "completed",
        external_id: externalId,
      });

      // 4 + 5 + 6. Persist the result, move to completed, stamp updated_at.
      transaction.update(tournamentRef, {
        status: "completed",
        result: {
          placement: 1,
          winner_uid: winneruid,
          winner_ref: winnerUserRef,
          registration_ref: registrationRef,
          prize: prizeReais,
          transaction_ref: prizeTxRef,
          declared_at: stampedAt,
          paid_at: stampedAt,
        },
        updated_at: stampedAt,
      });
    });

    return { success: true };
  } catch (error) {
    console.error("declareTournamentResult error:", error);
    throw toHttpsError(error);
  }
};

// Exported for behavioral tests of the authorization ordering. This is a plain
// function (no trigger metadata), so it is NOT a deployable endpoint — only the
// `createTournament` / `createtournament` onCall wrappers below are. Both wrap
// this same guarded handler.
export const createTournamentHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    // ADMIN-ONLY. Authorization runs BEFORE any payload validation, document
    // read, persistent-reference creation, transaction, batch, or write. It uses
    // the same centralized claim check as the other admin callables: a UID or an
    // email grants nothing, and `admin` must be boolean true. An unauthenticated
    // caller gets `unauthenticated`; an authenticated non-admin gets
    // `permission-denied` — both before the handler touches Firestore.
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para criar um campeonato.",
      "Apenas admin pode criar campeonatos."
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

    // The economy is chosen EXACTLY once, at creation: "cash" (real BRL) or
    // "beta_credit" (non-withdrawable Beta Credits). Required — no default,
    // no alias, no coercion. It can never change afterwards.
    const economyType = parseRequestedEconomyType(data.economy_type);

    // Entry fee and prize may legitimately be zero (a free tournament), but
    // never negative, and never finer than centavos. The SAME safe numeric
    // representation serves both economies; for "cash" the unit is BRL, for
    // "beta_credit" it is Beta Credit units (never BRL).
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

      // The authorized economy and its DURABLE LOCK are born equal. Every
      // financial operation re-checks both and fails closed on divergence,
      // making the type immutable in practice even before the Rules land.
      economy_type: economyType,
      locked_economy_type: economyType,

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

/** The error code alone — logged instead of the error/payload, so room
 * credentials can never reach the logs. */
function safeErrorCode(error: unknown): string {
  if (error instanceof https.HttpsError) return error.code;
  if (error instanceof DomainError) return error.code;
  return "internal";
}

/**
 * ADMIN-ONLY: publishes (or updates) a tournament's room credentials into
 * `tournament_rooms/{tournamentId}` — a document the client can never read or
 * write directly (see firestore.rules). Credentials are never logged and never
 * echoed back in the response.
 *
 * Exported for behavioral tests of the authorization/validation ordering; a
 * plain function with no trigger metadata is NOT a deployable endpoint.
 */
export const setTournamentRoomHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context,
      "Você precisa estar logado para publicar a sala.",
      "Apenas admin pode publicar a sala."
    );

    const { tournamentid, roomid, roompassword } =
      validateSetRoomPayload(data);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const roomRef = db.collection("tournament_rooms").doc(tournamentid);

    await db.runTransaction(async (transaction) => {
      const tournamentSnap = await transaction.get(tournamentRef);
      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      // A cancelled tournament is TERMINAL: it never receives a (new) room.
      const tournamentStatus = String(tournamentSnap.data()?.status || "")
        .trim()
        .toLowerCase();
      if (tournamentStatus === STATUS_CANCELLED) {
        throw new DomainError(
          "failed-precondition",
          "Não é possível definir a sala de um torneio cancelado."
        );
      }

      // Preserve created_at across re-publishes; only updated_at moves.
      const roomSnap = await transaction.get(roomRef);
      const createdAt =
        (roomSnap.exists && roomSnap.data()?.created_at) ||
        admin.firestore.FieldValue.serverTimestamp();

      transaction.set(roomRef, {
        tournament_ref: tournamentRef,
        room_id: roomid,
        room_password: roompassword,
        created_at: createdAt,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Exactly { success: true } — no id/password, and no extra fields.
    return { success: true };
  } catch (error) {
    // Log only the error CODE — never the error object or the payload, which
    // would leak the room credentials.
    console.error("setTournamentRoom error:", safeErrorCode(error));
    throw toHttpsError(error);
  }
};

/**
 * AUTHENTICATED player access: returns the room credentials for a tournament,
 * but ONLY to a caller who is registered (deterministic `{uid}_{tournamentId}`)
 * AND only once the room has been published. Failures carry an allowlisted
 * `details.reason` and never any internal detail.
 *
 * Exported for behavioral tests; not a deployable endpoint (no trigger).
 */
export const getTournamentRoomHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para acessar a sala."
    );
    const uid = callerAuth.uid;
    const tournamentid = validateGetRoomPayload(data);

    // Contract order: confirm the tournament exists FIRST (not-found), before
    // touching the registration or the room document.
    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const tournamentSnap = await tournamentRef.get();
    if (!tournamentSnap.exists) {
      throw new DomainError("not-found", "Torneio não encontrado.");
    }

    // Registration is then checked via the deterministic id ONLY — no query, no
    // field scan, no fallback. A non-participant never reads the room document.
    const registrationRef = db
      .collection("registrations")
      .doc(registrationId(uid, tournamentid));
    const registrationSnap = await registrationRef.get();

    // Only an ACTIVE registration grants access: a refunded one (cancelled
    // tournament) — or any other non-"registered" state — is treated exactly
    // like no registration at all, fail-closed.
    const registrationActive =
      registrationSnap.exists &&
      (registrationSnap.data() ?? {}).status === "registered";

    if (!registrationActive) {
      const decision = decideRoomAccess({
        registrationExists: false,
        roomExists: false,
        roomId: null,
        roomPassword: null,
      });
      // decision.ok is false here.
      if (!decision.ok) {
        throw new https.HttpsError(decision.code, decision.message, {
          reason: decision.reason,
        });
      }
    }

    const roomRef = db.collection("tournament_rooms").doc(tournamentid);
    const roomSnap = await roomRef.get();
    const roomData = roomSnap.exists ? roomSnap.data() ?? {} : {};

    const decision = decideRoomAccess({
      registrationExists: true,
      roomExists: roomSnap.exists,
      roomId: roomData.room_id,
      roomPassword: roomData.room_password,
    });

    if (!decision.ok) {
      throw new https.HttpsError(decision.code, decision.message, {
        reason: decision.reason,
      });
    }

    // Public contract: exactly { success, roomid, roompassword } — mapped from
    // the stored room_id / room_password, with no snake_case keys, no
    // tournament_ref, no timestamps, and no other fields.
    return {
      success: true,
      roomid: decision.credentials.room_id,
      roompassword: decision.credentials.room_password,
    };
  } catch (error) {
    console.error("getTournamentRoom error:", safeErrorCode(error));
    throw toHttpsError(error);
  }
};

export const setTournamentRoom = central.https.onCall(setTournamentRoomHandler);
export const getTournamentRoom = central.https.onCall(getTournamentRoomHandler);

// Secure start/result/settlement module — the deployable endpoint count goes
// 9 -> 11. `startTournament` opens the safe pre-state; `declareTournamentResult`
// is the canonical settlement.
export const startTournament = central.https.onCall(startTournamentHandler);
export const declareTournamentResult = central.https.onCall(
  declareTournamentResultHandler
);

// `payprize` is now a STRICT ALIAS of the same secure handler. It keeps its
// public name and region for compatibility, but accepts ONLY the new contract
// `{ tournamentid, winneruid }` and never `amount`/`externalid`. The legacy
// insecure body is gone — there is no deployable path to the old behavior.
export const payprize = central.https.onCall(declareTournamentResultHandler);

/**
 * ADMIN-ONLY, ATOMIC, IDEMPOTENT: cancels a not-yet-started tournament and
 * refunds EVERY paid registration to the exact bucket that paid it — cash
 * entries back to `balance` (reducing `total_spent`), beta entries back to
 * `beta_balance` — in ONE Firestore transaction. All or nothing: a failure of
 * any single validation leaves every wallet, registration, ledger and the
 * tournament byte-for-byte unchanged.
 *
 * TERMINAL: `cancelled` can never be joined, started, settled, paid or given
 * a room again, and no handler reopens it.
 *
 * SERVER-AUTHORITATIVE: the caller sends ONLY `{ tournamentid }`. Amounts come
 * from each registration's `entry_fee_snapshot` (or the provably safe cash
 * legacy `entry_fee`), cross-checked against the original entry ledger —
 * never from the tournament's current price, never from the client.
 *
 * IDEMPOTENT: refund ledgers use the deterministic id
 * `refund_{uid}_{tournamentid}`. A replay on an already-cancelled tournament
 * verifies every persisted artifact and returns success WITHOUT writing;
 * any missing or divergent artifact is failed-precondition, never repaired
 * silently.
 *
 * Exported for behavioral tests; a plain function with no trigger metadata is
 * NOT a deployable endpoint.
 */
export const cancelTournamentHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para cancelar o torneio.",
      "Apenas admin pode cancelar o torneio."
    );

    // Exactly `{ tournamentid }`; any extra key is invalid-argument.
    assertExactPayload(data, ["tournamentid"]);
    const tournamentid = normalizeTournamentId(data.tournamentid);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const prizeTxRef = db
      .collection("transactions")
      .doc(prizeTransactionId(tournamentid));

    const outcome = await db.runTransaction(async (transaction) => {
      // ── READS — every read happens before the first write ──
      const tournamentSnap = await transaction.get(tournamentRef);
      const prizeTxSnap = await transaction.get(prizeTxRef);

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }
      const tournamentData = tournamentSnap.data() ?? {};

      // Economy (type + durable lock), fail-closed on divergence/corruption.
      const economy = resolveTournamentEconomy(tournamentData);

      // Settlement evidence blocks cancellation EVEN IF the status was
      // tampered back to "open": a persisted result or the deterministic
      // prize ledger prove a settlement happened.
      const resultExists =
        tournamentData.result !== undefined && tournamentData.result !== null;
      if (resultExists || prizeTxSnap.exists) {
        throw new DomainError(
          "failed-precondition",
          "O torneio possui liquidação registrada e não pode ser cancelado."
        );
      }

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();

      // All registrations of this tournament, read INSIDE the transaction so
      // a concurrent join/cancel serializes against this decision.
      const registrationsSnap = await transaction.get(
        db
          .collection("registrations")
          .where("tournament_ref", "==", tournamentRef)
      );

      // ── Idempotent replay: already cancelled ──
      if (status === STATUS_CANCELLED) {
        const refundedCount = tournamentData.refunded_registration_count;
        const refundedTotal = tournamentData.refunded_total;
        const refundEconomy = tournamentData.refund_economy_type;
        if (
          !Number.isSafeInteger(refundedCount) ||
          (refundedCount as number) < 0 ||
          typeof refundedTotal !== "number" ||
          refundEconomy !== economy
        ) {
          throw new DomainError(
            "failed-precondition",
            "Torneio cancelado com marcadores de reembolso divergentes."
          );
        }
        if (registrationsSnap.size !== refundedCount) {
          throw new DomainError(
            "failed-precondition",
            "Torneio cancelado com inscrições divergentes do registrado."
          );
        }

        let verifiedTotalCentavos = 0;
        for (const doc of registrationsSnap.docs) {
          const reg = doc.data() ?? {};
          const refunded = checkRefundedRegistration({
            docId: doc.id,
            status: reg.status,
            refundEconomy: reg.refund_economy_type,
            tournamentEconomy: economy,
            refundedAmount: reg.refunded_amount,
            refundTransactionRefPath: documentPath(
              reg.refund_transaction_ref
            ),
          });
          if (!refunded.ok) {
            throw new DomainError("failed-precondition", refunded.message);
          }

          const uid = doc.id.slice(0, doc.id.length - tournamentid.length - 1);
          const refundTxSnap = await transaction.get(
            db.collection("transactions").doc(refundTransactionId(doc.id))
          );
          const refundTx = refundTxSnap.exists ? refundTxSnap.data() ?? {} : {};
          const ledger = checkRefundLedger({
            registrationDocId: doc.id,
            tournamentid,
            tournamentEconomy: economy,
            uid,
            expectedAmountReais: reg.refunded_amount as number,
            txExists: refundTxSnap.exists,
            category: refundTx.category,
            economyType: refundTx.economy_type,
            amountReais: refundTx.amount,
            userRefPath: documentPath(refundTx.user_ref),
            tournamentRefPath: documentPath(refundTx.tournament_ref),
            registrationRefPath: documentPath(refundTx.registration_ref),
          });
          if (!ledger.ok) {
            throw new DomainError("failed-precondition", ledger.message);
          }
          verifiedTotalCentavos += Math.round(
            (reg.refunded_amount as number) * 100
          );
        }
        if (centavosToReais(verifiedTotalCentavos) !== refundedTotal) {
          throw new DomainError(
            "failed-precondition",
            "Total reembolsado diverge dos artefatos persistidos."
          );
        }

        // Fully equivalent: success with NO write and NO timestamp change.
        return {
          idempotent: true,
          economy,
          refundedCount: refundedCount as number,
          refundedTotalReais: refundedTotal as number,
        };
      }

      // ── First execution: only the canonical pre-start state cancels ──
      if (status !== "open") {
        throw new DomainError(
          "failed-precondition",
          "Só é possível cancelar um torneio que ainda não começou."
        );
      }

      // Write-limit guard BEFORE any further work: the whole refund must fit
      // one atomic transaction — partial refunds are never attempted.
      if (!canCancelAtomically(registrationsSnap.size)) {
        throw new DomainError(
          "failed-precondition",
          "O torneio tem inscrições demais para um cancelamento atômico."
        );
      }

      // The persisted participant counters must reconcile with the actual
      // registrations — a divergent count is corrupt state, never guessed at.
      const counts = readParticipantCounts(tournamentData);
      if (counts.current !== registrationsSnap.size) {
        throw new DomainError(
          "failed-precondition",
          "Contagem de participantes diverge das inscrições persistidas."
        );
      }

      // ── Build and validate the COMPLETE refund plan before any write ──
      const plan: RefundPlanItem[] = [];
      const seenUids = new Set<string>();
      for (const doc of registrationsSnap.docs) {
        const reg = doc.data() ?? {};
        const resolved = resolveRefundPlanItem({
          docId: doc.id,
          tournamentid,
          tournamentEconomy: economy,
          status: reg.status,
          userRefPath: documentPath(reg.user_ref),
          tournamentRefPath: documentPath(reg.tournament_ref),
          registrationEconomy: reg.economy_type,
          entryFeeSnapshot: reg.entry_fee_snapshot,
          entryFee: reg.entry_fee,
          transactionRefPath: documentPath(reg.transaction_ref),
        });
        if (!resolved.ok) {
          throw new DomainError("failed-precondition", resolved.message);
        }
        if (seenUids.has(resolved.item.uid)) {
          throw new DomainError(
            "failed-precondition",
            "Inscrições duplicadas para o mesmo usuário."
          );
        }
        seenUids.add(resolved.item.uid);
        plan.push(resolved.item);
      }

      // Cross-check every NEW-STYLE entry against its original ledger.
      for (const item of plan) {
        if (item.legacy) continue;
        const entryTxSnap = await transaction.get(
          db.doc(item.entryTransactionPath as string)
        );
        const entryTx = entryTxSnap.exists ? entryTxSnap.data() ?? {} : {};
        const ledger = checkOriginalEntryLedger({
          item,
          tournamentid,
          txExists: entryTxSnap.exists,
          category: entryTx.category,
          economyType: entryTx.economy_type,
          userRefPath: documentPath(entryTx.user_ref),
          tournamentRefPath: documentPath(entryTx.tournament_ref),
          amountReais: entryTx.amount,
          expectedAmountReais: centavosToReais(item.amountCentavos),
        });
        if (!ledger.ok) {
          throw new DomainError("failed-precondition", ledger.message);
        }
      }

      // Read every wallet and pre-compute every credit — the LAST reads, and
      // still before the first write. Any invalid stored value, insufficient
      // total_spent or overflow aborts here, leaving everything untouched.
      const walletWrites: Array<{
        ref: FirebaseFirestore.DocumentReference;
        update: Record<string, unknown>;
        previousCentavos: number;
        afterCentavos: number;
      }> = [];
      for (const item of plan) {
        const walletRef = db.collection("wallets").doc(item.uid);
        const walletSnap = await transaction.get(walletRef);
        if (!walletSnap.exists) {
          throw new DomainError(
            "not-found",
            `Carteira do inscrito ${item.uid} não encontrada.`
          );
        }
        const walletData = walletSnap.data() ?? {};

        if (item.economy === ECONOMY_BETA_CREDIT) {
          const previousBeta = storedReaisToCentavos(
            walletData.beta_balance ?? 0,
            "saldo beta"
          );
          const betaAfter = addCentavos(previousBeta, item.amountCentavos);
          walletWrites.push({
            ref: walletRef,
            update: { beta_balance: centavosToReais(betaAfter) },
            previousCentavos: previousBeta,
            afterCentavos: betaAfter,
          });
        } else {
          const previousBalance = storedReaisToCentavos(
            walletData.balance ?? 0,
            "saldo da carteira"
          );
          const totalSpent = storedReaisToCentavos(
            walletData.total_spent ?? 0,
            "total gasto"
          );
          const spentAfter = subtractCentavos(totalSpent, item.amountCentavos);
          if (spentAfter < 0) {
            throw new DomainError(
              "failed-precondition",
              "Total gasto insuficiente para o reembolso."
            );
          }
          const balanceAfter = addCentavos(
            previousBalance,
            item.amountCentavos
          );
          walletWrites.push({
            ref: walletRef,
            update: {
              balance: centavosToReais(balanceAfter),
              total_spent: centavosToReais(spentAfter),
            },
            previousCentavos: previousBalance,
            afterCentavos: balanceAfter,
          });
        }
      }

      const totalCentavos = sumRefundCentavos(plan);

      // ── WRITES — everything is now validated ──
      // ONE server-timestamp sentinel for every stamp in this commit.
      const stampedAt = admin.firestore.FieldValue.serverTimestamp();

      for (let i = 0; i < plan.length; i++) {
        const item = plan[i];
        const write = walletWrites[i];
        const amountReais = centavosToReais(item.amountCentavos);
        const registrationRef = db
          .collection("registrations")
          .doc(item.registrationDocId);
        const refundTxRef = db
          .collection("transactions")
          .doc(refundTransactionId(item.registrationDocId));
        const entryTxRef = item.entryTransactionPath
          ? db.doc(item.entryTransactionPath)
          : null;

        // 1. Credit the ONE bucket that paid the entry.
        transaction.update(write.ref, write.update);

        // 2. Deterministic refund ledger — unmistakably cash OR beta.
        const base = {
          amount: amountReais,
          user_ref: db.collection("users").doc(item.uid),
          display_name: "Reembolso de inscrição",
          tournament_ref: tournamentRef,
          registration_ref: registrationRef,
          entry_transaction_ref: entryTxRef,
          timestamp: stampedAt,
          created_at: stampedAt,
          status: "completed",
          external_id: refundTransactionId(item.registrationDocId),
        };
        if (item.economy === ECONOMY_BETA_CREDIT) {
          transaction.set(refundTxRef, {
            ...base,
            category: BETA_REFUND_CATEGORY,
            economy_type: ECONOMY_BETA_CREDIT,
            beta_previous_balance: centavosToReais(write.previousCentavos),
            beta_balance_after: centavosToReais(write.afterCentavos),
          });
        } else {
          transaction.set(refundTxRef, {
            ...base,
            category: ENTRY_REFUND_CATEGORY,
            economy_type: ECONOMY_CASH,
            previous_balance: centavosToReais(write.previousCentavos),
            balance_after: centavosToReais(write.afterCentavos),
          });
        }

        // 3. The registration keeps every original field (including the
        // original transaction_ref) and gains the refunded state.
        transaction.update(registrationRef, {
          status: "refunded",
          refunded_at: stampedAt,
          refunded_amount: amountReais,
          refund_transaction_ref: refundTxRef,
          refund_economy_type: item.economy,
        });
      }

      // 4. The tournament becomes TERMINAL. Both participant pairs are zeroed
      // together (the code's own invariant); economy, lock, price and history
      // are preserved untouched.
      transaction.update(tournamentRef, {
        status: STATUS_CANCELLED,
        cancelled_at: stampedAt,
        cancelled_by: callerAuth.uid,
        refunded_registration_count: plan.length,
        refunded_total: centavosToReais(totalCentavos),
        refund_economy_type: economy,
        current_participants: 0,
        current_players: 0,
        updated_at: stampedAt,
      });

      return {
        idempotent: false,
        economy,
        refundedCount: plan.length,
        refundedTotalReais: centavosToReais(totalCentavos),
      };
    });

    return {
      success: true,
      tournament_id: tournamentid,
      economy_type: outcome.economy,
      refunded_registrations: outcome.refundedCount,
      refunded_amount: outcome.refundedTotalReais,
      idempotent: outcome.idempotent,
      message: "Torneio cancelado e inscrições reembolsadas.",
    };
  } catch (error) {
    console.error("cancelTournament error:", error);
    throw toHttpsError(error);
  }
};

export const cancelTournament = central.https.onCall(cancelTournamentHandler);

/**
 * ADMIN-ONLY, IDEMPOTENT: grants non-withdrawable Beta Credits to a player's
 * `wallets/{uid}.beta_balance` for the closed beta.
 *
 * ECONOMY ISOLATION (the whole point): this is the ONLY flow that writes
 * `beta_balance`, and it touches NOTHING else — never `balance`,
 * `total_deposited`, `total_won`, `total_spent` or `total_withdrawn`. Beta
 * Credits have no monetary value, no conversion to `balance` exists, and
 * `requestwithdrawal` never reads `beta_balance`, so a Beta Credit can never
 * become withdrawable money. `testdeposit` is NOT part of the beta flow.
 *
 * IDEMPOTENCY: the transaction id is the deterministic `beta_grant_{grant_id}`,
 * read INSIDE the Firestore transaction. First valid call credits exactly once;
 * an identical replay returns success with NO write; the same `grant_id` with
 * different data is failed-precondition with NO write. `granted_by` comes
 * EXCLUSIVELY from the verified token (`context.auth.uid`) — it is not an
 * accepted payload key.
 *
 * Exported for behavioral tests; a plain function with no trigger metadata is
 * NOT a deployable endpoint.
 */
export const grantBetaCreditHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para conceder créditos beta.",
      "Apenas admin pode conceder créditos beta."
    );

    // Exactly these five keys; `granted_by` (or anything else) is rejected.
    assertExactPayload(data, [
      "uid",
      "amount",
      "grant_id",
      "campaign_id",
      "reason",
    ]);
    const uid = normalizeBetaGrantUid(data.uid);
    const amountCentavos = validateBetaGrantAmount(data.amount);
    const grantId = normalizeGrantId(data.grant_id);
    const campaignId = normalizeCampaignId(data.campaign_id);
    const reason = normalizeReason(data.reason);

    // Provenance comes from the verified token ONLY — never from the payload.
    const grantedBy = callerAuth.uid;

    const walletRef = db.collection("wallets").doc(uid);
    const userRef = db.collection("users").doc(uid);
    const grantTxRef = db
      .collection("transactions")
      .doc(betaGrantTransactionId(grantId));

    const outcome = await db.runTransaction(async (transaction) => {
      // Reads first — every read before any write.
      const grantTxSnap = await transaction.get(grantTxRef);
      const walletSnap = await transaction.get(walletRef);

      if (!walletSnap.exists) {
        throw new DomainError(
          "not-found",
          "Carteira do destinatário não encontrada."
        );
      }

      const walletData = walletSnap.data() ?? {};
      // An old wallet without the field MEANS zero — read-side default only;
      // nothing is written just to normalize old documents.
      const previousBeta = storedReaisToCentavos(
        walletData.beta_balance ?? 0,
        "saldo beta"
      );

      // ── Idempotent replay: the deterministic grant transaction exists ──
      if (grantTxSnap.exists) {
        const stored = grantTxSnap.data() ?? {};
        const replay = checkBetaGrantReplay({
          grantId,
          uid,
          amountReais: centavosToReais(amountCentavos),
          campaignId,
          reason,
          stored: {
            category: stored.category,
            economyType: stored.economy_type,
            grantId: stored.grant_id,
            amountReais: stored.amount,
            campaignId: stored.campaign_id,
            reason: stored.reason,
            userRefPath: documentPath(stored.user_ref),
          },
        });
        if (!replay.ok) {
          throw new DomainError("failed-precondition", replay.message);
        }
        // Fully equivalent: success with NO credit and NO write — balances and
        // timestamps stay exactly as they were.
        return {
          idempotent: true,
          betaBalanceReais: centavosToReais(previousBeta),
        };
      }

      // ── First execution: credit exactly once ──
      // addCentavos enforces the safe ceiling atomically: an overflow throws
      // before any write, so a failed grant leaves no partial state.
      const afterBeta = addCentavos(previousBeta, amountCentavos);

      // ONE server-timestamp sentinel, reused so every stamp in this commit
      // resolves to the exact same time.
      const stampedAt = admin.firestore.FieldValue.serverTimestamp();

      // The ONLY wallet field this flow may touch is beta_balance.
      transaction.update(walletRef, {
        beta_balance: centavosToReais(afterBeta),
      });

      transaction.set(grantTxRef, {
        amount: centavosToReais(amountCentavos),
        category: BETA_GRANT_CATEGORY,
        economy_type: BETA_ECONOMY_TYPE,
        grant_id: grantId,
        campaign_id: campaignId,
        reason: reason,
        granted_by: grantedBy,
        user_ref: userRef,
        display_name: "Crédito Beta",
        tournament_ref: null,
        // Beta-pool stamps — deliberately NOT previous_balance/balance_after,
        // which in every cash transaction refer to the real `balance`.
        beta_previous_balance: centavosToReais(previousBeta),
        beta_balance_after: centavosToReais(afterBeta),
        timestamp: stampedAt,
        created_at: stampedAt,
        status: "completed",
        external_id: betaGrantTransactionId(grantId),
      });

      return {
        idempotent: false,
        betaBalanceReais: centavosToReais(afterBeta),
      };
    });

    return {
      success: true,
      idempotent: outcome.idempotent,
      grant_id: grantId,
      beta_balance: outcome.betaBalanceReais,
    };
  } catch (error) {
    console.error("grantBetaCredit error:", error);
    throw toHttpsError(error);
  }
};

export const grantBetaCredit = central.https.onCall(grantBetaCreditHandler);
