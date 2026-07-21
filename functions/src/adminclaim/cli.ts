import { LEGACY_ADMIN_UID } from "../domain/adminAuth.js";
import { computeFingerprint } from "./fingerprint.js";
import {
  APPLY_FLAG,
  CONFIRM_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  decide,
  EXPECTED_FINGERPRINT_FLAG,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "./guard.js";
import {
  AdminClaimState,
  decideApply,
  EXIT_FAILURE,
  EXIT_OK,
  exitCodeForPlan,
  planAdminClaim,
  renderApplyDecision,
  renderDryRun,
  renderWriteSuccess,
} from "./plan.js";

/**
 * Local, guarded, NON-DEPLOYABLE tool that assigns the `admin: true` custom claim
 * to the legacy administrator — stage 1 of docs/admin-transition.md.
 *
 * SAFETY MODEL:
 *  - The guard runs and must approve BEFORE firebase-admin is even imported. The
 *    import is dynamic for exactly this reason: a refused or help run never loads
 *    the SDK, resolves credentials, or opens a connection.
 *  - The target is ALWAYS LEGACY_ADMIN_UID from the central module. It cannot be
 *    passed by argument.
 *  - Dry-run is the default and only ever reads (Auth + `users`/`wallets` docs).
 *  - The ONLY possible write in the entire file is a single setCustomUserClaims,
 *    reached only in --apply, only after every confirmation, only after a fresh
 *    re-read whose fingerprint matches what the operator confirmed. Tokens are
 *    never revoked; no Firestore document is ever written.
 *  - Output is anonymized: no uid, email, token, or full claims are ever printed.
 *
 * This file is NOT exported by index.ts, imports no firebase-functions, declares
 * no onCall/onRequest, and its compiled output (lib/adminclaim) is excluded from
 * the deploy package in firebase.json. It cannot become an endpoint.
 */

const USAGE = `
Transição de admin claim — LOCAL, PROTEGIDA, NÃO IMPLANTÁVEL.
Adiciona a custom claim admin: true ao administrador legado (fase 1 de
docs/admin-transition.md). Dry-run por padrão; NUNCA escreve sem confirmação.

O alvo é sempre o administrador legado do módulo central. NÃO existe --uid /
--email / --id: informar qualquer um deles é recusado.

Uso:
  # Dry-run (somente leitura) contra produção:
  npm run admin:claim -- --project ${PRODUCTION_PROJECT_ID}

  # Apply (fase futura) — exige TODAS as confirmações ao mesmo tempo:
  npm run admin:claim -- --project ${PRODUCTION_PROJECT_ID} ${APPLY_FLAG} \\
    ${CONFIRM_FLAG} \\
    ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE} \\
    ${EXPECTED_FINGERPRINT_FLAG} <hash-do-dry-run>

Códigos de saída:
  0  dry-run concluído, ou apply concluído/no-op
  1  recusado, pré-condição não satisfeita, ou falha operacional
`;

/** A non-leaking error label: the error code only, never the raw error. */
function safeCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "erro-desconhecido";
}

function isUserNotFound(error: unknown): boolean {
  return safeCode(error) === "auth/user-not-found";
}

type AdminModule = typeof import("firebase-admin");

async function loadAdmin(): Promise<AdminModule> {
  // Dynamic import of a CJS package hands back a namespace wrapper whose real
  // module sits under `default` (same dance as audit/cli.ts).
  const imported = (await import("firebase-admin")) as unknown as AdminModule & {
    default?: AdminModule;
  };
  return imported.default ?? imported;
}

/** Reads the target's live state. Read-only: getUser + two document `.get()`s. */
async function readState(
  admin: AdminModule,
  uid: string
): Promise<{ state: AdminClaimState; fingerprint: string }> {
  const auth = admin.auth();
  const db = admin.firestore();

  let userExists = true;
  let disabled = false;
  let customClaims: Record<string, unknown> | undefined;

  try {
    const record = await auth.getUser(uid);
    disabled = record.disabled === true;
    customClaims = record.customClaims as Record<string, unknown> | undefined;
  } catch (error) {
    if (isUserNotFound(error)) {
      userExists = false;
    } else {
      throw error;
    }
  }

  const userDocExists = (await db.doc(`users/${uid}`).get()).exists;
  const walletDocExists = (await db.doc(`wallets/${uid}`).get()).exists;

  const state: AdminClaimState = {
    userExists,
    disabled,
    customClaims,
    userDocExists,
    walletDocExists,
  };
  const fingerprint = computeFingerprint({ uid, disabled, customClaims });
  return { state, fingerprint };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return EXIT_FAILURE;
  }

  const decision = decide(args);
  if (!decision.allowed) {
    console.error("RECUSADO: " + decision.message);
    console.error(USAGE);
    // An unsafe configuration is a failure, never a clean exit.
    return EXIT_FAILURE;
  }

  const admin = await loadAdmin();
  admin.initializeApp({ projectId: PRODUCTION_PROJECT_ID });

  const uid = LEGACY_ADMIN_UID;

  if (decision.mode === "dry-run") {
    const { state, fingerprint } = await readState(admin, uid);
    const plan = planAdminClaim(state);
    console.log(renderDryRun({ fingerprint, state, plan }));
    return exitCodeForPlan(plan);
  }

  // --- apply --------------------------------------------------------------
  // Re-read the account IMMEDIATELY before the write and recompute the
  // fingerprint. Any divergence from what the operator confirmed aborts.
  const { state, fingerprint } = await readState(admin, uid);
  const freshPlan = planAdminClaim(state);
  const outcome = decideApply(decision.expectedFingerprint, fingerprint, freshPlan);

  if (outcome.kind === "abort") {
    console.error(renderApplyDecision(outcome));
    return EXIT_FAILURE;
  }
  if (outcome.kind === "noop") {
    console.log(renderApplyDecision(outcome));
    return EXIT_OK;
  }

  // The single possible write in this tool. It preserves existing claims and
  // only sets admin: true. It NEVER revokes refresh tokens.
  try {
    await admin.auth().setCustomUserClaims(uid, outcome.nextClaims);
  } catch (error) {
    console.error(
      "FALHA ao atribuir a claim (" +
        safeCode(error) +
        "). Nenhuma garantia de escrita; trate como não aplicado."
    );
    return EXIT_FAILURE;
  }

  console.log(renderWriteSuccess(outcome.nextClaims));
  return EXIT_OK;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Any unexpected failure is exit 1 — never a clean exit. Only the error code
    // is printed, never the raw error, which could carry the uid or an email.
    console.error("FALHA na transição de admin claim (" + safeCode(error) + ").");
    process.exitCode = EXIT_FAILURE;
  });
