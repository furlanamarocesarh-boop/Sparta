import {
  BETA_ENTRY_FEE_CATEGORY,
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
  type EconomyType,
} from "./economy.js";
import { inspectReais } from "./money.js";

/**
 * The creator ranking — who moved the most money through their own tournaments.
 *
 * WHAT "MOVED" MEANS, decided and frozen: the sum of ENTRY FEES paid by
 * players to join their tournaments. Not prizes paid, and not both added
 * together. Entry fees measure what the creator GENERATED — a tournament that
 * is still filling already counts, and a creator is not punished for a
 * settlement that has not happened yet. Adding prizes on top would count the
 * same money twice, since an entry fee is usually what becomes the prize.
 *
 * TWO BOARDS, NEVER ONE. Cash and Beta Credits are separate documents and are
 * never summed, compared or ranked against each other — the same rule the
 * season ranking and the wallet already live by. A transaction whose category
 * disagrees with its tournament's economy is REFUSED rather than filed under a
 * guess: a row in the wrong board is a lie about real money.
 *
 * THE UID NEVER LEAVES. An entry is keyed by the creator's uid because that is
 * the only stable identifier the server has, and `projectCreatorRow` builds
 * what the client sees key by key — so the uid stays on this side, exactly as
 * on the public profile.
 */

export const CREATOR_RANKINGS_COLLECTION = "creator_rankings";

/**
 * The per-season creator board, kept ALONGSIDE the all-time one above.
 *
 * TWO BOARDS, NOT A REPLACEMENT. The leaderboard the app shows is all-time —
 * "who has moved the most, ever" — and turning it into a monthly board would
 * silently change a feature that was already decided. But a season placement
 * badge needs a season, so the same accrual also writes here. It is one extra
 * document per paid registration, which is nothing against the cost of having
 * one number mean two different things.
 *
 * Document id follows `seasonDocumentId`: the economy and the season, never one
 * without the other.
 */
export const CREATOR_SEASONS_COLLECTION = "creator_seasons";
export const CREATOR_ENTRIES_SUBCOLLECTION = "entries";

/** The field the board is ordered by. Integer centavos, never reais. */
export const CREATOR_VOLUME_FIELD = "volume_centavos";

/**
 * How many rows one leaderboard page may return.
 *
 * BOUNDED BECAUSE THE READ FANS OUT. Each row needs the creator's tournament
 * count, which is an aggregate query per creator; an unbounded page would turn
 * one call into an unbounded number of them. Twenty-five is a leaderboard
 * people actually read, and the cost is knowable in advance.
 */
export const CREATOR_LEADERBOARD_PAGE_SIZE = 25;

/** The entry-fee category that belongs to each economy. */
const CASH_ENTRY_FEE_CATEGORY = "entry_fee";

/**
 * Which economy an entry-fee category belongs to, or null when the category is
 * not an entry fee at all.
 *
 * A CLOSED ALLOWLIST. Every other ledger row — prize, deposit, withdrawal,
 * refund, house funding — is not volume a creator generated, and treating an
 * unknown future category as one would silently inflate somebody's rank.
 */
export function economyOfEntryFee(category: unknown): EconomyType | null {
  if (category === CASH_ENTRY_FEE_CATEGORY) return ECONOMY_CASH;
  if (category === BETA_ENTRY_FEE_CATEGORY) return ECONOMY_BETA_CREDIT;
  return null;
}

export interface CreatorAccrualInput {
  /** The ledger row's category, verbatim. */
  readonly category: unknown;
  /** The row's amount in reais. Stored negative (a debit); magnitude is used. */
  readonly amount: unknown;
  /** `creator_uid` from the tournament the fee was paid into. */
  readonly creatorUid: unknown;
  /** `economy_type` from that same tournament. */
  readonly tournamentEconomy: unknown;
  /** The uid that paid. Used only to refuse self-inflation. */
  readonly payerUid: unknown;
}

export type CreatorAccrual =
  | {
      readonly accrue: true;
      readonly economy: EconomyType;
      readonly creatorUid: string;
      readonly centavos: number;
    }
  | { readonly accrue: false; readonly reason: CreatorAccrualRefusal };

