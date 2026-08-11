import { addAggregateCentavos } from "./aggregateMoney.js";
import { ECONOMY_BETA_CREDIT, ECONOMY_CASH } from "./economy.js";
import { BETA_PRIZE_CATEGORY } from "./economy.js";
import { DomainError, failedPrecondition } from "./errors.js";
import { monthOfDayKey, normalizeMonth } from "./engagementStats.js";
import { ACTIVITY_TIMEZONE, businessDayKey } from "./playerActivity.js";
import { isPublicPlayerId } from "./publicPlayerId.js";

/**
 * Season ranking — the PURE domain rules, with no `firebase-functions` and no
 * Admin SDK import, so every branch is unit-tested without a database.
 *
 * WHAT THIS OWNS (step 5 of the design's section 21, and nothing more):
 *  - which ledger rows are ranking-bearing at all;
 *  - the season a row belongs to, and that season's half-open window;
 *  - the first-active-season gate;
 *  - the arithmetic and the structural validation of an entry, a parent and an
 *    existing guard.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN. It never touches Firestore, exports no
 * Cloud Function, issues no query, and computes NO position, comparator, cursor
 * or tie-break — ordering is step 6 and is absent here on purpose. All I/O,
 * every transaction boundary and every server timestamp stay in `index.ts`.
 */

/** The two economies a prize can belong to. They are never summed. */
export type RankingEconomy = typeof ECONOMY_CASH | typeof ECONOMY_BETA_CREDIT;

/**
 * The cash prize ledger category, declared ONCE here instead of being spelled
 * out at each comparison. Its beta counterpart already has a constant
 * (`BETA_PRIZE_CATEGORY`), so this closes the asymmetry rather than adding a
 * second source of truth.
 */
export const CASH_PRIZE_CATEGORY = "prize";

/** The deterministic prefix every settlement prize transaction id carries. */
export const PRIZE_TRANSACTION_ID_PREFIX = "prize_";

/** The status a ledger row must carry to be counted. */
export const COMPLETED_TRANSACTION_STATUS = "completed";

export const SEASON_RANKINGS_COLLECTION = "season_rankings";
export const SEASON_ENTRIES_SUBCOLLECTION = "entries";
export const RANKING_EVENTS_COLLECTION = "ranking_events";

/**
 * The business calendar. Reused, never redefined: the repository designates
 * `ACTIVITY_TIMEZONE` as the convention for every day-bucketed feature, and a
 * second interpretation of "which month" is exactly the drift this avoids.
 */
export const RANKING_TIMEZONE = ACTIVITY_TIMEZONE;

/**
 * THE FIRST SEASON THE RANKING PROCESSES — explicitly August 2026.
 *
 * Source configuration and nothing else: not Firestore, not `functions.config()`,
 * not an environment variable, not Remote Config, and never an implicit default
 * such as "the current month". Events before this fixed milestone remain
 * permanently out of scope and are never backfilled.
 *
 * `null` remains the fail-closed state: no identity is minted, no transaction
 * is opened and no document is written.
 */
export const FIRST_ACTIVE_SEASON_ID: string | null = "2026-08";

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * True when the document id is the canonical settlement prize id.
 *
 * The trigger observes EVERY creation in `transactions`, so this is the first
 * and cheapest discriminator. It also rejects a row that merely carries a prize
 * category while living outside the deterministic namespace.
 */
export function isPrizeTransactionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.startsWith(PRIZE_TRANSACTION_ID_PREFIX) &&
    id.length > PRIZE_TRANSACTION_ID_PREFIX.length
  );
}

/**
 * Maps a ledger category to its economy, or null when the category is not
 * ranking-bearing.
 *
 * ALLOWLIST, never a denylist: `admin_correction`, a future category, a legacy
 * row and a typo are all equally excluded. The economy comes from the CATEGORY,
 * because the cash prize row carries no `economy_type` field at all.
 */
export function classifyPrizeCategory(
  category: unknown
): RankingEconomy | null {
  if (category === CASH_PRIZE_CATEGORY) return ECONOMY_CASH;
  if (category === BETA_PRIZE_CATEGORY) return ECONOMY_BETA_CREDIT;
  return null;
}

/** True when the stored status is exactly the settled status. */
export function isCompletedStatus(status: unknown): boolean {
  return status === COMPLETED_TRANSACTION_STATUS;
}

