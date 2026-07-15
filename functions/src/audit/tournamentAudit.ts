import {
  CANONICAL_CURRENT,
  CANONICAL_MAX,
  LEGACY_CURRENT,
  LEGACY_MAX,
} from "../domain/tournamentFields.js";

/**
 * Tournament participant-field auditing — pure, no Firebase.
 *
 * The field names come from `tournamentFields.ts` rather than being retyped, so
 * the auditor and the runtime can never look at different fields.
 *
 * This module CLASSIFIES; it does not decide whether a join is allowed (that is
 * `readParticipantCounts`). It answers a different question: "what shape is the
 * existing data in, and would the hardened backend choke on it?"
 */

/** How a document's participant fields are laid out. */
export type ShapeCategory =
  /** Only current_participants + max_participants. */
  | "canonical-only"
  /** Only current_players + max_players (what deployed createTournament wrote). */
  | "legacy-only"
  /** Both pairs present and in agreement. Ideal. */
  | "both-matching"
  /** Both pairs present but contradicting each other. The backend will refuse. */
  | "both-diverging"
  /** A pair is half-written, e.g. a max with no current. */
  | "partial"
  /** Neither a canonical nor a legacy capacity exists. */
  | "capacity-missing";

/** Value-level defects, independent of the shape. */
export type ValueProblem =
  | "non-integer"
  | "negative"
  | "current-exceeds-max";

export interface TournamentFinding {
  /** Document id. Only ever emitted when the operator passes --show-ids. */
  readonly id: string;
  readonly shape: ShapeCategory;
  readonly valueProblems: readonly ValueProblem[];
  /** True when this document would break the hardened jointournament. */
  readonly blocking: boolean;
}

type Doc = Record<string, unknown>;

const present = (value: unknown): boolean =>
  value !== undefined && value !== null;

/** A count is only usable if it is a non-negative safe integer. */
const isUsableCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function auditTournamentDocument(id: string, data: Doc): TournamentFinding {
  const hasCanonicalCurrent = present(data[CANONICAL_CURRENT]);
  const hasCanonicalMax = present(data[CANONICAL_MAX]);
  const hasLegacyCurrent = present(data[LEGACY_CURRENT]);
  const hasLegacyMax = present(data[LEGACY_MAX]);

  const shape = classifyShape(
    hasCanonicalCurrent,
    hasCanonicalMax,
    hasLegacyCurrent,
    hasLegacyMax,
    data
  );

  const valueProblems = findValueProblems(data);

  // A document is blocking when the hardened backend would refuse to act on it:
  // it cannot determine a capacity, the two pairs contradict each other, or a
  // value is not a usable count. `current > max` is reported but is NOT
  // blocking — jointournament already treats it as "full" and rejects the join,
  // which is the safe outcome, not a crash.
  const blocking =
    shape === "capacity-missing" ||
    shape === "both-diverging" ||
    shape === "partial" ||
    valueProblems.includes("non-integer") ||
    valueProblems.includes("negative");

  return { id, shape, valueProblems, blocking };
}

function classifyShape(
  hasCanonicalCurrent: boolean,
  hasCanonicalMax: boolean,
  hasLegacyCurrent: boolean,
  hasLegacyMax: boolean,
  data: Doc
): ShapeCategory {
  const canonicalComplete = hasCanonicalCurrent && hasCanonicalMax;
  const legacyComplete = hasLegacyCurrent && hasLegacyMax;
  const canonicalPartial =
    (hasCanonicalCurrent || hasCanonicalMax) && !canonicalComplete;
  const legacyPartial = (hasLegacyCurrent || hasLegacyMax) && !legacyComplete;

  // No capacity at all — not from either pair. This is the one the backend can
  // never guess its way out of, and must never default to 0.
  if (!hasCanonicalMax && !hasLegacyMax) {
    return "capacity-missing";
  }

  if (canonicalComplete && legacyComplete) {
    const sameCurrent = data[CANONICAL_CURRENT] === data[LEGACY_CURRENT];
    const sameMax = data[CANONICAL_MAX] === data[LEGACY_MAX];
    return sameCurrent && sameMax ? "both-matching" : "both-diverging";
  }

  // A half-written pair (e.g. max without current) is reported separately from
  // a clean single-pair document: it is a corrupt write, not a legacy one.
  if (canonicalPartial || legacyPartial) {
    return "partial";
  }

  return canonicalComplete ? "canonical-only" : "legacy-only";
}

function findValueProblems(data: Doc): ValueProblem[] {
  const problems: ValueProblem[] = [];
  const keys = [
    CANONICAL_CURRENT,
    CANONICAL_MAX,
    LEGACY_CURRENT,
    LEGACY_MAX,
  ];

  let nonInteger = false;
  let negative = false;

  for (const key of keys) {
    const value = data[key];
    if (!present(value)) continue;

    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      nonInteger = true;
      continue;
    }
    if (value < 0) {
      negative = true;
    }
  }

  if (nonInteger) problems.push("non-integer");
  if (negative) problems.push("negative");

  // Compare only when both sides of a pair are usable, otherwise the comparison
  // would be meaningless (and would double-report an already-flagged defect).
  if (exceeds(data[CANONICAL_CURRENT], data[CANONICAL_MAX])) {
    problems.push("current-exceeds-max");
  } else if (exceeds(data[LEGACY_CURRENT], data[LEGACY_MAX])) {
    problems.push("current-exceeds-max");
  }

  return problems;
}

function exceeds(current: unknown, max: unknown): boolean {
  if (!isUsableCount(current) || !isUsableCount(max)) return false;
  return (current as number) > (max as number);
}
