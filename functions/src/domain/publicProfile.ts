/**
 * The public profile — what a STRANGER may learn about a player.
 *
 * THIS MODULE EXISTS TO BE A WALL. Every other read path in this backend
 * refuses to show one player anything about another: the Rules deny reading
 * someone else's `users/{uid}`, a tournament result does not name its winner to
 * a non-admin, and `getPartnerEarnings` returns counts rather than people. A
 * public profile deliberately opens a hole in that, so the hole is cut here, in
 * one place, by an allowlist — never by projecting a document and removing the
 * fields someone remembered to remove.
 *
 * ADDRESSED BY PSEUDONYM, NEVER BY UID. `publicPlayerId` is 22 random bytes,
 * not derived from anything, and the map back to the account is Rules-denied to
 * every client in both directions. So a profile link identifies a player
 * without handing over the identifier that every other collection is keyed by.
 *
 * NO MONEY. Not balance, not total won, not what a tournament paid. A profile
 * is a page a player sends to strangers, and "how much money does this person
 * have" is not something a stranger should be able to ask — even where the
 * season leaderboard already publishes a score.
 *
 * COUNTS, NOT HISTORY. How many tournaments someone played is a fact about
 * them; WHICH tournaments, and when, is a movement pattern. The first is a
 * profile, the second is surveillance.
 */

/** Exactly what leaves the server for a stranger. Nothing else is added. */
export interface PublicProfile {
  readonly publicPlayerId: string;
  /** The Sparta nickname. Empty when the player has not chosen one. */
  readonly nickname: string;
  /** Badge ids. The client resolves names and art from its own catalogue. */
  readonly badges: readonly string[];
  readonly tournamentsPlayed: number;
  readonly tournamentsCreated: number;
  /**
   * Month and year the account was created, never the exact instant.
   *
   * "Desde agosto de 2026" is the fact a profile wants to convey. A precise
   * timestamp is a correlation handle — it pins an account to a moment that can
   * be matched against a signup elsewhere.
   */
  readonly memberSince: string | null;
}

/** The stored fields this projection is allowed to read. */
export interface PublicProfileSource {
  readonly publicPlayerId: string;
  readonly username: unknown;
  readonly badges: unknown;
  readonly tournamentsPlayed: unknown;
  readonly tournamentsCreated: unknown;
  readonly createdAt: unknown;
}

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/**
 * Builds the profile, key by key.
 *
 * BUILT UP, NOT STRIPPED DOWN. A projection that starts from the stored
 * document and deletes the private fields leaks every field added later by
 * someone who did not know this function existed. Starting from nothing means
 * a new field on `users/{uid}` is invisible here until somebody deliberately
 * adds it — which is the only version of this that stays safe over time.
 */
export function projectPublicProfile(
  source: PublicProfileSource
): PublicProfile {
  return {
    publicPlayerId: source.publicPlayerId,
    nickname: readNickname(source.username),
    badges: readBadges(source.badges),
    tournamentsPlayed: readCount(source.tournamentsPlayed),
    tournamentsCreated: readCount(source.tournamentsCreated),
    memberSince: readMonth(source.createdAt),
  };
}

function readNickname(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function readBadges(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((b): b is string => typeof b === "string" && b !== "");
}

/**
 * A stored count, or zero.
 *
 * Zero for anything unusable, because this is a display path for a stranger:
 * refusing to render a profile over a malformed counter would turn a data
 * fault into a broken page for someone who has no way to fix it.
 */
function readCount(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/** "agosto de 2026", or null when there is no usable date. */
function readMonth(raw: unknown): string | null {
  const date = toDate(raw);
  if (date === null) return null;
  return `${MONTHS[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  // Duck-typed so a Firestore Timestamp works without importing the Admin SDK.
  const candidate = raw as { toDate?: () => Date } | null | undefined;
  if (candidate && typeof candidate.toDate === "function") {
    try {
      const date = candidate.toDate();
      return date instanceof Date && !Number.isNaN(date.getTime())
        ? date
        : null;
    } catch {
      return null;
    }
  }
  return null;
}
