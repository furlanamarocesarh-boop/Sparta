import { invalidArgument } from "./errors.js";
import { ECONOMY_CASH, type EconomyType } from "./economy.js";

/**
 * Partner (influencer) referral — the PURE domain rules, with no
 * `firebase-functions` and no Admin SDK import, so every branch is unit-tested
 * without a database.
 *
 * WHAT THIS PHASE BUILDS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It builds ATTRIBUTION (who brought whom, and until when) and ACCRUAL (how
 * much is owed). It does NOT pay anybody. That is not an omission — it is
 * forced by the backend as it stands:
 *
 *  - there is no real-money deposit path in production (`testdeposit` is gated
 *    by an admin claim AND a `demo-` project check), so no BRL enters a wallet;
 *  - `requestwithdrawal` debits and writes `status: "pending"`, and NOTHING in
 *    the codebase ever moves that document to paid — not even for players;
 *  - settlement credits the winner the FULL `prize` and retains nothing, so the
 *    7,5 % fee below is product policy, not bookkeeping.
 *
 * Accruing is still worth doing now, because attribution is the one input that
 * CANNOT be reconstructed later: a commission can be recomputed over history,
 * but "who referred this player" only exists if it was recorded at the moment
 * of the click.
 *
 * PRIVACY. Linking a player to the partner who recruited them is new personal
 * data processing, and section 10.6 of the ranking design records that the
 * current LGPD basis does NOT cover partner attribution. Shipping this requires
 * a privacy-notice change; no code in this module can substitute for that.
 */

/** Partner registry. Admin-created; never client-writable. */
export const PARTNERS_COLLECTION = "partners";

/**
 * The uniqueness guard for referral codes, keyed BY the code. The document id
 * *is* the lock — Firestore guarantees at most one — so claiming a code is a
 * create-only write rather than a read-then-write race. Same structural trick
 * as `public_player_id_index`.
 */
export const REFERRAL_CODES_COLLECTION = "referral_codes";

/** Ledger category of an accrued, not yet payable, partner commission. */
export const COMMISSION_ACCRUED_CATEGORY = "commission_accrued";

/**
 * Approved product rates, transcribed from
 * `docs/design/season-rankings-admin-metrics.md` section 10.6.1. They are
 * POLICY: this module computes what is owed under them, and does not retain,
 * move or pay anything.
 *
 *   sparta_fee_bps        = 750   -> 7,5 % of the cash entry fee
 *   partner_commission_bps = 4000 -> 40 % OF THAT FEE (~3 % of the entry)
 *
 * Two consequences are written into the rules below because the same document
 * states them: the fee is INCLUDED in the entry fee, so a player is never
 * charged extra for having been referred; and beta or free tournaments generate
 * no fee at all, so they can never accrue a commission.
 */
export const SPARTA_FEE_BPS = 750;
export const PARTNER_COMMISSION_BPS = 4000;

/** Basis points are per ten thousand. Named so no call site writes `10000`. */
export const BPS_DENOMINATOR = 10_000;

/**
 * How long an attribution earns, counted from the moment it is recorded.
 *
 * The window bounds the liability: a partner is paid for the year that follows
 * the acquisition, not forever. `attributed_at` and `attribution_expires_at`
 * are both persisted so the expiry is a stored fact rather than a value
 * recomputed from a constant that might later change.
 */
export const ATTRIBUTION_WINDOW_MONTHS = 12;

/**
 * Referral code format.
 *
 * DIFFERENT THREAT MODEL FROM `publicPlayerId`, ON PURPOSE. A pseudonym must be
 * unguessable, because guessing one would confirm a player's presence on a
 * public leaderboard. A referral code is the opposite: it is printed in a bio,
 * read aloud in a video and typed by hand, so it must be short and memorable.
 * Guessing one buys an attacker nothing — the code only says which partner gets
 * credit, and claiming is authenticated and create-only.
 *
 * So the code is an admin-assigned slug, not entropy: lowercase ASCII letters,
 * digits and single inner hyphens, 3..24 characters.
 */
export const REFERRAL_CODE_MIN_LENGTH = 3;
export const REFERRAL_CODE_MAX_LENGTH = 24;
const REFERRAL_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Codes that must never be issued, because they would collide with a route
 * segment or impersonate the platform. Checked after normalisation.
 */
export const RESERVED_REFERRAL_CODES: readonly string[] = [
  "admin",
  "api",
  "app",
  "sparta",
  "spartabattle",
  "suporte",
  "support",
  "t",
  "r",
  "www",
];

/**
 * Everything that can be wrong with a referral code, as DATA rather than as an
 * exception — so an admin screen can explain the problem, and so the rules are
 * unit-testable without catching throws. Same shape as `MoneyProblem`.
 */
