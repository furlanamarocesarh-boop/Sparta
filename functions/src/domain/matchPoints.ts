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
 * SHARES, NOT AMOUNTS. A slice is basis points of the prize, so changing the
 * prize rescales the split instead of leaving three absolute figures that no
 * longer add up. They must total EXACTLY 100 %: a distribution that quietly
 * summed to 97 % would strand money with no rule for where it went.
 *
 * EVERY NUMBER IS AN INTEGER. Points are whole; money is integer centavos.
 * Nothing here divides money without deciding, explicitly, who gets the
 * remainder — see `splitPrize`.
 */

/** Ceilings. Not capacity plans — bounds that keep a hostile payload finite. */
export const MAX_MATCHES = 50;
export const MAX_KILL_POINTS = 1_000;
export const MAX_PLACEMENT_POINTS = 10_000;
export const MAX_RANKED_PLACEMENTS = 100;
export const MAX_PRIZE_SLICES = 50;
export const BPS_TOTAL = 10_000;

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
  /** Share of the prize, in basis points. */
  readonly shareBps: number;
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
  | "shares-must-total-100"
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
 * Whether a prize distribution is usable.
 *
 * POSITIONS MUST BE 1..N WITH NO GAPS. Paying 1st and 3rd but not 2nd is not a
 * split anybody means to configure — it is a typo, and one that a player would
 * discover by not being paid.
 */
export function checkPrizeDistribution(
  slices: readonly PrizeSlice[]
): ConfigCheck {
  if (!Array.isArray(slices) || slices.length === 0) {
    return { ok: false, reason: "empty-distribution" };
  }
  if (slices.length > MAX_PRIZE_SLICES) {
    return { ok: false, reason: "too-many-slices" };
  }

  const seen = new Set<number>();
  let total = 0;
  for (const slice of slices) {
    if (
      !isWholeInRange(slice?.position, 1, MAX_PRIZE_SLICES) ||
      !isWholeInRange(slice?.shareBps, 1, BPS_TOTAL)
    ) {
      return { ok: false, reason: "bad-slice" };
    }
    if (seen.has(slice.position)) {
      return { ok: false, reason: "duplicate-position" };
    }
    seen.add(slice.position);
    total += slice.shareBps;
  }

  for (let position = 1; position <= slices.length; position += 1) {
    if (!seen.has(position)) {
      return { ok: false, reason: "non-consecutive-positions" };
    }
  }

  if (total !== BPS_TOTAL) {
    return { ok: false, reason: "shares-must-total-100" };
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
 * Splits the prize across the standings.
 *
 * THE REMAINDER GOES TO FIRST PLACE, deterministically. Basis points of an odd
 * number of centavos never divide evenly — 100 centavos split 1/3 leaves one
 * over — and the alternatives are worse: dropping it loses money from the pool
 * every settlement, and spreading it needs a second rule nobody can predict.
 * One documented recipient means the sum ALWAYS equals the prize exactly, which
 * is the property that lets a settlement be checked.
 */
export function splitPrize(
  prizeCentavos: number,
  slices: readonly PrizeSlice[],
  standings: readonly Standing[]
): PrizeSplit {
  if (
    !Number.isInteger(prizeCentavos) ||
    prizeCentavos < 0 ||
    checkPrizeDistribution(slices).ok === false
  ) {
    return { awards: [], paidCentavos: 0, unclaimedCentavos: 0 };
  }

  const ordered = [...slices].sort((a, b) => a.position - b.position);

  const awards: PrizeAward[] = [];
  let assigned = 0;
  let unclaimed = 0;

  for (const slice of ordered) {
    const centavos = Math.floor((prizeCentavos * slice.shareBps) / BPS_TOTAL);
    assigned += centavos;
    const winner = standings[slice.position - 1];
    if (winner === undefined) {
      unclaimed += centavos;
      continue;
    }
    awards.push({ uid: winner.uid, position: slice.position, centavos });
  }

  // The floors leave a remainder. It belongs to first place if first place was
  // actually claimed; otherwise it joins the unclaimed money rather than being
  // invented onto somebody else.
  const remainder = prizeCentavos - assigned;
  if (remainder > 0) {
    if (awards.length > 0 && awards[0].position === 1) {
      awards[0] = {
        ...awards[0],
        centavos: awards[0].centavos + remainder,
      };
    } else {
      unclaimed += remainder;
    }
  }

  const paid = awards.reduce((sum, award) => sum + award.centavos, 0);
  return { awards, paidCentavos: paid, unclaimedCentavos: unclaimed };
}
