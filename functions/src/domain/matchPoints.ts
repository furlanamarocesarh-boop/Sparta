/**
 * Multi-match tournaments: points, standings and prize by placement.
 *
 * WHAT A CHAMPIONSHIP ACTUALLY IS. A Battle Royale tournament is several
 * matches, and a player's result is the sum across them: points for each kill,
 * points for where they finished each match. The winner is whoever has the most
 * points at the end — not whoever won the last match.
 *
 * THE PRIZE SPLIT IS THE CREATOR'S, ALWAYS, and it is NOT a multi-match
 * feature. A single-match tournament may equally pay 1st, 2nd and 3rd. So the
 * distribution lives on the tournament and applies whether there is one match
 * or twelve; `matchesCount: 1` is a normal tournament, not a special case.
 *
 * AMOUNTS, NOT SHARES. A slice is the money that position receives, in integer
 * centavos, exactly as the creator typed it. This was basis points first, and
 * the round trip was the problem: R$ 3,00 split as R$ 1,00 / R$ 1,00 / R$ 1,00
 * is 3333 bps three times, which is 9999 — so one slice had to be nudged to
 * 3334, and first place got R$ 1,02 for a split the creator wrote as equal.
 * Storing what was typed means the payout IS what was typed, and it deletes
 * the remainder rule instead of documenting it.
 *
 * THE SUM MUST EQUAL THE PRIZE EXACTLY, which is the same guarantee 100 % gave
 * and is checked where both numbers exist — at creation. A split totalling less
 * than the prize would strand money with no rule for where it went; more would
 * promise money the tournament never collected.
 *
 * EVERY NUMBER IS AN INTEGER. Points are whole; money is integer centavos.
 */

/** Ceilings. Not capacity plans — bounds that keep a hostile payload finite. */
export const MAX_MATCHES = 50;
export const MAX_KILL_POINTS = 1_000;
export const MAX_PLACEMENT_POINTS = 10_000;
export const MAX_RANKED_PLACEMENTS = 100;
export const MAX_PRIZE_SLICES = 50;

/**
 * The most one position may be configured to receive, in centavos.
 *
 * The tournament's own prize already bounds a real split — the sum has to
 * equal it. This ceiling is for the case where there IS no prize to bound
 * against: a saved preset, which carries amounts and no tournament.
 */
export const MAX_SLICE_CENTAVOS = 100_000_000;

/** What a kill and a finishing position are worth. */
export interface PointsConfig {
  /** Points per kill. Zero is legitimate: a placement-only championship. */
  readonly killPoints: number;
  /**
   * Points by finishing position, best first. Index 0 is 1st place.
   *
   * SHORTER THAN THE LOBBY IS NORMAL: positions past the end score zero, which
   * is how every real format works — only the top places are worth points.
   */
  readonly placementPoints: readonly number[];
}

/** One paying position. */
export interface PrizeSlice {
  /** 1-based finishing position in the FINAL standings. */
  readonly position: number;
  /** What that position receives, in integer centavos. Never zero: a position
   * that receives nothing is not a paying position. */
  readonly centavos: number;
}

export type ConfigRefusal =
  | "bad-matches-count"
  | "bad-kill-points"
  | "bad-placement-points"
  | "too-many-placements"
  | "empty-distribution"
  | "bad-slice"
  | "duplicate-position"
  | "non-consecutive-positions"
  | "must-total-prize"
  | "too-many-slices";

export type ConfigCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ConfigRefusal };

function isWholeInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Whether a tournament's scoring rules are usable. */
export function checkPointsConfig(
  matchesCount: unknown,
  config: PointsConfig
): ConfigCheck {
  if (!isWholeInRange(matchesCount, 1, MAX_MATCHES)) {
    return { ok: false, reason: "bad-matches-count" };
  }
  if (!isWholeInRange(config.killPoints, 0, MAX_KILL_POINTS)) {
    return { ok: false, reason: "bad-kill-points" };
  }
  if (!Array.isArray(config.placementPoints)) {
    return { ok: false, reason: "bad-placement-points" };
  }
  if (config.placementPoints.length > MAX_RANKED_PLACEMENTS) {
    return { ok: false, reason: "too-many-placements" };
  }
  for (const points of config.placementPoints) {
    if (!isWholeInRange(points, 0, MAX_PLACEMENT_POINTS)) {
      return { ok: false, reason: "bad-placement-points" };
    }
  }
  return { ok: true };
}

