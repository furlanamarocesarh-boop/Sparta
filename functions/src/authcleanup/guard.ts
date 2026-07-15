/**
 * Safety guard for the orphan-auth cleanup.
 *
 * Deletes a Firebase Auth account, which is irreversible, so it is guarded like
 * the financial reset: five independent signals, all required at once, one of
 * which (the fingerprint) can only be obtained by running the dry run first.
 *
 * Pure — no Firebase import — so every refusal path is unit-tested without a
 * network or credentials.
 */

export const PRODUCTION_PROJECT_ID = "sparta-battle";

export const APPLY_FLAG = "--apply";
export const CONFIRM_DELETE_FLAG = "--confirm-delete-orphan-test-auth";
export const CONFIRMATION_FLAG = "--confirmation";
export const CONFIRMATION_PHRASE = "DELETE_SINGLE_ORPHAN_TEST_AUTH";
export const FINGERPRINT_FLAG = "--expected-fingerprint";

export interface AuthCleanupArgs {
  readonly project?: string;
  readonly apply: boolean;
  readonly confirmDelete: boolean;
  readonly confirmation?: string;
  readonly expectedFingerprint?: string;
  readonly help: boolean;
}

export type AuthCleanupDecision =
  | { readonly allowed: true; readonly mode: "dry-run" }
  | {
      readonly allowed: true;
      readonly mode: "apply";
      readonly expectedFingerprint: string;
    }
  | { readonly allowed: false; readonly reason: RefusalReason; readonly message: string };

export type RefusalReason =
  | "missing-project"
  | "wrong-project"
  | "missing-apply-flag"
  | "missing-delete-confirmation"
  | "missing-confirmation-phrase"
  | "wrong-confirmation-phrase"
  | "missing-fingerprint"
  | "malformed-fingerprint"
  | "identifier-not-accepted";

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parses argv. A UID or e-mail is deliberately NOT parseable — there is no
 * `--uid` and no `--email`. The target is found by detection, never supplied.
 */
export function parseArgs(argv: readonly string[]): AuthCleanupArgs {
  let project: string | undefined;
  let apply = false;
  let confirmDelete = false;
  let confirmation: string | undefined;
  let expectedFingerprint: string | undefined;
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
    } else if (arg === FINGERPRINT_FLAG) {
      expectedFingerprint = argv[i + 1];
      i++;
    } else if (arg.startsWith(`${FINGERPRINT_FLAG}=`)) {
      expectedFingerprint = arg.slice(FINGERPRINT_FLAG.length + 1);
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { project, apply, confirmDelete, confirmation, expectedFingerprint, help };
}

/** True when argv tries to hand us an identifier. Always refused. */
export function containsIdentifierArgument(argv: readonly string[]): boolean {
  return argv.some(
    (arg) =>
      arg.startsWith("--uid") ||
      arg.startsWith("--email") ||
      arg.startsWith("--e-mail") ||
      arg.startsWith("--user") ||
      arg.startsWith("--id")
  );
}

export function decide(
  args: AuthCleanupArgs,
  argv: readonly string[] = []
): AuthCleanupDecision {
  if (containsIdentifierArgument(argv)) {
    return {
      allowed: false,
      reason: "identifier-not-accepted",
      message:
        "UID ou e-mail não são aceitos. A conta órfã é detectada, nunca informada.",
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

  const reachingForWrite =
    args.apply ||
    args.confirmDelete ||
    args.confirmation !== undefined ||
    args.expectedFingerprint !== undefined;

  if (!reachingForWrite) {
    return { allowed: true, mode: "dry-run" };
  }

  if (!args.apply) {
    return {
      allowed: false,
      reason: "missing-apply-flag",
      message: `Exclusão exige ${APPLY_FLAG}.`,
    };
  }

  if (!args.confirmDelete) {
    return {
      allowed: false,
      reason: "missing-delete-confirmation",
      message: `Exclusão exige ${CONFIRM_DELETE_FLAG}.`,
    };
  }

  if (args.confirmation === undefined) {
    return {
      allowed: false,
      reason: "missing-confirmation-phrase",
      message: `Exclusão exige ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}.`,
    };
  }

  if (args.confirmation !== CONFIRMATION_PHRASE) {
    return {
      allowed: false,
      reason: "wrong-confirmation-phrase",
      message: `A frase precisa ser exatamente ${CONFIRMATION_PHRASE}.`,
    };
  }

  if (args.expectedFingerprint === undefined) {
    return {
      allowed: false,
      reason: "missing-fingerprint",
      message:
        `Exclusão exige ${FINGERPRINT_FLAG} <fingerprint>. ` +
        "Rode o dry-run primeiro para obtê-lo.",
    };
  }

  if (!FINGERPRINT_PATTERN.test(args.expectedFingerprint)) {
    return {
      allowed: false,
      reason: "malformed-fingerprint",
      message: "O fingerprint precisa ser um SHA-256 (64 caracteres hex).",
    };
  }

  return { allowed: true, mode: "apply", expectedFingerprint: args.expectedFingerprint };
}
