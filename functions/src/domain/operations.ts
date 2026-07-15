import { DomainError, failedPrecondition } from "./errors.js";
import { addCentavos, centavosToReais, subtractCentavos, toCentavos } from "./money.js";

/**
 * The financial rules of each operation, as pure functions.
 *
 * These exist so the invariants that actually protect players' money — you
 * cannot withdraw more than you have, a prize cannot be negative, a balance
 * cannot go below zero — are testable without Firestore, without the Admin SDK,
 * and without ever touching production. `index.ts` composes exactly these
 * functions inside its transactions, so a test here tests the shipped rule, not
 * a paraphrase of it.
 */

/** Minimum withdrawal: R$ 5,00. Unchanged from the deployed behavior. */
export const MIN_WITHDRAWAL_CENTAVOS = 500;

/** Maximum withdrawal: R$ 10.000,00. Unchanged from the deployed behavior. */
export const MAX_WITHDRAWAL_CENTAVOS = 1_000_000;

/** Validates a requested deposit amount (admin-only `testdeposit`). */
export function validateDepositAmount(raw: unknown): number {
  return toCentavos(raw, { field: "valor do depósito" });
}

/** Validates a prize amount. Zero and negative prizes are rejected. */
export function validatePrizeAmount(raw: unknown): number {
  return toCentavos(raw, { field: "valor do prêmio" });
}

/** Validates a withdrawal amount, including the min/max band. */
export function validateWithdrawalAmount(raw: unknown): number {
  const centavos = toCentavos(raw, {
    field: "valor do saque",
    maxCentavos: MAX_WITHDRAWAL_CENTAVOS,
  });

  if (centavos < MIN_WITHDRAWAL_CENTAVOS) {
    throw new DomainError(
      "invalid-argument",
      `O saque mínimo é R$${centavosToReais(MIN_WITHDRAWAL_CENTAVOS)}.`
    );
  }

  return centavos;
}

/**
 * Validates the entry fee stored on a tournament document.
 *
 * A tournament with a zero or missing entry fee is not joinable through the
 * paid flow — the deployed code rejected it too, and that is preserved.
 */
export function validateEntryFee(raw: unknown): number {
  return toCentavos(raw, { field: "valor da inscrição" });
}

/**
 * Debits a wallet. The single place "you cannot spend what you do not have" is
 * enforced, for both withdrawals and tournament entry fees.
 *
 * @throws DomainError('failed-precondition') when the balance is insufficient.
 */
export function debit(
  balanceCentavos: number,
  amountCentavos: number
): number {
  if (balanceCentavos < amountCentavos) {
    throw failedPrecondition("Saldo insuficiente.");
  }

  const balanceAfter = subtractCentavos(balanceCentavos, amountCentavos);

  // Integers cannot drift negative behind our back, but this is money: assert.
  if (balanceAfter < 0) {
    throw failedPrecondition("Saldo insuficiente.");
  }

  return balanceAfter;
}

/** Credits a wallet (deposit, prize). Overflow is rejected, never wrapped. */
export function credit(
  balanceCentavos: number,
  amountCentavos: number
): number {
  return addCentavos(balanceCentavos, amountCentavos);
}
