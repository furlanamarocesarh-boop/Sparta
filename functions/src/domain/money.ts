import { DomainError, invalidArgument } from "./errors.js";

/**
 * Money.
 *
 * EXTERNAL CONTRACT (unchanged): Firestore stores money as a NUMBER OF REAIS
 * (e.g. `balance: 10.5`). Old documents and the previous FlutterFlow client
 * depend on that, so this phase does not migrate the stored representation.
 *
 * INTERNAL CONTRACT (new): every arithmetic operation inside the functions is
 * performed on INTEGER CENTAVOS. Floating-point reais are converted to centavos
 * at the edge, all adding/subtracting happens in exact integers, and the result
 * is converted back to normalized reais only when it is written to Firestore.
 *
 * Why this matters: the previous code did `balance - entryFee` directly on
 * doubles. `0.1 + 0.2 === 0.30000000000000004`, and repeated deposits/debits
 * accumulate that drift into a wallet balance that is silently wrong. Integers
 * cannot drift.
 */

/** Upper bound for any single amount: R$ 1,000,000.00. */
export const MAX_CENTAVOS = 100_000_000;

/** Upper bound for a wallet balance / accumulated total: R$ 10,000,000.00. */
export const MAX_BALANCE_CENTAVOS = 1_000_000_000;

/**
 * Tolerance when checking that a real has at most two decimal places.
 *
 * `10.10 * 100` is `1009.9999999999999` in IEEE-754, not `1010`. Comparing the
 * scaled value against its rounded form with a small epsilon accepts that
 * representation noise while still rejecting a genuine third decimal (10.101
 * scales to 1010.1, which is 0.1 away from 1010 — far outside the epsilon).
 */
const SCALE_EPSILON = 1e-6;

export interface ToCentavosOptions {
  /** Field name used in the error message, e.g. "valor do saque". */
  readonly field: string;
  /** Whether 0 is a legal value for this operation. Defaults to false. */
  readonly allowZero?: boolean;
  /** Maximum accepted value, in centavos. Defaults to [MAX_CENTAVOS]. */
  readonly maxCentavos?: number;
}

/**
 * Converts a validated amount in reais into exact integer centavos.
 *
 * Rejects (never silently truncates): non-numbers, NaN, Infinity, negatives,
 * more than two decimal places, unsafe integers, and values above the limit.
 */
export function toCentavos(value: unknown, options: ToCentavosOptions): number {
  const { field, allowZero = false, maxCentavos = MAX_CENTAVOS } = options;

  // `typeof NaN === "number"`, so this only rejects strings/null/undefined/
  // booleans/objects. NaN and Infinity are caught by the isFinite check below.
  if (typeof value !== "number") {
    throw invalidArgument(`O ${field} precisa ser um número.`);
  }

  // Covers NaN, Infinity and -Infinity in one check.
  if (!Number.isFinite(value)) {
    throw invalidArgument(`O ${field} é inválido.`);
  }

  if (value < 0) {
    throw invalidArgument(`O ${field} não pode ser negativo.`);
  }

  if (value === 0 && !allowZero) {
    throw invalidArgument(`O ${field} precisa ser maior que zero.`);
  }

  const scaled = value * 100;

  // Guard before rounding: a value large enough to lose integer precision
  // cannot be trusted, and Math.round would happily return a wrong answer.
  if (!Number.isSafeInteger(Math.round(scaled))) {
    throw invalidArgument(`O ${field} é grande demais.`);
  }

  const centavos = Math.round(scaled);

  if (Math.abs(scaled - centavos) > SCALE_EPSILON) {
    throw invalidArgument(
      `O ${field} pode ter no máximo 2 casas decimais.`
    );
  }

  if (centavos > maxCentavos) {
    throw invalidArgument(`O ${field} está acima do limite permitido.`);
  }

  return centavos;
}

/**
 * Reads a monetary value already persisted in Firestore (reais) into centavos.
 *
 * Separate from [toCentavos] because stored data is not user input: a corrupt
 * balance is a `failed-precondition` (server-side data problem), not an
 * `invalid-argument` (caller mistake). Zero is always legal for stored values.
 */
export function storedReaisToCentavos(
  value: unknown,
  field: string
): number {
  try {
    return toCentavos(value, {
      field,
      allowZero: true,
      maxCentavos: MAX_BALANCE_CENTAVOS,
    });
  } catch (error) {
    const message =
      error instanceof DomainError ? error.message : `O ${field} é inválido.`;
    throw new DomainError("failed-precondition", message);
  }
}

/**
 * Converts exact centavos back into the reais number Firestore stores.
 *
 * `toFixed(2)` normalizes the division so the written value is always a clean
 * two-decimal number (e.g. `10.5`, never `10.500000000000002`).
 */
export function centavosToReais(centavos: number): number {
  if (!Number.isSafeInteger(centavos)) {
    throw invalidArgument("Valor monetário interno inválido.");
  }
  return Number((centavos / 100).toFixed(2));
}

/** Exact addition. Throws rather than overflowing into unsafe-integer land. */
export function addCentavos(a: number, b: number): number {
  assertSafeCentavos(a);
  assertSafeCentavos(b);
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum > MAX_BALANCE_CENTAVOS) {
    throw new DomainError(
      "failed-precondition",
      "Operação excede o limite de saldo permitido."
    );
  }
  return sum;
}

/** Exact subtraction. */
export function subtractCentavos(a: number, b: number): number {
  assertSafeCentavos(a);
  assertSafeCentavos(b);
  return a - b;
}

function assertSafeCentavos(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(
      "failed-precondition",
      "Valor monetário interno inválido."
    );
  }
}