/**
 * Whether a distribution's SHAPE is usable, ignoring the total.
 *
 * Separate from the total on purpose: a saved preset carries amounts and no
 * tournament, so there is no prize to check the sum against. Everything that
 * can be judged without one is judged here.
 *
 * POSITIONS MUST BE 1..N WITH NO GAPS. Paying 1st and 3rd but not 2nd is not a
 * split anybody means to configure — it is a typo, and one that a player would
 * discover by not being paid.
 */
export function checkPrizeSlices(
  slices: readonly PrizeSlice[]
): ConfigCheck {
  if (!Array.isArray(slices) || slices.length === 0) {
    return { ok: false, reason: "empty-distribution" };
  }
  if (slices.length > MAX_PRIZE_SLICES) {
    return { ok: false, reason: "too-many-slices" };
  }

  const seen = new Set<number>();
  for (const slice of slices) {
    if (
      !isWholeInRange(slice?.position, 1, MAX_PRIZE_SLICES) ||
      !isWholeInRange(slice?.centavos, 1, MAX_SLICE_CENTAVOS)
    ) {
      return { ok: false, reason: "bad-slice" };
    }
    if (seen.has(slice.position)) {
      return { ok: false, reason: "duplicate-position" };
    }
    seen.add(slice.position);
  }

  for (let position = 1; position <= slices.length; position += 1) {
    if (!seen.has(position)) {
      return { ok: false, reason: "non-consecutive-positions" };
    }
  }

  return { ok: true };
}

/** What a distribution pays in total, in centavos. */
export function totalDistributed(slices: readonly PrizeSlice[]): number {
  return slices.reduce(
    (sum, slice) => sum + (Number.isInteger(slice?.centavos) ? slice.centavos : 0),
    0
  );
}

/**
 * Whether a distribution is usable FOR A GIVEN PRIZE.
 *
 * The sum has to match to the centavo. Less would strand money with no rule
 * for where it went; more would promise money the tournament never collected —
 * and the settlement would discover that with a player already told they won.
 */
export function checkPrizeDistribution(
  slices: readonly PrizeSlice[],
  prizeCentavos: number
): ConfigCheck {
  const shape = checkPrizeSlices(slices);
  if (!shape.ok) return shape;

  if (
    !Number.isInteger(prizeCentavos) ||
    totalDistributed(slices) !== prizeCentavos
  ) {
    return { ok: false, reason: "must-total-prize" };
  }
  return { ok: true };
}

/** One player's line in one match. */
export interface MatchEntry {
  readonly uid: string;
  readonly kills: number;
  /** 1-based finishing position in THAT match. */
  readonly placement: number;
}

/** Everything reported for one match. */
export interface MatchResult {
  /** 1-based, and unique within a tournament. */
  readonly matchNumber: number;
  readonly entries: readonly MatchEntry[];
}

/** A player's total across every match played. */
export interface Standing {
  readonly uid: string;
  readonly points: number;
  readonly kills: number;
  /** The best (lowest) placement reached in any match. Tie-break only. */
  readonly bestPlacement: number;
  /** How many matches this player was reported in. */
  readonly matchesPlayed: number;
}

/** What one finishing position scores. Positions past the table score zero. */
export function placementPointsFor(
  config: PointsConfig,
  placement: number
): number {
  if (!Number.isInteger(placement) || placement < 1) return 0;
  const points = config.placementPoints[placement - 1];
  return typeof points === "number" && Number.isInteger(points) && points >= 0
    ? points
    : 0;
}

