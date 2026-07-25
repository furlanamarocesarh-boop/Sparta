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
import { inspectReais, MAX_BALANCE_CENTAVOS } from "../domain/money.js";
import {
  reconcileWallet,
  ReconciliationResult,
  TransactionRecord,
  UserRefStatus,
} from "./reconcile.js";
import {
  anonymousLabel,
  reconciliationExitCode,
  renderReconciliation,
} from "./reconcileReport.js";
import {
  EXIT_FAILURE,
  exitCodeFor,
  renderReport,
  summarize,
} from "./report.js";
import { auditTournamentDocument, TournamentFinding } from "./tournamentAudit.js";
import {
  auditWalletDocument,
  WalletField,
  WALLET_MONEY_FIELDS,
  WalletFinding,
} from "./walletAudit.js";

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

  // --- Reconciliation mode --------------------------------------------------
  //
  // Only wallets with MISSING monetary fields are reconciled. Ids are used here,
  // internally, purely to correlate a wallet with its user and its related
  // documents — and they are dropped before anything is rendered. The report
  // layer only ever sees "Wallet A".
  if (args.reconcile) {
    const results: ReconciliationResult[] = [];

    for (const [index, finding] of walletFindings.entries()) {
      // Optional fields (beta_balance) never produce "missing", so this keeps
      // its original WalletField domain; the guard makes that explicit.
      const missingFields = finding.issues
        .filter(
          (issue): issue is { field: WalletField; problem: "missing" } =>
            issue.problem === "missing" &&
            (WALLET_MONEY_FIELDS as readonly string[]).includes(issue.field)
        )
        .map((issue) => issue.field);

      // Only missing-field wallets are in scope for this step.
      if (missingFields.length === 0) continue;

      const walletId = finding.id;
      const userRefPath = `users/${walletId}`;
      const userRef = db.doc(userRefPath);

      const walletSnap = await db.doc(`wallets/${walletId}`).get();
      const walletData = walletSnap.data() ?? {};

      const userSnap = await userRef.get();

      // user_ref must exist AND point at this wallet's own owner. The REASON it
      // fails is captured too — an absent ref is a very different problem from
      // one pointing at another user — but the offending path is never carried
      // out of this scope.
      const storedUserRef = walletData.user_ref as { path?: string } | undefined;

      let userRefStatus: UserRefStatus;
      if (storedUserRef === undefined || storedUserRef === null) {
        userRefStatus = "missing";
      } else if (typeof storedUserRef.path !== "string") {
        userRefStatus = "not-a-reference";
      } else if (storedUserRef.path !== userRefPath) {
        userRefStatus = "points-elsewhere";
      } else {
        userRefStatus = "valid";
      }
      const userRefValid = userRefStatus === "valid";

      const presentCentavos: Partial<Record<WalletField, number | null>> = {};
      for (const field of WALLET_MONEY_FIELDS) {
        if (missingFields.includes(field)) continue;
        const inspection = inspectReais(walletData[field], {
          allowZero: true,
          maxCentavos: MAX_BALANCE_CENTAVOS,
        });
        presentCentavos[field] = inspection.ok ? inspection.centavos : null;
      }

      // The `.path` of a stored DocumentReference, or null for anything else.
      const refPath = (value: unknown): string | null => {
        const path = (value as { path?: unknown } | null | undefined)?.path;
        return typeof path === "string" ? path : null;
      };

      const transactions: TransactionRecord[] = [];
      await scanCollection(
        db
          .collection("transactions")
          .where("user_ref", "==", userRef) as unknown as ReadOnlyQuery,
        { orderByField: documentId },
        (txId, data) => {
          transactions.push({
            category: data.category,
            status: data.status,
            amount: data.amount,
            path: `transactions/${txId}`,
            economyType: data.economy_type,
            tournamentRefPath: refPath(data.tournament_ref),
            registrationRefPath: refPath(data.registration_ref),
            entryTransactionRefPath: refPath(data.entry_transaction_ref),
            hasCashStamps:
              data.previous_balance !== undefined ||
              data.balance_after !== undefined,
            hasBetaStamps:
              data.beta_previous_balance !== undefined ||
              data.beta_balance_after !== undefined,
          });
        }
      );

      const withdrawalStatuses: string[] = [];
      await scanCollection(
        db
          .collection("withdrawals")
          .where("user_ref", "==", userRef) as unknown as ReadOnlyQuery,
        { orderByField: documentId },
        (_id, data) => {
          withdrawalStatuses.push(
            typeof data.status === "string" ? data.status : "(inválido)"
          );
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

      // beta_balance: absence is legal (reads as zero); when present its value
      // is inspected like any stored money field.
      const betaBalancePresent = walletData.beta_balance !== undefined;
      let betaBalanceCentavos: number | null = null;
      if (betaBalancePresent) {
        const inspection = inspectReais(walletData.beta_balance, {
          allowZero: true,
          maxCentavos: MAX_BALANCE_CENTAVOS,
        });
        betaBalanceCentavos = inspection.ok ? inspection.centavos : null;
      }

      results.push(
        reconcileWallet(anonymousLabel(index), {
          missingFields,
          presentCentavos,
          userDocExists: userSnap.exists,
          userRefValid,
          userRefStatus,
          betaBalancePresent,
          betaBalanceCentavos,
          related: { transactions, withdrawalStatuses, registrationCount },
        })
      );
    }

    console.log(renderReconciliation(results));
    return reconciliationExitCode(results);
  }

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
