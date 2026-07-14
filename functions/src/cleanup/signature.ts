import { inspectReais, MAX_BALANCE_CENTAVOS } from "../domain/money.js";
import { WALLET_MONEY_FIELDS, WalletField } from "../audit/walletAudit.js";

/**
 * Exact signatures of the two anomalous TEST documents.
 *
 * These are not heuristics and not ids. A document is only ever touched if it
 * matches EVERY property the read-only reconciliation actually observed. Ids are
 * never accepted from the command line (a typo'd id is how you delete the wrong
 * wallet); targets are found by matching these signatures and nothing else.
 *
 * If reality has drifted even slightly — a different balance, one new
 * transaction, a user_ref that has since been fixed — the signature stops
 * matching and the tool refuses to write. That is the intended behavior: the
 * signature IS the safety interlock.
 *
 * Observed by the reconciliation (commit 82c6015), against sparta-battle:
 *
 *   Wallet A  missing exactly `total_withdrawn`;
 *             balance R$70,00; total_deposited R$50,00; total_won R$20,00;
 *             total_spent R$0,00; `user_ref` ABSENT; users/{uid} EXISTS;
 *             exactly 1 transaction (prize / completed / R$20,00);
 *             0 withdrawals; 0 registrations.
 *
 *   Wallet B  all five money fields missing; users/{uid} DOES NOT EXIST;
 *             `user_ref` present but pointing elsewhere;
 *             0 transactions; 0 withdrawals; 0 registrations.
 */

// --- Wallet A expected values, in exact centavos. ---------------------------
export const WALLET_A_BALANCE_CENTAVOS = 7_000;
export const WALLET_A_DEPOSITED_CENTAVOS = 5_000;
export const WALLET_A_WON_CENTAVOS = 2_000;
export const WALLET_A_SPENT_CENTAVOS = 0;

/** The single fake transaction on Wallet A. */
export const FAKE_TX_CATEGORY = "prize";
export const FAKE_TX_STATUS = "completed";
export const FAKE_TX_CENTAVOS = 2_000;

export interface TransactionSnapshot {
  readonly category: unknown;
  readonly status: unknown;
  readonly amount: unknown;
}

/**
 * Everything the signature check needs about one wallet.
 *
 * `userRefPath` and `expectedUserRefPath` are used ONLY inside the matching and
 * are never carried into any output.
 */
export interface WalletCandidate {
  /** Raw field values straight from the wallet document. */
  readonly walletData: Readonly<Record<string, unknown>>;
  /** `wallet.user_ref.path`, or undefined when absent / not a reference. */
  readonly userRefPath: string | undefined;
  /** `users/{walletId}` — what a correct user_ref would be. */
  readonly expectedUserRefPath: string;
  readonly userDocExists: boolean;
  readonly transactions: readonly TransactionSnapshot[];
  readonly withdrawalCount: number;
  readonly registrationCount: number;
}

export type TargetKind = "wallet-a" | "wallet-b" | "not-a-target";

/** True when the field is absent or null in the document. */
function isMissing(data: Readonly<Record<string, unknown>>, field: string): boolean {
  return data[field] === undefined || data[field] === null;
}

/** True when the field holds exactly `centavos`, as an exact money value. */
function isExactly(
  data: Readonly<Record<string, unknown>>,
  field: WalletField,
  centavos: number
): boolean {
  const inspection = inspectReais(data[field], {
    allowZero: true,
    maxCentavos: MAX_BALANCE_CENTAVOS,
  });
  return inspection.ok && inspection.centavos === centavos;
}

/** True when a transaction is exactly the known fake prize of R$20,00. */
export function isFakeTransaction(tx: TransactionSnapshot): boolean {
  if (tx.category !== FAKE_TX_CATEGORY) return false;
  if (tx.status !== FAKE_TX_STATUS) return false;

  const amount = inspectReais(tx.amount, {
    allowZero: false,
    maxCentavos: MAX_BALANCE_CENTAVOS,
  });
  return amount.ok && amount.centavos === FAKE_TX_CENTAVOS;
}

export function matchesWalletA(candidate: WalletCandidate): boolean {
  const { walletData } = candidate;

  // Exactly one field missing, and it must be total_withdrawn.
  const missing = WALLET_MONEY_FIELDS.filter((field) =>
    isMissing(walletData, field)
  );
  if (missing.length !== 1 || missing[0] !== "total_withdrawn") return false;

  // Every present money field must hold exactly the observed value.
  if (!isExactly(walletData, "balance", WALLET_A_BALANCE_CENTAVOS)) return false;
  if (!isExactly(walletData, "total_deposited", WALLET_A_DEPOSITED_CENTAVOS)) {
    return false;
  }
  if (!isExactly(walletData, "total_won", WALLET_A_WON_CENTAVOS)) return false;
  if (!isExactly(walletData, "total_spent", WALLET_A_SPENT_CENTAVOS)) return false;

  // user_ref was ABSENT. If someone has since fixed it, this is no longer the
  // document we reconciled, and we must not touch it.
  if (candidate.userRefPath !== undefined) return false;

  if (!candidate.userDocExists) return false;

  // Exactly one related transaction, and it is the known fake prize.
  if (candidate.transactions.length !== 1) return false;
  if (!isFakeTransaction(candidate.transactions[0])) return false;

  if (candidate.withdrawalCount !== 0) return false;
  if (candidate.registrationCount !== 0) return false;

  return true;
}

export function matchesWalletB(candidate: WalletCandidate): boolean {
  const { walletData } = candidate;

  // All five money fields missing.
  const missing = WALLET_MONEY_FIELDS.filter((field) =>
    isMissing(walletData, field)
  );
  if (missing.length !== WALLET_MONEY_FIELDS.length) return false;

  // The owning user does not exist — this is what makes it orphaned.
  if (candidate.userDocExists) return false;

  // user_ref is PRESENT but points somewhere other than its own owner.
  if (candidate.userRefPath === undefined) return false;
  if (candidate.userRefPath === candidate.expectedUserRefPath) return false;

  // Zero financial activity of any kind.
  if (candidate.transactions.length !== 0) return false;
  if (candidate.withdrawalCount !== 0) return false;
  if (candidate.registrationCount !== 0) return false;

  return true;
}

export function classify(candidate: WalletCandidate): TargetKind {
  if (matchesWalletA(candidate)) return "wallet-a";
  if (matchesWalletB(candidate)) return "wallet-b";
  return "not-a-target";
}