/**
 * A Firestore `Timestamp` (production), a `Date` (tests), or null for anything
 * else. Duck-typed on `toDate()` so this module stays free of the Admin SDK.
 */
export function toUsableDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value && typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      const date = (value as { toDate: () => Date }).toDate();
      return date instanceof Date && !Number.isNaN(date.getTime())
        ? date
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ── Season derivation ───────────────────────────────────────────────────────

/** The `YYYY-MM` season an instant belongs to, in the business calendar. */
export function seasonIdFromInstant(instant: Date): string {
  return monthOfDayKey(businessDayKey(instant, RANKING_TIMEZONE));
}

/** The season document id: the economy and the season, never one without the other. */
export function seasonDocumentId(
  economy: RankingEconomy,
  seasonId: string
): string {
  return `${economy}_${seasonId}`;
}

/**
 * The zone's UTC offset, in milliseconds, at a given instant.
 *
 * Read from `Intl` rather than hardcoded: Brazil abolished DST in 2019, but
 * assuming that permanently would silently produce wrong month boundaries if it
 * ever returned.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined || !/^\d+$/.test(found.value)) {
      throw failedPrecondition("Não foi possível resolver o fuso da temporada.");
    }
    return Number(found.value);
  };

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    // `hour12: false` renders midnight as 24 in some ICU versions.
    read("hour") % 24,
    read("minute"),
    read("second")
  );

  return asUtc - instant.getTime();
}

/** The UTC instant of a local wall-clock midnight in the business calendar. */
function localMidnightUtc(year: number, month: number): Date {
  const wallAsUtc = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);

  // First approximation: assume the offset that applies at the wall time read
  // as UTC, then correct once against the offset that actually applies at the
  // resulting instant. Two passes are exact for every real zone rule.
  const firstPass = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), RANKING_TIMEZONE);
  const secondPass =
    wallAsUtc - zoneOffsetMs(new Date(firstPass), RANKING_TIMEZONE);

  return new Date(secondPass);
}

export interface SeasonWindow {
  /** First instant of the month, inclusive. */
  readonly start: Date;
  /** First instant of the FOLLOWING month, exclusive. */
  readonly end: Date;
}

/**
 * The half-open window `[start, nextStart)` of a season, in the business
 * calendar.
 *
 * Half-open on purpose: there is no `23:59:59.999` rounding edge, and
 * consecutive seasons neither gap nor overlap, so every instant belongs to
 * exactly one season.
 */
export function seasonWindow(seasonId: string): SeasonWindow {
  const month = normalizeMonth(seasonId);
  const start = localMidnightUtc(month.year, month.month);
  const end =
    month.month === 12
      ? localMidnightUtc(month.year + 1, 1)
      : localMidnightUtc(month.year, month.month + 1);

  return { start, end };
}

// ── First-active-season gate ────────────────────────────────────────────────

export type ActivationDecision =
  | { readonly kind: "inert" }
  | { readonly kind: "before-first-season" }
  | { readonly kind: "active" };

/**
 * Decides whether an event's season may be processed at all.
 *
 * `inert` means the feature is not configured: absent OR malformed both stop
 * everything, and a malformed value is never coerced into a plausible month.
 * `before-first-season` means the feature is live but this event predates the
 * milestone, which the design freezes as permanently out of scope — there is no
 * backfill.
 *
 * Both non-active outcomes are decided BEFORE any identity is minted and before
 * any transaction is opened, so an unconfigured deployment writes nothing at all.
 */
export function decideActivation(
  configured: unknown,
  seasonId: string
): ActivationDecision {
  if (typeof configured !== "string") return { kind: "inert" };

  let firstActive: string;
  try {
    firstActive = normalizeMonth(configured).key;
  } catch {
    return { kind: "inert" };
  }

  // `YYYY-MM` is fixed-width, so lexicographic order IS chronological order.
  return seasonId < firstActive
    ? { kind: "before-first-season" }
    : { kind: "active" };
}

// ── Shared numeric validation ───────────────────────────────────────────────

function isStoredCount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

function corrupt(what: string): DomainError {
  return failedPrecondition(`Documento de ranking inconsistente: ${what}.`);
}

// ── The accepted event ──────────────────────────────────────────────────────

/** Everything the writers need, already validated by the handler's front door. */
export interface PrizeRankingEvent {
  readonly transactionId: string;
  readonly publicPlayerId: string;
  readonly economy: RankingEconomy;
  readonly amountCentavos: number;
  readonly seasonId: string;
  readonly dayKey: string;
  readonly prizeAt: Date;
}

