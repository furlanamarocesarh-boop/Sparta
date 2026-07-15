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
 * Everything that can be wrong with a monetary value, as data rather than as an
 * exception.
 *
 * This exists so the read-only data audit can *classify* a bad value instead of
 * merely failing on it — and, crucially, so it does so using THIS module's rules
 * rather than a second copy of them. There is exactly one definition of "valid
 * money" in the codebase: [inspectReais].
 */
export type MoneyProblem =
  | "missing"
  | "not-a-number"
  | "nan"
  | "infinite"
  | "negative"
  | "zero-not-allowed"
  | "too-many-decimals"
  | "unsafe"
  | "above-limit";

export type MoneyInspection =
  | { readonly ok: true; readonly centavos: number }
  | { readonly ok: false; readonly problem: MoneyProblem };

/**
 * Inspects a value in reais WITHOUT throwing, returning either the exact
 * centavos or the specific reason it is unusable.
 *
 * [toCentavos] is a thin wrapper over this, so the validation rules and their
 * order are defined once and shared by the callables and the auditor.
 */
export function inspectReais(
  value: unknown,
  options: { allowZero?: boolean; maxCentavos?: number } = {}
): MoneyInspection {
  const { allowZero = false, maxCentavos = MAX_CENTAVOS } = options;

  if (value === undefined || value === null) {
    return { ok: false, problem: "missing" };
  }

  // `typeof NaN === "number"`, so this only rejects strings/booleans/objects.
  // NaN and Infinity are caught below.
  if (typeof value !== "number") {
    return { ok: false, problem: "not-a-number" };
  }

  if (Number.isNaN(value)) {
    return { ok: false, problem: "nan" };
  }

  if (!Number.isFinite(value)) {
    return { ok: false, problem: "infinite" };
  }

  if (value < 0) {
    return { ok: false, problem: "negative" };
  }

  if (value === 0 && !allowZero) {
    return { ok: false, problem: "zero-not-allowed" };
  }

  const scaled = value * 100;

  // Guard before rounding: a value large enough to lose integer precision
  // cannot be trusted, and Math.round would happily return a wrong answer.
  if (!Number.isSafeInteger(Math.round(scaled))) {
    return { ok: false, problem: "unsafe" };
  }

  const centavos = Math.round(scaled);

  if (Math.abs(scaled - centavos) > SCALE_EPSILON) {
    return { ok: false, problem: "too-many-decimals" };
  }

  if (centavos > maxCentavos) {
    return { ok: false, problem: "above-limit" };
  }

  return { ok: true, centavos };
}

/**
 * Converts a validated amount in reais into exact integer centavos.
 *
 * Rejects (never silently truncates): non-numbers, NaN, Infinity, negatives,
 * more than two decimal places, unsafe integers, and values above the limit.
 *
 * The rules live in [inspectReais]; this only turns a problem into the
 * DomainError (and the exact pt-BR message) the callables already return.
 */
export function toCentavos(value: unknown, options: ToCentavosOptions): number {
  const { field, allowZero = false, maxCentavos = MAX_CENTAVOS } = options;

  const inspection = inspectReais(value, { allowZero, maxCentavos });

  if (inspection.ok) {
    return inspection.centavos;
  }

  throw invalidArgument(messageFor(inspection.problem, field));
}

/** The player-facing message for each problem. Unchanged from before. */
function messageFor(problem: MoneyProblem, field: string): string {
  switch (problem) {
    // A missing value and a non-number are the same mistake to a caller.
    case "missing":
    case "not-a-number":
      return `O ${field} precisa ser um número.`;
    case "nan":
    case "infinite":
      return `O ${field} é inválido.`;
    case "negative":
      return `O ${field} não pode ser negativo.`;
    case "zero-not-allowed":
      return `O ${field} precisa ser maior que zero.`;
    case "unsafe":
      return `O ${field} é grande demais.`;
    case "too-many-decimals":
      return `O ${field} pode ter no máximo 2 casas decimais.`;
    case "above-limit":
      return `O ${field} está acima do limite permitido.`;
  }
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
