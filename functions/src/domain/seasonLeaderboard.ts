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
export const LEADERBOARD_CURSOR_VERSION = 3;

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

// ── Canonical ordering scalars ──────────────────────────────────────────────

/**
 * THE CANONICAL ORDER — a TYPED tuple, not a string.
 *
 *   scoreOrder DESC, winsOrder DESC, FieldPath.documentId() ASC
 *
 * WHY NOT A STRING KEY. A textual key could only be bounded by a lexicographic
 * range, and a range bounds a PREFIX — never the interior of the string. A
 * hostile value that respected the prefix (`v1|0…`) stayed inside the queried
 * range, so the aggregates counted it while the page that had to parse it
 * failed: the leaderboard went down for the whole season while the individual
 * position answered, with its ordinal silently inflated. Findings B1/B1b.
 *
 * WHY TIMESTAMP. Firestore validates this type natively: seconds and
 * nanoseconds are integers and `0 <= nanoseconds < 1e9` is enforced by the
 * SDK. There is therefore no "inside the range but structurally malformed"
 * state to detect later — validity is a property of the type plus the bounds
 * of the query itself, so an out-of-domain entry is excluded from the CANONICAL
 * count while remaining in the PHYSICAL count, and the season fails closed
 * before any page is served, wherever the corruption sits.
 *
 * THESE TIMESTAMPS ARE NOT DATES. They are ordinal scalars. One second
 * represents 1 000 000 ranking units. Never pass them through `Date`, a
 * timezone, an ISO string or any temporal formatting.
 */

/**
 * Ranking units per second.
 *
 * MICROSECONDS, not nanoseconds. Firestore PERSISTS a Timestamp with
 * microsecond precision: it truncates nanoseconds to a multiple of 1000. A
 * `value % 1_000_000_000` encoding is therefore NOT injective through storage
 * — scoreCentavos 200 and 300 both persist as `Timestamp(0, 0)` and become
 * indistinguishable, destroying the order. Proven against the emulator before
 * this representation was adopted. Keeping nanoseconds a multiple of 1000 by
 * construction makes the round trip exact.
 */
const RANK_UNITS_PER_SECOND = 1_000_000;

/** Nanoseconds per ranking unit. Every encoded nanosecond is a multiple of this. */
const NANOSECONDS_PER_RANK_UNIT = 1_000;

const NANOSECONDS_PER_SECOND = 1_000_000_000;

/** The largest scalar the ordering represents: every count here is a safe integer. */
export const MAX_RANK_VALUE = Number.MAX_SAFE_INTEGER;

/**
 * The component bounds of the domain, precomputed so the decoder can reject an
 * out-of-domain scalar BEFORE multiplying.
 *
 * WHY NOT bigint: the deploy build targets ES2017 (`functions/tsconfig.json`),
 * where bigint literals are unavailable, and the compile target of the deployed
 * package is out of scope here. Plain integers are used instead, and every
 * operation is proven exact rather than assumed:
 *
 *   encode  seconds = floor(v / 1e6) <= 9_007_199_254        exact
 *           nanos   = (v % 1e6) * 1e3 < 1e9                  exact
 *   decode  rejected unless seconds < MAX_RANK_SECONDS, or
 *           seconds === MAX_RANK_SECONDS and micros <= MAX_RANK_MICROS,
 *           so seconds * 1e6 + micros <= MAX_SAFE_INTEGER    exact
 *
 * Every intermediate therefore stays inside the exactly-representable integer
 * range; no value is ever multiplied before it is known to be in domain.
 */
const MAX_RANK_SECONDS = Math.floor(MAX_RANK_VALUE / RANK_UNITS_PER_SECOND);
const MAX_RANK_MICROS = MAX_RANK_VALUE % RANK_UNITS_PER_SECOND;

/** A Firestore Timestamp, as the pure domain sees it — no Admin SDK import. */
export interface RankScalar {
  readonly seconds: number;
  readonly nanoseconds: number;
}

function isRankableCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_RANK_VALUE
  );
}