export type CreatorAccrualRefusal =
  | "not-an-entry-fee"
  | "no-creator"
  | "economy-mismatch"
  | "bad-amount"
  | "zero-amount"
  | "self-entry";

/**
 * Decides whether one ledger row adds to a creator's volume, and how much.
 *
 * ORDER MATTERS, cheapest and most disqualifying first. The economy check comes
 * BEFORE the amount is even inspected, because a mismatch means the two sides
 * disagree about what kind of money this is, and no amount is meaningful until
 * that is settled.
 */
export function decideCreatorAccrual(
  input: CreatorAccrualInput
): CreatorAccrual {
  const economy = economyOfEntryFee(input.category);
  if (economy === null) return { accrue: false, reason: "not-an-entry-fee" };

  const creatorUid = normalizeUid(input.creatorUid);
  if (creatorUid === null) return { accrue: false, reason: "no-creator" };

  // FAIL CLOSED ON DISAGREEMENT. A `beta_entry_fee` filed against a cash
  // tournament means one of the two documents is wrong, and picking either
  // one would publish real money under the wrong board.
  if (input.tournamentEconomy !== economy) {
    return { accrue: false, reason: "economy-mismatch" };
  }

  // A CREATOR JOINING THEIR OWN TOURNAMENT DOES NOT COUNT. The fee is real and
  // the ledger keeps it, but ranking it as volume they generated would let
  // anyone climb by paying themselves in a loop.
  const payerUid = normalizeUid(input.payerUid);
  if (payerUid !== null && payerUid === creatorUid) {
    return { accrue: false, reason: "self-entry" };
  }

  const raw = input.amount;
  const inspection = inspectReais(
    typeof raw === "number" ? Math.abs(raw) : raw,
    { allowZero: true }
  );
  if (!inspection.ok) return { accrue: false, reason: "bad-amount" };

  // A FREE TOURNAMENT MOVES NO MONEY. It is a legitimate row, not corrupt data,
  // so it is refused quietly rather than written as a zero increment.
  if (inspection.centavos === 0) {
    return { accrue: false, reason: "zero-amount" };
  }

  return {
    accrue: true,
    economy,
    creatorUid,
    centavos: inspection.centavos,
  };
}

/**
 * The same uid rule the rest of the backend uses: trimmed, non-empty, no "/",
 * at most 200 chars — so it can never escape its document path.
 */
function normalizeUid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const uid = value.trim();
  if (!uid || uid !== value) return null;
  if (uid.includes("/") || uid.length > 200) return null;
  return uid;
}

/** Exactly what one leaderboard row looks like to a client. */
export interface CreatorRow {
  readonly position: number;
  /** The Sparta nickname, or empty when the creator has not chosen one. */
  readonly nickname: string;
  /**
   * The pseudonym that addresses their public profile, or null when they do
   * not have one yet. Null means the row simply is not tappable.
   */
  readonly publicPlayerId: string | null;
  readonly volumeCentavos: number;
  readonly tournamentsCreated: number;
}

export interface CreatorRowSource {
  readonly position: number;
  readonly nickname: unknown;
  readonly publicPlayerId: unknown;
  readonly volumeCentavos: unknown;
  readonly tournamentsCreated: unknown;
}

/**
 * Builds one row, key by key.
 *
 * BUILT UP, NOT STRIPPED DOWN — the same rule as the public profile, and for
 * the same reason: the stored entry carries `creator_uid`, and a projection
 * that started from the document and deleted what it remembered would ship it
 * the first time somebody added a field without reading this function.
 */
export function projectCreatorRow(source: CreatorRowSource): CreatorRow {
  return {
    position: source.position,
    nickname: typeof source.nickname === "string" ? source.nickname.trim() : "",
    publicPlayerId:
      typeof source.publicPlayerId === "string" && source.publicPlayerId !== ""
        ? source.publicPlayerId
        : null,
    volumeCentavos: readCount(source.volumeCentavos),
    tournamentsCreated: readCount(source.tournamentsCreated),
  };
}

/** A stored non-negative integer, or zero. A display path never throws. */
function readCount(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}