/**
 * The final standings, best first.
 *
 * THE TIE-BREAK IS TOTAL AND DETERMINISTIC, in this order: more points, then
 * more kills, then a better single-match placement, then the uid. Every real
 * format needs the first three; the uid is there so that two players who are
 * genuinely identical still get a STABLE order. Without a total order the same
 * results could rank two ways on two reads, and one of them would be paid.
 *
 * A PLAYER MISSING FROM A MATCH SCORES NOTHING FOR IT rather than being
 * dropped: turning up to four of six matches is a result, not an absence.
 *
 * ENTRIES ARE SUMMED, NOT REPLACED. The same uid twice in one match is the
 * operator reporting a correction, and refusing it here would leave them no way
 * to fix a typo — validation of that belongs where results are accepted.
 */
export function computeStandings(
  config: PointsConfig,
  matches: readonly MatchResult[]
): Standing[] {
  const byUid = new Map<string, {
    points: number;
    kills: number;
    best: number;
    played: number;
  }>();

  for (const match of matches) {
    for (const entry of match.entries) {
      if (typeof entry.uid !== "string" || entry.uid === "") continue;
      const kills =
        Number.isInteger(entry.kills) && entry.kills >= 0 ? entry.kills : 0;
      const placement =
        Number.isInteger(entry.placement) && entry.placement >= 1
          ? entry.placement
          : 0;

      const row = byUid.get(entry.uid) ?? {
        points: 0,
        kills: 0,
        best: Number.MAX_SAFE_INTEGER,
        played: 0,
      };
      row.points +=
        kills * config.killPoints + placementPointsFor(config, placement);
      row.kills += kills;
      if (placement >= 1) row.best = Math.min(row.best, placement);
      row.played += 1;
      byUid.set(entry.uid, row);
    }
  }

  return [...byUid.entries()]
    .map(([uid, row]) => ({
      uid,
      points: row.points,
      kills: row.kills,
      bestPlacement:
        row.best === Number.MAX_SAFE_INTEGER ? 0 : row.best,
      matchesPlayed: row.played,
    }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.kills !== a.kills) return b.kills - a.kills;
      // A best placement of 0 means "never placed", which loses to any real one.
      const aBest = a.bestPlacement === 0 ? Number.MAX_SAFE_INTEGER : a.bestPlacement;
      const bBest = b.bestPlacement === 0 ? Number.MAX_SAFE_INTEGER : b.bestPlacement;
      if (aBest !== bBest) return aBest - bBest;
      return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
    });
}

/** What one player is owed. */
export interface PrizeAward {
  readonly uid: string;
  /** 1-based position in the final standings. */
  readonly position: number;
  readonly centavos: number;
}

export interface PrizeSplit {
  readonly awards: readonly PrizeAward[];
  /** Paid out in total. Never more than the prize. */
  readonly paidCentavos: number;
  /**
   * Slices with nobody to pay, in centavos.
   *
   * NOT REDISTRIBUTED. Fewer players than paying positions is the operator's
   * situation to resolve, and silently moving third place's money to first
   * would pay somebody an amount nobody configured.
   */
  readonly unclaimedCentavos: number;
}

/**
 * Hands each position what it was configured to receive.
 *
 * NO ARITHMETIC ON MONEY. The amounts were decided when the tournament was
 * created and checked against the prize then; here they are only routed to
 * whoever finished in each place. That is the point of storing amounts instead
 * of percentages — there is no division, so there is no remainder, so there is
 * no rule about who gets it. What the creator typed is what gets paid.
 */
export function splitPrize(
  prizeCentavos: number,
  slices: readonly PrizeSlice[],
  standings: readonly Standing[]
): PrizeSplit {
  if (
    !Number.isInteger(prizeCentavos) ||
    prizeCentavos < 0 ||
    checkPrizeDistribution(slices, prizeCentavos).ok === false
  ) {
    return { awards: [], paidCentavos: 0, unclaimedCentavos: 0 };
  }

  const ordered = [...slices].sort((a, b) => a.position - b.position);

  const awards: PrizeAward[] = [];
  let unclaimed = 0;

  for (const slice of ordered) {
    const winner = standings[slice.position - 1];
    if (winner === undefined) {
      unclaimed += slice.centavos;
      continue;
    }
    awards.push({
      uid: winner.uid,
      position: slice.position,
      centavos: slice.centavos,
    });
  }

  const paid = awards.reduce((sum, award) => sum + award.centavos, 0);
  return { awards, paidCentavos: paid, unclaimedCentavos: unclaimed };
}
