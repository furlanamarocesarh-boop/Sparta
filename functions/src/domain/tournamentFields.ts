import { failedPrecondition } from "./errors.js";

/**
 * Tournament participant fields.
 *
 * THE PROBLEM THIS SOLVES: the deployed backend disagrees with itself.
 * `createTournament` writes `current_players` / `max_players`, while
 * `jointournament` reads `current_participants` / `max_participants`. A
 * tournament created through `createTournament` therefore looked to
 * `jointournament` like it had a max of 0, and every registration was rejected
 * with "Limite de participantes inválido."
 *
 * TRANSITION STRATEGY (no data migration required):
 *  - CANONICAL: `current_participants` / `max_participants`.
 *  - LEGACY (still read): `current_players` / `max_players`.
 *  - New tournaments write BOTH pairs with identical values, so old clients
 *    and old queries keep working.
 *  - Reads prefer canonical, fall back to legacy, and REFUSE to guess when the
 *    two pairs disagree — a silent wrong answer about capacity is how a
 *    tournament gets oversold.
 *
 * A missing limit is never treated as 0 (that would look like "full" and reject
 * everyone) nor as unlimited (that would oversell). It is an explicit failure.
 */

export const CANONICAL_CURRENT = "current_participants";
export const CANONICAL_MAX = "max_participants";
export const LEGACY_CURRENT = "current_players";
export const LEGACY_MAX = "max_players";

export interface ParticipantCounts {
  readonly current: number;
  readonly max: number;
}

type Doc = Record<string, unknown>;

/**
 * Resolves the participant counts of a tournament document.
 *
 * @throws DomainError('failed-precondition') when the fields are missing,
 *   invalid, or the canonical and legacy pairs contradict each other.
 */
export function readParticipantCounts(data: Doc): ParticipantCounts {
  const current = resolveField(
    data,
    CANONICAL_CURRENT,
    LEGACY_CURRENT,
    "Número atual de participantes inválido.",
    { requiredPositive: false }
  );

  const max = resolveField(
    data,
    CANONICAL_MAX,
    LEGACY_MAX,
    "Limite de participantes inválido.",
    { requiredPositive: true }
  );

  return { current, max };
}

/** True when the tournament has no room left. */
export function isFull(counts: ParticipantCounts): boolean {
  return counts.current >= counts.max;
}

/**
 * The fields to write when a registration succeeds.
 *
 * Both pairs are advanced together so the two representations can never drift
 * apart. Returns absolute values (not increments) because the caller has
 * already read the current count inside the transaction.
 */
export function participantIncrementUpdate(
  counts: ParticipantCounts
): Record<string, number> {
  const next = counts.current + 1;
  return {
    [CANONICAL_CURRENT]: next,
    [LEGACY_CURRENT]: next,
  };
}

/** The participant fields a newly created tournament must write. */
export function newTournamentParticipantFields(
  maxParticipants: number
): Record<string, number> {
  return {
    [CANONICAL_CURRENT]: 0,
    [CANONICAL_MAX]: maxParticipants,
    // Legacy mirror — keeps the previous client and any existing query working.
    [LEGACY_CURRENT]: 0,
    [LEGACY_MAX]: maxParticipants,
  };
}

function resolveField(
  data: Doc,
  canonicalKey: string,
  legacyKey: string,
  errorMessage: string,
  options: { requiredPositive: boolean }
): number {
  const hasCanonical = isPresent(data[canonicalKey]);
  const hasLegacy = isPresent(data[legacyKey]);

  if (!hasCanonical && !hasLegacy) {
    // Explicitly NOT defaulted to 0. A missing capacity is a broken document,
    // and guessing either way corrupts the tournament.
    throw failedPrecondition(errorMessage);
  }

  const canonical = hasCanonical
    ? validInteger(data[canonicalKey], errorMessage, options.requiredPositive)
    : undefined;
  const legacy = hasLegacy
    ? validInteger(data[legacyKey], errorMessage, options.requiredPositive)
    : undefined;

  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    // Both present and contradictory: we cannot know which one is true, and
    // picking one could oversell the tournament or lock players out. Fail.
    throw failedPrecondition(
      "Dados do torneio inconsistentes. Contate o suporte."
    );
  }

  return (canonical ?? legacy) as number;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function validInteger(
  value: unknown,
  errorMessage: string,
  requiredPositive: boolean
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw failedPrecondition(errorMessage);
  }
  if (value < 0) {
    throw failedPrecondition(errorMessage);
  }
  if (requiredPositive && value <= 0) {
    throw failedPrecondition(errorMessage);
  }
  return value;
}
