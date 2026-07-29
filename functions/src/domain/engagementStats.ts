import { DomainError, invalidArgument } from "./errors.js";
import { addCentavos, inspectReais, subtractCentavos } from "./money.js";
import { businessDayKey, ACTIVITY_TIMEZONE } from "./playerActivity.js";

/**
 * Competitive statistics — the PURE domain rules, with no `firebase-functions`
 * and no Admin SDK import, so every branch is unit-tested without a database.
 *
 * WHAT THIS COMPUTES: the player's TOURNAMENT net result, derived read-only
 * from canonical ledger rows. It never writes, never changes a balance, and is
 * NOT a source of truth — the wallet and the ledger remain authoritative. There
 * is deliberately no persisted aggregate for a client to tamper with.
 *
 * THE TWO ECONOMIES ARE NEVER SUMMED. `cash` is Brazilian reais; `beta_credit`
 * is non-monetary Beta Credits. The repository's frozen contract forbids adding
 * them, so this module returns them as two independent results and offers no
 * combined figure — there is no field that could hold one.
 *
 * MONEY UNIT: every amount this module produces is an INTEGER number of
 * centavos (for cash) or centavos-like units (for beta), never a float. Stored
 * reais are converted at the edge through `money.ts`, all arithmetic uses
 * `addCentavos`/`subtractCentavos`, and nothing is divided back to reais here.
 */

/** The calendar used for day, week and month boundaries. */
export const STATS_TIMEZONE = ACTIVITY_TIMEZONE;

/** Weeks begin on Monday. 1 = Monday … 7 = Sunday (ISO). */
export const WEEK_START_ISO_WEEKDAY = 1;

/** Which pool a ledger row moved. */
export type StatsEconomy = "cash" | "beta_credit";

/**
 * The part a canonical category plays in the tournament result.
 *
 * `entry` subtracts, `prize` and `refund` add, `excluded` does nothing.
 */
export type LedgerRole = "entry" | "prize" | "refund" | "excluded";

export interface CategoryMapping {
  readonly role: LedgerRole;
  /** Null exactly when [role] is `excluded`. */
  readonly economy: StatsEconomy | null;
  /** -1 subtracts, +1 adds, 0 ignores. Derived from [role], never stored. */
  readonly sign: -1 | 0 | 1;
}

const EXCLUDED: CategoryMapping = { role: "excluded", economy: null, sign: 0 };

/**
 * THE CANONICAL MAPPING — every category any deployed handler writes.
 *
 * | category         | written by                | economy | role     | sign |
 * |------------------|---------------------------|---------|----------|------|
 * | `entry_fee`      | jointournament (cash)     | cash    | entry    |  -1  |
 * | `prize`          | declareTournamentResult   | cash    | prize    |  +1  |
 * | `entry_refund`   | cancelTournament (cash)   | cash    | refund   |  +1  |
 * | `beta_entry_fee` | jointournament (beta)     | beta    | entry    |  -1  |
 * | `beta_prize`     | declareTournamentResult   | beta    | prize    |  +1  |
 * | `beta_refund`    | cancelTournament (beta)   | beta    | refund   |  +1  |
 * | `deposit`        | testdeposit               | —       | excluded |   0  |
 * | `withdrawal`     | requestwithdrawal         | —       | excluded |   0  |
 * | `beta_grant`     | grantBetaCredit           | —       | excluded |   0  |
 *
 * ECONOMY COMES FROM THE CATEGORY, NOT FROM `economy_type`. The cash `prize`,
 * `deposit` and `withdrawal` rows do not carry an `economy_type` field at all,
 * so the category is the only discriminator present on every row.
 *
 * REFUNDS use their real signed effect (+): `entry_refund`/`beta_refund` are
 * dedicated categories written only by `cancelTournament` when money returns to
 * the player, so an entry (-5) plus its refund (+5) nets to exactly zero.
 *
 * EXCLUSIONS: a deposit is the player's own money arriving, a withdrawal is it
 * leaving, and a beta grant is a gift. None is something the player won or lost
 * by competing. Anything NOT in this table — including the one-off
 * `admin_correction` bookkeeping row, which no handler writes — is excluded by
 * the unknown-category policy below.
 */
const CATEGORY_TABLE: Readonly<Record<string, CategoryMapping>> = {
  entry_fee: { role: "entry", economy: "cash", sign: -1 },
  prize: { role: "prize", economy: "cash", sign: 1 },
  entry_refund: { role: "refund", economy: "cash", sign: 1 },
  beta_entry_fee: { role: "entry", economy: "beta_credit", sign: -1 },
  beta_prize: { role: "prize", economy: "beta_credit", sign: 1 },
  beta_refund: { role: "refund", economy: "beta_credit", sign: 1 },
  deposit: EXCLUDED,
  withdrawal: EXCLUDED,
  beta_grant: EXCLUDED,
};

