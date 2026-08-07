import { createHmac, timingSafeEqual } from "node:crypto";

import { ECONOMY_BETA_CREDIT, ECONOMY_CASH } from "./economy.js";
import { DomainError, failedPrecondition, invalidArgument } from "./errors.js";
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
export const LEADERBOARD_CURSOR_VERSION = 2;

// ── Request normalization ───────────────────────────────────────────────────

/**
 * The requested page size, CLAMPED server-side (design sections 9.1, 12.2 and
 * the frozen matrix 16.4: "`limit` 1000 → Clamped to 100").
 *
 * Absent means the default. A positive integer above the ceiling is the one
 * case the contract says to satisfy rather than refuse: the caller gets the
 * maximum page, never more. Everything the contract does NOT call a page size
 * — a non-number, a float, `NaN`, zero or a negative — remains a rejection,
 * because clamping those would be inventing a value the caller never asked
 * for.
 */
export function normalizeLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return LEADERBOARD_DEFAULT_LIMIT;

  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw invalidArgument("O limite precisa ser um número inteiro.");
  }
  if (raw < 1) {
    throw invalidArgument(
      `O limite precisa estar entre 1 e ${LEADERBOARD_MAX_LIMIT}.`
    );
  }
  return Math.min(raw, LEADERBOARD_MAX_LIMIT);
}

/** The requested economy. Only the two frozen values exist. */
export function normalizeEconomy(raw: unknown): RankingEconomy {
  if (raw === ECONOMY_CASH || raw === ECONOMY_BETA_CREDIT) return raw;
  throw invalidArgument('Economia inválida. Use "cash" ou "beta_credit".');
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Design section 8.4 (frozen): the current season plus the 11 preceding
 * monthly seasons stay servable — a rolling window of at most 12. Older
 * seasons are simply not served, and neither is a FUTURE season.
 */
export const SEASON_RETENTION_MONTHS = 12;

const SEASON_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

/** Zero-based absolute month index of a `YYYY-MM` key, for exact month math. */
function monthIndexOf(seasonId: string): number {
  const match = SEASON_KEY_PATTERN.exec(seasonId);
  if (match === null) {
    throw invalidArgument("Temporada indisponível.");
  }
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw invalidArgument("Temporada indisponível.");
  }
  return Number(match[1]) * 12 + (month - 1);
}

/**
 * Rejects any season outside the retention window.
 *
 * Exact arithmetic on the two `YYYY-MM` keys — no day counting, no Date math
 * and no local timezone. The CALLER derives `currentSeasonId` from the
 * business calendar (America/Sao_Paulo, via `seasonIdFromInstant`), so the
 * window boundary moves exactly when the business month does.
 *
 * The rejection is deliberately GENERIC: one public message for an expired
 * season, a future season and a season that never existed alike —
 * distinguishing them would reveal which seasons hold data.
 */
export function assertSeasonServable(
  seasonId: string,
  currentSeasonId: string
): void {
  const age = monthIndexOf(currentSeasonId) - monthIndexOf(seasonId);
  if (age < 0 || age >= SEASON_RETENTION_MONTHS) {
    throw invalidArgument("Temporada indisponível.");
  }
}

// ── Canonical ordering key ──────────────────────────────────────────────────

/**
 * THE CANONICAL SORT KEY — one string field that IS the ordering.
 *
 * WHY A SINGLE KEY. Ordering on the three stored fields cannot express
 * "structurally valid" to Firestore. `orderBy` drops a document only when the
 * field is ABSENT; a field present with the wrong TYPE still sorts (Firestore
 * orders across types), so a corrupt entry silently entered the aggregates
 * while the page that had to render it failed — the two surfaces disagreed.
 *
 * `rankKey` closes that by construction:
 *
 *   v1|<complement(scoreCentavos)>|<complement(winsCount)>|<publicPlayerId>
 *
 * - ONE predictable Firestore type (string), so the half-open range
 *   [RANK_KEY_MIN, RANK_KEY_MAX) matches strings of THIS version and nothing
 *   else. Numbers, null, booleans, arrays, maps, bytes and timestamps all fall
 *   outside it, as does another schema version — verified against the emulator.
 * - each number is stored as a fixed-width complement, so a single ASCENDING
 *   string sort reproduces scoreCentavos DESC, winsCount DESC exactly.
 * - the LAST component is the document id, which is the authoritative
 *   `publicPlayerId`. Document ids are unique, so the key is unique: the
 *   comparator identifies exactly one entry and `startAfter` is unambiguous.
 *
 * It is produced ONLY by the internal write path, from values the domain has
 * already normalised — never from client input and never at read time.
 */
