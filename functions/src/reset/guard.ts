/**
 * Safety guard for the test-financial reset.
 *
 * This tool DELETES every ledger document and overwrites every wallet, so it is
 * the most dangerous thing in this repository. It is guarded accordingly: five
 * independent signals, all required at once, one of which (the fingerprint) can
 * only be obtained by actually running the dry run first.
 *
 * Pure — no Firebase import here — so every refusal path is unit-tested without
 * a network, credentials or an emulator.
 */

/** The only project this tool will ever write to. Never read from .firebaserc. */
export const PRODUCTION_PROJECT_ID = "sparta-battle";

export const APPLY_FLAG = "--apply";
export const CONFIRM_RESET_FLAG = "--confirm-reset-all-test-financial-data";
export const CONFIRMATION_FLAG = "--confirmation";
export const CONFIRMATION_PHRASE = "RESET_ALL_CURRENT_TEST_FINANCIAL_DATA";
export const FINGERPRINT_FLAG = "--expected-fingerprint";

export interface ResetArgs {
  readonly project?: string;
  readonly apply: boolean;
  readonly confirmReset: boolean;
  readonly confirmation?: string;
  readonly expectedFingerprint?: string;
  readonly help: boolean;
}

export type ResetMode = "dry-run" | "apply";

export type ResetDecision =
  | { readonly allowed: true; readonly mode: "dry-run" }
  | {
      readonly allowed: true;
      readonly mode: "apply";
      readonly expectedFingerprint: string;
    }
  | {
      readonly allowed: false;
      readonly reason: RefusalReason;
      readonly message: string;
    };

export type RefusalReason =
  | "missing-project"
  | "wrong-project"
  | "missing-apply-flag"
  | "missing-reset-confirmation"
  | "missing-confirmation-phrase"
  | "wrong-confirmation-phrase"
  | "missing-fingerprint"
  | "malformed-fingerprint"
  | "ids-not-accepted";

/** A SHA-256 hex digest: exactly 64 lowercase hex characters. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Parses argv. Document ids are deliberately NOT parseable — there is no
 * `--wallet-id` and never will be. Targets come from enumeration, never argv.
 */
export function parseArgs(argv: readonly string[]): ResetArgs {
  let project: string | undefined;
  let apply = false;
  let confirmReset = false;
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
    } else if (arg === CONFIRM_RESET_FLAG) {
      confirmReset = true;
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

  return {
    project,
    apply,
    confirmReset,
    confirmation,
    expectedFingerprint,
    help,
  };
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

export function decide(
  args: ResetArgs,
  argv: readonly string[] = []
): ResetDecision {
  if (containsIdArgument(argv)) {
    return {
      allowed: false,
      reason: "ids-not-accepted",
      message:
        "IDs de documento não são aceitos. Os alvos são enumerados do Firestore.",
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
    args.confirmReset ||
    args.confirmation !== undefined ||
    args.expectedFingerprint !== undefined;

  if (!reachingForWrite) {
    return { allowed: true, mode: "dry-run" };
  }

  // From here the operator is reaching for the write path, so EVERY signal must
  // be present. A partially-confirmed apply is refused outright rather than
  // silently downgraded to a dry run — a half-typed command must never look like
  // it "worked".
  if (!args.apply) {
    return {
      allowed: false,
      reason: "missing-apply-flag",
      message: `Escrita exige ${APPLY_FLAG}.`,
    };
  }

  if (!args.confirmReset) {
    return {
      allowed: false,
      reason: "missing-reset-confirmation",
      message: `Escrita exige ${CONFIRM_RESET_FLAG}.`,
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
      message: `A frase precisa ser exatamente ${CONFIRMATION_PHRASE}.`,
    };
  }

  if (args.expectedFingerprint === undefined) {
    return {
      allowed: false,
      reason: "missing-fingerprint",
      message:
        `Escrita exige ${FINGERPRINT_FLAG} <fingerprint>. ` +
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

  return {
    allowed: true,
    mode: "apply",
    expectedFingerprint: args.expectedFingerprint,
  };
}