export type ReferralCodeProblem =
  | "missing"
  | "not-a-string"
  | "too-short"
  | "too-long"
  | "bad-characters"
  | "reserved";

export type ReferralCodeInspection =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly problem: ReferralCodeProblem };

/**
 * The single definition of "valid referral code" in the codebase.
 *
 * Normalises before judging — trims and lowercases — so `" JoaoGamer "` and
 * `"joaogamer"` are the same code and cannot both be issued.
 */
export function inspectReferralCode(value: unknown): ReferralCodeInspection {
  if (value === undefined || value === null || value === "") {
    return { ok: false, problem: "missing" };
  }
  if (typeof value !== "string") {
    return { ok: false, problem: "not-a-string" };
  }

  const code = value.trim().toLowerCase();

  /**
   * RESERVATION IS CHECKED FIRST, BEFORE LENGTH AND SHAPE.
   *
   * Not for speed — for authority. Some reserved words are shorter than the
   * minimum length (`t`, the tournament route segment), so a cheapest-first
   * order would reject them as "too-short" and the reservation would never be
   * consulted. That is a list which LOOKS like it protects a route while
   * actually being shadowed by an unrelated rule: relax the minimum length
   * later and the protection silently changes meaning. Checking reservation
   * first makes the list mean exactly what it says, whatever the other rules do.
   */
  if (RESERVED_REFERRAL_CODES.includes(code)) {
    return { ok: false, problem: "reserved" };
  }
  if (code.length < REFERRAL_CODE_MIN_LENGTH) {
    return { ok: false, problem: "too-short" };
  }
  if (code.length > REFERRAL_CODE_MAX_LENGTH) {
    return { ok: false, problem: "too-long" };
  }
  if (!REFERRAL_CODE_PATTERN.test(code)) {
    return { ok: false, problem: "bad-characters" };
  }

  return { ok: true, code };
}

/** Throwing wrapper for handler code, which wants a normalised code or an error. */
export function normalizeReferralCode(value: unknown): string {
  const seen = inspectReferralCode(value);
  if (seen.ok) return seen.code;

  const messages: Record<ReferralCodeProblem, string> = {
    missing: "Informe o código de indicação.",
    "not-a-string": "O código de indicação precisa ser um texto.",
    "too-short": `O código precisa ter ao menos ${REFERRAL_CODE_MIN_LENGTH} caracteres.`,
    "too-long": `O código pode ter no máximo ${REFERRAL_CODE_MAX_LENGTH} caracteres.`,
    "bad-characters":
      "O código aceita apenas letras minúsculas, números e hífen entre eles.",
    reserved: "Esse código é reservado.",
  };
  throw invalidArgument(messages[seen.problem]);
}

/**
 * Adds whole months to an instant, clamping the day so month-end never rolls
 * forward. 31 Jan + 1 month is 28/29 Feb, never 2/3 March — a rollover would
 * silently hand a partner an extra day of commission.
 */
export function addMonths(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  const lastDayOfTarget = new Date(
    Date.UTC(year, month + months + 1, 0)
  ).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month + months,
      Math.min(day, lastDayOfTarget),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds()
    )
  );
}

/** When an attribution recorded at [attributedAt] stops earning. */
export function attributionExpiresAt(attributedAt: Date): Date {
  return addMonths(attributedAt, ATTRIBUTION_WINDOW_MONTHS);
}

/**
 * The platform fee contained in a cash entry fee, in integer centavos.
 *
 * Floor, not round: rounding up would let the platform accrue a liability
 * larger than the fee it actually contains, which is the one direction that
 * cannot be allowed when the commission is funded by that fee.
 */
export function feeCentavosFor(entryCentavos: number): number {
  assertWholeNonNegative(entryCentavos, "entryCentavos");
  return Math.floor((entryCentavos * SPARTA_FEE_BPS) / BPS_DENOMINATOR);
}

/** The partner's share OF THE FEE — never of the entry — in integer centavos. */
export function commissionCentavosFor(entryCentavos: number): number {
  const fee = feeCentavosFor(entryCentavos);
  const commission = Math.floor(
    (fee * PARTNER_COMMISSION_BPS) / BPS_DENOMINATOR
  );

  /**
   * THE INVARIANT THIS FEATURE EXISTS TO PROTECT: the money paid to a partner
   * comes out of the platform's own take, so it can never exceed that take, and
   * the take can never exceed what the player actually paid. A violation here
   * means the platform would owe more than it earned on the transaction.
   */
  if (commission > fee || fee > entryCentavos) {
    throw invalidArgument("Comissão inconsistente com a taxa da plataforma.");
  }

  return commission;
}

