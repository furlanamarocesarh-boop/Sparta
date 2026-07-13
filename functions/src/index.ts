import * as admin from "firebase-admin";
import { auth, https } from "firebase-functions/v1";

admin.initializeApp();
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
const db = admin.firestore();

function generatePlayerId(): string {
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `PLR-${rand}`;
}

export const onUserCreated = auth.user().onCreate(async (user) => {
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
export const testdeposit = https.onCall(async (data, context) => {
  console.log("========== testdeposit CALLED ==========");
  console.log("auth exists:", !!context.auth);
  console.log("data received:", data);

  if (!context.auth) {
    throw new https.HttpsError(
      "unauthenticated",
      "Você precisa estar logado para fazer depósito."
    );
  }

  const uid = context.auth.uid;

  const allowedAdminUid = "Fnj4w17GGeP7XgQ5yF3gXTL1yR42";

  if (uid !== allowedAdminUid) {
    throw new https.HttpsError(
      "permission-denied",
      "Apenas admin pode fazer depósito de teste."
    );
  }

  const amount = Number(data.amount);
  const externalId = getExternalId(data, "deposit");

  console.log("uid:", uid);
  console.log("amount:", amount);
  console.log("externalId:", externalId);

  if (!uid) {
    throw new https.HttpsError(
      "unauthenticated",
      "UID não encontrado."
    );
  }

  if (!amount || amount <= 0) {
    throw new https.HttpsError(
      "invalid-argument",
      "Amount precisa ser maior que zero."
    );
  }
  const db = admin.firestore();

  const walletRef = db.collection("wallets").doc(uid);
  const userRef = db.collection("users").doc(uid);
  const transactionRef = db.collection("transactions").doc(externalId);

  console.log("walletRef path:", walletRef.path);
  console.log("userRef path:", userRef.path);
  console.log("transactionRef path:", transactionRef.path);

  await db.runTransaction(async (transaction) => {
    console.log("Starting Firestore transaction");

    const existingTransaction = await transaction.get(transactionRef);

    if (existingTransaction.exists) {
      throw new https.HttpsError(
        "already-exists",
        "Já existe uma transação com esse externalid."
      );
    }

    const walletSnap = await transaction.get(walletRef);

    let previousBalance = 0;
    let totalDeposited = 0;

    if (walletSnap.exists) {
      const walletData = walletSnap.data() || {};

      previousBalance =
        typeof walletData.balance === "number" ? walletData.balance : 0;

      totalDeposited =
        typeof walletData.total_deposited === "number"
          ? walletData.total_deposited
          : 0;
    }

    const newBalance = previousBalance + amount;
    const newTotalDeposited = totalDeposited + amount;

    transaction.set(
      walletRef,
      {
        balance: newBalance,
        total_deposited: newTotalDeposited,
        user_ref: userRef,
      },
      { merge: true }
    );

    transaction.set(transactionRef, {
      amount: amount,
      category: "deposit",
      user_ref: userRef,
      display_name: "Test Deposit",
      tournament_ref: null,
      previous_balance: previousBalance,
      balance_after: newBalance,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: "completed",
      external_id: externalId,
    });

    console.log("Deposit transaction prepared:", {
      uid,
      externalId,
      previousBalance,
      newBalance,
    });
  });

  console.log("========== testdeposit SUCCESS ==========");

  return {
    success: true,
    message: "Depósito de teste realizado com sucesso.",
    externalid: externalId,
    amount: amount,
  };
});
exports.requestwithdrawal = https.onCall(async (data, context) => {
  // 1. Precisa estar logado
  if (!context.auth) {
    throw new https.HttpsError(
      "unauthenticated",
      "Você precisa estar logado para solicitar saque."
    );
  }

  const uid = context.auth.uid;

  // 2. Ler parâmetros
  const rawAmount = data.amount;
  const rawPixkey = data.pixkey;

  const amount = Number(rawAmount);
  const pixkey = String(rawPixkey || "").trim();

  // 3. Validações do amount
  if (!Number.isFinite(amount)) {
    throw new https.HttpsError(
      "invalid-argument",
      "Valor de saque inválido."
    );
  }

  if (amount <= 0) {
    throw new https.HttpsError(
      "invalid-argument",
      "O valor do saque precisa ser maior que zero."
    );
  }

  const amountRounded = Math.round(amount * 100) / 100;

  if (amount !== amountRounded) {
    throw new https.HttpsError(
      "invalid-argument",
      "O valor do saque pode ter no máximo 2 casas decimais."
    );
  }

  const minimumWithdrawal = 5;

  if (amount < minimumWithdrawal) {
    throw new https.HttpsError(
      "invalid-argument",
      `O saque mínimo é R$${minimumWithdrawal}.`
    );
  }

  const maximumWithdrawal = 10000;

  if (amount > maximumWithdrawal) {
    throw new https.HttpsError(
      "invalid-argument",
      "Valor de saque acima do limite permitido."
    );
  }

  // 4. Validação básica da chave PIX
  if (!pixkey) {
    throw new https.HttpsError(
      "invalid-argument",
      "A chave PIX é obrigatória."
    );
  }

  if (pixkey.length < 5 || pixkey.length > 140) {
    throw new https.HttpsError(
      "invalid-argument",
      "Chave PIX inválida."
    );
  }

  // Bloqueia caracteres invisíveis/estranhos
  if (/[\x00-\x1F\x7F]/.test(pixkey)) {
    throw new https.HttpsError(
      "invalid-argument",
      "Chave PIX contém caracteres inválidos."
    );
  }

  const db = admin.firestore();

  const userRef = db.collection("users").doc(uid);
  const walletRef = db.collection("wallets").doc(uid);

  // externalid automático
  const externalid = generateExternalId("withdrawal");

  const transactionRef = db.collection("transactions").doc(externalid);
  const withdrawalRef = db.collection("withdrawals").doc(externalid);

  try {
    await db.runTransaction(async (transaction) => {
      const walletSnap = await transaction.get(walletRef);

      if (!walletSnap.exists) {
        throw new https.HttpsError(
          "failed-precondition",
          "Carteira não encontrada."
        );
      }

      const walletData = walletSnap.data() || {};
      const currentBalance = Number(walletData.balance || 0);

      if (!Number.isFinite(currentBalance)) {
        throw new https.HttpsError(
          "failed-precondition",
          "Saldo inválido na carteira."
        );
      }

      if (currentBalance < amount) {
        throw new https.HttpsError(
          "failed-precondition",
          "Saldo insuficiente."
        );
      }

      const balanceAfter = Math.round((currentBalance - amount) * 100) / 100;
      const previousBalance = Math.round(currentBalance * 100) / 100;

      if (balanceAfter < 0) {
        throw new https.HttpsError(
          "failed-precondition",
          "Saldo insuficiente."
        );
      }

      transaction.update(walletRef, {
        balance: balanceAfter,
        total_withdrawn: admin.firestore.FieldValue.increment(amount),
      });

      transaction.set(transactionRef, {
        amount: amount,
        category: "withdrawal",
        user_ref: userRef,
        display_name: "Saque",
        tournament_ref: null,
        previous_balance: previousBalance,
        balance_after: balanceAfter,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "pending",
        external_id: externalid,
      });

      transaction.set(withdrawalRef, {
        amount: amount,
        user_ref: userRef,
        status: "pending",
        pix_key_snapshot: pixkey,
        transaction_ref: transactionRef,

        // Campos preparados para API PIX futura
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
      amount: amount,
      status: "pending",
    };
  } catch (error) {
    console.error("requestwithdrawal error:", error);

    if (error instanceof https.HttpsError) {
      throw error;
    }

    throw new https.HttpsError(
      "internal",
      "Erro ao solicitar saque."
    );
  }
});
exports.jointournament = https.onCall(async (data, context) => {
  // 1. Precisa estar logado
  if (!context.auth) {
    throw new https.HttpsError(
      "unauthenticated",
      "Você precisa estar logado para entrar no torneio."
    );
  }

  const uid = context.auth.uid;

  // 2. Ler e validar tournamentid
  const tournamentid = String(data.tournamentid || "").trim();

  if (!tournamentid) {
    throw new https.HttpsError(
      "invalid-argument",
      "ID do torneio é obrigatório."
    );
  }

  if (tournamentid.includes("/") || tournamentid.length > 200) {
    throw new https.HttpsError(
      "invalid-argument",
      "ID do torneio inválido."
    );
  }

  const db = admin.firestore();

  const userRef = db.collection("users").doc(uid);
  const walletRef = db.collection("wallets").doc(uid);
  const tournamentRef = db.collection("tournaments").doc(tournamentid);

  // ID determinístico impede inscrição duplicada no mesmo torneio
  const registrationid = `${uid}_${tournamentid}`;
  const registrationRef = db.collection("registrations").doc(registrationid);

  // Transaction ID automático
  const externalid = generateExternalId("entryfee");
  const transactionRef = db.collection("transactions").doc(externalid);

  try {
    await db.runTransaction(async (transaction) => {
      // 3. Ler docs dentro da transaction
      const walletSnap = await transaction.get(walletRef);
      const tournamentSnap = await transaction.get(tournamentRef);
      const registrationSnap = await transaction.get(registrationRef);

      // 4. Validar wallet
      if (!walletSnap.exists) {
        throw new https.HttpsError(
          "failed-precondition",
          "Carteira não encontrada."
        );
      }

      const walletData = walletSnap.data() || {};
      const currentBalance = Number(walletData.balance || 0);

      if (!Number.isFinite(currentBalance)) {
        throw new https.HttpsError(
          "failed-precondition",
          "Saldo inválido na carteira."
        );
      }

      // 5. Validar torneio
      if (!tournamentSnap.exists) {
        throw new https.HttpsError(
          "not-found",
          "Torneio não encontrado."
        );
      }

      const tournamentData = tournamentSnap.data() || {};

      const status = String(tournamentData.status || "").trim().toLowerCase();

      if (status !== "open") {
        throw new https.HttpsError(
          "failed-precondition",
          "Este torneio não está aberto para inscrições."
        );
      }

      const entryFee = Number(tournamentData.entry_fee);

      if (!Number.isFinite(entryFee)) {
        throw new https.HttpsError(
          "failed-precondition",
          "Taxa de entrada inválida."
        );
      }

      if (entryFee <= 0) {
        throw new https.HttpsError(
          "failed-precondition",
          "Taxa de entrada precisa ser maior que zero."
        );
      }

      const entryFeeRounded = Math.round(entryFee * 100) / 100;

      if (entryFee !== entryFeeRounded) {
        throw new https.HttpsError(
          "failed-precondition",
          "Taxa de entrada pode ter no máximo 2 casas decimais."
        );
      }

      const currentParticipants = Number(tournamentData.current_participants || 0);
      const maxParticipants = Number(tournamentData.max_participants || 0);

      if (!Number.isFinite(currentParticipants) || currentParticipants < 0) {
        throw new https.HttpsError(
          "failed-precondition",
          "Número atual de participantes inválido."
        );
      }

      if (!Number.isFinite(maxParticipants) || maxParticipants <= 0) {
        throw new https.HttpsError(
          "failed-precondition",
          "Limite de participantes inválido."
        );
      }

      if (currentParticipants >= maxParticipants) {
        throw new https.HttpsError(
          "failed-precondition",
          "Este torneio já está lotado."
        );
      }

      // 6. Bloquear inscrição duplicada
      if (registrationSnap.exists) {
        throw new https.HttpsError(
          "already-exists",
          "Você já está inscrito neste torneio."
        );
      }

      // 7. Validar saldo
      if (currentBalance < entryFee) {
        throw new https.HttpsError(
          "failed-precondition",
          "Saldo insuficiente."
        );
      }

      const previousBalance = Math.round(currentBalance * 100) / 100;
      const balanceAfter = Math.round((currentBalance - entryFee) * 100) / 100;

      if (balanceAfter < 0) {
        throw new https.HttpsError(
          "failed-precondition",
          "Saldo insuficiente."
        );
      }

      // 8. Atualizar wallet
      transaction.update(walletRef, {
        balance: balanceAfter,
        total_spent: admin.firestore.FieldValue.increment(entryFee),
      });

      // 9. Atualizar torneio
      transaction.update(tournamentRef, {
        current_participants: admin.firestore.FieldValue.increment(1),
      });

      // 10. Criar registration
      transaction.set(registrationRef, {
        user_ref: userRef,
        tournament_ref: tournamentRef,
        entry_fee: entryFee,
        status: "registered",
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 11. Criar transaction financeira
      transaction.set(transactionRef, {
        amount: entryFee,
        category: "entry_fee",
        user_ref: userRef,
        display_name: "Entrada em torneio",
        tournament_ref: tournamentRef,
        previous_balance: previousBalance,
        balance_after: balanceAfter,
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

    if (error instanceof https.HttpsError) {
      throw error;
    }

    throw new https.HttpsError(
      "internal",
      "Erro ao entrar no torneio."
    );
  }
});
export const payprize = https.onCall(async (data, context) => {
  console.log("payprize called");
  console.log("auth uid:", context.auth?.uid);
  console.log("data received:", data);

  if (!context.auth) {
    console.log("payprize error: unauthenticated");

    throw new https.HttpsError(
      "unauthenticated",
      "Você precisa estar logado para pagar prêmio."
    );
  }

  const adminUid = context.auth.uid;
  const allowedAdminUid = "Fnj4w17GGeP7XgQ5yF3gXTL1yR42";

  if (adminUid !== allowedAdminUid) {
    console.log("payprize error: permission denied", adminUid);

    throw new https.HttpsError(
      "permission-denied",
      "Você não tem permissão para pagar prêmio."
    );
  }

  const winneruid = data.winneruid;
  const tournamentid = data.tournamentid;
  const amount = Number(data.amount);
 const externalid =
  typeof data.externalid === "string" && data.externalid.trim().length > 0
    ? data.externalid.trim()
    : `prize_${winneruid}_${tournamentid}`;

  if (!winneruid || typeof winneruid !== "string") {
    console.log("payprize error: invalid winneruid", winneruid);

    throw new https.HttpsError(
      "invalid-argument",
      "Winner UID inválido."
    );
  }

  if (!tournamentid || typeof tournamentid !== "string") {
    console.log("payprize error: invalid tournamentid", tournamentid);

    throw new https.HttpsError(
      "invalid-argument",
      "Tournament ID inválido."
    );
  }

  if (!amount || amount <= 0) {
    console.log("payprize error: invalid amount", amount);

    throw new https.HttpsError(
      "invalid-argument",
      "Valor do prêmio inválido."
    );
  }
  const db = admin.firestore();

  const winnerUserRef = db.collection("users").doc(winneruid);
  const winnerWalletRef = db.collection("wallets").doc(winneruid);
  const tournamentRef = db.collection("tournaments").doc(tournamentid);
  const transactionRef = db.collection("transactions").doc(externalid);

  try {
    const result = await db.runTransaction(async (transaction) => {
      console.log("payprize transaction started");

      const winnerWalletSnap = await transaction.get(winnerWalletRef);
      const tournamentSnap = await transaction.get(tournamentRef);
      const existingTransactionSnap = await transaction.get(transactionRef);

      if (existingTransactionSnap.exists) {
        console.log("payprize error: duplicate externalid", externalid);

        throw new https.HttpsError(
          "already-exists",
          "Já existe uma transação com esse external ID."
        );
      }

      if (!winnerWalletSnap.exists) {
        console.log("payprize error: winner wallet not found", winneruid);

        throw new https.HttpsError(
          "not-found",
          "Carteira do vencedor não encontrada."
        );
      }

      if (!tournamentSnap.exists) {
        console.log("payprize error: tournament not found", tournamentid);

        throw new https.HttpsError(
          "not-found",
          "Torneio não encontrado."
        );
      }

      const walletData = winnerWalletSnap.data();

      const previousBalance = Number(walletData?.balance || 0);
      const previousTotalWon = Number(walletData?.total_won || 0);

      const balanceAfter = previousBalance + amount;
      const totalWonAfter = previousTotalWon + amount;

      transaction.update(winnerWalletRef, {
        balance: balanceAfter,
        total_won: totalWonAfter,
      });

      transaction.set(transactionRef, {
        amount: amount,
        category: "prize",
        user_ref: winnerUserRef,
        display_name: "",
        tournament_ref: tournamentRef,
        previous_balance: previousBalance,
        balance_after: balanceAfter,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed",
        external_id: externalid,
      });

      console.log("payprize transaction success", {
        adminUid,
        winneruid,
        tournamentid,
        amount,
        previousBalance,
        balanceAfter,
        externalid,
      });

      return {
        success: true,
        winner_uid: winneruid,
        tournament_id: tournamentid,
        amount: amount,
        previous_balance: previousBalance,
        balance_after: balanceAfter,
        external_id: externalid,
      };
    });

    return result;
  } catch (error) {
    console.error("payprize catch error:", error);

    if (error instanceof https.HttpsError) {
      throw error;
    }

    throw new https.HttpsError(
      "internal",
      "Erro interno ao pagar prêmio."
    );
  }
});

const createTournamentHandler = async (data: any, context: any) => {
  if (!context.auth) {
    throw new https.HttpsError(
      "unauthenticated",
      "Você precisa estar logado para criar um campeonato."
    );
  }
  const uid = context.auth.uid;

  const name = String(data.name || "").trim();
  const description = String(data.description || "").trim();

  const entryFee = Number(data.entry_fee);
  const prize = Number(data.prize);
  const maxPlayers = Number(data.max_players);

  const gameMode = String(data.game_mode || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

  if (!name) {
    throw new https.HttpsError(
      "invalid-argument",
      "O nome do campeonato é obrigatório."
    );
  }

  if (Number.isNaN(entryFee) || entryFee < 0) {
    throw new https.HttpsError(
      "invalid-argument",
      "O valor da inscrição precisa ser válido."
    );
  }

  if (Number.isNaN(prize) || prize < 0) {
    throw new https.HttpsError(
      "invalid-argument",
      "O valor da premiação precisa ser válido."
    );
  }

  if (Number.isNaN(maxPlayers) || maxPlayers <= 0) {
    throw new https.HttpsError(
      "invalid-argument",
      "O número máximo de jogadores precisa ser maior que zero."
    );
  }

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
    throw new https.HttpsError(
      "invalid-argument",
      "Modo de jogo inválido. Use solo, duo, squad, 2v2 ou 4v4."
    );
  }

  const userRef = admin.firestore().collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    throw new https.HttpsError(
      "not-found",
      "Usuário criador não encontrado."
    );
  }

  const userData = userSnap.data() || {};

  const creatorName =
    userData.display_name ||
    userData.username ||
    userData.name ||
    userData.nickname ||
    context.auth.token.email ||
    "Criador";

  const tournamentRef = admin.firestore().collection("tournaments").doc();

  await tournamentRef.set({
    name,
    description,

    entry_fee: entryFee,
    prize,

    status: "open",

    creator_ref: userRef,
    creator_uid: uid,
    creator_name: creatorName,

    game_mode: gameMode,
    game_mode_label: gameModeLabel,
    team_size: teamSize,
    format_type: formatType,

    current_players: 0,
    max_players: maxPlayers,

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
};

export const createTournament = https.onCall(createTournamentHandler);
export const createtournament = https.onCall(createTournamentHandler);