import { ReadOnlyQuery, scanCollection } from "../audit/collector.js";
import { applyOrphanDeletion } from "./apply.js";
import { AuthAccount, AuthSnapshot } from "./detect.js";
import {
  APPLY_FLAG,
  CONFIRM_DELETE_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  decide,
  FINGERPRINT_FLAG,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "./guard.js";
import { buildAuthCleanupPlan } from "./plan.js";
import type { DocumentStamp } from "../reset/fingerprint.js";

/**
 * Guarded cleanup of the single orphan TEST Auth account.
 *
 * NOT a Cloud Function: not exported from `src/index.ts`, `lib/authcleanup` is
 * excluded from the deploy package, no `firebase-functions` import, no
 * `onCall`/`onRequest`. It cannot become a callable or an endpoint.
 *
 * DRY RUN IS THE DEFAULT. The apply requires five signals, re-reads Auth AND
 * Firestore, re-verifies the fingerprint, re-confirms the target is still an
 * orphan, and then performs the ONE allowed operation: `auth.deleteUser` for a
 * single account. No Firestore document is ever created, updated or deleted.
 */

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

/** The three collections whose `user_ref` we inspect for financial references. */
const FINANCIAL_COLLECTIONS = ["transactions", "withdrawals", "registrations"] as const;

const USAGE = `
Exclusão da conta órfã de TESTE do Firebase Auth — dry-run por padrão.

  # Dry run (padrão, não exclui nada; imprime o fingerprint):
  node lib/authcleanup/cli.js --project ${PRODUCTION_PROJECT_ID}

  # Execução real (exige os CINCO sinais simultaneamente):
  node lib/authcleanup/cli.js --project ${PRODUCTION_PROJECT_ID} \\
    ${APPLY_FLAG} ${CONFIRM_DELETE_FLAG} \\
    ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE} \\
    ${FINGERPRINT_FLAG} <fingerprint-do-dry-run>

UID e e-mail NÃO são aceitos. A conta órfã é detectada, nunca informada.
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
  const auth = admin.auth();
  const documentId = admin.firestore.FieldPath.documentId();

  console.error(
    `Projeto "${args.project}" — modo: ${
      decision.mode === "apply" ? "APLICAR (EXCLUSÃO)" : "DRY RUN (nenhuma exclusão)"
    }`
  );

  const snapshot = await readSnapshot(db, auth, documentId);
  const result = buildAuthCleanupPlan(snapshot);

  // --- Report (aggregate counts only). --------------------------------------
  const counts = result.ok ? result.plan.counts : result.counts;
  console.log("=".repeat(68));
  console.log(
    "LIMPEZA DE AUTH ÓRFÃO — " + (decision.mode === "apply" ? "APLICAR" : "DRY RUN")
  );
  console.log("=".repeat(68));
  console.log("");
  console.log(`  contas Auth encontradas   : ${counts.authAccounts}`);
  console.log(`  users encontrados         : ${counts.users}`);
  console.log(`  wallets encontradas       : ${counts.wallets}`);
  console.log(`  órfãos elegíveis          : ${counts.orphans}`);
  console.log("");

  if (!result.ok) {
    console.log(`  operações planejadas      : 0`);
    console.log("");
    console.log(result.reason);
    console.log("Nenhuma conta foi excluída. Nenhuma escrita no Firestore.");
    // Zero orphans (the idempotent case) is a clean, successful outcome.
    return EXIT_OK;
  }

  const plan = result.plan;
  console.log(`  operações planejadas      : ${plan.deleteUserOps} deleteUser`);
  console.log(`  escritas no Firestore     : ${plan.firestoreOps}`);
  console.log("");
  console.log(`  FINGERPRINT: ${plan.fingerprint}`);
  console.log("");

  if (decision.mode === "dry-run") {
    console.log("=".repeat(68));
    console.log("DRY RUN: nenhuma conta foi excluída. Nada foi alterado.");
    console.log("Para aplicar, repita com:");
    console.log(
      `  ${APPLY_FLAG} ${CONFIRM_DELETE_FLAG} \\\n  ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE} \\\n  ${FINGERPRINT_FLAG} ${plan.fingerprint}`
    );
    console.log("=".repeat(68));
    return EXIT_OK;
  }

  // --- Apply. ---------------------------------------------------------------
  // Auth has no multi-document transaction, so we re-read EVERYTHING fresh and
  // re-validate immediately before the single delete. Any drift aborts.
  //
  // `applyOrphanDeletion` is handed ONLY a deleteUser callback — no Firestore
  // write surface — so it cannot write a document even in principle.
  const fresh = await readSnapshot(db, auth, documentId);

  const outcome = await applyOrphanDeletion(
    fresh,
    decision.expectedFingerprint,
    (uid) => auth.deleteUser(uid)
  );

  if (!outcome.ok) {
    console.error("ABORTADO — nada foi excluído: " + outcome.reason);
    return EXIT_FAILURE;
  }

  console.log("=".repeat(68));
  console.log("APLICADO: 1 conta órfã de Auth excluída.");
  console.log("Nenhum documento do Firestore foi criado, alterado ou removido.");
  console.log("=".repeat(68));
  return EXIT_OK;
}

/**
 * Reads the full Auth + Firestore snapshot.
 *
 * READ-ONLY over Firestore: only `.get()` / paged scans. The only Auth call is
 * `listUsers`, which is a read.
 */
async function readSnapshot(
  db: FirebaseFirestore.Firestore,
  auth: import("firebase-admin").auth.Auth,
  documentId: unknown
): Promise<AuthSnapshot> {
  // --- Auth accounts (paged). -----------------------------------------------
  const accounts: AuthAccount[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      accounts.push({
        uid: user.uid,
        createdAt: user.metadata.creationTime ?? "",
        lastSignInAt: user.metadata.lastSignInTime ?? "",
      });
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // --- Firestore footprint. -------------------------------------------------
  const [usersSnap, walletsSnap] = await Promise.all([
    db.collection("users").get(),
    db.collection("wallets").get(),
  ]);

  const userUids = new Set(usersSnap.docs.map((doc) => doc.id));
  const walletUids = new Set(walletsSnap.docs.map((doc) => doc.id));

  const firestoreStamps: DocumentStamp[] = [];
  for (const doc of usersSnap.docs) {
    firestoreStamps.push({
      path: `users/${doc.id}`,
      updateTime: doc.updateTime?.toDate().toISOString() ?? "",
    });
  }
  for (const doc of walletsSnap.docs) {
    firestoreStamps.push({
      path: `wallets/${doc.id}`,
      updateTime: doc.updateTime?.toDate().toISOString() ?? "",
    });
  }

  // Any financial document referencing a uid via user_ref -> users/{uid}.
  const financiallyReferencedUids = new Set<string>();
  for (const collection of FINANCIAL_COLLECTIONS) {
    await scanCollection(
      db.collection(collection) as unknown as ReadOnlyQuery,
      { orderByField: documentId },
      (id, data) => {
        const ref = data.user_ref as { path?: string } | undefined;
        if (ref?.path && ref.path.startsWith("users/")) {
          financiallyReferencedUids.add(ref.path.slice("users/".length));
        }
        firestoreStamps.push({ path: `${collection}/${id}`, updateTime: "" });
      }
    );
  }

  return {
    accounts,
    userUids,
    walletUids,
    financiallyReferencedUids,
    firestoreStamps,
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
