import { ECONOMY_CASH, type EconomyType } from "./economy.js";
import { FIRST_ACTIVE_SEASON_ID, seasonWindow } from "./seasonRanking.js";

/**
 * Season placement badges — the trophy for where you finished a month.
 *
 * ONE BADGE PER SEASON, decided deliberately. "Top 1" alone would be a trophy
 * with no date on it; `season_player_top1_2026-09` says which month was won,
 * and a second win in October is a second trophy rather than a no-op. The cost
 * is that the id space is INFINITE, so these ids can never live in the fixed
 * table `BADGES` — they are PARSED, not looked up, and every consumer that
 * asked "is this a real badge id" has to learn this second answer.
 *
 * CASH ONLY, decided deliberately. A placement badge is permanent and public,
 * and awarding one for topping a play-money board would spend the trophy's
 * meaning before the real economy exists. The consequence is stated plainly
 * rather than hidden: no production wallet holds cash today, so this engine
 * will correctly award NOTHING until real money moves. It accrues no debt and
 * grants no consolation prize in the meantime.
 *
 * BEST TIER ONLY, per season. Finishing second literally satisfies "top 3",
 * "top 10" and "top 100" as well, and handing out four trophies for one result
 * would bury the achievement in its own consolation prizes. Second place earns
 * exactly one badge: Top 2.
 *
 * AWARDED ONLY AFTER THE SEASON CLOSES. "You are third" is not a fact until the
 * month is over — mid-season it is a snapshot that tomorrow contradicts. There
 * is no scheduler in this backend and none is added: the placement is computed
 * on the next read after the month ended, which is the same read-and-grant
 * shape the rest of the badge engine already has, with no job to fall behind.
 */

/** Which ranking a placement came from. */
export type SeasonBadgeTrack = "player" | "creator";

/**
 * The economy a placement badge may be earned in.
 *
 * A CONSTANT, not a parameter. Making it configurable would invite a caller to
 * pass `beta_credit` and mint permanent trophies out of play money.
 */
export const SEASON_BADGE_ECONOMY: EconomyType = ECONOMY_CASH;

/**
 * The placements that earn a badge, best first.
 *
 * ORDER IS LOAD-BEARING: `placementTier` returns the FIRST match, which is why
 * the best tier is the one awarded.
 */
export const SEASON_BADGE_TIERS: readonly number[] = [1, 2, 3, 10, 100];

const SEASON_BADGE_PREFIX = "season";
const SEASON_ID_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** What a season badge id means, once parsed. */
export interface SeasonBadge {
  readonly track: SeasonBadgeTrack;
  /** The tier: 1, 2, 3, 10 or 100. Never an arbitrary rank. */
  readonly tier: number;
  readonly seasonId: string;
}

/** The canonical id, e.g. `season_player_top1_2026-09`. */
export function seasonBadgeId(badge: SeasonBadge): string {
  if (!SEASON_BADGE_TIERS.includes(badge.tier)) {
    throw new Error(`tier inválido para selo de temporada: ${badge.tier}`);
  }
  if (!SEASON_ID_PATTERN.test(badge.seasonId)) {
    throw new Error(`temporada inválida: ${badge.seasonId}`);
  }
  return `${SEASON_BADGE_PREFIX}_${badge.track}_top${badge.tier}_${badge.seasonId}`;
}

/**
 * Reads a season badge id, or null when it is not one.
 *
 * STRICT ON PURPOSE. This is what tells the rest of the system that an id
 * outside the fixed table is nonetheless real, so anything it accepts becomes
 * writable into a player's badge list. A tier of 7 or a season of `2026-13`
 * would render as a trophy nobody could ever have earned.
 */
