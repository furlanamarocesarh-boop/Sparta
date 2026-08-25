/**
 * Safety guard for the `created_at` backfill.
 *
 * PURE on purpose — no firebase import anywhere in this file — so every refusal
 * path is unit tested without a network, credentials or the Admin SDK. The cli
 * runs this guard and must get `allowed: true` BEFORE it loads firebase-admin.
 *
 * Same posture as `adminclaim`: DRY-RUN by default, REFUSE anything unsafe, and
 * never fall back to the project in `.firebaserc`.
 *
 * NO FINGERPRINT HERE, unlike `adminclaim`, and the difference is deliberate.
 * That tool touches ONE account, so pinning the exact state the operator
 * reviewed is both possible and right. This one sweeps every account, and the
 * set changes whenever somebody signs up — a fingerprint would fail for a
 * perfectly correct reason and train the operator to work around it. What makes
 * this tool safe instead is structural: it can only ever FILL an absent field,
 * it re-checks that inside the same transaction that writes, and running it
 * twice is a no-op.
 */

/** The one project this tool may ever touch. Never a default, never inferred. */
export const PRODUCTION_PROJECT_ID = "sparta-battle";

export const APPLY_FLAG = "--apply";
export const CONFIRM_FLAG = "--confirm-created-at-backfill";
export const CONFIRMATION_FLAG = "--confirmation";
export const CONFIRMATION_PHRASE = "FILL_MISSING_CREATED_AT_NEVER_OVERWRITE";

/**
 * Flags that would narrow or redirect the sweep.
 *
 * REFUSED OUTRIGHT, and their VALUE is never read. A backfill that can be
 * pointed at one account is a single-document editor wearing a migration's
 * name, and the whole safety argument above — "it can only fill, it is
 * idempotent, it sweeps everything" — stops being true the moment a target can
 * be chosen.
 */
export const FORBIDDEN_TARGET_FLAGS = [
  "--uid",
  "--user",
  "--email",
  "--id",
  "--target",
  "--account",
  "--date",
  "--created-at",
] as const;

/**
 * The emulator host variables, as read from the environment.
 *
 * PASSED IN RATHER THAN READ HERE, so this module stays pure and the refusal
 * below is provable in a unit test without touching `process.env`.
 */
export interface EmulatorEnv {
  readonly firestoreEmulatorHost?: string;
  readonly authEmulatorHost?: string;
}

export interface BackfillArgs {
  readonly project?: string;
  readonly apply: boolean;
  readonly confirm: boolean;
  readonly confirmationPhrase?: string;
  /** The first forbidden flag seen, if any. Its VALUE is never captured. */
  readonly forbiddenFlag?: string;
  readonly help: boolean;
}

export type GuardRefusal =
  | "forbidden-target-arg"
  | "missing-project"
  | "wrong-project"
  | "emulator-host-set"
  | "apply-missing-confirm-flag"
  | "apply-missing-confirmation"
  | "apply-wrong-confirmation";

export type GuardDecision =
  | { readonly allowed: true; readonly mode: "dry-run" }
  | { readonly allowed: true; readonly mode: "apply" }
  | {
      readonly allowed: false;
      readonly reason: GuardRefusal;
      readonly message: string;
    };

function flagName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

/** Parses argv (already without `node` and the script path). No side effects. */
export function parseArgs(argv: readonly string[]): BackfillArgs {
  let project: string | undefined;
  let apply = false;
  let confirm = false;
  let confirmationPhrase: string | undefined;
  let forbiddenFlag: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = flagName(arg);

    if ((FORBIDDEN_TARGET_FLAGS as readonly string[]).includes(name)) {
      // Record ONLY the flag name. Swallow a following space-separated value so
      // it is not mistaken for another flag — but drop it, never capture it.
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
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { project, apply, confirm, confirmationPhrase, forbiddenFlag, help };
}

/**
 * Decides whether the tool may run, and in which mode.
 *
 * The order matters. A targeting argument is refused before anything else. A
 * missing or wrong project is refused next, so the tool can never fall back to
 * `.firebaserc` — which points at the real project. Only the exact project,
 * with `--apply` and every confirmation, reaches "apply".
 */
export function decide(
  args: BackfillArgs,
  env: EmulatorEnv = {}
): GuardDecision {
  if (args.forbiddenFlag) {
    return {
      allowed: false,
      reason: "forbidden-target-arg",
      message:
        `O argumento "${args.forbiddenFlag}" não é aceito. Este comando varre ` +
        "todas as contas e só preenche o campo ausente: ele não escolhe alvo " +
        "e não aceita uma data vinda de fora.",
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

  /**
   * A LEFTOVER EMULATOR HOST IS REFUSED, not ignored.
   *
   * It cannot damage production — the SDK would talk to the emulator instead.
   * The danger is the opposite one: the run would sweep an empty emulator,
   * report "0 a gravar" and look like a completed backfill, and the operator
   * would believe production was done. A no-op that reads as success is worse
   * than a refusal.
   */
  const emulatorHost = env.firestoreEmulatorHost || env.authEmulatorHost;
  if (emulatorHost) {
    return {
      allowed: false,
      reason: "emulator-host-set",
      message:
        "FIRESTORE_EMULATOR_HOST ou FIREBASE_AUTH_EMULATOR_HOST está definido " +
        `("${emulatorHost}"), então este comando falaria com o emulador e o ` +
        `relatório não diria nada sobre "${PRODUCTION_PROJECT_ID}". Limpe a ` +
        "variável e rode de novo.",
    };
  }

  if (!args.apply) {
    return { allowed: true, mode: "dry-run" };
  }

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
      message: `Para escrever é obrigatório ${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}.`,
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

  return { allowed: true, mode: "apply" };
}
