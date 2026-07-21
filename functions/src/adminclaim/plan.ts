import {
  APPLY_FLAG,
  CONFIRM_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  EXPECTED_FINGERPRINT_FLAG,
  PRODUCTION_PROJECT_ID,
} from "./guard.js";

/**
 * The decision logic for the admin-claim transition — PURE, no Firebase.
 *
 * `planAdminClaim` decides what a claim assignment WOULD do from the observed
 * account state alone. `decideApply` decides whether an actual write may proceed
 * given the operator's expected fingerprint and a fresh read taken immediately
 * before writing. The cli is a thin shell that feeds real Firebase reads into
 * these functions and renders their result; every branch here is unit tested.
 *
 * All rendering here is deliberately ANONYMIZED: it never emits the target uid,
 * an email, a token, or full claim values — only counts and booleans.
 */

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;

export interface AdminClaimState {
  /** The target account exists in Firebase Auth. */
  readonly userExists: boolean;
  /** The Auth account is disabled. */
  readonly disabled: boolean;
  /** Existing custom claims, exactly as Auth returns them (may be undefined). */
  readonly customClaims: Record<string, unknown> | undefined;
  /** `users/{uid}` exists in Firestore. */
  readonly userDocExists: boolean;
  /** `wallets/{uid}` exists in Firestore. */
  readonly walletDocExists: boolean;
}

export type AbortReason =
  | "user-not-found"
  | "user-disabled"
  | "missing-user-doc"
  | "missing-wallet-doc";

export type AdminClaimPlan =
  | { readonly kind: "abort"; readonly reason: AbortReason; readonly message: string }
  | { readonly kind: "noop"; readonly message: string }
  | {
      readonly kind: "add-claim";
      readonly nextClaims: Record<string, unknown>;
      readonly existingClaimCount: number;
      readonly message: string;
    };

/**
 * Decide, from the observed state alone, what a claim assignment WOULD do.
 *
 * Preconditions are checked FIRST and any failure aborts: a missing, disabled,
 * or doc-less account is never a target. Only then is the claim itself
 * considered. `admin` is treated as "set" ONLY when it is exactly boolean
 * `true`; a truthy non-boolean (e.g. the string "true") is normalized.
 */
export function planAdminClaim(state: AdminClaimState): AdminClaimPlan {
  if (!state.userExists) {
    return {
      kind: "abort",
      reason: "user-not-found",
      message: "A conta alvo não existe no Firebase Auth.",
    };
  }
  if (state.disabled) {
    return {
      kind: "abort",
      reason: "user-disabled",
      message: "A conta alvo está desativada.",
    };
  }
  if (!state.userDocExists) {
    return {
      kind: "abort",
      reason: "missing-user-doc",
      message: "O documento users/<alvo> não existe.",
    };
  }
  if (!state.walletDocExists) {
    return {
      kind: "abort",
      reason: "missing-wallet-doc",
      message: "O documento wallets/<alvo> não existe.",
    };
  }

  const existing = state.customClaims ?? {};
  const existingClaimCount = Object.keys(existing).length;

  if (existing.admin === true) {
    return {
      kind: "noop",
      message: "A claim admin já é exatamente true. Nada a fazer.",
    };
  }

  // Preserve EVERY existing claim; add/normalize ONLY admin to boolean true.
  const nextClaims: Record<string, unknown> = { ...existing, admin: true };
  return {
    kind: "add-claim",
    nextClaims,
    existingClaimCount,
    message: "Adicionaria admin: true, preservando as demais claims.",
  };
}

export type ApplyOutcome =
  | { readonly kind: "write"; readonly nextClaims: Record<string, unknown> }
  | { readonly kind: "noop" }
  | { readonly kind: "abort"; readonly reason: string; readonly message: string };

/**
 * Decide whether an apply may write, given the EXPECTED fingerprint from the
 * operator's dry-run and a FRESH fingerprint + plan taken immediately before the
 * write.
 *
 * Order is the safety property:
 *   1. a fresh precondition failure aborts (the account changed for the worse);
 *   2. ANY fingerprint divergence aborts — claims/disabled/uid moved since the
 *      dry-run, so the operator must look again before writing;
 *   3. an already-set claim is a no-op;
 *   4. otherwise, and only otherwise, write.
 */
export function decideApply(
  expectedFingerprint: string,
  freshFingerprint: string,
  freshPlan: AdminClaimPlan
): ApplyOutcome {
  if (freshPlan.kind === "abort") {
    return { kind: "abort", reason: freshPlan.reason, message: freshPlan.message };
  }
  if (expectedFingerprint !== freshFingerprint) {
    return {
      kind: "abort",
      reason: "fingerprint-divergence",
      message:
        "O estado da conta mudou desde o dry-run (fingerprint divergente). " +
        "Nada foi escrito. Rode o dry-run novamente e reconfirme.",
    };
  }
  if (freshPlan.kind === "noop") {
    return { kind: "noop" };
  }
  return { kind: "write", nextClaims: freshPlan.nextClaims };
}