export const RANK_KEY_VERSION = "v1";

/** Separator. Outside the pseudonym alphabet `[A-Za-z0-9_-]`, so it cannot occur inside a component. */
const RANK_KEY_SEPARATOR = "|";

/**
 * The queryable bounds of this version's key space, half-open.
 *
 * Both complements are DECIMAL, so a well-formed key is always
 * `v1|` followed by a digit. Bounding on `0`…`:` (the code point right after
 * `9`) therefore admits only keys whose first numeric position really is
 * numeric — a string like `v1|abc|…` sorts above `v1|:` and falls outside, so
 * the count-based invariant sees it as physically present but not canonical
 * and the season fails closed. A looser `["v1|", "v1}")` bound would have let
 * such a key inside the aggregates while the page that had to render it
 * failed — reintroducing exactly the divergence this key exists to remove.
 */
export const RANK_KEY_MIN = `${RANK_KEY_VERSION}${RANK_KEY_SEPARATOR}0`;

/** Exclusive upper bound: ":" is the code point right after "9". */
export const RANK_KEY_MAX = `${RANK_KEY_VERSION}${RANK_KEY_SEPARATOR}:`;

/**
 * Complement base. Every count this key orders is a safe integer, so
 * `MAX_SAFE_INTEGER - value` is itself a non-negative safe integer.
 */
const RANK_KEY_COMPLEMENT_BASE = Number.MAX_SAFE_INTEGER;

/** Fixed width, so complements compare digit by digit. */
const RANK_KEY_NUMBER_WIDTH = String(RANK_KEY_COMPLEMENT_BASE).length;

function isRankableCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= RANK_KEY_COMPLEMENT_BASE
  );
}

/** `MAX - value`, zero-padded, so ascending string order means descending value. */
function complement(value: number): string {
  return String(RANK_KEY_COMPLEMENT_BASE - value).padStart(
    RANK_KEY_NUMBER_WIDTH,
    "0"
  );
}

/**
 * Builds the canonical key. WRITE PATH ONLY.
 *
 * Fails closed on any input the ordering could not represent faithfully, so a
 * malformed entry is never given a queryable key in the first place.
 */
export function buildRankKey(
  scoreCentavos: unknown,
  winsCount: unknown,
  publicPlayerId: unknown
): string {
  if (!isRankableCount(scoreCentavos)) {
    throw failedPrecondition("Entry com pontuação inválida.");
  }
  if (!isRankableCount(winsCount)) {
    throw failedPrecondition("Entry com vitórias inválidas.");
  }
  if (!isPublicPlayerId(publicPlayerId)) {
    throw failedPrecondition("Entry sem identificador público válido.");
  }

  return [
    RANK_KEY_VERSION,
    complement(scoreCentavos),
    complement(winsCount),
    publicPlayerId,
  ].join(RANK_KEY_SEPARATOR);
}

/** The values a canonical key carries. The key is the ONLY source of truth for them. */
export interface RankKeyParts {
  readonly scoreCentavos: number;
  readonly winsCount: number;
  readonly publicPlayerId: string;
}

/**
 * Decodes a canonical key, or fails closed.
 *
 * READ PATH. Every published score, win count and pseudonym comes from here,
 * so the redundant `scoreCentavos` / `winsCount` / `publicPlayerId` fields kept
 * on the document for auditing can never become a second source of truth able
 * to move a rank, a page or a response.
 */
