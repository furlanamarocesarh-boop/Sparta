import { DomainError, invalidArgument } from "./errors.js";

/**
 * Daily app-access tracking — the PURE domain rules, with no
 * `firebase-functions` and no Admin SDK import, so every branch is unit-tested
 * without a database.
 *
 * WHAT AN ACTIVITY RECORD IS (frozen contract for the closed beta):
 *  - `player_activity/{uid}_{YYYY-MM-DD}` records that a player OPENED the app
 *    on that business-calendar day. Nothing else;
 *  - it is NOT financial. It never reads or writes wallets, balances,
 *    transactions, registrations or tournaments, and it carries no amount;
 *  - the day key is derived from SERVER time in the business calendar timezone.
 *    A client may SEND its own day for cross-checking, but it can never steer
 *    which document is written — the id always comes from the server clock;
 *  - the uid comes exclusively from the verified token, never from the payload;
 *  - the document id is deterministic, so repeated opens on the same day are
 *    idempotent by construction: the first write wins and later calls are no-ops.
 *
 * HISTORY IS NOT BACKFILLED. Access history begins on the release that ships
 * this module. Firebase Authentication's `lastSignInTime` is a single moving
 * value, not a log, so inventing past days from it would fabricate data.
 */

/**
 * The business-calendar timezone.
 *
 * The repository defined NO tournament/accounting timezone before this module
 * (no `America/`, `timeZone` or DST handling existed anywhere in the backend),
 * so this is the first explicit convention rather than an override of one.
 * Every future day-bucketed feature should reuse this constant.
 */
export const ACTIVITY_TIMEZONE = "America/Sao_Paulo";

/** The collection holding one document per player per business day. */
export const ACTIVITY_COLLECTION = "player_activity";

/**
 * How far a CLIENT-reported day may sit from the server's day before it is
 * rejected as implausible. One day absorbs the only legitimate cause — a device
 * a few hours off, or a call racing local midnight — while still rejecting a
 * client trying to write into last month or next year.
 */
export const MAX_CLIENT_DAY_DRIFT_DAYS = 1;

/** `YYYY-MM-DD`, and nothing else. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The earliest day this feature can legitimately record. Anything before the
 * beta exists is corrupt input, not history — and this module never backfills.
 */
const EARLIEST_PLAUSIBLE_DAY = "2026-01-01";

/**
 * The business-calendar day (`YYYY-MM-DD`) an instant falls on.
 *
 * Uses `Intl` with an IANA zone rather than a hardcoded UTC-3 offset: Brazil
 * abolished DST in 2019, but hardcoding that assumption would silently produce
 * wrong day boundaries if it ever returns. `en-CA` is deliberate — it is the
 * locale whose short date format IS `YYYY-MM-DD` — but the parts are read
 * explicitly instead of trusting the joined string.
 */
export function businessDayKey(
  instant: Date,
  timeZone: string = ACTIVITY_TIMEZONE
): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw invalidArgument("Instante inválido para o calendário de negócio.");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (!year || !month || !day) {
    throw invalidArgument("Não foi possível resolver o dia de negócio.");
  }

  return `${year}-${month}-${day}`;
}

/**
 * The deterministic activity document id — one document per uid per business
 * day. This is what makes a same-day replay idempotent: the second call finds
 * the document and writes nothing.
 */
export function activityDocumentId(uid: string, dayKey: string): string {
  return `${uid}_${dayKey}`;
}

/**
 * Normalizes the uid with the secure pattern already used by `jointournament`,
 * `grantBetaCredit` and the settlement module: trimmed, non-empty, no "/", and
 * no longer than 200 chars — so it can never escape its document path.
 *
 * NOTE: this validates the uid that came FROM THE VERIFIED TOKEN. It is never
 * called on a payload-supplied uid, because the payload has no uid field.
 */
