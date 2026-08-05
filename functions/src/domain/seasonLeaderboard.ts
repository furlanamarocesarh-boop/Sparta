import { ECONOMY_BETA_CREDIT, ECONOMY_CASH } from "./economy.js";
import { DomainError, invalidArgument } from "./errors.js";
import { isPublicPlayerId, publicPlayerLabel } from "./publicPlayerId.js";
import type { RankingEconomy } from "./seasonRanking.js";

/**
 * Season leaderboard reads — the PURE rules, with no `firebase-functions` and no
 * Admin SDK import, so every branch is unit-tested without a database.
 *
 * WHAT THIS OWNS: the canonical order, the page size, the opaque cursor, the
 * exact-ordinal arithmetic and the allowlisted public projection.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN. It issues no query and reads no document —
 * `index.ts` performs the Firestore work and feeds the results through here.
 * It also stores nothing: a position is DERIVED on every read (design section
 * 8.3), never persisted, so it can never go stale against the totals it
 * describes.
 */

/** Page size when the caller does not ask for one. */
export const LEADERBOARD_DEFAULT_LIMIT = 50;

/** Hard server-side ceiling. There is no "return everything" mode. */
export const LEADERBOARD_MAX_LIMIT = 100;

/** The cursor format version, so a stale client cursor is rejected, not misread. */
export const LEADERBOARD_CURSOR_VERSION = 1;

// ── Request normalization ───────────────────────────────────────────────────

/**
 * The requested page size, clamped server-side.
 *
 * Absent means the default. Anything present must be a real integer in range —
 * a float, a string or a number outside `[1, LEADERBOARD_MAX_LIMIT]` is the
 * caller's mistake and is rejected rather than silently clamped, so a client
 * asking for 1000 learns that it cannot have it.
 */
export function normalizeLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return LEADERBOARD_DEFAULT_LIMIT;

  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw invalidArgument("O limite precisa ser um número inteiro.");
  }
  if (raw < 1 || raw > LEADERBOARD_MAX_LIMIT) {
    throw invalidArgument(
      `O limite precisa estar entre 1 e ${LEADERBOARD_MAX_LIMIT}.`
    );
  }
  return raw;
}

/** The requested economy. Only the two frozen values exist. */
export function normalizeEconomy(raw: unknown): RankingEconomy {
  if (raw === ECONOMY_CASH || raw === ECONOMY_BETA_CREDIT) return raw;
  throw invalidArgument('Economia inválida. Use "cash" ou "beta_credit".');
}

// ── Canonical order ─────────────────────────────────────────────────────────

/** The three comparator levels, as stored on an entry. */
export interface OrderKey {
  readonly scoreCentavos: number;
  readonly winsCount: number;
  readonly publicPlayerId: string;
}

/**
 * The canonical order of design section 4.3, as a comparator.
 *
 * Exactly three levels: score descending, wins descending, `publicPlayerId`
 * ascending. There is NO uid level and NO timestamp level — `lastPrizeAt` is
 * audit data, so a delayed trigger can never move anyone's position. Level 3
 * makes the order strictly total, which is what lets positions be exact
 * ordinals with no shared places (section 4.4).
 */
export function compareEntries(a: OrderKey, b: OrderKey): number {
  if (a.scoreCentavos !== b.scoreCentavos) {
    return b.scoreCentavos - a.scoreCentavos;
  }
  if (a.winsCount !== b.winsCount) {
    return b.winsCount - a.winsCount;
  }
  // Binary/canonical string comparison — never locale-aware, which would make
  // the order depend on the server's collation.
  if (a.publicPlayerId < b.publicPlayerId) return -1;
  if (a.publicPlayerId > b.publicPlayerId) return 1;
  return 0;
}

/**
 * The exact ordinal, given how many entries precede the caller.
 *
 * `ahead` comes from three disjoint counts that together cover exactly the
 * preceding entries (section 9.2), so this is arithmetic on a proven count —
 * never an estimate and never a shared place.
 */
export function rankFromAhead(ahead: unknown): number {
  if (typeof ahead !== "number" || !Number.isSafeInteger(ahead) || ahead < 0) {
    throw new DomainError(
      "failed-precondition",
      "Contagem de posições inválida."
    );
  }
  return ahead + 1;
}

// ── Cursor ──────────────────────────────────────────────────────────────────

export interface LeaderboardCursor {
  readonly economy: RankingEconomy;
  readonly seasonId: string;
  /** The ordering tuple of the LAST row of the previous page. */
  readonly after: OrderKey;
  /** How many rows precede the next page, so numbering continues across pages. */
  readonly offset: number;
}

/**
 * A non-cryptographic checksum over the cursor payload.
 *
 * FNV-1a, chosen because it is deterministic, dependency-free and adequate for
 * what a cursor actually needs: detecting corruption and casual tampering.
 *
 * IT IS NOT A SIGNATURE, and deliberately so. A cursor carries no privilege —
 * every row it can reach is already visible to any authenticated caller through
 * ordinary paging — so there is nothing to forge one's way into. The binding
 * that matters is the economy/season check in [decodeCursor], which is enforced
 * against the REQUEST rather than trusted from the cursor.
 */
