import { ReadOnlyQuery, scanCollection } from "../audit/collector.js";
import { WALLET_MONEY_FIELDS } from "../audit/walletAudit.js";
import {
  APPLY_FLAG,
  CONFIRM_DELETE_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  decide,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "./guard.js";
import {
  buildPlan,
  CandidateWithId,
  describePlan,
  executeCleanup,
  TxLike,
} from "./plan.js";
import {
  classify,
  isFakeTransaction,
  TransactionSnapshot,
  WalletCandidate,
} from "./signature.js";

/**
 * Guarded cleanup of the two anomalous TEST documents.
 *
 * NOT a Cloud Function. This file is deliberately NOT exported from
 * `src/index.ts`, and `lib/cleanup` is excluded from the deploy package in
 * `firebase.json` — it cannot become a callable or an endpoint, by construction.
 * It is a local operator tool, run by hand.
 *
 * DRY RUN IS THE DEFAULT. Writing needs four explicit signals at once, and even
 * then every document is re-read and re-validated INSIDE the Firestore
 * transaction immediately before the write. If anything has changed since the
 * scan — a new transaction, a different balance, a repaired user_ref — the whole
 * thing aborts and nothing is written.
 */

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

const USAGE = `
Limpeza de dados de TESTE — dry-run por padrão.

  # Dry run (padrão, não escreve nada):
  node lib/cleanup/cli.js --project ${PRODUCTION_PROJECT_ID}

  # Execução real (exige as QUATRO confirmações simultâneas):
  node lib/cleanup/cli.js --project ${PRODUCTION_PROJECT_ID} \\
    ${APPLY_FLAG} ${CONFIRM_DELETE_FLAG} ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}

IDs de documento NÃO são aceitos. Os alvos são localizados exclusivamente pela
assinatura exata verificada pela auditoria.
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    console.log(USAGE);
    return EXIT_FAILURE;
  }

  const decision = decide(args, argv);

  if (!decision.allowed) {
    console.error("RECUSADO: " + decision.message);
    console.error(USAGE);
    return EXIT_FAILURE;
  }

  const mode = decision.mode;

  // Only now — after the guard approved — is the SDK loaded.
  type AdminModule = typeof import("firebase-admin");
  const imported = (await import("firebase-admin")) as unknown as AdminModule & {
    default?: AdminModule;
  };
  const admin = imported.default ?? imported;

  admin.initializeApp({ projectId: args.project });
  const db = admin.firestore();
  const documentId = admin.firestore.FieldPath.documentId();

  console.error(
    `Projeto "${args.project}" — modo: ${
      mode === "apply" ? "APLICAR (ESCRITA)" : "DRY RUN (nenhuma escrita)"
    }`
  );

  // --- Scan: build a candidate for every wallet. -----------------------------
  const walletIds: string[] = [];
  const walletData = new Map<string, Record<string, unknown>>();

  await scanCollection(
    db.collection("wallets") as unknown as ReadOnlyQuery,
    { orderByField: documentId },
    (id, data) => {
      walletIds.push(id);
      walletData.set(id, data);
    }
  );

  const candidates: CandidateWithId[] = [];

  for (const walletId of walletIds) {
    const data = walletData.get(walletId) ?? {};
    const candidate = await buildCandidate(db, documentId, walletId, data);
    candidates.push({ id: walletId, candidate });
  }

  const plan = buildPlan(candidates);

  if (!plan.ok) {
    // Includes the idempotent case: a second run after a successful apply finds
    // no targets and exits cleanly, having written nothing.
    console.log("=".repeat(64));
    console.log("LIMPEZA DE DADOS DE TESTE");
    console.log("=".repeat(64));
    console.log("");
    console.log(plan.reason);
    console.log("");
    console.log("Nenhuma escrita foi realizada.");
    return EXIT_OK;
  }

  // --- Report (anonymized). --------------------------------------------------
  console.log("=".repeat(64));
  console.log("LIMPEZA DE DADOS DE TESTE — " + (mode === "apply" ? "APLICAR" : "DRY RUN"));
  console.log("=".repeat(64));
  console.log("");
  console.log(`Alvos encontrados: 2 (exatamente 1 Wallet A e 1 Wallet B)`);
  console.log("");
  for (const line of describePlan()) console.log(line);
  console.log("");

  if (mode === "dry-run") {
    console.log("=".repeat(64));
    console.log("DRY RUN: nenhuma escrita foi realizada. Nada foi alterado.");
    console.log(
      `Para aplicar: ${APPLY_FLAG} ${CONFIRM_DELETE_FLAG} ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}`
    );
    console.log("=".repeat(64));
    return EXIT_OK;
  }

  // --- Apply: re-read and re-validate INSIDE the transaction. ----------------
  const walletARef = db.collection("wallets").doc(plan.targets.walletA.id);
  const walletBRef = db.collection("wallets").doc(plan.targets.walletB.id);
  const userARef = db.collection("users").doc(plan.targets.walletA.id);

  // Re-locate the fake transaction by its signature, not by a remembered id.
  const fakeTxIds: string[] = [];
  await scanCollection(
    db
      .collection("transactions")
      .where("user_ref", "==", userARef) as unknown as ReadOnlyQuery,
    { orderByField: documentId },
    (id, data) => {
      if (isFakeTransaction(data as unknown as TransactionSnapshot)) {
        fakeTxIds.push(id);
      }
    }
  );

  if (fakeTxIds.length !== 1) {
    console.error(
      `ABORTADO: esperava exatamente 1 transaction falsa, encontrei ${fakeTxIds.length}. Nada foi escrito.`
    );
    return EXIT_FAILURE;
  }

  const fakeTxRef = db.collection("transactions").doc(fakeTxIds[0]);

  try {
    await db.runTransaction(async (transaction) => {
      // Re-read everything under the transaction's consistency guarantee.
      const [walletASnap, walletBSnap, userASnap, fakeTxSnap] = await Promise.all([
        transaction.get(walletARef),
        transaction.get(walletBRef),
        transaction.get(userARef),
        transaction.get(fakeTxRef),
      ]);

      if (!walletASnap.exists || !walletBSnap.exists || !fakeTxSnap.exists) {
        throw new Error("um documento alvo desapareceu — abortando");
      }

      // Rebuild both candidates from the fresh reads and re-run the SAME
      // signature check. If a single byte drifted since the scan, this fails.
      const freshA = await buildCandidate(
        db,
        documentId,
        plan.targets.walletA.id,
        walletASnap.data() ?? {}
      );
      const freshB = await buildCandidate(
        db,
        documentId,
        plan.targets.walletB.id,
        walletBSnap.data() ?? {}
      );

      if (classify(freshA) !== "wallet-a") {
        throw new Error("Wallet A mudou desde a verificação — abortando");
      }
      if (classify(freshB) !== "wallet-b") {
        throw new Error("Wallet B mudou desde a verificação — abortando");
      }
      if (!userASnap.exists) {
        throw new Error("users/{uid} da Wallet A não existe — abortando");
      }
      if (
        !isFakeTransaction(fakeTxSnap.data() as unknown as TransactionSnapshot)
      ) {
        throw new Error("a transaction alvo não é mais a falsa — abortando");
      }

      executeCleanup(transaction as unknown as TxLike, {
        walletARef,
        walletAUserRef: userARef,
        fakeTransactionRef: fakeTxRef,
        walletBRef,
      });
    });
  } catch (error) {
    // A failed commit is a FAILURE, never a success. Firestore rolls the whole
    // transaction back, so there is no partial write to clean up.
    console.error("ABORTADO — nada foi escrito:", (error as Error).message);
    return EXIT_FAILURE;
  }

  console.log("=".repeat(64));
  console.log("APLICADO com sucesso, atomicamente:");
  console.log("  - Wallet A: 5 campos financeiros zerados + user_ref corrigido;");
  console.log("  - Wallet A: 1 transaction falsa removida;");
  console.log("  - Wallet B: documento órfão removido.");
  console.log("Nenhum usuário e nenhuma autenticação foram removidos.");
  console.log("=".repeat(64));
  return EXIT_OK;
}

/** Gathers everything the signature needs for one wallet. */
async function buildCandidate(
  db: FirebaseFirestore.Firestore,
  documentId: unknown,
  walletId: string,
  data: Record<string, unknown>
): Promise<WalletCandidate> {
  const expectedUserRefPath = `users/${walletId}`;
  const userRef = db.collection("users").doc(walletId);

  const storedUserRef = data.user_ref as { path?: string } | undefined | null;
  const userRefPath =
    storedUserRef && typeof storedUserRef.path === "string"
      ? storedUserRef.path
      : undefined;

  const userSnap = await userRef.get();

  const transactions: TransactionSnapshot[] = [];
  await scanCollection(
    db
      .collection("transactions")
      .where("user_ref", "==", userRef) as unknown as ReadOnlyQuery,
    { orderByField: documentId },
    (_id, txData) => {
      transactions.push({
        category: txData.category,
        status: txData.status,
        amount: txData.amount,
      });
    }
  );

  let withdrawalCount = 0;
  await scanCollection(
    db
      .collection("withdrawals")
      .where("user_ref", "==", userRef) as unknown as ReadOnlyQuery,
    { orderByField: documentId },
    () => {
      withdrawalCount++;
    }
  );

  let registrationCount = 0;
  await scanCollection(
    db
      .collection("registrations")
      .where("user_ref", "==", userRef) as unknown as ReadOnlyQuery,
    { orderByField: documentId },
    () => {
      registrationCount++;
    }
  );

  // Sanity: the money-field list is the one the audit uses.
  void WALLET_MONEY_FIELDS;

  return {
    walletData: data,
    userRefPath,
    expectedUserRefPath,
    userDocExists: userSnap.exists,
    transactions,
    withdrawalCount,
    registrationCount,
  };
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("FALHA:", error);
    process.exitCode = EXIT_FAILURE;
  });
