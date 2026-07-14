import { executeReset, RefResolver, ResetTx } from "./execute.js";
import { computeFingerprint, shortFingerprint } from "./fingerprint.js";
import {
  APPLY_FLAG,
  CONFIRM_RESET_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  decide,
  FINGERPRINT_FLAG,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "./guard.js";
import {
  buildResetPlan,
  LedgerCollection,
  LEDGER_COLLECTIONS,
  LedgerSnapshot,
  ResetSnapshot,
  stampsFor,
  TournamentSnapshot,
  WalletSnapshot,
} from "./plan.js";

/**
 * Guarded reset of ALL test financial state.
 *
 * NOT a Cloud Function: not exported from `src/index.ts`, `lib/reset` is
 * excluded from the deploy package, no `firebase-functions` import, no
 * `onCall`/`onRequest`. It cannot become a callable or an endpoint.
 *
 * DRY RUN IS THE DEFAULT. Applying requires five signals at once, one of which
 * is a fingerprint that can only be obtained by running the dry run — and which
 * is re-verified against freshly-read data INSIDE the transaction, immediately
 * before any write. If a single document changed in between, it aborts.
 */

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

const USAGE = `
Reset do estado financeiro de TESTE — dry-run por padrão.

  # Dry run (padrão, não escreve nada; imprime o fingerprint):
  node lib/reset/cli.js --project ${PRODUCTION_PROJECT_ID}

  # Execução real (exige os CINCO sinais simultaneamente):
  node lib/reset/cli.js --project ${PRODUCTION_PROJECT_ID} \\
    ${APPLY_FLAG} ${CONFIRM_RESET_FLAG} \\
    ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE} \\
    ${FINGERPRINT_FLAG} <fingerprint-do-dry-run>

IDs de documento NÃO são aceitos.
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

  // Only after the guard approves is the SDK loaded.
  type AdminModule = typeof import("firebase-admin");
  const imported = (await import("firebase-admin")) as unknown as AdminModule & {
    default?: AdminModule;
  };
  const admin = imported.default ?? imported;

  admin.initializeApp({ projectId: args.project });
  const db = admin.firestore();

  console.error(
    `Projeto "${args.project}" — modo: ${
      decision.mode === "apply" ? "APLICAR (ESCRITA)" : "DRY RUN (nenhuma escrita)"
    }`
  );

  const snapshot = await readSnapshot(db);
  const result = buildResetPlan(snapshot);

  if (!result.ok) {
    console.error("ABORTADO: " + result.reason);
    return EXIT_FAILURE;
  }

  const plan = result.plan;

  // --- Report (aggregate counts + fingerprint only). -------------------------
  console.log("=".repeat(68));
  console.log(
    "RESET FINANCEIRO DE TESTE — " +
      (decision.mode === "apply" ? "APLICAR" : "DRY RUN")
  );
  console.log("=".repeat(68));
  console.log("");
  console.log(`  users preservados (intocados)   : ${plan.usersPreserved}`);
  console.log(`  wallets a zerar                 : ${plan.walletsToZero}`);
  console.log(`  wallets já limpas               : ${plan.walletsAlreadyClean}`);
  console.log(`  transactions a remover          : ${plan.ledgerCounts.transactions}`);
  console.log(`  withdrawals a remover           : ${plan.ledgerCounts.withdrawals}`);
  console.log(`  registrations a remover         : ${plan.ledgerCounts.registrations}`);
  console.log(`  tournaments a normalizar        : ${plan.tournamentsToNormalize}`);
  console.log(
    `  tournaments já canônicos        : ${plan.tournamentsAlreadyCanonical}`
  );
  console.log("");
  console.log(`  TOTAL DE WRITES PLANEJADAS      : ${plan.writes}`);
  console.log("");
  console.log(`  FINGERPRINT: ${plan.fingerprint}`);
  console.log("");

  if (plan.writes === 0) {
    // Idempotent: a second run after a successful reset has nothing to do.
    console.log("Nada a fazer: o estado já está limpo. Zero writes.");
    console.log("Nenhuma escrita foi realizada.");
    return EXIT_OK;
  }

  if (decision.mode === "dry-run") {
    console.log("=".repeat(68));
    console.log("DRY RUN: nenhuma escrita foi realizada. Nada foi alterado.");
    console.log("Para aplicar, repita com:");
    console.log(
      `  ${APPLY_FLAG} ${CONFIRM_RESET_FLAG} \\\n  ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE} \\\n  ${FINGERPRINT_FLAG} ${plan.fingerprint}`
    );
    console.log("=".repeat(68));
    return EXIT_OK;
  }

  // --- Apply. ---------------------------------------------------------------
  if (decision.expectedFingerprint !== plan.fingerprint) {
    console.error(
      "ABORTADO: o fingerprint informado não corresponde ao estado atual " +
        `(esperado ${shortFingerprint(decision.expectedFingerprint)}…, ` +
        `atual ${shortFingerprint(plan.fingerprint)}…). ` +
        "Algum documento mudou desde o dry-run. Nenhuma escrita."
    );
    return EXIT_FAILURE;
  }

  const refs: RefResolver = {
    wallet: (id) => db.collection("wallets").doc(id),
    user: (id) => db.collection("users").doc(id),
    tournament: (id) => db.collection("tournaments").doc(id),
    ledger: (collection, id) => db.collection(collection).doc(id),
  };

  try {
    await db.runTransaction(async (transaction) => {
      // Re-QUERY every collection inside the transaction. Re-reading known refs
      // would not reveal a document CREATED after the dry run; a fresh query
      // does. This is what makes "any new document aborts" true.
      const fresh = await readSnapshotInTransaction(db, transaction);

      const freshFingerprint = computeFingerprint(stampsFor(fresh));

      if (freshFingerprint !== decision.expectedFingerprint) {
        throw new Error(
          "o estado mudou entre a verificação e a escrita — abortando"
        );
      }

      const freshPlan = buildResetPlan(fresh);
      if (!freshPlan.ok) {
        throw new Error(freshPlan.reason);
      }
      if (freshPlan.plan.writes !== plan.writes) {
        throw new Error("o número de writes mudou — abortando");
      }

      executeReset(
        transaction as unknown as ResetTx,
        freshPlan.plan.operations,
        refs
      );
    });
  } catch (error) {
    // Firestore rolls the whole transaction back. A failed commit is a FAILURE,
    // never a success, and there is no partial write to clean up.
    console.error("ABORTADO — nada foi escrito:", (error as Error).message);
    return EXIT_FAILURE;
  }

  console.log("=".repeat(68));
  console.log("APLICADO com sucesso, atomicamente:");
  console.log(`  - ${plan.walletsToZero} wallets zeradas (campos não financeiros preservados);`);
  console.log(`  - ${plan.ledgerCounts.transactions} transactions removidas;`);
  console.log(`  - ${plan.ledgerCounts.withdrawals} withdrawals removidas;`);
  console.log(`  - ${plan.ledgerCounts.registrations} registrations removidas;`);
  console.log(`  - ${plan.tournamentsToNormalize} tournaments normalizados.`);
  console.log("Nenhum user e nenhuma autenticação foram tocados.");
  console.log("=".repeat(68));
  return EXIT_OK;
}

/** Reads the full financial scope (non-transactional, for planning). */
async function readSnapshot(
  db: FirebaseFirestore.Firestore
): Promise<ResetSnapshot> {
  const [usersSnap, walletsSnap, tournamentsSnap] = await Promise.all([
    db.collection("users").get(),
    db.collection("wallets").get(),
    db.collection("tournaments").get(),
  ]);

  const userIds = new Set(usersSnap.docs.map((doc) => doc.id));

  const wallets: WalletSnapshot[] = walletsSnap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
    updateTime: doc.updateTime?.toDate().toISOString() ?? "",
    userExists: userIds.has(doc.id),
  }));

  const tournaments: TournamentSnapshot[] = tournamentsSnap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
    updateTime: doc.updateTime?.toDate().toISOString() ?? "",
  }));

  const ledger: LedgerSnapshot[] = [];
  for (const collection of LEDGER_COLLECTIONS) {
    const snap = await db.collection(collection).get();
    for (const doc of snap.docs) {
      ledger.push({
        collection,
        id: doc.id,
        updateTime: doc.updateTime?.toDate().toISOString() ?? "",
      });
    }
  }

  return { userCount: usersSnap.size, wallets, tournaments, ledger };
}

/** The same read, but through the transaction, so the data is locked. */
async function readSnapshotInTransaction(
  db: FirebaseFirestore.Firestore,
  transaction: FirebaseFirestore.Transaction
): Promise<ResetSnapshot> {
  const usersSnap = await transaction.get(db.collection("users"));
  const walletsSnap = await transaction.get(db.collection("wallets"));
  const tournamentsSnap = await transaction.get(db.collection("tournaments"));

  const userIds = new Set(usersSnap.docs.map((doc) => doc.id));

  const wallets: WalletSnapshot[] = walletsSnap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
    updateTime: doc.updateTime?.toDate().toISOString() ?? "",
    userExists: userIds.has(doc.id),
  }));

  const tournaments: TournamentSnapshot[] = tournamentsSnap.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
    updateTime: doc.updateTime?.toDate().toISOString() ?? "",
  }));

  const ledger: LedgerSnapshot[] = [];
  for (const collection of LEDGER_COLLECTIONS) {
    const snap = await transaction.get(db.collection(collection));
    for (const doc of snap.docs) {
      ledger.push({
        collection: collection as LedgerCollection,
        id: doc.id,
        updateTime: doc.updateTime?.toDate().toISOString() ?? "",
      });
    }
  }

  return { userCount: usersSnap.size, wallets, tournaments, ledger };
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("FALHA:", error);
    process.exitCode = EXIT_FAILURE;
  });