// ── Guard ───────────────────────────────────────────────────────────────────

/** The persisted guard, read back as plain values. */
export interface StoredGuard {
  readonly transactionRefPath?: unknown;
  readonly publicPlayerId?: unknown;
  readonly economy?: unknown;
  readonly amountCentavos?: unknown;
  readonly seasonId?: unknown;
  readonly dayKey?: unknown;
  readonly appliedAt?: unknown;
}

export type GuardDecision =
  | { readonly kind: "replay" }
  | { readonly kind: "apply" };

/**
 * Decides whether an existing guard makes this delivery an idempotent replay.
 *
 * A guard whose immutable fields all match the event means entry, parent and
 * guard were committed together — they share one atomic commit — so returning
 * without writing is safe and correct.
 *
 * ANY divergence is corruption and fails closed. The guard is never repaired,
 * never overwritten and never reconciled here: a wrong guard means something
 * upstream is wrong, and silently rewriting it would destroy the evidence.
 *
 * `appliedAt` is checked only for being a usable timestamp. Comparing it with a
 * fresh server timestamp would be meaningless — it records when the first
 * application happened, not when this delivery arrived.
 */
export function checkExistingGuard(input: {
  readonly event: PrizeRankingEvent;
  readonly expectedTransactionRefPath: string;
  readonly stored: StoredGuard | null;
}): GuardDecision {
  const { event, stored } = input;

  if (stored === null) return { kind: "apply" };

  if (stored.transactionRefPath !== input.expectedTransactionRefPath) {
    throw corrupt("a referência da transação do guard diverge");
  }
  if (stored.publicPlayerId !== event.publicPlayerId) {
    throw corrupt("o jogador do guard diverge");
  }
  if (stored.economy !== event.economy) {
    throw corrupt("a economia do guard diverge");
  }
  if (stored.amountCentavos !== event.amountCentavos) {
    throw corrupt("o valor do guard diverge");
  }
  if (stored.seasonId !== event.seasonId) {
    throw corrupt("a temporada do guard diverge");
  }
  if (stored.dayKey !== event.dayKey) {
    throw corrupt("o dia do guard diverge");
  }
  if (toUsableDate(stored.appliedAt) === null) {
    throw corrupt("o guard não tem data de aplicação utilizável");
  }

  return { kind: "replay" };
}

// ── Entry ───────────────────────────────────────────────────────────────────

export interface StoredEntry {
  readonly publicPlayerId?: unknown;
  readonly economy?: unknown;
  readonly seasonId?: unknown;
  readonly scoreCentavos?: unknown;
  readonly winsCount?: unknown;
  readonly firstPrizeAt?: unknown;
  readonly lastPrizeAt?: unknown;
}

export type EntryPlan =
  | {
      readonly kind: "create";
      readonly scoreCentavos: number;
      readonly winsCount: number;
      readonly firstPrizeAt: Date;
      readonly lastPrizeAt: Date;
    }
  | {
      readonly kind: "update";
      readonly scoreCentavos: number;
      readonly winsCount: number;
      readonly lastPrizeAt: Date;
    };

/**
 * The entry a prize produces, created or accumulated.
 *
 * A zero-centavo prize is a legitimate win: it creates the entry and increments
 * `winsCount` while adding zero to the score. `firstPrizeAt` is written once and
 * never moved; `lastPrizeAt` always advances to the prize's own timestamp, not
 * to the moment the trigger happened to run.
 *
 * An existing entry is validated in full before its numbers are trusted. An
 * overflow inside `addAggregateCentavos` propagates: it must abort the whole
 * transaction, never degrade into a clamp or a no-op.
 */
