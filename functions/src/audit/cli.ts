import {
  DEFAULT_PAGE_SIZE,
  ReadOnlyQuery,
  scanCollection,
} from "./collector.js";
import {
  decide,
  parseArgs,
  PRODUCTION_CONFIRM_FLAG,
  PRODUCTION_PROJECT_ID,
} from "./guard.js";
import {
  EXIT_FAILURE,
  exitCodeFor,
  renderReport,
  summarize,
} from "./report.js";
import { auditTournamentDocument, TournamentFinding } from "./tournamentAudit.js";
import { auditWalletDocument, WalletFinding } from "./walletAudit.js";

/**
 * Entry point for the read-only data audit.
 *
 * ORDER OF OPERATIONS IS THE SAFETY PROPERTY: the guard runs and must approve
 * BEFORE `firebase-admin` is even imported. The import is dynamic for exactly
 * this reason — a refused run never loads the SDK, never resolves credentials,
 * and never opens a connection. There is no code path where a missing flag
 * still ends up initializing production Firestore.
 *
 * This tool only ever calls `.get()`. It cannot write: see `collector.ts`.
 */

const USAGE = `
Auditoria de dados — SOMENTE LEITURA. Nunca escreve, migra ou corrige.

Uso:
  # Contra o emulador local (seguro, padrão para desenvolvimento):
  firebase emulators:exec --project demo-sparta-battle --only firestore \\
    "node lib/audit/cli.js --project demo-sparta-battle"

  # Contra produção — exige confirmação explícita:
  node lib/audit/cli.js --project ${PRODUCTION_PROJECT_ID} ${PRODUCTION_CONFIRM_FLAG}

Opções:
  --project <id>                          Obrigatório. Nunca usa o .firebaserc.
  ${PRODUCTION_CONFIRM_FLAG}   Obrigatório para ler produção.
  --show-ids                              Lista ids dos documentos afetados.
                                          NÃO commite essa saída.
  --help                                  Mostra esta ajuda.

Códigos de saída:
  0  auditoria executada, nenhuma anomalia
  2  auditoria executada, anomalias encontradas
  1  falha operacional ou configuração insegura
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return EXIT_FAILURE;
  }

  const decision = decide(args, {
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
  });

  if (!decision.allowed) {
    console.error("RECUSADO: " + decision.message);
    console.error(USAGE);
    // Unsafe configuration is a failure, never a clean exit. A caller must not
    // be able to mistake "I refused to run" for "the data is fine".
    return EXIT_FAILURE;
  }

  // Only now — after the guard approved — is the SDK loaded. The import is
  // dynamic precisely so that a refused run never touches firebase-admin.
  //
  // The `.default ?? module` dance is required because this compiles to
  // CommonJS: a dynamic import of a CJS package hands back a namespace wrapper
  // whose real module sits under `default`. TypeScript's types describe the
  // module itself, not the wrapper, so this goes through `unknown` — reaching
  // straight for `initializeApp` type-checks but throws at runtime.
  type AdminModule = typeof import("firebase-admin");
  const imported = (await import("firebase-admin")) as unknown as AdminModule & {
    default?: AdminModule;
  };
  const admin = imported.default ?? imported;

  admin.initializeApp({ projectId: args.project });
  const db = admin.firestore();
  const documentId = admin.firestore.FieldPath.documentId();

  console.error(
    `Lendo (somente leitura) o projeto "${args.project}" ` +
      `[${decision.target}], ${DEFAULT_PAGE_SIZE} documentos por página...`
  );

  const walletFindings: WalletFinding[] = [];
  const tournamentFindings: TournamentFinding[] = [];

  const walletsScanned = await scanCollection(
    db.collection("wallets") as unknown as ReadOnlyQuery,
    { orderByField: documentId },
    (id, data) => {
      const finding = auditWalletDocument(id, data);
      if (finding) walletFindings.push(finding);
    }
  );

  const tournamentsScanned = await scanCollection(
    db.collection("tournaments") as unknown as ReadOnlyQuery,
    { orderByField: documentId },
    (id, data) => {
      tournamentFindings.push(auditTournamentDocument(id, data));
    }
  );

  const summary = summarize(
    walletsScanned,
    walletFindings,
    tournamentsScanned,
    tournamentFindings
  );

  console.log(
    renderReport(summary, {
      showIds: args.showIds,
      target: `${args.project} (${decision.target})`,
    })
  );

  return exitCodeFor(summary);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Any unexpected failure is exit 1 — an operational failure must never be
    // reported as "no anomalies found".
    console.error("FALHA na auditoria:", error);
    process.exitCode = EXIT_FAILURE;
  });
