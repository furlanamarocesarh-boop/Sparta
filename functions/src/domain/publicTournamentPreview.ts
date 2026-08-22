import { ECONOMY_BETA_CREDIT, ECONOMY_CASH } from "./economy.js";
import { inspectReais } from "./money.js";
import { readParticipantCounts } from "./tournamentFields.js";

/**
 * The PUBLIC projection of a tournament — the only shape an unauthenticated
 * caller ever receives.
 *
 * WHY A PROJECTION AND NOT A RULES CHANGE. Opening `tournaments` for public
 * read would expose EVERY field of EVERY tournament to the whole internet,
 * including `creator_uid`, `creator_ref`, the settled `result`, and — worse —
 * any field added later, which would leak by default. This module inverts that:
 * the response is built key by key, so a new stored field is invisible here
 * until someone deliberately adds it.
 *
 * WHAT IS DELIBERATELY ABSENT, and must stay absent:
 *  - `creator_uid` / `creator_ref` — real account identifiers;
 *  - `creator_name` — a person's display name;
 *  - `result`, winner fields — settlement data;
 *  - `locked_economy_type` — internal accounting state;
 *  - `created_at` / `updated_at` — operational metadata;
 *  - anything from `tournament_rooms` (room id and password), `registrations`,
 *    `wallets` or `transactions`. Those are SEPARATE collections that this
 *    module never receives and the handler never reads.
 */

/** Every key the public response may contain. Used by the handler AND the tests. */
export const PUBLIC_PREVIEW_KEYS = [
  "name",
  "gameMode",
  "gameModeLabel",
  "economy",
  "entryFeeCentavos",
  "prizeCentavos",
  "status",
  "currentParticipants",
  "maxParticipants",
  "startsAt",
] as const;

export type PublicPreviewKey = (typeof PUBLIC_PREVIEW_KEYS)[number];

export type PublicEconomy = typeof ECONOMY_CASH | typeof ECONOMY_BETA_CREDIT;

export interface PublicTournamentPreview {
  readonly name: string;
  readonly gameMode: string;
  readonly gameModeLabel: string;
  readonly economy: PublicEconomy;
  readonly entryFeeCentavos: number;
  readonly prizeCentavos: number;
  readonly status: PublicStatus;
  readonly currentParticipants: number;
  readonly maxParticipants: number;
  /** ISO-8601 UTC, or null when the tournament has no scheduled start. */
  readonly startsAt: string | null;
}

/**
 * The statuses a stranger may learn. An ALLOWLIST, not a pass-through: an
 * unrecognised status is a tournament this endpoint refuses to describe, so an
 * internal state introduced later cannot leak through a public URL.
 */
export const PUBLIC_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export type PublicStatus = (typeof PUBLIC_STATUSES)[number];

// ── Identifier ──────────────────────────────────────────────────────────────

/** Upper bound, mirroring the app's share-link rule. */
export const MAX_PUBLIC_ID_LENGTH = 200;

/**
 * Whether a query-string id is one this endpoint will even look up.
 *
 * The SAME rule the Flutter client applies before publishing a share link
 * (`lib/features/tournaments/domain/tournament_share.dart`): an id the app
 * refuses to put in a URL is an id the backend refuses to resolve. Rejecting
 * here also keeps malformed input from reaching Firestore at all.
 */
export function isValidPublicId(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length === 0 || raw.length > MAX_PUBLIC_ID_LENGTH) return false;
  if (raw === "." || raw === "..") return false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // Control characters, space and '/' would change what the id MEANS.
    if (code <= 0x20 || code === 0x7f || code === 0x2f) return false;
  }
  return true;
}

// ── Name ────────────────────────────────────────────────────────────────────

/** Longest name published. Beyond this the tail is replaced by an ellipsis. */
export const MAX_PUBLIC_NAME_LENGTH = 80;