export function decodeRankKey(rankKey: unknown): RankKeyParts {
  if (typeof rankKey !== "string") {
    throw failedPrecondition("Entry sem chave canônica.");
  }

  const parts = rankKey.split(RANK_KEY_SEPARATOR);
  if (parts.length !== 4 || parts[0] !== RANK_KEY_VERSION) {
    throw failedPrecondition("Entry sem chave canônica.");
  }

  const [, rawScore, rawWins, publicPlayerId] = parts;
  if (
    rawScore.length !== RANK_KEY_NUMBER_WIDTH ||
    rawWins.length !== RANK_KEY_NUMBER_WIDTH ||
    !/^\d+$/.test(rawScore) ||
    !/^\d+$/.test(rawWins)
  ) {
    throw failedPrecondition("Entry sem chave canônica.");
  }

  const scoreCentavos = RANK_KEY_COMPLEMENT_BASE - Number(rawScore);
  const winsCount = RANK_KEY_COMPLEMENT_BASE - Number(rawWins);
  if (
    !isRankableCount(scoreCentavos) ||
    !isRankableCount(winsCount) ||
    !isPublicPlayerId(publicPlayerId)
  ) {
    throw failedPrecondition("Entry sem chave canônica.");
  }

  return { scoreCentavos, winsCount, publicPlayerId };
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
  /**
   * The canonical key of the LAST row of the previous page.
   *
   * One component, not a three-field tuple: `rankKey` already encodes the whole
   * ordering AND ends in the unique document id, so `startAfter(rankKey)`
   * resumes after exactly one entry. The old tuple could repeat when two
   * documents carried the same stored `publicPlayerId`, which made
   * `startAfter` ambiguous and could skip or repeat a row.
   */
  readonly afterRankKey: string;
  /** How many rows precede the next page, so numbering continues across pages. */
  readonly offset: number;
}

/** The environment variable holding the cursor signing key in production. */
export const RANKING_CURSOR_SECRET_ENV = "RANKING_CURSOR_HMAC_SECRET";

/**
 * Minimum key length. 32 bytes matches the HMAC-SHA256 block security level;
 * anything shorter is rejected rather than stretched, so a placeholder value
 * cannot quietly become the production key.
 */
export const MIN_CURSOR_SECRET_BYTES = 32;

/**
 * Upper bound on an inbound cursor, checked BEFORE any decoding.
 *
 * A real cursor is ~120 characters. This bounds the work an unauthenticated-shaped
 * input can cause before it is rejected, and costs nothing for legitimate use.
 */
export const MAX_CURSOR_CHARS = 512;

/**
 * The signing key, validated.
 *
 * Fails CLOSED: absent, empty, non-string or too short all raise rather than
 * falling back to an unsigned or weakly-keyed cursor. There is deliberately no
 * default and no derivation from public data — a key derived from the project
 * id, the season or a uid would be reproducible by anyone who can see those.
 */
function cursorKey(secret: unknown): Buffer {
  if (typeof secret !== "string" || secret.length === 0) {
    throw failedPrecondition("Assinatura de cursor não configurada.");
  }

  const key = Buffer.from(secret, "utf8");
  if (key.length < MIN_CURSOR_SECRET_BYTES) {
    throw failedPrecondition("Assinatura de cursor não configurada.");
  }

  return key;
}

/**
 * The canonical payload the MAC covers — every field the cursor carries, in a
 * fixed order, so no component can be swapped without invalidating the tag.
 */
function payloadOf(cursor: LeaderboardCursor): string {
  return JSON.stringify([
    LEADERBOARD_CURSOR_VERSION,
    cursor.economy,
    cursor.seasonId,
    cursor.afterRankKey,
    cursor.offset,
  ]);
}

/** HMAC-SHA256 over the canonical payload. */
function macOf(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload, "utf8").digest();
}

/**
 * The opaque cursor for the row after [cursor.after]. Server-produced only.
 *
 * The tag is a keyed MAC, not a checksum: it authenticates the cursor's ORIGIN
 * and INTEGRITY — without the key a client cannot mint or alter one. That is
 * ALL it guarantees. A legitimately issued cursor can still be REPLAYED, and
 * the MAC says nothing about time: `startAfter` resumes after the encoded
 * ordering tuple against LIVE data, and the carried absolute offset only
 * continues the visual numbering. There is no snapshot between pages — an
 * entry that moves in the ordering between requests changes which rows the
 * remaining pages return and what their live positions are: one that moved
 * ahead of the tuple is OMITTED from the rest of the run, and one that moved
 * behind it would REPEAT (reachable only by an out-of-band write, since a
 * prize never lowers a key).
 */
export function encodeCursor(
  cursor: LeaderboardCursor,
  secret: unknown
): string {
  const key = cursorKey(secret);
  const payload = payloadOf(cursor);
  const tag = macOf(payload, key).toString("base64url");

  return Buffer.from(`${payload}.${tag}`, "utf8").toString("base64url");
}