function assertWholeNonNegative(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw invalidArgument(`${field} precisa ser um inteiro não negativo.`);
  }
}

/**
 * Why an entry did not accrue a commission. Reasons are data so the admin
 * metrics can show "attributed but outside the window" separately from
 * "beta tournament", instead of collapsing both into a silent zero.
 */
export type NoAccrualReason =
  | "not-attributed"
  | "beta-economy"
  | "free-entry"
  | "window-expired"
  | "self-referral"
  | "partner-inactive";

export type CommissionDecision =
  | { readonly accrues: false; readonly reason: NoAccrualReason }
  | {
      readonly accrues: true;
      readonly partnerRef: string;
      readonly entryCentavos: number;
      readonly feeCentavos: number;
      readonly commissionCentavos: number;
    };

export interface CommissionInput {
  /** The partner this player is attributed to, or null when unattributed. */
  readonly partnerRef: string | null;
  /** When the attribution was recorded, or null when unattributed. */
  readonly attributedAt: Date | null;
  /**
   * The expiry STORED on the user at attribution time.
   *
   * This is the authority, not [ATTRIBUTION_WINDOW_MONTHS]. An attribution is a
   * commercial term agreed when it was recorded: if the window constant is
   * later shortened, already-recorded attributions must keep the terms they
   * were recorded under, and recomputing from the live constant would silently
   * shorten every contract already in force.
   *
   * Null only for a row written before the field existed; those fall back to
   * recomputation, which is the best available answer for them.
   */
  readonly attributionExpiresAt: Date | null;
  /** Whether the partner is still accepting accruals. */
  readonly partnerActive: boolean;
  /** The uid that owns the partner, when the partner is also a player. */
  readonly partnerOwnerUid: string | null;
  /** The player paying the entry fee. */
  readonly payerUid: string;
  /** The tournament economy, resolved by the caller. */
  readonly economy: EconomyType;
  /** The entry fee actually paid, in integer centavos. */
  readonly entryCentavos: number;
  /** The instant the entry was paid. */
  readonly now: Date;
}

/**
 * The whole accrual policy in one pure function.
 *
 * Order matters and is deliberate: the cheapest, most categorical refusals come
 * first, and self-referral is checked BEFORE the window so that a partner
 * farming their own account is reported as fraud rather than as an expiry.
 */
export function decideCommission(input: CommissionInput): CommissionDecision {
  const { partnerRef, attributedAt } = input;

  if (!partnerRef || !attributedAt) {
    return { accrues: false, reason: "not-attributed" };
  }
  if (input.economy !== ECONOMY_CASH) {
    return { accrues: false, reason: "beta-economy" };
  }
  if (input.entryCentavos <= 0) {
    return { accrues: false, reason: "free-entry" };
  }
  if (
    input.partnerOwnerUid !== null &&
    input.partnerOwnerUid === input.payerUid
  ) {
    return { accrues: false, reason: "self-referral" };
  }
  if (!input.partnerActive) {
    return { accrues: false, reason: "partner-inactive" };
  }
  // Stored expiry wins. Recomputation is the fallback for legacy rows only.
  const expiresAt =
    input.attributionExpiresAt ?? attributionExpiresAt(attributedAt);
  if (input.now.getTime() >= expiresAt.getTime()) {
    return { accrues: false, reason: "window-expired" };
  }

  const feeCentavos = feeCentavosFor(input.entryCentavos);
  const commissionCentavos = commissionCentavosFor(input.entryCentavos);

  /**
   * A fee small enough to floor to zero accrues nothing. Writing a zero ledger
   * row would be noise that still costs a document and a read.
   */
  if (commissionCentavos <= 0) {
    return { accrues: false, reason: "free-entry" };
  }

  return {
    accrues: true,
    partnerRef,
    entryCentavos: input.entryCentavos,
    feeCentavos,
    commissionCentavos,
  };
}

/**
 * Deterministic id of the accrual row for one registration.
 *
 * One registration can accrue at most one commission, and a replay must find
 * the SAME document rather than write a second one. Same idempotency shape as
 * `prize_{tournamentId}` and `refund_{uid}_{tournamentId}`.
 */
export function commissionAccrualId(registrationId: string): string {
  if (!registrationId) {
    throw invalidArgument("registrationId é obrigatório.");
  }
  return `commission_${registrationId}`;
}

