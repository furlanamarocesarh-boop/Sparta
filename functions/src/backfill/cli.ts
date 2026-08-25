import {
  APPLY_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  CONFIRM_FLAG,
  decide,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "./guard.js";
import {
  AccountState,
  BackfillTally,
  decideBackfill,
  emptyTally,
  EXIT_FAILURE,
  EXIT_OK,
  renderReport,
  tally,
} from "./plan.js";

/**
 * Local, guarded, NON-DEPLOYABLE tool that fills `users/{uid}.created_at`.
 *
 * WHY IT EXISTS. The public profile shows "Desde agosto de 2026" from that
 * field, and nothing in this backend wrote it until the fix in `onUserCreated`.
 * Every account created before that fix therefore has no start date, and their
 * profile silently omits the line.
 *
 * THE DATE IS TRANSCRIBED FROM FIREBASE AUTH, never inferred. `creationTime` is
 * the moment the account was created, recorded by Auth as it happened. This is
 * the one source that holds the same fact the field is supposed to hold.
 *
 * SAFETY MODEL:
 *  - The guard runs and must approve BEFORE firebase-admin is even imported.
 *    The import is dynamic for exactly that reason: a refused or help run never
 *    loads the SDK, resolves credentials, or opens a connection.
 *  - Dry-run is the default and only ever reads.
 *  - The ONE write in this file is inside a transaction that RE-READS the
 *    document and writes only when `created_at` is still absent. Overwriting is
 *    therefore impossible even under a concurrent signup, not merely unlikely.
 *  - The sweep cannot be narrowed: `--uid`, `--email`, `--date` and friends are
 *    refused, so this can never become a single-document editor.
 *  - Output is anonymized: counts only, never a uid, an e-mail or one account's
 *    date.
 *
 * This file is NOT exported by index.ts, imports no firebase-functions, declares
 * no onCall/onRequest, and its compiled output (lib/backfill) is excluded from
 * the deploy package in firebase.json. It cannot become an endpoint.
 */

const USAGE = `
Backfill de created_at — LOCAL, PROTEGIDO, NÃO IMPLANTÁVEL.

Preenche users/{uid}.created_at nas contas que não têm o campo, com o instante
real do cadastro registrado pelo Firebase Auth (metadata.creationTime).
NUNCA sobrescreve uma data existente. Dry-run por padrão.

Uso:
  # Dry-run (somente leitura) contra produção:
  npm run backfill:createdat -- --project ${PRODUCTION_PROJECT_ID}

  # Aplicar — exige TODAS as confirmações ao mesmo tempo:
  npm run backfill:createdat -- --project ${PRODUCTION_PROJECT_ID} ${APPLY_FLAG} \\
    ${CONFIRM_FLAG} \\
    ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}

Rodar duas vezes é inofensivo: a segunda vez não escreve nada.

Códigos de saída:
  0  dry-run concluído, ou aplicação concluída
  1  recusado, ou falha operacional
`;

/** A non-leaking error label: the error code only, never the raw error. */
function safeCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "erro-desconhecido";
}

type AdminModule = typeof import("firebase-admin");

/**
 * Loads the Admin SDK, unwrapping the CommonJS interop shape.
 *
 * `await import()` of a CJS module yields a namespace whose `default` holds the
 * real module, so reading `.apps` off the namespace itself finds nothing. Same
 * unwrapping as `adminclaim/cli.ts`, for the same reason.
 */
async function loadAdmin(): Promise<AdminModule> {
  const imported = (await import("firebase-admin")) as unknown as AdminModule & {
    default?: AdminModule;
  };
  return imported.default ?? imported;
}

/** How many Auth records one page pulls. Auth's own maximum. */
const PAGE_SIZE = 1000;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  const decision = decide(args, {
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    authEmulatorHost: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  });
  if (!decision.allowed) {
    console.error(`RECUSADO (${decision.reason}): ${decision.message}`);
    console.error(USAGE);
    return EXIT_FAILURE;
  }

  const applying = decision.mode === "apply";

  // Only now — after the guard approved — does the SDK enter the process.
  const admin = await loadAdmin();
  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: PRODUCTION_PROJECT_ID });
  }
  const db = admin.firestore();
  const auth = admin.auth();

  const now = new Date();
  const totals: BackfillTally = emptyTally();

  let pageToken: string | undefined;
  try {
    do {
      const page = await auth.listUsers(PAGE_SIZE, pageToken);

      for (const record of page.users) {
        const ref = db.collection("users").doc(record.uid);
        const snap = await ref.get();

        const state: AccountState = {
          authCreationTime: record.metadata?.creationTime,
          userDocumentExists: snap.exists,
          storedCreatedAt: snap.exists ? snap.get("created_at") : undefined,
        };

        const plan = decideBackfill(state, now);
        tally(totals, plan);

        if (plan.kind !== "write" || !applying) continue;

        /**
         * THE ONLY WRITE IN THIS TOOL.
         *
         * The re-read inside the transaction is what makes overwriting
         * structurally impossible rather than merely unlikely: between the read
         * above and this write, `onUserCreated` could have stamped the field on
         * a brand-new account, and that value is more precise than anything
         * reconstructed here. Seeing it, this aborts.
         */
        await db.runTransaction(async (transaction) => {
          const fresh = await transaction.get(ref);
          if (!fresh.exists) return;
          const current = fresh.get("created_at");
          if (current !== undefined && current !== null) return;

          transaction.update(ref, {
            created_at: admin.firestore.Timestamp.fromDate(plan.value),
          });
        });
      }

      pageToken = page.pageToken;
    } while (pageToken);
  } catch (error) {
    console.error(`FALHA OPERACIONAL (${safeCode(error)})`);
    console.error(renderReport(totals, applying));
    return EXIT_FAILURE;
  }

  console.log(renderReport(totals, applying));

  if (!applying && totals.written > 0) {
    console.log(
      "Para gravar, repita com:\n" +
        `  npm run backfill:createdat -- --project ${PRODUCTION_PROJECT_ID} ` +
        `${APPLY_FLAG} ${CONFIRM_FLAG} ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}\n`
    );
  }

  return EXIT_OK;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    /**
     * This catch only ever sees SETUP failures — the guard, the dynamic import,
     * credentials. Per-account errors are caught inside the sweep and reported
     * as a code alone. So the message is printed here: it carries no account
     * data, and swallowing it turns a tooling bug into "erro-desconhecido",
     * which is exactly what happened the first time this ran.
     */
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`FALHA INESPERADA (${safeCode(error)}) — ${detail}`);
    process.exitCode = EXIT_FAILURE;
  });
