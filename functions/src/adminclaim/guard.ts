/**
 * Safety guard for the admin-claim transition tool.
 *
 * PURE on purpose — there is no firebase import anywhere in this file — so every
 * refusal path is unit tested without a network, credentials, or the Admin SDK.
 * The cli runs this guard and must get `allowed: true` BEFORE it ever loads
 * firebase-admin.
 *
 * Default posture: DRY-RUN, and REFUSE anything unsafe. A write to production
 * Auth is only reachable when the operator names the exact project AND passes
 * every confirmation flag AND an expected fingerprint. Nothing is implicit, and
 * the target UID can NEVER come from an argument — it is always LEGACY_ADMIN_UID
 * from the central module.
 */

/** The one project this tool may ever touch. Never a default, never inferred. */
export const PRODUCTION_PROJECT_ID = "sparta-battle";

/** Explicit opt-ins required to leave dry-run and actually write. Verbose on purpose. */
export const APPLY_FLAG = "--apply";
export const CONFIRM_FLAG = "--confirm-admin-claim-transition";
export const CONFIRMATION_FLAG = "--confirmation";
export const CONFIRMATION_PHRASE = "ADD_ADMIN_CLAIM_KEEP_LEGACY_FALLBACK";
export const EXPECTED_FINGERPRINT_FLAG = "--expected-fingerprint";

/**
 * Flags that would name a target. The target is ALWAYS `LEGACY_ADMIN_UID` from
 * the central module — accepting any of these, even to "double-check", would let
 * a caller point this tool at an arbitrary account. Their mere presence is
 * refused, and their VALUE is never read.
 */
export const FORBIDDEN_TARGET_FLAGS = [
  "--uid",
  "--user",
  "--email",
  "--id",
  "--target",
  "--account",
] as const;

export interface AdminClaimArgs {
  readonly project?: string;
  readonly apply: boolean;
  readonly confirm: boolean;
  readonly confirmationPhrase?: string;
  readonly expectedFingerprint?: string;
  /** The first target-naming flag seen, if any. Its VALUE is never captured. */
  readonly forbiddenFlag?: string;
  readonly help: boolean;
}

export type GuardRefusal =
  | "forbidden-target-arg"
  | "missing-project"
  | "wrong-project"
  | "apply-missing-confirm-flag"
  | "apply-missing-confirmation"
  | "apply-wrong-confirmation"
  | "apply-missing-fingerprint";

export type GuardDecision =
  | { readonly allowed: true; readonly mode: "dry-run" }
  | {
      readonly allowed: true;
      readonly mode: "apply";
      readonly expectedFingerprint: string;
    }
  | {
      readonly allowed: false;
      readonly reason: GuardRefusal;
      readonly message: string;
    };

/** The flag name (before any `=value`). */
function flagName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

/** Parses argv (already without `node` and the script path). No side effects. */
export function parseArgs(argv: readonly string[]): AdminClaimArgs {
  let project: string | undefined;
  let apply = false;
  let confirm = false;
  let confirmationPhrase: string | undefined;
  let expectedFingerprint: string | undefined;
  let forbiddenFlag: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = flagName(arg);

    if ((FORBIDDEN_TARGET_FLAGS as readonly string[]).includes(name)) {
      // Record ONLY the flag name; never read or store its value. Also swallow a
      // following space-separated value token so it is not mistaken for another
      // flag — but it is deliberately dropped, never captured.
      if (!forbiddenFlag) forbiddenFlag = name;
      if (arg === name && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        i++;
      }
      continue;
    }

    if (name === "--project") {
      project = arg === name ? argv[++i] : arg.slice("--project=".length);
    } else if (arg === APPLY_FLAG) {
      apply = true;
    } else if (arg === CONFIRM_FLAG) {
      confirm = true;
    } else if (name === CONFIRMATION_FLAG) {
      confirmationPhrase =
        arg === name ? argv[++i] : arg.slice((CONFIRMATION_FLAG + "=").length);
    } else if (name === EXPECTED_FINGERPRINT_FLAG) {
      expectedFingerprint =
        arg === name
          ? argv[++i]
          : arg.slice((EXPECTED_FINGERPRINT_FLAG + "=").length);
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return {
    project,
    apply,
    confirm,
    confirmationPhrase,
    expectedFingerprint,
    forbiddenFlag,
    help,
  };
}

/**
 * Decides whether the tool may run, and in which mode.
 *
 * The order matters. A target-naming argument is refused before anything else,
 * so there is no path where a caller-supplied UID is honoured. A missing or
 * wrong project is refused next, so the tool can never fall back to `.firebaserc`
 * (which points at the real project). Only the exact project, with `--apply` and
 * every confirmation, reaches "apply".
 */
export function decide(args: AdminClaimArgs): GuardDecision {
  if (args.forbiddenFlag) {
    return {
      allowed: false,
      reason: "forbidden-target-arg",
      message:
        `O argumento "${args.forbiddenFlag}" não é aceito. O alvo é sempre o ` +
        "administrador legado do módulo central e nunca vem por argumento.",
    };
  }

  if (!args.project) {
    return {
      allowed: false,
      reason: "missing-project",
      message:
        "Nenhum projeto informado. Este comando nunca usa o projeto padrão do " +
        ".firebaserc. Informe --project explicitamente.",
    };
  }

  if (args.project !== PRODUCTION_PROJECT_ID) {
    return {
      allowed: false,
      reason: "wrong-project",
      message:
        `Projeto "${args.project}" não é aceito. Este comando só opera em ` +
        `"${PRODUCTION_PROJECT_ID}".`,
    };
  }

  // Correct project, no --apply → the safe default: a read-only dry-run.
  if (!args.apply) {
    return { allowed: true, mode: "dry-run" };
  }

  // --apply requires ALL confirmations, simultaneously. Each missing piece is a
  // distinct, explicit refusal.
  if (!args.confirm) {
    return {
      allowed: false,
      reason: "apply-missing-confirm-flag",
      message: `Para escrever é obrigatório ${CONFIRM_FLAG}.`,
    };
  }
  if (args.confirmationPhrase === undefined) {
    return {
      allowed: false,
      reason: "apply-missing-confirmation",
      message:
        `Para escrever é obrigatório ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}.`,
    };
  }
  if (args.confirmationPhrase !== CONFIRMATION_PHRASE) {
    return {
      allowed: false,
      reason: "apply-wrong-confirmation",
      message:
        "A frase de confirmação não confere. Esperado exatamente: " +
        `${CONFIRMATION_PHRASE}.`,
    };
  }
  if (!args.expectedFingerprint) {
    return {
      allowed: false,
      reason: "apply-missing-fingerprint",
      message:
        `Para escrever é obrigatório ${EXPECTED_FINGERPRINT_FLAG} <hash>, ` +
        "obtido no dry-run imediatamente anterior.",
    };
  }

  return {
    allowed: true,
    mode: "apply",
    expectedFingerprint: args.expectedFingerprint,
  };
}