export function parseSeasonBadgeId(value: unknown): SeasonBadge | null {
  if (typeof value !== "string") return null;

  const parts = value.split("_");
  if (parts.length !== 4) return null;
  const [prefix, track, top, seasonId] = parts;

  if (prefix !== SEASON_BADGE_PREFIX) return null;
  if (track !== "player" && track !== "creator") return null;
  if (!top.startsWith("top")) return null;

  const raw = top.slice(3);
  // `Number` would accept " 1", "1e0" and "01"; only exact digits are the id
  // this module writes, and accepting a second spelling means two ids for one
  // trophy.
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const tier = Number(raw);
  if (!SEASON_BADGE_TIERS.includes(tier)) return null;

  if (!SEASON_ID_PATTERN.test(seasonId)) return null;

  return { track, tier, seasonId };
}

/** Whether an id is a season badge. */
export function isSeasonBadgeId(value: unknown): boolean {
  return parseSeasonBadgeId(value) !== null;
}

/**
 * The tier a final rank earns, or null when it earns nothing.
 *
 * Rank 1 -> 1, rank 2 -> 2, rank 3 -> 3, ranks 4..10 -> 10, ranks 11..100 ->
 * 100, and anything beyond -> null. A non-integer or non-positive rank earns
 * nothing rather than being rounded into a trophy.
 */
export function placementTier(rank: unknown): number | null {
  if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1) {
    return null;
  }
  for (const tier of SEASON_BADGE_TIERS) {
    if (rank <= tier) return tier;
  }
  return null;
}

/** The badge a final rank earns in one season, or null. */
export function badgeForPlacement(
  track: SeasonBadgeTrack,
  seasonId: string,
  rank: unknown
): string | null {
  const tier = placementTier(rank);
  if (tier === null) return null;
  if (!SEASON_ID_PATTERN.test(seasonId)) return null;
  return seasonBadgeId({ track, tier, seasonId });
}

/**
 * Whether a season is over, and therefore final.
 *
 * The window comes from `seasonRanking`, so "which month" has exactly one
 * definition in this backend and the boundary is the same one the leaderboard
 * uses — including the timezone.
 */
export function isSeasonClosed(seasonId: string, now: Date): boolean {
  if (!SEASON_ID_PATTERN.test(seasonId)) return false;
  return seasonWindow(seasonId).end.getTime() <= now.getTime();
}

/** The month before [seasonId], as a season id. */
export function previousSeasonId(seasonId: string): string {
  const year = Number(seasonId.slice(0, 4));
  const month = Number(seasonId.slice(5, 7));
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** The month after [seasonId], as a season id. */
export function nextSeasonId(seasonId: string): string {
  const year = Number(seasonId.slice(0, 4));
  const month = Number(seasonId.slice(5, 7));
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * How many closed seasons one call may settle.
 *
 * A player returning after a year would otherwise make one badge read fan out
 * into a year of rank lookups. Twelve bounds the work, and the cursor means the
 * remainder is simply settled on the next call rather than lost.
 */
export const MAX_SEASONS_PER_SETTLEMENT = 12;

export interface SeasonsToSettleInput {
  /** `season_badges_through` from the account: the last season already settled. */
  readonly settledThrough: unknown;
  readonly now: Date;
}

/**
 * Which closed seasons still owe this account a placement check.
 *
 * NEVER BEFORE THE FIRST ACTIVE SEASON. Months before the ranking existed have
 * no entries, so asking about them would be a read that can only answer "no" —
 * and backfilling a trophy for a month that was never ranked would be inventing
 * a result.
 *
 * NEVER THE CURRENT MONTH. A placement is not a fact until the month is over.
 */
export function seasonsToSettle(input: SeasonsToSettleInput): string[] {
  const first = FIRST_ACTIVE_SEASON_ID;
  if (first === null) return [];

  const cursor =
    typeof input.settledThrough === "string" &&
    SEASON_ID_PATTERN.test(input.settledThrough) &&
    input.settledThrough >= first
      ? nextSeasonId(input.settledThrough)
      : first;

  const out: string[] = [];
  let season = cursor;
  while (out.length < MAX_SEASONS_PER_SETTLEMENT) {
    if (!isSeasonClosed(season, input.now)) break;
    out.push(season);
    season = nextSeasonId(season);
  }
  return out;
}