/**
 * Decodes a cursor, or rejects it.
 *
 * THE MAC IS VERIFIED BEFORE ANY FIELD IS READ. Nothing inside the payload is
 * parsed, trusted or acted upon until the tag proves the payload is one this
 * server produced — so a forged offset or ordering tuple never reaches the
 * validation logic, let alone a query.
 *
 * Comparison is constant-time, and the tag length is checked first because
 * `timingSafeEqual` throws on a length mismatch rather than returning false.
 *
 * REJECTED, never reinterpreted: a malformed string, a wrong or truncated tag,
 * an unknown version, an implausible field, and a cursor minted for a DIFFERENT
 * season or economy — silently restarting that from page 1 would let a client
 * interleave two rankings without noticing.
 */
export function decodeCursor(
  raw: unknown,
  expected: { readonly economy: RankingEconomy; readonly seasonId: string },
  secret: unknown
): LeaderboardCursor {
  const key = cursorKey(secret);

  if (typeof raw !== "string" || raw.length === 0) {
    throw invalidArgument("Cursor inválido.");
  }
  if (raw.length > MAX_CURSOR_CHARS) {
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

  let presented: Buffer;
  try {
    presented = Buffer.from(decoded.slice(split + 1), "base64url");
  } catch {
    throw invalidArgument("Cursor inválido.");
  }

  const expectedTag = macOf(payload, key);
  // Length first: timingSafeEqual THROWS on differing lengths.
  if (
    presented.length !== expectedTag.length ||
    !timingSafeEqual(presented, expectedTag)
  ) {
    throw invalidArgument("Cursor inválido.");
  }

  let parts: unknown;
  try {
    parts = JSON.parse(payload);
  } catch {
    throw invalidArgument("Cursor inválido.");
  }

  if (!Array.isArray(parts) || parts.length !== 5) {
    throw invalidArgument("Cursor inválido.");
  }

  const [version, economy, seasonId, afterRankKey, offset] =
    parts as unknown[];

  if (version !== LEADERBOARD_CURSOR_VERSION) {
    throw invalidArgument("Cursor inválido.");
  }
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    typeof afterRankKey !== "string" ||
    afterRankKey < RANK_KEY_MIN ||
    afterRankKey >= RANK_KEY_MAX
  ) {
    throw invalidArgument("Cursor inválido.");
  }
  // The key must itself decode: a cursor can only point at a position the
  // canonical ordering is actually able to express.
  try {
    decodeRankKey(afterRankKey);
  } catch {
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
    afterRankKey,
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
  readonly rankKey?: unknown;
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
 *
 * NOTHING STORED ON THE DOCUMENT IS A SOURCE OF TRUTH EXCEPT THE CANONICAL KEY.
 *
 * - the ordered values come from `rankKey`;
 * - the identity comes from the DOCUMENT ID, which must equal the key's own id
 *   component or the entry is corrupt and fails closed;
 * - `economy` and `seasonId` come from the CALLER'S VALIDATED REQUEST, because
 *   they are structural properties of the document PATH
 *   (`season_rankings/{economy}_{seasonId}/entries/{publicPlayerId}`) — a row
 *   reached through the cash/2026-08 path IS cash/2026-08, whatever its own
 *   fields happen to say.
 *
 * The stored `scoreCentavos`, `winsCount`, `publicPlayerId`, `economy` and
 * `seasonId` are audit copies and are deliberately NOT read. Reading them made
 * them a second source of truth able to disagree with the path and the key —
 * which is exactly how the leaderboard and the individual position came to
 * diverge, one throwing while the other answered.
 */
export function publicEntry(
  position: number,
  documentId: string,
  stored: StoredLeaderboardEntry,
  economy: RankingEconomy,
  seasonId: string
): PublicLeaderboardEntry {
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new DomainError("failed-precondition", "Posição inválida.");
  }
  if (!isPublicPlayerId(documentId)) {
    throw new DomainError(
      "failed-precondition",
      "Entry sem identificador público válido."
    );
  }

  // Throws `failed-precondition` when the key is absent, mistyped, of another
  // version or structurally invalid.
  const parts = decodeRankKey(stored.rankKey);

  if (parts.publicPlayerId !== documentId) {
    throw new DomainError(
      "failed-precondition",
      "Entry com identidade divergente."
    );
  }

  return {
    position,
    publicPlayerId: documentId,
    label: publicPlayerLabel(documentId),
    scoreCentavos: parts.scoreCentavos,
    winsCount: parts.winsCount,
    economy,
    seasonId,
  };
}
