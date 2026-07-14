/**
 * Safety guard for the test-data cleanup.
 *
 * This tool DELETES and OVERWRITES documents, so it is guarded harder than the
 * read-only auditor. It is a pure function — no Firebase import in this file —
 * so every refusal path is unit-tested without a network or credentials.
 *
 * Default posture: DRY RUN. Writing requires four independent, explicit signals
 * at once. Any one of them missing means dry run; a wrong project means refuse
 * outright, before anything is initialized.
 */

/** The only project this tool will ever write to. Never read from .firebaserc. */
export const PRODUCTION_PROJECT_ID = "sparta-battle";

export const APPLY_FLAG = "--apply";
export const CONFIRM_DELETE_FLAG = "--confirm-delete-test-data";
export const CONFIRMATION_FLAG = "--confirmation";
/** Must be typed out in full. Deliberately unmistakable. */
export const CONFIRMATION_PHRASE = "ALL_CURRENT_DATA_IS_TEST";

export interface CleanupArgs {
  readonly project?: string;
  readonly apply: boolean;
  readonly confirmDelete: boolean;
  readonly confirmation?: string;
  readonly help: boolean;
}

export type CleanupMode = "dry-run" | "apply";

export type CleanupDecision =
  | { readonly allowed: true; readonly mode: CleanupMode }
  | { readonly allowed: false; readonly reason: RefusalReason; readonly message: string };

export type RefusalReason =
  | "missing-project"
  | "wrong-project"
  | "missing-apply-flag"
  | "missing-delete-confirmation"
  | "missing-confirmation-phrase"
  | "wrong-confirmation-phrase"
  | "ids-not-accepted";

/**
 * Parses argv. NOTE: document ids are deliberately NOT parseable — there is no
 * `--wallet-id` and never will be. A mistyped id is exactly how the wrong wallet
 * gets deleted; targets are found by signature only.
 */
export function parseArgs(argv: readonly string[]): CleanupArgs {
  let project: string | undefined;
  let apply = false;
  let confirmDelete = false;
  let confirmation: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--project") {
      project = argv[i + 1];
      i++;
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
    } else if (arg === APPLY_FLAG) {
      apply = true;
    } else if (arg === CONFIRM_DELETE_FLAG) {
      confirmDelete = true;
    } else if (arg === CONFIRMATION_FLAG) {
      confirmation = argv[i + 1];
      i++;
    } else if (arg.startsWith("--confirmation=")) {
      confirmation = arg.slice("--confirmation=".length);
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { project, apply, confirmDelete, confirmation, help };
}

/** True when argv tries to hand us a document id. Always refused. */
export function containsIdArgument(argv: readonly string[]): boolean {
  return argv.some(
    (arg) =>
      arg.startsWith("--wallet-id") ||
      arg.startsWith("--uid") ||
      arg.startsWith("--doc") ||
      arg.startsWith("--id")
  );
}

/**
 * Decides whether to run, and in which mode.
 *
 * The project is validated FIRST and unconditionally — even a dry run refuses
 * to point at anything other than the real project, so this tool can never be
 * aimed at an unexpected database by accident.
 */
export function decide(
  args: CleanupArgs,
  argv: readonly string[] = []
): CleanupDecision {
  if (containsIdArgument(argv)) {
    return {
      allowed: false,
      reason: "ids-not-accepted",
      message:
        "IDs de documento não são aceitos. Os alvos são localizados apenas " +
        "pela assinatura exata verificada pela auditoria.",
    };
  }

  if (!args.project) {
    return {
      allowed: false,
      reason: "missing-project",
      message:
        "Nenhum projeto informado. Esta ferramenta nunca usa o projeto padrão " +
        "do .firebaserc. Informe --project explicitamente.",
    };
  }

  if (args.project !== PRODUCTION_PROJECT_ID) {
    return {
      allowed: false,
      reason: "wrong-project",
      message: `Projeto "${args.project}" não é "${PRODUCTION_PROJECT_ID}".`,
    };
  }

  // Not asking to write: a dry run. This is the default, and it is safe.
  if (!args.apply && !args.confirmDelete && args.confirmation === undefined) {
    return { allowed: true, mode: "dry-run" };
  }

  // From here on the operator is reaching for the write path, so EVERY signal
  // must be present. A partially-confirmed apply is refused outright rather than
  // silently downgraded to a dry run — a half-typed command must not look like
  // it "worked".
  if (!args.apply) {
    return {
      allowed: false,
      reason: "missing-apply-flag",
      message: `Escrita exige ${APPLY_FLAG}.`,
    };
  }

  if (!args.confirmDelete) {
    return {
      allowed: false,
      reason: "missing-delete-confirmation",
      message: `Escrita exige ${CONFIRM_DELETE_FLAG}.`,
    };
  }

  if (args.confirmation === undefined) {
    return {
      allowed: false,
      reason: "missing-confirmation-phrase",
      message: `Escrita exige ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}.`,
    };
  }

  if (args.confirmation !== CONFIRMATION_PHRASE) {
    return {
      allowed: false,
      reason: "wrong-confirmation-phrase",
      message: `A frase de confirmação precisa ser exatamente ${CONFIRMATION_PHRASE}.`,
    };
  }

  return { allowed: true, mode: "apply" };
}