export function decideEntry(input: {
  readonly event: PrizeRankingEvent;
  readonly stored: StoredEntry | null;
}): EntryPlan {
  const { event, stored } = input;

  if (!isPublicPlayerId(event.publicPlayerId)) {
    throw corrupt("o identificador público do evento é inválido");
  }

  if (stored === null) {
    return {
      kind: "create",
      scoreCentavos: event.amountCentavos,
      winsCount: 1,
      firstPrizeAt: event.prizeAt,
      lastPrizeAt: event.prizeAt,
    };
  }

  if (stored.publicPlayerId !== event.publicPlayerId) {
    throw corrupt("o jogador da entry diverge");
  }
  if (stored.economy !== event.economy) {
    throw corrupt("a economia da entry diverge");
  }
  if (stored.seasonId !== event.seasonId) {
    throw corrupt("a temporada da entry diverge");
  }
  if (!isStoredCount(stored.scoreCentavos)) {
    throw corrupt("a pontuação da entry é inválida");
  }
  if (!isStoredCount(stored.winsCount) || stored.winsCount < 1) {
    throw corrupt("o número de vitórias da entry é inválido");
  }
  if (toUsableDate(stored.firstPrizeAt) === null) {
    throw corrupt("a data do primeiro prêmio é inválida");
  }
  if (toUsableDate(stored.lastPrizeAt) === null) {
    throw corrupt("a data do último prêmio é inválida");
  }

  return {
    kind: "update",
    scoreCentavos: addAggregateCentavos(
      stored.scoreCentavos,
      event.amountCentavos
    ),
    winsCount: stored.winsCount + 1,
    lastPrizeAt: event.prizeAt,
  };
}

// ── Parent ──────────────────────────────────────────────────────────────────

export interface StoredParent {
  readonly economy?: unknown;
  readonly seasonId?: unknown;
  readonly timezone?: unknown;
  readonly playerCount?: unknown;
  readonly totalScoreCentavos?: unknown;
  readonly windowStart?: unknown;
  readonly windowEnd?: unknown;
}

export type ParentPlan =
  | {
      readonly kind: "create";
      readonly playerCount: number;
      readonly totalScoreCentavos: number;
      readonly windowStart: Date;
      readonly windowEnd: Date;
    }
  | {
      readonly kind: "update";
      readonly playerCount: number;
      readonly totalScoreCentavos: number;
    };

/**
 * The season parent a prize produces, born on demand.
 *
 * `playerCount` counts materialized entries, so it advances only when the entry
 * itself is new. `totalScoreCentavos` always accumulates. The stored window is
 * re-derived and compared rather than trusted, so a parent written under a
 * different calendar interpretation is caught instead of being extended.
 *
 * A MISSING parent is only legitimate alongside a NEW entry. Firestore keeps a
 * subcollection alive after its parent document is deleted, so "no parent but
 * the entry already exists" is a real, reachable state — and rebuilding from it
 * would silently republish `playerCount: 1` and a single-prize total over
 * however many entries actually survive. That is precisely the silent repair the
 * design forbids, so it fails closed instead.
 */
export function decideParent(input: {
  readonly event: PrizeRankingEvent;
  readonly stored: StoredParent | null;
  readonly entryCreated: boolean;
  readonly window: SeasonWindow;
}): ParentPlan {
  const { event, stored, window } = input;

  if (stored === null) {
    if (!input.entryCreated) {
      throw corrupt(
        "o parent da temporada não existe, mas a entry do jogador já existe"
      );
    }

    return {
      kind: "create",
      playerCount: 1,
      totalScoreCentavos: event.amountCentavos,
      windowStart: window.start,
      windowEnd: window.end,
    };
  }

  if (stored.economy !== event.economy) {
    throw corrupt("a economia do parent diverge");
  }
  if (stored.seasonId !== event.seasonId) {
    throw corrupt("a temporada do parent diverge");
  }
  if (stored.timezone !== RANKING_TIMEZONE) {
    throw corrupt("o fuso do parent diverge");
  }
  if (!isStoredCount(stored.playerCount) || stored.playerCount < 1) {
    throw corrupt("a contagem de jogadores do parent é inválida");
  }
  if (!isStoredCount(stored.totalScoreCentavos)) {
    throw corrupt("o total do parent é inválido");
  }

  const storedStart = toUsableDate(stored.windowStart);
  const storedEnd = toUsableDate(stored.windowEnd);
  if (storedStart === null || storedEnd === null) {
    throw corrupt("a janela do parent é inválida");
  }
  if (storedStart.getTime() !== window.start.getTime()) {
    throw corrupt("o início da janela do parent diverge");
  }
  if (storedEnd.getTime() !== window.end.getTime()) {
    throw corrupt("o fim da janela do parent diverge");
  }

  return {
    kind: "update",
    playerCount: input.entryCreated
      ? stored.playerCount + 1
      : stored.playerCount,
    totalScoreCentavos: addAggregateCentavos(
      stored.totalScoreCentavos,
      event.amountCentavos
    ),
  };
}