/** Encodes a ranking scalar. WRITE PATH ONLY. */
export function encodeRankScalar(value: unknown): RankScalar {
  if (!isRankableCount(value)) {
    throw failedPrecondition("Valor de ordenação inválido.");
  }

  const seconds = Math.floor(value / RANK_UNITS_PER_SECOND);
  const nanoseconds =
    (value % RANK_UNITS_PER_SECOND) * NANOSECONDS_PER_RANK_UNIT;

  // Exactness proven, not assumed.
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(nanoseconds) ||
    seconds < 0 ||
    seconds > MAX_RANK_SECONDS ||
    nanoseconds < 0 ||
    nanoseconds >= NANOSECONDS_PER_SECOND ||
    nanoseconds % NANOSECONDS_PER_RANK_UNIT !== 0
  ) {
    throw failedPrecondition("Valor de ordenação inválido.");
  }

  return { seconds, nanoseconds };
}

/** The inclusive bounds of the canonical domain. */
export const MIN_RANK_SCALAR: RankScalar = encodeRankScalar(0);
export const MAX_RANK_SCALAR: RankScalar = encodeRankScalar(MAX_RANK_VALUE);

/**
 * Decodes a persisted scalar, or fails closed.
 *
 * Defensive on every component, because a document can carry anything: the
 * shape, both integralities, the nanosecond range, the microsecond alignment
 * and the final safe-integer domain are all checked. Accepts any object with
 * numeric `seconds`/`nanoseconds`, which is exactly what a Firestore
 * `Timestamp` exposes, so the pure domain needs no Admin SDK import.
 */
export function decodeRankScalar(raw: unknown): number {
  if (raw === null || typeof raw !== "object") {
    throw failedPrecondition("Entry sem ordenação canônica.");
  }

  const { seconds, nanoseconds } = raw as {
    seconds?: unknown;
    nanoseconds?: unknown;
  };

  if (
    typeof seconds !== "number" ||
    typeof nanoseconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(nanoseconds) ||
    seconds < 0 ||
    nanoseconds < 0 ||
    nanoseconds >= NANOSECONDS_PER_SECOND ||
    nanoseconds % NANOSECONDS_PER_RANK_UNIT !== 0
  ) {
    throw failedPrecondition("Entry sem ordenação canônica.");
  }

  const micros = nanoseconds / NANOSECONDS_PER_RANK_UNIT;

  // Bounded BEFORE the multiplication, so the sum below is always exact.
  if (
    seconds > MAX_RANK_SECONDS ||
    (seconds === MAX_RANK_SECONDS && micros > MAX_RANK_MICROS)
  ) {
    throw failedPrecondition("Entry sem ordenação canônica.");
  }

  const value = seconds * RANK_UNITS_PER_SECOND + micros;
  if (!isRankableCount(value)) {
    throw failedPrecondition("Entry sem ordenação canônica.");
  }

  return value;
}

