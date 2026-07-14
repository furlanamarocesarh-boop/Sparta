/**
 * Safety guard for the data audit.
 *
 * This is the single thing standing between a developer typing `npm run
 * audit:data` and a tool touching the live project. It is a PURE function on
 * purpose: it decides go/no-go from the arguments and the environment alone,
 * with no Firebase import anywhere in this file, so every refusal path is unit
 * tested without a network, credentials, or an emulator.
 *
 * Default posture: REFUSE. Production is only reachable when the operator names
 * the project *and* types the long confirmation flag. Nothing is implicit.
 */

/** The real project. Never a default, never inferred from `.firebaserc`. */
export const PRODUCTION_PROJECT_ID = "sparta-battle";

/** The explicit opt-in required to read production. Deliberately verbose. */
export const PRODUCTION_CONFIRM_FLAG = "--confirm-read-only-production-audit";

export interface AuditArgs {
  readonly project?: string;
  readonly confirmProduction: boolean;
  /** Include document ids in the report. Off by default (ids are identifying). */
  readonly showIds: boolean;
  /**
   * Run the anonymized wallet reconciliation instead of the aggregate audit.
   * Still read-only, still behind the same guard.
   */
  readonly reconcile: boolean;
  readonly help: boolean;
}

export type GuardDecision =
  | { readonly allowed: true; readonly target: "production" | "emulator" }
  | { readonly allowed: false; readonly reason: GuardRefusal; readonly message: string };

export type GuardRefusal =
  | "missing-project"
  | "unconfirmed-production"
  | "unknown-project"
  | "emulator-not-running";

/** Parses argv (without `node` and the script path). No side effects. */
export function parseArgs(argv: readonly string[]): AuditArgs {
  let project: string | undefined;
  let confirmProduction = false;
  let showIds = false;
  let reconcile = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--project") {
      project = argv[i + 1];
      i++;
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
    } else if (arg === PRODUCTION_CONFIRM_FLAG) {
      confirmProduction = true;
    } else if (arg === "--show-ids") {
      showIds = true;
    } else if (arg === "--reconcile") {
      reconcile = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { project, confirmProduction, showIds, reconcile, help };
}

export interface GuardEnv {
  /** Set by the Firebase emulator (`emulators:exec`). Undefined in production. */
  readonly firestoreEmulatorHost?: string;
}

/**
 * Decides whether the audit may run, and against what.
 *
 * The order matters. A missing project is refused BEFORE anything else, so the
 * tool can never fall back to `.firebaserc` (which points at the real project)
 * and quietly audit production because someone forgot a flag.
 */
export function decide(args: AuditArgs, env: GuardEnv): GuardDecision {
  if (!args.project) {
    return {
      allowed: false,
      reason: "missing-project",
      message:
        "Nenhum projeto informado. Este comando nunca usa o projeto padrão do " +
        ".firebaserc. Informe --project explicitamente.",
    };
  }

  // A `demo-*` id can only ever reach an emulator: the Firebase SDK refuses to
  // contact a real backend with it. Still, require the emulator to actually be
  // running, so a "safe" run cannot silently hang or fall through.
  if (args.project.startsWith("demo-")) {
    if (!env.firestoreEmulatorHost) {
      return {
        allowed: false,
        reason: "emulator-not-running",
        message:
          `O projeto "${args.project}" é de emulador, mas FIRESTORE_EMULATOR_HOST ` +
          "não está definido. Rode via firebase emulators:exec.",
      };
    }
    return { allowed: true, target: "emulator" };
  }

  if (args.project !== PRODUCTION_PROJECT_ID) {
    return {
      allowed: false,
      reason: "unknown-project",
      message:
        `Projeto "${args.project}" não reconhecido. Use "${PRODUCTION_PROJECT_ID}" ` +
        `com ${PRODUCTION_CONFIRM_FLAG}, ou um projeto demo-* no emulador.`,
    };
  }

  if (!args.confirmProduction) {
    return {
      allowed: false,
      reason: "unconfirmed-production",
      message:
        `Leitura de produção ("${PRODUCTION_PROJECT_ID}") exige confirmação ` +
        `explícita. Repita o comando com ${PRODUCTION_CONFIRM_FLAG}.`,
    };
  }

  return { allowed: true, target: "production" };
}