/** The only status that represents a settled result. */
export const COMPLETED_STATUS = "completed";

/**
 * Classifies a stored category.
 *
 * UNKNOWN-CATEGORY POLICY (explicit, tested): anything not in the table above —
 * a legacy row, a future category, an administrative adjustment — is EXCLUDED
 * and counted, never guessed at. Excluding is the safe direction: a row we
 * cannot classify must not silently move a player's reported result.
 */
export function classifyCategory(category: unknown): CategoryMapping {
  if (typeof category !== "string") return EXCLUDED;
  return CATEGORY_TABLE[category.trim()] ?? EXCLUDED;
}

/** True when this category is known to the table (counted or deliberately excluded). */
export function isKnownCategory(category: unknown): boolean {
  return (
    typeof category === "string" &&
    Object.prototype.hasOwnProperty.call(CATEGORY_TABLE, category.trim())
  );
}

// ── Month ───────────────────────────────────────────────────────────────────

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const MIN_YEAR = 2020;
const MAX_YEAR = 2100;

export interface NormalizedMonth {
  readonly year: number;
  readonly month: number;
  readonly key: string;
}

/**
 * Validates the requested `YYYY-MM`. Strict: rejects a missing value, a
 * non-string, a malformed shape, month 00 or 13, and an implausible year.
 */
export function normalizeMonth(raw: unknown): NormalizedMonth {
  if (typeof raw !== "string") {
    throw invalidArgument("O mês é obrigatório no formato AAAA-MM.");
  }
  const key = raw.trim();
  if (!MONTH_PATTERN.test(key)) {
    throw invalidArgument("O mês precisa estar no formato AAAA-MM.");
  }
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  if (month < 1 || month > 12) {
    throw invalidArgument("O mês precisa estar entre 01 e 12.");
  }
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw invalidArgument("O ano solicitado está fora do intervalo suportado.");
  }
  return { year, month, key };
}

/** `YYYY-MM` of a day key `YYYY-MM-DD`. */
export function monthOfDayKey(dayKey: string): string {
  return dayKey.slice(0, 7);
}

/** Days in the calendar month, as `YYYY-MM-DD`, ascending. */
export function daysInMonth(month: NormalizedMonth): string[] {
  const count = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= count; d++) {
    days.push(`${month.key}-${String(d).padStart(2, "0")}`);
  }
  return days;
}

// ── Week (Monday-based) ─────────────────────────────────────────────────────

/**
 * The Monday of the week containing [dayKey], as `YYYY-MM-DD`.
 *
 * UTC is used only to do calendar arithmetic on an already-resolved local day —
 * never to decide which day an instant belongs to. That decision is made once,
 * by `businessDayKey`, in [STATS_TIMEZONE].
 */
export function weekStartOf(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0 = Sunday. Convert to ISO 1 = Monday … 7 = Sunday.
  const iso = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() - (iso - WEEK_START_ISO_WEEKDAY));
  return utc.toISOString().slice(0, 10);
}