function checksum(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    // FNV prime, in 32-bit arithmetic.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function payloadOf(cursor: LeaderboardCursor): string {
  return JSON.stringify([
    LEADERBOARD_CURSOR_VERSION,
    cursor.economy,
    cursor.seasonId,
    cursor.after.scoreCentavos,
    cursor.after.winsCount,
    cursor.after.publicPlayerId,
    cursor.offset,
  ]);
}

/** The opaque cursor for the row after [cursor.after]. Server-produced only. */
export function encodeCursor(cursor: LeaderboardCursor): string {
  const payload = payloadOf(cursor);
  return Buffer.from(`${payload}.${checksum(payload)}`, "utf8").toString(
    "base64url"
  );
}

/**
 * Decodes a cursor, or rejects it.
 *
 * REJECTED, never reinterpreted: a malformed string, a corrupted or tampered
 * payload, an unknown version, and — the case that matters most — a cursor
 * minted for a DIFFERENT season or economy. Silently restarting such a request
 * from page 1 would let a client interleave two rankings without noticing.
 */
export function decodeCursor(
  raw: unknown,
  expected: { readonly economy: RankingEconomy; readonly seasonId: string }
): LeaderboardCursor {
  if (typeof raw !== "string" || raw.length === 0) {
    throw invalidArgument("Cursor inválido.");
  }

  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw invalidArgument("Cursor inválido.");
  }

  const split = decoded.lastIndexOf(".");
  if (split <= 0) throw invalidArgument("Cursor inválido.");

  const payload = decoded.slice(0, split);
  if (decoded.slice(split + 1) !== checksum(payload)) {
    throw invalidArgument("Cursor inválido.");
  }

  let parts: unknown;
  try {
    parts = JSON.parse(payload);
  } catch {
    throw invalidArgument("Cursor inválido.");
  }

  if (!Array.isArray(parts) || parts.length !== 7) {
    throw invalidArgument("Cursor inválido.");
  }

  const [version, economy, seasonId, score, wins, publicPlayerId, offset] =
    parts as unknown[];

  if (version !== LEADERBOARD_CURSOR_VERSION) {
    throw invalidArgument("Cursor inválido.");
  }
  if (
    !Number.isSafeInteger(score) ||
    (score as number) < 0 ||
    !Number.isSafeInteger(wins) ||
    (wins as number) < 0 ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !isPublicPlayerId(publicPlayerId)
  ) {
    throw invalidArgument("Cursor inválido.");
  }

  // The binding that actually matters, checked against the REQUEST.
  if (economy !== expected.economy || seasonId !== expected.seasonId) {
    throw invalidArgument(
      "O cursor pertence a outra temporada ou economia."
    );
  }

  return {
    economy: economy as RankingEconomy,
    seasonId: seasonId as string,
    after: {
      scoreCentavos: score as number,
      winsCount: wins as number,
      publicPlayerId: publicPlayerId,
    },
    offset: offset as number,
  };
}

// ── Public projection ───────────────────────────────────────────────────────

/** A stored entry, read back as plain values. */
export interface StoredLeaderboardEntry {
  readonly publicPlayerId?: unknown;
  readonly economy?: unknown;
  readonly seasonId?: unknown;
  readonly scoreCentavos?: unknown;
  readonly winsCount?: unknown;
}

export interface PublicLeaderboardEntry {
  readonly position: number;
  readonly publicPlayerId: string;
  readonly label: string;
  readonly scoreCentavos: number;
  readonly winsCount: number;
  readonly economy: RankingEconomy;
  readonly seasonId: string;
}

/**
 * The ONLY shape a leaderboard row is ever published in.
 *
 * An allowlist, built field by field rather than by spreading the stored
 * document: a field added to the entry later cannot leak into a public response
 * by accident. The uid is absent because it is not on the entry at all — and
 * `firstPrizeAt`, `lastPrizeAt` and `updatedAt` are audit data that no client
 * needs.
 */
export function publicEntry(
  position: number,
  stored: StoredLeaderboardEntry
): PublicLeaderboardEntry {
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new DomainError("failed-precondition", "Posição inválida.");
  }
  if (!isPublicPlayerId(stored.publicPlayerId)) {
    throw new DomainError(
      "failed-precondition",
      "Entry sem identificador público válido."
    );
  }
  if (
    typeof stored.scoreCentavos !== "number" ||
    !Number.isSafeInteger(stored.scoreCentavos) ||
    stored.scoreCentavos < 0
  ) {
    throw new DomainError("failed-precondition", "Entry com pontuação inválida.");
  }
  if (
    typeof stored.winsCount !== "number" ||
    !Number.isSafeInteger(stored.winsCount) ||
    stored.winsCount < 1
  ) {
    throw new DomainError("failed-precondition", "Entry com vitórias inválidas.");
  }
  if (
    stored.economy !== ECONOMY_CASH &&
    stored.economy !== ECONOMY_BETA_CREDIT
  ) {
    throw new DomainError("failed-precondition", "Entry com economia inválida.");
  }
  if (typeof stored.seasonId !== "string" || stored.seasonId.length === 0) {
    throw new DomainError("failed-precondition", "Entry sem temporada.");
  }

  return {
    position,
    publicPlayerId: stored.publicPlayerId,
    label: publicPlayerLabel(stored.publicPlayerId),
    scoreCentavos: stored.scoreCentavos,
    winsCount: stored.winsCount,
    economy: stored.economy,
    seasonId: stored.seasonId,
  };
}
