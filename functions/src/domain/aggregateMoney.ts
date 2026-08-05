import { DomainError } from "./errors.js";

/**
 * Platform-aggregate money — a domain DELIBERATELY separate from `money.ts`.
 *
 * WHY A SECOND MODULE. `money.ts` governs one player's wallet and one
 * transaction amount: `addCentavos` throws above `MAX_BALANCE_CENTAVOS`
 * (R$ 10 000 000,00), a bound sized for a single wallet. A season total or an
 * administrative bucket is a cross-player figure with no relation to that
 * bound — reusing the wallet helper would make aggregate reads start throwing
 * once cumulative platform volume crossed R$ 10 M, a latent failure with no
 * real limit behind it. The wallet contract is frozen and is NOT touched here.
 *
 * WHAT THIS DOMAIN GUARANTEES:
 *  - only safe, finite, non-negative INTEGER centavos, in and out;
 *  - addition is always checked;
 *  - no operation may exceed [MAX_AGGREGATE_CENTAVOS];
 *  - no floating point, no silent rounding;
 *  - no saturation, no clamping, no wraparound — an overflow THROWS, so the
 *    caller's write never happens and the aggregate is left untouched.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Converting reais to centavos stays with
 * `inspectReais` in `money.ts` — there is exactly one definition of "valid
 * money" in this codebase and this module does not add a second. Subtraction is
 * absent because ranking aggregates only accumulate: a credited prize is final
 * and irreversible under the current backend, so nothing decrements them.
 */

/**
 * Upper bound for any platform-wide aggregate, in centavos.
 *
 * It is `Number.MAX_SAFE_INTEGER` (9 007 199 254 740 991 centavos, about
 * R$ 90 trilhões) — a CORRECTNESS ceiling, not a business one: beyond it,
 * integer arithmetic in a double silently stops being exact, which is precisely
 * the failure this domain exists to prevent.
 */
export const MAX_AGGREGATE_CENTAVOS = Number.MAX_SAFE_INTEGER;

/**
 * Every operand rule of the aggregate domain, in one place.
 *
 * Private on purpose, mirroring `assertSafeCentavos` in `money.ts`: the module
 * exposes the constant and the checked add, and nothing else.
 *
 * The conditions overlap by design — `isSafeInteger` already implies finite and
 * integer, and no safe integer can exceed `MAX_AGGREGATE_CENTAVOS` because the
 * ceiling IS that bound. Each rule is still stated explicitly so the contract
 * reads as the contract, and so lowering the ceiling later cannot silently make
 * one of them a no-op.
 */
function assertAggregateCentavos(value: number): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_AGGREGATE_CENTAVOS
  ) {
    throw new DomainError(
      "failed-precondition",
      "Valor agregado interno inválido."
    );
  }
}

/**
 * Exact addition in the aggregate domain.
 *
 * OVERFLOW IS CHECKED BEFORE THE SUM IS TRUSTED. Above 2^53 a double no longer
 * represents every integer, so `a + b` is rounded and then inspected — the sum
 * itself cannot be the evidence that the sum is correct. Comparing
 * `a > MAX_AGGREGATE_CENTAVOS - b` decides the question entirely within the
 * safe range, on operands already proven safe.
 *
 * A result exactly equal to the ceiling is legal: the contract forbids
 * EXCEEDING it, not reaching it. Zero is legal in both operands and in the
 * result — a season total starts at zero.
 */
export function addAggregateCentavos(a: number, b: number): number {
  assertAggregateCentavos(a);
  assertAggregateCentavos(b);

  if (a > MAX_AGGREGATE_CENTAVOS - b) {
    throw new DomainError(
      "failed-precondition",
      "Operação excede o limite de agregado permitido."
    );
  }

  const sum = a + b;

  // Belt and braces: the result is re-proven, never assumed from the operands.
  if (
    !Number.isSafeInteger(sum) ||
    sum < 0 ||
    sum > MAX_AGGREGATE_CENTAVOS
  ) {
    throw new DomainError(
      "failed-precondition",
      "Operação excede o limite de agregado permitido."
    );
  }

  return sum;
}