export function normalizeActivityUid(value: unknown): string {
  const uid = String(value || "").trim();
  if (!uid) {
    throw invalidArgument("UID do jogador é obrigatório.");
  }
  if (uid.includes("/") || uid.length > 200) {
    throw invalidArgument("UID do jogador inválido.");
  }
  return uid;
}

/**
 * True when the string is a real calendar date, not merely well-shaped.
 * Rejects `2026-02-30` and `2026-13-01`, which the regex alone accepts.
 */
function isRealCalendarDay(dayKey: string): boolean {
  const [year, month, day] = dayKey.split("-").map((p) => Number(p));
  if (month < 1 || month > 12 || day < 1) return false;
  // UTC is safe here: this only asks "does this Y/M/D exist", never "when".
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  );
}

/** Whole days between two `YYYY-MM-DD` keys, calendar-wise and sign-free. */
function absoluteDayDistance(a: string, b: string): number {
  const toUtcMs = (key: string) => {
    const [year, month, day] = key.split("-").map((p) => Number(p));
    return Date.UTC(year, month - 1, day);
  };
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.abs(toUtcMs(a) - toUtcMs(b)) / MS_PER_DAY;
}

/**
 * Validates an OPTIONAL client-reported day against the server's day.
 *
 * The result is advisory only: the caller still writes the SERVER day key. This
 * exists so a device with a badly wrong clock is rejected loudly instead of
 * silently recording a day the player never opened the app.
 *
 * Returns the normalized client day, or null when the client sent nothing.
 */
export function validateClientDay(
  raw: unknown,
  serverDayKey: string
): string | null {
  if (raw === undefined || raw === null) return null;

  if (typeof raw !== "string") {
    throw invalidArgument("Data do cliente inválida.");
  }
  const clientDay = raw.trim();
  if (!clientDay) {
    throw invalidArgument("Data do cliente inválida.");
  }
  if (!DAY_KEY_PATTERN.test(clientDay)) {
    throw invalidArgument("Data do cliente deve estar no formato AAAA-MM-DD.");
  }
  if (!isRealCalendarDay(clientDay)) {
    throw invalidArgument("Data do cliente não é uma data real.");
  }
  if (clientDay < EARLIEST_PLAUSIBLE_DAY) {
    throw invalidArgument("Data do cliente é implausível.");
  }
  if (absoluteDayDistance(clientDay, serverDayKey) > MAX_CLIENT_DAY_DRIFT_DAYS) {
    throw new DomainError(
      "failed-precondition",
      "Relógio do dispositivo muito distante do servidor."
    );
  }
  return clientDay;
}

/**
 * Validates an OPTIONAL client timezone offset, in minutes, as reported by the
 * device. Advisory metadata only — it never selects the business day.
 *
 * The accepted band is the real range of world offsets (UTC-12:00 to UTC+14:00);
 * anything outside it is a malformed client, not an exotic location.
 */
export function validateClientOffsetMinutes(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw invalidArgument("Fuso horário do cliente inválido.");
  }
  if (raw < -12 * 60 || raw > 14 * 60) {
    throw invalidArgument("Fuso horário do cliente fora do intervalo válido.");
  }
  return raw;
}

/** The persisted activity fields a replay check compares. */
export interface StoredActivity {
  readonly uid?: unknown;
  readonly activityDay?: unknown;
  readonly userRefPath?: string | null;
}

/**
 * Decides whether an EXISTING activity document makes this call an idempotent
 * replay. A document whose uid or day disagrees with the deterministic id it
 * lives under is corrupt state, never silently adopted.
 */
export function checkActivityReplay(input: {
  readonly uid: string;
  readonly dayKey: string;
  readonly stored: StoredActivity;
}): { ok: true } | { ok: false; message: string } {
  const { stored } = input;
  const consistent =
    stored.uid === input.uid &&
    stored.activityDay === input.dayKey &&
    stored.userRefPath === `users/${input.uid}`;

  if (!consistent) {
    return {
      ok: false,
      message: "Registro de acesso divergente para este dia.",
    };
  }
  return { ok: true };
}