/** Compares two scalars the way Firestore orders Timestamps. */
export function compareRankScalars(a: RankScalar, b: RankScalar): number {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  if (a.nanoseconds !== b.nanoseconds) {
    return a.nanoseconds < b.nanoseconds ? -1 : 1;
  }
  return 0;
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
   * The canonical tuple of the LAST row of the previous page, carried as PLAIN
   * SCALARS. The handler re-encodes the two integers into ordering Timestamps
   * only AFTER the MAC and the field validation have both passed, and resumes
   * with `startAfter(scoreOrder, winsOrder, documentId)`.
   *
   * The document id is the final component and is unique, so the tuple
   * identifies exactly one entry: `startAfter` can neither skip nor repeat.
   */
  readonly afterScoreCentavos: number;
  readonly afterWinsCount: number;
  readonly afterDocumentId: string;
  /**
   * How many rows precede the next page, so numbering continues across pages.
   *
   * GLOBAL, not page-relative: it is the count of rows the run has already
   * served, so `absoluteOffset + index + 1` is the row's visual position in the
   * season. Paging itself is driven by the ordering tuple above — this number
   * never seeks, and is therefore visual only.
   */
  readonly absoluteOffset: number;
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
 *
 * POSITIONAL, and the order is part of the v3 contract: the wire format carries
 * no names, so renaming the decoded property to `absoluteOffset` leaves the
 * signed bytes byte-for-byte identical. There is deliberately no second format
 * and no alias — a v3 payload is these seven values, in this order, or it is
 * rejected.
 */
function payloadOf(cursor: LeaderboardCursor): string {
  return JSON.stringify([
    LEADERBOARD_CURSOR_VERSION,
    cursor.economy,
    cursor.seasonId,
    cursor.afterScoreCentavos,
    cursor.afterWinsCount,
    cursor.afterDocumentId,
    cursor.absoluteOffset,
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
 * ordering tuple against LIVE data, and the carried `absoluteOffset` only
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
 * server produced — so a forged `absoluteOffset` or ordering tuple never
 * reaches the validation logic, let alone a query.
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

  if (!Array.isArray(parts) || parts.length !== 7) {
    throw invalidArgument("Cursor inválido.");
  }

  const [
    version,
    economy,
    seasonId,
    afterScoreCentavos,
    afterWinsCount,
    afterDocumentId,
    absoluteOffset,
  ] = parts as unknown[];

  if (version !== LEADERBOARD_CURSOR_VERSION) {
    throw invalidArgument("Cursor inválido.");
  }
  if (
    !Number.isSafeInteger(absoluteOffset) ||
    (absoluteOffset as number) < 0 ||
    !isRankableCount(afterScoreCentavos) ||
    !isRankableCount(afterWinsCount) ||
    !isPublicPlayerId(afterDocumentId)
  ) {
    throw invalidArgument("Cursor inválido.");
  }
  // Both scalars must be representable in the canonical ordering: a cursor can
  // only point at a position the domain is actually able to express.
  try {
    encodeRankScalar(afterScoreCentavos);
    encodeRankScalar(afterWinsCount);
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
    afterScoreCentavos: afterScoreCentavos as number,
    afterWinsCount: afterWinsCount as number,
    afterDocumentId: afterDocumentId as string,
    absoluteOffset: absoluteOffset as number,
  };
}

// ── Public projection ───────────────────────────────────────────────────────

/** A stored entry, read back as plain values. */
export interface StoredLeaderboardEntry {
  /** The canonical ordering scalars — the ONLY decisive fields. */
  readonly scoreOrder?: unknown;
  readonly winsOrder?: unknown;
  /** Audit copies. Never read by the read path. */
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
 * NOTHING STORED IS A SOURCE OF TRUTH EXCEPT THE TWO ORDERING SCALARS.
 *
 * - the ordered values come from `scoreOrder` / `winsOrder`, the same fields
 *   the queries order and count by — so what is published, what is counted and
 *   what is paged are one set, never three;
 * - the identity IS the DOCUMENT ID. There is no stored identity to reconcile
 *   against, so two documents can never claim the same player;
 * - `economy` and `seasonId` come from the CALLER'S VALIDATED REQUEST, because
 *   they are structural properties of the document PATH
 *   (`season_rankings/{economy}_{seasonId}/entries/{documentId}`) — a row
 *   reached through the cash/2026-08 path IS cash/2026-08, whatever its own
 *   fields happen to say.
 *
 * The stored `scoreCentavos`, `winsCount`, `publicPlayerId`, `economy`,
 * `seasonId` and any legacy `rankKey` are audit copies and are deliberately NOT
 * read. Reading them made them a second source of truth able to disagree with
 * the path and the ordering — which is exactly how the leaderboard and the
 * individual position came to diverge, one throwing while the other answered.
 *
 * The decode here is a projection, NOT a validity gate: an entry whose scalars
 * are absent, mistyped or out of bounds has already been excluded from the
 * canonical count, so the season fails closed before any page is built.
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

  return {
    position,
    publicPlayerId: documentId,
    label: publicPlayerLabel(documentId),
    scoreCentavos: decodeRankScalar(stored.scoreOrder),
    winsCount: decodeRankScalar(stored.winsOrder),
    economy,
    seasonId,
  };
}