/** True when [dayKey] falls in the Monday-based week containing [reference]. */
export function isSameWeek(dayKey: string, reference: string): boolean {
  return weekStartOf(dayKey) === weekStartOf(reference);
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/** One canonical ledger row, already read from Firestore. */
export interface LedgerRow {
  readonly id: string;
  readonly category: unknown;
  readonly status: unknown;
  readonly amount: unknown;
  /** The instant the row was written. Absent/unparseable rows are skipped. */
  readonly at: Date | null;
}

export interface EconomyTotals {
  /** `YYYY-MM-DD` → net centavos, only for days inside the requested month. */
  readonly dailyNet: ReadonlyMap<string, number>;
  readonly currentWeekNet: number;
  readonly currentMonthNet: number;
  readonly lifetimeNet: number;
}

export interface AggregationResult {
  readonly cash: EconomyTotals;
  readonly beta: EconomyTotals;
  /** Rows skipped because the category is not in the canonical table. */
  readonly excludedUnknownCategory: number;
  /** Rows skipped because the stored amount is unusable. */
  readonly excludedMalformedAmount: number;
  /** Rows skipped because they carry no usable timestamp. */
  readonly excludedUndated: number;
  /** Rows skipped because the status is not `completed`. */
  readonly excludedNotCompleted: number;
}

interface Mutable {
  daily: Map<string, number>;
  week: number;
  month: number;
  lifetime: number;
}

const emptyMutable = (): Mutable => ({
  daily: new Map(),
  week: 0,
  month: 0,
  lifetime: 0,
});

const freeze = (m: Mutable): EconomyTotals => ({
  dailyNet: m.daily,
  currentWeekNet: m.week,
  currentMonthNet: m.month,
  lifetimeNet: m.lifetime,
});

/**
 * Aggregates ledger rows into per-economy totals.
 *
 * [requestedMonth] scopes `dailyNet` — the calendar the client asked for.
 * [today] is the SERVER's current business day and scopes `currentWeekNet`
 * (Monday-based) and `currentMonthNet`. `lifetimeNet` spans everything.
 *
 * Every skip is counted rather than silently swallowed, so the caller can
 * disclose exactly how many rows did not reach a total.
 */
export function aggregateLedger(input: {
  readonly rows: readonly LedgerRow[];
  readonly requestedMonth: NormalizedMonth;
  readonly today: string;
  readonly timeZone?: string;
}): AggregationResult {
  const timeZone = input.timeZone ?? STATS_TIMEZONE;
  const cash = emptyMutable();
  const beta = emptyMutable();

  let excludedUnknownCategory = 0;
  let excludedMalformedAmount = 0;
  let excludedUndated = 0;
  let excludedNotCompleted = 0;

  const currentMonth = input.today.slice(0, 7);

  for (const row of input.rows) {
    if (!isKnownCategory(row.category)) {
      excludedUnknownCategory++;
      continue;
    }

    const mapping = classifyCategory(row.category);
    if (mapping.sign === 0 || mapping.economy === null) continue;

    const status = typeof row.status === "string" ? row.status.trim() : "";
    if (status.toLowerCase() !== COMPLETED_STATUS) {
      excludedNotCompleted++;
      continue;
    }

    // Stored amounts are non-negative reais; the ROLE supplies the sign, so a
    // corrupt negative amount can never flip an entry fee into a prize.
    const inspection = inspectReais(row.amount, { allowZero: true });
    if (!inspection.ok) {
      excludedMalformedAmount++;
      continue;
    }
    const magnitude = inspection.centavos;

    if (row.at === null) {
      excludedUndated++;
      continue;
    }

    let dayKey: string;
    try {
      dayKey = businessDayKey(row.at, timeZone);
    } catch {
      excludedUndated++;
      continue;
    }

    const target = mapping.economy === "cash" ? cash : beta;
    const apply = (base: number) =>
      mapping.sign === 1
        ? addCentavos(base, magnitude)
        : subtractCentavos(base, magnitude);

    target.lifetime = apply(target.lifetime);
    if (monthOfDayKey(dayKey) === currentMonth) target.month = apply(target.month);
    if (isSameWeek(dayKey, input.today)) target.week = apply(target.week);
    if (monthOfDayKey(dayKey) === input.requestedMonth.key) {
      target.daily.set(dayKey, apply(target.daily.get(dayKey) ?? 0));
    }
  }

  return {
    cash: freeze(cash),
    beta: freeze(beta),
    excludedUnknownCategory,
    excludedMalformedAmount,
    excludedUndated,
    excludedNotCompleted,
  };
}

/**
 * The `dailyNet` array for one economy: every day of the requested month that
 * has a non-zero result, ascending by date. Days with no movement are omitted —
 * the client renders the full calendar grid and treats an absent day as zero.
 */
export function dailyNetArray(
  totals: EconomyTotals
): { date: string; amount: number }[] {
  return [...totals.dailyNet.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, amount]) => ({ date, amount }));
}

/**
 * Activity day keys inside the requested month, deduplicated and ascending.
 * A malformed stored `activity_day` is dropped rather than surfaced.
 */
export function activityDaysInMonth(
  storedDays: readonly unknown[],
  month: NormalizedMonth
): string[] {
  const valid = new Set<string>();
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  for (const raw of storedDays) {
    if (typeof raw !== "string") continue;
    const day = raw.trim();
    if (!pattern.test(day)) continue;
    if (monthOfDayKey(day) !== month.key) continue;
    const [y, m, d] = day.split("-").map(Number);
    const asUtc = new Date(Date.UTC(y, m - 1, d));
    if (
      asUtc.getUTCFullYear() !== y ||
      asUtc.getUTCMonth() !== m - 1 ||
      asUtc.getUTCDate() !== d
    ) {
      continue;
    }
    valid.add(day);
  }
  return [...valid].sort();
}

/** Guards a uid taken from the verified token. Mirrors the other modules. */
export function normalizeStatsUid(value: unknown): string {
  const uid = String(value || "").trim();
  if (!uid) throw invalidArgument("UID do jogador é obrigatório.");
  if (uid.includes("/") || uid.length > 200) {
    throw invalidArgument("UID do jogador inválido.");
  }
  return uid;
}

/** Re-exported so the handler and tests share one DomainError import path. */
export { DomainError };
