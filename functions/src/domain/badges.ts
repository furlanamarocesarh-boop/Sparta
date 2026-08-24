/**
 * Rare items: badges now, avatars later.
 *
 * ONE INVENTORY, NOT THREE SYSTEMS. Badges, avatars and whatever comes next are
 * all the same shape — a thing an account owns, earned at a moment, that may
 * carry a reward. Modelling badges alone would make the avatar a rewrite, so
 * the type is `RareItem` and a badge is one kind of it.
 *
 * EARNED IS FOREVER. Every threshold here counts something that can go DOWN: a
 * referred player can delete their account, a tournament can be cancelled. A
 * badge that vanishes because someone else deleted an account punishes a person
 * for something they did do, and turns support into archaeology. So awards are
 * a HIGH-WATER MARK: once the threshold is met the item is granted and stored,
 * and nothing in this module can take it back.
 *
 * THE THRESHOLDS ARE DATA. Adding a tier is one row in a table, not a branch —
 * because there will be more, and the fifteenth badge should cost what the
 * first one did.
 */

export type BadgeTrack = "creator" | "partner" | "player";

/** What a track counts. Named so the source is unmistakable at the call site. */
export type BadgeMetric =
  /** Tournaments this account created. */
  | "tournamentsCreated"
  /**
   * Players this account brought who COUNT — attributed, registration
   * complete, and past `PLAYER_COUNTS_AFTER_TOURNAMENTS`. Never raw signups.
   */
  | "playersBrought"
  /** Tournaments this account played in. */
  | "tournamentsPlayed"
  /** Simply being an approved partner. */
  | "isPartner";

export interface BadgeDefinition {
  readonly id: string;
  readonly track: BadgeTrack;
  readonly metric: BadgeMetric;
  /** The count at which it is earned. `isPartner` uses 1 = yes. */
  readonly threshold: number;
  readonly name: string;
  /**
   * A reward attached to the badge, or null.
   *
   * DELIBERATELY OPAQUE AND OPTIONAL. Two tiers are meant to pay something that
   * has not been decided, and encoding "there is a prize" without encoding what
   * it is lets that decision arrive later as DATA rather than as a change to
   * the engine. Null means no reward, never "reward unknown" — an undecided
   * reward is recorded here as null until it is decided.
   */
  readonly reward: string | null;
}

/**
 * THE TABLE. Order within a track is ascending by threshold, which
 * `highestEarned` relies on.
 */
export const BADGES: readonly BadgeDefinition[] = [
  // ── Criador: campeonatos CRIADOS (não concluídos).
  { id: "creator_verified", track: "creator", metric: "tournamentsCreated", threshold: 10, name: "Criador verificado", reward: null },
  { id: "creator_junior", track: "creator", metric: "tournamentsCreated", threshold: 100, name: "Criador junior", reward: null },
  { id: "creator_semi_pro", track: "creator", metric: "tournamentsCreated", threshold: 500, name: "Criador semi profissional", reward: null },
  { id: "creator_pro", track: "creator", metric: "tournamentsCreated", threshold: 1_000, name: "Criador profissional", reward: null },
  { id: "creator_legend", track: "creator", metric: "tournamentsCreated", threshold: 2_000, name: "Criador lendário", reward: null },

  // ── Colaborador: o primeiro é só ser aprovado; os demais contam gente.
  { id: "partner_noobie", track: "partner", metric: "isPartner", threshold: 1, name: "Colaborador noobie", reward: null },
  { id: "partner_junior", track: "partner", metric: "playersBrought", threshold: 100, name: "Colaborador junior", reward: null },
  { id: "partner_semi_pro", track: "partner", metric: "playersBrought", threshold: 1_000, name: "Colaborador semi profissional", reward: null },
  { id: "partner_pro", track: "partner", metric: "playersBrought", threshold: 5_000, name: "Colaborador profissional", reward: null },
  { id: "partner_legend", track: "partner", metric: "playersBrought", threshold: 10_000, name: "Colaborador lendário", reward: null },

  // ── Jogador: campeonatos JOGADOS.
  { id: "spartan_noobie", track: "player", metric: "tournamentsPlayed", threshold: 50, name: "Spartano noobie", reward: null },
  { id: "spartan_junior", track: "player", metric: "tournamentsPlayed", threshold: 500, name: "Spartano junior", reward: null },
  { id: "spartan_semi_pro", track: "player", metric: "tournamentsPlayed", threshold: 1_500, name: "Spartano semi profissional", reward: null },
  { id: "spartan_pro", track: "player", metric: "tournamentsPlayed", threshold: 3_000, name: "Spartano profissional", reward: null },
  { id: "spartan_legend", track: "player", metric: "tournamentsPlayed", threshold: 5_000, name: "Spartano lendário", reward: null },
];

