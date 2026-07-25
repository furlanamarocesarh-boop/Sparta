import {
  inspectReais,
  MAX_BALANCE_CENTAVOS,
  MoneyProblem,
} from "../domain/money.js";

/**
 * Wallet auditing — pure, no Firebase.
 *
 * Every monetary judgement here is delegated to `inspectReais`, the SAME
 * function the Cloud Functions use. That is deliberate: if the auditor had its
 * own copy of "what counts as valid money", the two could disagree, and the
 * audit would bless data that the hardened backend then rejects in production —
 * which is precisely the failure this tool exists to prevent.
 */

/** The monetary fields every wallet document is expected to carry. */
export const WALLET_MONEY_FIELDS = [
  "balance",
  "total_deposited",
  "total_won",
  "total_spent",
  "total_withdrawn",
] as const;

export type WalletField = (typeof WALLET_MONEY_FIELDS)[number];

/**
 * OPTIONAL monetary fields: legal to be absent (a pre-beta wallet reads
 * `beta_balance` as zero — absence is NOT a finding), but when PRESENT they
 * must be valid money like any other field.
 */
export const OPTIONAL_WALLET_MONEY_FIELDS = ["beta_balance"] as const;

export type OptionalWalletField = (typeof OPTIONAL_WALLET_MONEY_FIELDS)[number];

export interface WalletFieldIssue {
  readonly field: WalletField | OptionalWalletField;
  readonly problem: MoneyProblem;
}

export interface WalletFinding {
  /** Document id. Only ever emitted when the operator passes --show-ids. */
  readonly id: string;
  readonly issues: readonly WalletFieldIssue[];
}

/**
 * Audits one wallet document.
 *
 * Stored balances and totals may legitimately be zero (a fresh wallet from
 * `onUserCreated` is all zeros), so `allowZero` is true. They are bounded by
 * MAX_BALANCE_CENTAVOS rather than the per-transaction limit.
 */
export function auditWalletDocument(
  id: string,
  data: Record<string, unknown>
): WalletFinding | null {
  const issues: WalletFieldIssue[] = [];

  for (const field of WALLET_MONEY_FIELDS) {
    const inspection = inspectReais(data[field], {
      allowZero: true,
      maxCentavos: MAX_BALANCE_CENTAVOS,
    });

    if (!inspection.ok) {
      issues.push({ field, problem: inspection.problem });
    }
  }

  // Optional fields: absence is legal (never a "missing" finding); a present
  // but invalid value is a finding like any other.
  for (const field of OPTIONAL_WALLET_MONEY_FIELDS) {
    if (data[field] === undefined) continue;
    const inspection = inspectReais(data[field], {
      allowZero: true,
      maxCentavos: MAX_BALANCE_CENTAVOS,
    });
    if (!inspection.ok) {
      issues.push({ field, problem: inspection.problem });
    }
  }

  return issues.length > 0 ? { id, issues } : null;
}