/**
 * Whether a claim may write the attribution.
 *
 * CREATE-ONLY, BY DESIGN. `partner_ref` is never overwritten: an immutable
 * first-touch bond is auditable, and it removes the incentive for a partner to
 * chase players who already belong to someone else. The consequence is stated
 * plainly rather than hidden — once a player's window expires they stop
 * earning, and no second partner inherits them. Re-attribution would need an
 * anti-farming design that does not exist yet.
 */
export type AttributionDecision =
  | { readonly attributes: true; readonly code: string }
  | {
      readonly attributes: false;
      readonly reason: "already-attributed" | "self-referral";
    };

export interface AttributionInput {
  /** The partner already recorded on the user, when there is one. */
  readonly existingPartnerRef: string | null;
  /** The normalised code being claimed. */
  readonly code: string;
  /** The uid that owns the partner behind [code], when it is also a player. */
  readonly partnerOwnerUid: string | null;
  /** The uid claiming the code. */
  readonly claimantUid: string;
}

export function decideAttribution(
  input: AttributionInput
): AttributionDecision {
  if (input.existingPartnerRef) {
    return { attributes: false, reason: "already-attributed" };
  }
  if (
    input.partnerOwnerUid !== null &&
    input.partnerOwnerUid === input.claimantUid
  ) {
    return { attributes: false, reason: "self-referral" };
  }
  return { attributes: true, code: input.code };
}

/**
 * The running total a partner has accrued, kept on `partners/{id}`.
 *
 * Stored in integer CENTAVOS and incremented inside the same transaction that
 * writes the accrual row, so the total and the ledger can never disagree.
 * Integer increment is exact — the warning elsewhere in this codebase about
 * `FieldValue.increment()` concerns FLOAT reais, which drift; these are whole
 * centavos and cannot.
 */
export const PARTNER_TOTAL_FIELD = "total_accrued_centavos";

/** How many recent accruals a partner may page through in one call. */
export const PARTNER_RECENT_LIMIT_DEFAULT = 20;
export const PARTNER_RECENT_LIMIT_MAX = 50;

/**
 * ONE accrual, as the PARTNER is allowed to see it.
 *
 * Built key by key from an allowlist, exactly like the public tournament
 * preview: a field added to the stored row later cannot leak by simply existing.
 *
 * WHAT IS DELIBERATELY ABSENT: any way to identify the player. No uid, no
 * pseudonym, no e-mail, no registration id, no tournament reference. A partner
 * learns THAT they earned and HOW MUCH, never FROM WHOM — the same stance that
 * makes `public_player_ids` unreadable even to an admin client. Knowing which
 * of your followers gambles, and how much, is not a marketing metric.
 */
export interface PartnerAccrualView {
  readonly accruedAt: string;
  readonly commissionCentavos: number;
}

export interface PartnerEarningsView {
  readonly name: string;
  readonly code: string;
  readonly active: boolean;
  /** Everything accrued so far, in integer centavos. */
  readonly totalAccruedCentavos: number;
  /** How many players are attributed to this partner, ever. */
  readonly attributedPlayers: number;
  /**
   * How many of those are still inside their earning window.
   *
   * Reported SEPARATELY rather than folded into the total, because the two
   * answer different questions and collapsing them misleads in both directions:
   * a lone total counts people who stopped earning months ago and invites the
   * partner to expect revenue that cannot come, while a lone active count hides
   * the audience they actually brought.
   */
  readonly earningPlayers: number;
  /**
   * Nothing has been paid, and the screen must say so rather than implying a
   * balance. This is a stored fact, not a UI string, so the backend cannot
   * quietly start claiming otherwise.
   */
  readonly payoutAvailable: false;
  readonly amountUnit: "centavos";
  readonly recent: readonly PartnerAccrualView[];
}

/** Clamps a caller-supplied page size. Never trusts the client's number. */
export function normalizeRecentLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return PARTNER_RECENT_LIMIT_DEFAULT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw invalidArgument(
      `O limite precisa ser um inteiro entre 1 e ${PARTNER_RECENT_LIMIT_MAX}.`
    );
  }
  return Math.min(raw, PARTNER_RECENT_LIMIT_MAX);
}

/**
 * Projects one stored accrual row into the partner-facing shape.
 *
 * Returns null for a row that cannot be projected safely, so an unusable
 * document is dropped from the page instead of failing the whole request or —
 * far worse — being passed through unfiltered.
 */
export function projectPartnerAccrual(
  raw: unknown,
  accruedAtIso: string | null
): PartnerAccrualView | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;

  const commission = row.amount_centavos;
  if (typeof commission !== "number" || !Number.isInteger(commission)) {
    return null;
  }
  if (commission <= 0) return null;
  if (!accruedAtIso) return null;

  return { accruedAt: accruedAtIso, commissionCentavos: commission };
}