/** Exit code for a completed dry-run: an abort is a precondition failure (1). */
export function exitCodeForPlan(plan: AdminClaimPlan): number {
  return plan.kind === "abort" ? EXIT_FAILURE : EXIT_OK;
}

/** A failed setCustomUserClaims is NEVER reported as success. */
export function exitCodeForWrite(writeSucceeded: boolean): number {
  return writeSucceeded ? EXIT_OK : EXIT_FAILURE;
}

// --- Anonymized rendering ---------------------------------------------------

/** Describes the claim state WITHOUT emitting any claim key or value. */
function claimSummary(state: AdminClaimState): string {
  if (!state.userExists) return "conta inexistente";
  const claims = state.customClaims ?? {};
  const count = Object.keys(claims).length;
  let adminStatus: string;
  if (claims.admin === true) {
    adminStatus = "admin=true (boolean)";
  } else if ("admin" in claims) {
    adminStatus = "admin presente, porém não-boolean (seria normalizado)";
  } else {
    adminStatus = "admin ausente";
  }
  return `${count} claim(s) existente(s); ${adminStatus}`;
}

function planLabel(plan: AdminClaimPlan): string {
  if (plan.kind === "abort") {
    return `ABORTAR (${plan.reason}) — ${plan.message}`;
  }
  if (plan.kind === "noop") {
    return `NENHUMA AÇÃO — ${plan.message}`;
  }
  return (
    `ADICIONAR admin: true (preserva ${plan.existingClaimCount} claim(s) ` +
    `existente(s)) — ${plan.message}`
  );
}

/** The exact command a future apply must run. Contains NO uid — only the hash. */
export function buildApplyCommand(fingerprint: string): string {
  return [
    "npm run admin:claim --",
    `--project ${PRODUCTION_PROJECT_ID}`,
    APPLY_FLAG,
    CONFIRM_FLAG,
    `${CONFIRMATION_FLAG} ${CONFIRMATION_PHRASE}`,
    `${EXPECTED_FINGERPRINT_FLAG} ${fingerprint}`,
  ].join(" ");
}

export interface DryRunView {
  readonly fingerprint: string;
  readonly state: AdminClaimState;
  readonly plan: AdminClaimPlan;
}

export function renderDryRun(view: DryRunView): string {
  const s = view.state;
  return [
    "TRANSIÇÃO DE ADMIN CLAIM — DRY-RUN (SOMENTE LEITURA)",
    "Alvo: administrador legado (UID redigido; derivado do módulo central).",
    `Conta existe no Auth: ${s.userExists ? "sim" : "não"}`,
    `Desativada: ${s.disabled ? "sim" : "não"}`,
    `users/<alvo> existe: ${s.userDocExists ? "sim" : "não"}`,
    `wallets/<alvo> existe: ${s.walletDocExists ? "sim" : "não"}`,
    `Estado das claims: ${claimSummary(s)}`,
    `Fingerprint: ${view.fingerprint}`,
    "",
    `Plano: ${planLabel(view.plan)}`,
    "",
    "Nenhuma escrita foi feita. Para aplicar (etapa futura, exige nova",
    "confirmação e o fingerprint deste dry-run):",
    `  ${buildApplyCommand(view.fingerprint)}`,
  ].join("\n");
}

/** Rendered for an apply that did NOT write (abort or no-op). Anonymized. */
export function renderApplyDecision(outcome: ApplyOutcome): string {
  if (outcome.kind === "abort") {
    return `APPLY ABORTADO (${outcome.reason}) — ${outcome.message} Nada foi escrito.`;
  }
  if (outcome.kind === "noop") {
    return "APPLY: a claim admin já era exatamente true. Nenhuma escrita necessária.";
  }
  return "APPLY: pronto para escrever.";
}

/** Rendered after a successful write. Emits only a count, never claim values. */
export function renderWriteSuccess(nextClaims: Record<string, unknown>): string {
  const others = Math.max(0, Object.keys(nextClaims).length - 1);
  return (
    `APPLY: admin: true atribuído, preservando ${others} outra(s) claim(s). ` +
    "Tokens NÃO foram revogados: o administrador precisa sair e entrar novamente " +
    "(ou forçar getIdToken(true)) para o token carregar a claim. O fallback de " +
    "UID legado continua ativo até uma fase futura."
  );
}
