import { DomainError } from "./errors.js";
import { toCentavos } from "./money.js";
import type { Check } from "./settlement.js";

/**
 * Beta Credits — the PURE domain rules, with no `firebase-functions` and no
 * Admin SDK import, so every branch is unit-tested without a database.
 *
 * WHAT A BETA CREDIT IS (frozen contract for the closed beta):
 *  - `wallets/{uid}.beta_balance` holds the player's Beta Credits;
 *  - Beta Credits have NO monetary value and are NEVER withdrawable;
 *  - they use the SAME safe numeric representation as real money (stored as a
 *    NUMBER OF "reais-like" units, computed in exact integer centavos-like
 *    units via `money.ts`) so drift/NaN/negative/overflow are impossible —
 *    but the unit is NOT BRL and there is NO conversion to `balance`;
 *  - an absent `beta_balance` on an old wallet MEANS zero (no migration);
 *  - the five cash fields (`balance`, `total_deposited`, `total_won`,
 *    `total_spent`, `total_withdrawn`) are NEVER touched by any beta flow, and
 *    the cash ledger identity does not include beta categories.
 *
 * This module covers ONLY the grant flow (`grantBetaCredit`). Beta entry fees,
 * beta prizes and refunds are deliberately NOT here — they arrive with the
 * tournament `economy_type` in a later branch.
 */

/** The transaction category of a Beta Credit grant. NOT a cash category. */
export const BETA_GRANT_CATEGORY = "beta_grant";

/** The economy tag stamped on every beta transaction. */
export const BETA_ECONOMY_TYPE = "beta_credit";

/** Upper bound for the free-text grant reason. */
export const MAX_REASON_LENGTH = 500;

/**
 * The deterministic transaction id of a grant — one document per `grant_id`,
 * mirroring `prize_{tournamentid}`. This is what makes the grant idempotent:
 * a replay finds the document and never credits twice.
 */
export function betaGrantTransactionId(grantId: string): string {
  return `beta_grant_${grantId}`;
}

/**
 * Normalizes and validates an identifier with the secure pattern already used
 * by `jointournament` and the settlement module: trimmed, non-empty, no "/",
 * and no longer than 200 chars — so it can never escape its document path.
 */
function normalizeIdentifier(
  value: unknown,
  requiredMessage: string,
  invalidMessage: string
): string {
  const id = String(value || "").trim();
  if (!id) {
    throw new DomainError("invalid-argument", requiredMessage);
  }
  if (id.includes("/") || id.length > 200) {
    throw new DomainError("invalid-argument", invalidMessage);
  }
  return id;
}

export function normalizeBetaGrantUid(value: unknown): string {
  return normalizeIdentifier(
    value,
    "UID do destinatário é obrigatório.",
    "UID do destinatário inválido."
  );
}

export function normalizeGrantId(value: unknown): string {
  return normalizeIdentifier(
    value,
    "grant_id é obrigatório.",
    "grant_id inválido."
  );
}

export function normalizeCampaignId(value: unknown): string {
  return normalizeIdentifier(
    value,
    "campaign_id é obrigatório.",
    "campaign_id inválido."
  );
}

/**
 * The human reason for the grant: required, trimmed, free of control
 * characters, and bounded — it is persisted verbatim on the transaction.
 */
export function normalizeReason(value: unknown): string {
  const reason = String(value ?? "").trim();
  if (!reason) {
    throw new DomainError(
      "invalid-argument",
      "O motivo da concessão é obrigatório."
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(reason)) {
    throw new DomainError(
      "invalid-argument",
      "O motivo da concessão contém caracteres inválidos."
    );
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new DomainError(
      "invalid-argument",
      "O motivo da concessão é longo demais."
    );
  }
  return reason;
}

/**
 * Validates a requested grant amount into exact integer centavos-like units.
 * Rejects (never silently truncates): non-numbers, NaN, Infinity, zero,
 * negatives, more than two decimals, unsafe integers, and values above the
 * per-operation limit — via the SINGLE money definition in `money.ts`.
 */
export function validateBetaGrantAmount(raw: unknown): number {
  return toCentavos(raw, { field: "valor do crédito beta" });
}

/** The persisted grant-transaction fields the replay check compares. */
export interface StoredBetaGrant {
  readonly category?: unknown;
  readonly economyType?: unknown;
  readonly grantId?: unknown;
  readonly amountReais?: unknown;
  readonly campaignId?: unknown;
  readonly reason?: unknown;
  readonly userRefPath?: string | null;
}

/**
 * Decides whether an EXISTING `beta_grant_{grant_id}` transaction makes this
 * call an idempotent replay. Every identity field must match EXACTLY:
 * a same-`grant_id` request with a different uid, amount, campaign or reason —
 * or a colliding document that is not a beta grant at all — is a
 * failed-precondition, and nothing is written. `granted_by` is deliberately
 * NOT compared: a different admin replaying an identical grant is still the
 * same grant.
 */
export function checkBetaGrantReplay(input: {
  readonly grantId: string;
  readonly uid: string;
  readonly amountReais: number;
  readonly campaignId: string;
  readonly reason: string;
  readonly stored: StoredBetaGrant;
}): Check {
  const { stored } = input;
  const equivalent =
    stored.category === BETA_GRANT_CATEGORY &&
    stored.economyType === BETA_ECONOMY_TYPE &&
    stored.grantId === input.grantId &&
    stored.amountReais === input.amountReais &&
    stored.campaignId === input.campaignId &&
    stored.reason === input.reason &&
    stored.userRefPath === `users/${input.uid}`;

  if (!equivalent) {
    return {
      ok: false,
      message: "Já existe uma concessão diferente com este grant_id.",
    };
  }
  return { ok: true };
}