/**
 * The creator's free text, made safe to host on a public page.
 *
 * This is NOT an HTML-escaping step — the renderer escapes, and doing it twice
 * would publish visible `&amp;`. What it removes is the class of characters
 * that change how text BEHAVES rather than how it reads:
 *
 *  - C0/C1 control characters and DEL, which break layout and logs;
 *  - bidirectional overrides (U+202A-U+202E, U+2066-U+2069), which can render a
 *    string in an order that hides or reverses part of it;
 *  - zero-width characters (U+200B-U+200D, U+FEFF), invisible padding used to
 *    smuggle content past length limits and moderation;
 *  - runs of whitespace, collapsed to one space so a name cannot occupy a
 *    screen by itself.
 *
 * Returns null when nothing legible survives — an empty title is not something
 * to publish as a blank heading.
 */
export function sanitizeTournamentName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);

    const isC0 = code <= 0x1f;
    const isDelOrC1 = code >= 0x7f && code <= 0x9f;
    const isBidi =
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    const isZeroWidth =
      (code >= 0x200b && code <= 0x200d) || code === 0xfeff;

    if (isC0 || isDelOrC1 || isBidi || isZeroWidth) {
      // C0 includes tab/newline: they become a space, then collapse below.
      out += code === 0x09 || code === 0x0a || code === 0x0d ? " " : "";
      continue;
    }
    out += raw[i];
  }

  const collapsed = out.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;

  if (collapsed.length <= MAX_PUBLIC_NAME_LENGTH) return collapsed;
  // Trimmed again so the ellipsis never follows a space.
  return collapsed.slice(0, MAX_PUBLIC_NAME_LENGTH).trimEnd() + "…";
}

// ── Projection ──────────────────────────────────────────────────────────────

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readEconomy(value: unknown): PublicEconomy | null {
  if (value === ECONOMY_CASH) return ECONOMY_CASH;
  if (value === ECONOMY_BETA_CREDIT) return ECONOMY_BETA_CREDIT;
  return null;
}

function readStatus(value: unknown): PublicStatus | null {
  return (PUBLIC_STATUSES as readonly string[]).includes(value as string)
    ? (value as PublicStatus)
    : null;
}

/** A Firestore Timestamp, a Date, or null. Never a guess. */
function readInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const toDate = (value as { toDate?: unknown }).toDate;
  if (typeof toDate === "function") {
    try {
      const date = (value as { toDate: () => Date }).toDate();
      return date instanceof Date && !Number.isNaN(date.getTime())
        ? date.toISOString()
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Builds the public preview, or null when the document cannot be described
 * faithfully.
 *
 * FAILS CLOSED AS A 404, not as a partial answer. A tournament missing a name,
 * carrying a malformed amount or sitting in an unrecognised status is simply
 * not published — rendering half of it would put authoritative-looking numbers
 * on a public page.
 *
 * Money is stored in REAIS and published in CENTAVOS, converted once here, so
 * no consumer has to know the storage unit.
 */
export function projectPublicPreview(
  data: Record<string, unknown> | null | undefined
): PublicTournamentPreview | null {
  if (data === null || data === undefined) return null;

  const name = sanitizeTournamentName(data.name);
  if (name === null) return null;

  const gameMode = readString(data.game_mode);
  const gameModeLabel = readString(data.game_mode_label);
  if (gameMode === null || gameModeLabel === null) return null;

  const economy = readEconomy(data.economy_type);
  if (economy === null) return null;

  const status = readStatus(data.status);
  if (status === null) return null;

  // A free tournament is legitimate, so zero is allowed for the entry fee.
  const entryFee = inspectReais(data.entry_fee, { allowZero: true });
  if (!entryFee.ok) return null;

  const prize = inspectReais(data.prize, { allowZero: true });
  if (!prize.ok) return null;

  let counts: { current: number; max: number };
  try {
    counts = readParticipantCounts(data as never);
  } catch {
    // Ambiguous or contradictory counts: refuse rather than publish a number
    // that could oversell or misrepresent the tournament.
    return null;
  }

  return {
    name,
    gameMode,
    gameModeLabel,
    economy,
    entryFeeCentavos: entryFee.centavos,
    prizeCentavos: prize.centavos,
    status,
    currentParticipants: counts.current,
    maxParticipants: counts.max,
    startsAt: readInstant(data.starts_at),
  };
}