/**
 * How many tournaments a referred player must have played before they count
 * toward a partner's tier.
 *
 * WHY A FLOOR AT ALL. A signup costs nothing, and the partner tiers carry
 * prizes — so counting raw signups would pay for creating accounts. Five
 * tournaments costs five entry fees, which makes the metric expensive to
 * forge with exactly the money the forgery is trying to win.
 *
 * It is also the strongest "real account" test this backend has: no profile
 * field proves an account is genuine, and playing five tournaments does.
 */
export const PLAYER_COUNTS_AFTER_TOURNAMENTS = 5;

/**
 * Whether one referred player counts toward the partner who brought them.
 *
 * `registrationComplete` is supplied by the caller rather than derived here,
 * because what makes a registration "complete" is not yet decided and has no
 * field in this backend today — see the note where this is called. Passing it
 * in means the answer plugs in later without touching this rule.
 */
export function referredPlayerCounts(input: {
  readonly tournamentsPlayed: number;
  readonly registrationComplete: boolean;
}): boolean {
  return (
    input.registrationComplete &&
    isUsableCount(input.tournamentsPlayed) &&
    input.tournamentsPlayed >= PLAYER_COUNTS_AFTER_TOURNAMENTS
  );
}

/** Everything an account has done, as the badge rules need to see it. */
export interface BadgeCounts {
  readonly tournamentsCreated: number;
  readonly playersBrought: number;
  readonly tournamentsPlayed: number;
  readonly isPartner: boolean;
}

/** Which badges these counts qualify for, ignoring what is already owned. */
export function qualifiedBadges(
  counts: BadgeCounts
): readonly BadgeDefinition[] {
  return BADGES.filter((badge) => {
    const value = counts[
      badge.metric === "isPartner" ? "isPartner" : badge.metric
    ];
    const numeric = typeof value === "boolean" ? (value ? 1 : 0) : value;
    return isUsableCount(numeric) && numeric >= badge.threshold;
  });
}

/**
 * The badges to GRANT now: qualified, minus already owned.
 *
 * Returning only the new ones is what makes granting idempotent — running this
 * every day writes nothing on a day nothing changed.
 */
export function badgesToAward(
  counts: BadgeCounts,
  owned: readonly string[]
): readonly BadgeDefinition[] {
  const has = new Set(owned);
  return qualifiedBadges(counts).filter((badge) => !has.has(badge.id));
}

/**
 * The top badge of a track among those OWNED — the one worth displaying.
 *
 * Reads from what is owned rather than from current counts, so a player whose
 * referred accounts vanished still shows the tier they reached. That is the
 * high-water mark made visible.
 */
export function highestEarned(
  track: BadgeTrack,
  owned: readonly string[]
): BadgeDefinition | null {
  const has = new Set(owned);
  let best: BadgeDefinition | null = null;
  for (const badge of BADGES) {
    if (badge.track !== track || !has.has(badge.id)) continue;
    if (best === null || badge.threshold >= best.threshold) best = badge;
  }
  return best;
}

/** The next tier of a track, for a "faltam N" line. Null when maxed. */
export function nextTier(
  track: BadgeTrack,
  owned: readonly string[]
): BadgeDefinition | null {
  const has = new Set(owned);
  for (const badge of BADGES) {
    if (badge.track === track && !has.has(badge.id)) return badge;
  }
  return null;
}

export function badgeById(id: string): BadgeDefinition | null {
  return BADGES.find((b) => b.id === id) ?? null;
}

/**
 * A count this module is willing to act on.
 *
 * A negative or fractional count is corrupt, and awarding a permanent badge
 * from a corrupt number is not something a later fix can undo. Unusable counts
 * qualify for NOTHING rather than being clamped to zero — clamping would hide
 * the fault while looking like a legitimate "not yet".
 */
function isUsableCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
