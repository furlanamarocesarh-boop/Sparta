import { invalidArgument } from "./errors.js";
import { MAX_BALANCE_CENTAVOS, inspectReais } from "./money.js";

/**
 * Per-kill prizes — the PURE payout rules, with no `firebase-functions` and no
 * Admin SDK import, so every branch is unit-tested without a database.
 *
 * WHAT CHANGES, IN ONE LINE. Today a tournament pays ONE prize to ONE player.
 * A per-kill tournament pays MANY players, and the amount is not known until
 * the kills are reported. That turns a fixed, pre-validated number into a
 * computed one — which is why the guard below exists.
 *
 * THE INVARIANT THIS MODULE IS FOR: the tournament can never pay out more than
 * it took in. A placement prize is bounded when the tournament is created; a
 * per-kill prize is unbounded by construction, because nothing stops someone
 * typing 500 kills. Nothing in the backend compares a payout against what was
 * collected today — this is the first place that comparison exists.
 *
 * FAIL WHOLE, NEVER PARTIAL. When the reported kills would exceed the pool the
 * whole declaration is refused and NOBODY is paid. Paying a proportional share
 * was rejected deliberately: it silently pays a player less than the tournament
 * advertised, and the player has no way to tell that happened. A refusal is
 * visible immediately and is almost always a typo, not a real result.
 *
 * ECONOMY-AGNOSTIC. The arithmetic is identical for cash and Beta Credits — the
 * caller supplies centavos and receives centavos. This module never reads an
 * economy, so it cannot become a place where the two pools accidentally mix.
 */

/**
 * Writes one payout costs: the player's wallet, plus its ledger row.
 *
 * Settlement additionally writes the tournament and its result, so the budget
 * is `players * 2 + 2` against Firestore's 500-write transaction ceiling. The
 * cap below is far stricter than that arithmetic requires, matching the
 * existing `MAX_CANCELLABLE_REGISTRATIONS` precedent: a Free Fire lobby holds
 * about 50 players, so 150 is comfortable headroom rather than a real limit.
 */
export const WRITES_PER_PAYOUT = 2;
export const MAX_PAYOUT_PLAYERS = 150;

/** True when the whole settlement fits in one atomic transaction. */
export function canSettleAtomically(players: number): boolean {
  return players >= 0 && players <= MAX_PAYOUT_PLAYERS;
}

export function writesRequiredForSettlement(players: number): number {
  return players * WRITES_PER_PAYOUT + 2;
}

/** One player's reported performance. Kills only — never an amount. */
export interface KillReport {
  readonly uid: string;
  readonly kills: number;
}

/** One player's computed payout, in integer centavos. */
export interface Payout {
  readonly uid: string;
  readonly kills: number;
  /** The per-kill component: `kills * killPrizeCentavos`. */
  readonly killCentavos: number;
  /** The placement component. Non-zero only for the winner. */
  readonly placementCentavos: number;
  /** What the player actually receives. */
  readonly totalCentavos: number;
}

export type PayoutRefusal =
  | "payee-not-registered"
  | "exceeds-pool"
  | "too-many-players"
  | "duplicate-player"
  | "invalid-kills"
  | "invalid-amount"
  | "winner-not-reported"
  | "nothing-to-pay";

export type PayoutDecision =
  | {
      readonly ok: true;
      readonly payouts: readonly Payout[];
      /** Sum of every payout. Never exceeds the pool. */
      readonly totalCentavos: number;
      /** What was collected in entry fees. */
      readonly poolCentavos: number;
    }
  | { readonly ok: false; readonly reason: PayoutRefusal };

export interface PayoutInput {
  /** The winner, who also receives the placement prize. */
  readonly winnerUid: string;
  /** The placement prize in centavos. Zero for a pure per-kill tournament. */
  readonly placementCentavos: number;
  /** Paid per kill, in centavos. Zero for a placement-only tournament. */
  readonly killPrizeCentavos: number;
  /** Every player's reported kills. May omit players who scored none. */
  readonly reports: readonly KillReport[];
  /**
   * Total collected in entry fees for this tournament, in centavos.
   *
   * Supplied by the caller from the ledger, NOT from a field on the tournament:
   * what was actually paid in is the only honest ceiling, and a stored figure
   * could drift from it after refunds.
   */
  readonly poolCentavos: number;
  /**
   * The uids that MAY be paid: the confirmed registrations of THIS tournament,
   * under THIS tournament's economy — the very rows that funded `poolCentavos`.
   *
   * REQUIRED, never optional. The single-winner path validates the winner's
   * registration and its economy before crediting anyone; this path pays many
   * players, so skipping the same question would make an operator typo credit a
   * stranger. Making the field mandatory means a payout cannot be decided
   * without stating who is entitled to one — the check cannot be forgotten at a
   * call site, because there is no call site without it.
   *
   * The invariant, in one line: ONLY WHO PAID IN MAY BE PAID OUT.
   */
  readonly eligibleUids: ReadonlySet<string>;
}

/**
 * The whole payout policy in one pure function.
 *
 * Order is deliberate: shape errors first, then the pool check LAST, so a
 * refusal for exceeding the pool means the numbers were well-formed and simply
 * too large — which is the message an operator needs.
 */
export function decidePayouts(input: PayoutInput): PayoutDecision {
  const {
    winnerUid,
    placementCentavos,
    killPrizeCentavos,
    reports,
    poolCentavos,
    eligibleUids,
  } = input;

  if (
    !isWholeNonNegative(placementCentavos) ||
    !isWholeNonNegative(killPrizeCentavos) ||
    !isWholeNonNegative(poolCentavos)
  ) {
    return { ok: false, reason: "invalid-amount" };
  }

  if (!canSettleAtomically(reports.length)) {
    return { ok: false, reason: "too-many-players" };
  }

  const seen = new Set<string>();
  for (const report of reports) {
    if (!report.uid || typeof report.uid !== "string") {
      return { ok: false, reason: "invalid-kills" };
    }
    if (seen.has(report.uid)) {
      return { ok: false, reason: "duplicate-player" };
    }
    seen.add(report.uid);

    if (!isWholeNonNegative(report.kills)) {
      return { ok: false, reason: "invalid-kills" };
    }
  }

  /**
   * WHO, before HOW MUCH. Every reported player must be a confirmed registrant
   * of this tournament. Checked for EVERY row and not only the paid ones: a
   * report is a claim about who played, and a stranger listed with zero kills
   * is the same mistake as one listed with ten — caught one edit earlier.
   *
   * This runs before the arithmetic so the refusal names the real problem. An
   * unregistered uid that happens to fit under the pool would otherwise be
   * paid, and the pool ceiling would report everything as fine.
   */
  for (const report of reports) {
    if (!eligibleUids.has(report.uid)) {
      return { ok: false, reason: "payee-not-registered" };
    }
  }

  /**
   * The winner must appear in the report even with zero kills. Paying a
   * placement prize to someone absent from the result would mean the operator
   * and the payout disagree about who played.
   */
  if (placementCentavos > 0 && !seen.has(winnerUid)) {
    return { ok: false, reason: "winner-not-reported" };
  }

  const payouts: Payout[] = [];
  let totalCentavos = 0;

  for (const report of reports) {
    const killCentavos = report.kills * killPrizeCentavos;
    const placement = report.uid === winnerUid ? placementCentavos : 0;
    const total = killCentavos + placement;

    // A player who earned nothing is not paid and gets no ledger row: an empty
    // credit is noise that still costs a document and a read.
    if (total <= 0) continue;

    if (total > MAX_BALANCE_CENTAVOS) {
      return { ok: false, reason: "invalid-amount" };
    }

    payouts.push({
      uid: report.uid,
      kills: report.kills,
      killCentavos,
      placementCentavos: placement,
      totalCentavos: total,
    });
    totalCentavos += total;
  }

  if (payouts.length === 0) {
    return { ok: false, reason: "nothing-to-pay" };
  }

  /**
   * THE GUARD. Everything above is arithmetic; this is the rule. A tournament
   * may distribute what it collected and not a centavo more.
   */
  if (totalCentavos > poolCentavos) {
    return { ok: false, reason: "exceeds-pool" };
  }

  return { ok: true, payouts, totalCentavos, poolCentavos };
}

/** Human-readable refusal, for the callable boundary. */
export function payoutRefusalMessage(reason: PayoutRefusal): string {
  switch (reason) {
    case "payee-not-registered":
      return (
        "Um dos jogadores informados não tem inscrição confirmada neste " +
        "torneio. Confira os jogadores antes de declarar o resultado."
      );
    case "exceeds-pool":
      return (
        "A premiação informada é maior do que o total arrecadado neste " +
        "torneio. Confira os abates antes de declarar o resultado."
      );
    case "too-many-players":
      return `Um resultado pode pagar no máximo ${MAX_PAYOUT_PLAYERS} jogadores.`;
    case "duplicate-player":
      return "O mesmo jogador aparece duas vezes no resultado.";
    case "invalid-kills":
      return "A contagem de abates precisa ser um número inteiro não negativo.";
    case "invalid-amount":
      return "Valor de premiação inválido.";
    case "winner-not-reported":
      return "O vencedor precisa constar no resultado.";
    case "nothing-to-pay":
      return "O resultado informado não gera pagamento para ninguém.";
  }
}

/** Throwing wrapper for handler code. */
export function assertPayoutDecision(decision: PayoutDecision): void {
  if (!decision.ok) {
    throw invalidArgument(payoutRefusalMessage(decision.reason));
  }
}

function isWholeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Ledger categories for a per-kill payout — deliberately DISTINCT from `prize`.
 *
 * WHY NOT REUSE `prize`. The season ranking treats every ranking-bearing row as
 * a win and does `winsCount + 1` (`seasonRanking.ts:446`). A player who placed
 * thirtieth and got two kills would be recorded as having WON the tournament.
 * Money won is money won and belongs in the score; a kill is not a victory.
 *
 * These categories therefore mean: counts toward `scoreCentavos`, never toward
 * `winsCount`. The placement prize keeps the existing `prize` / `beta_prize`
 * categories and remains the only thing that can be a win.
 */
export const KILL_PRIZE_CATEGORY = "kill_prize";
export const BETA_KILL_PRIZE_CATEGORY = "beta_kill_prize";

/**
 * The deterministic payout id for ONE player in ONE tournament.
 *
 * WHY IT KEEPS THE `prize_` PREFIX. The ranking trigger's front door accepts an
 * id only when it starts with that prefix (`seasonRanking.ts:85-91`). A payout
 * that must reach the ranking has to be recognisable there, and the prefix is
 * the recognition. The uid suffix is what makes it one row PER PLAYER instead
 * of the single `prize_{tournamentId}` slot that exists today.
 *
 * WHY IT MATTERS THAT IT IS DETERMINISTIC. The settlement writes N rows. If it
 * dies halfway, the retry must land on the SAME N documents and create-only
 * must reject the ones already written — otherwise a replay pays twice. The
 * current single-slot id is written with `set`, so a second write silently
 * erases the first; nothing derived from this function may ever do that.
 */
export function payoutTransactionId(
  tournamentid: string,
  uid: string
): string {
  if (!tournamentid || !uid) {
    throw invalidArgument("Torneio e jogador são obrigatórios.");
  }
  return `prize_${tournamentid}_${uid}`;
}

/**
 * True when [id] is a per-player payout for [tournamentid].
 *
 * Used to tell the legacy single-slot row apart from the new per-player ones
 * without parsing: `prize_{tid}` is not a payout id, `prize_{tid}_{uid}` is.
 */
export function isPayoutTransactionId(
  id: unknown,
  tournamentid: string
): id is string {
  if (typeof id !== "string" || !tournamentid) return false;
  const prefix = `prize_${tournamentid}_`;
  return id.startsWith(prefix) && id.length > prefix.length;
}

/** The ledger category a payout component belongs to, by economy. */
export function killPrizeCategoryFor(economy: string): string {
  return economy === "beta_credit"
    ? BETA_KILL_PRIZE_CATEGORY
    : KILL_PRIZE_CATEGORY;
}

/** One registration, as the pool computation needs to see it. */
export interface RegistrationForPool {
  readonly status: unknown;
  /** The server-authoritative amount this registration actually paid. */
  readonly entryFeeSnapshot: unknown;
  /** Who paid it, from the registration's `user_ref` — never from the caller. */
  readonly uid: unknown;
  /**
   * Which economy paid it. `undefined` means a legacy registration with no
   * recorded provenance, which the cash path accepts and the beta path does
   * not — the same rule `checkRegistrationEconomy` applies to the winner on the
   * single-winner path, kept identical here on purpose.
   */
  readonly economyType: unknown;
}

export type PoolResult =
  | {
      readonly ok: true;
      readonly centavos: number;
      readonly counted: number;
      /**
       * Exactly the uids whose entry fees are counted in `centavos`.
       *
       * Returned from the SAME pass that sums the pool so the two can never
       * disagree. A separate eligibility query could drift from the funding
       * set — and the whole invariant is that they are the same set.
       */
      readonly eligibleUids: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly reason: "unusable-registration" };

/**
 * What the tournament actually collected, in integer centavos.
 *
 * SUMMED FROM THE REGISTRATIONS, never read from a field on the tournament.
 * `entry_fee` on the tournament is the advertised price; what was collected is
 * the sum of what each player was actually charged, and the two diverge the
 * moment a price changes or a registration is refunded. The ceiling on a payout
 * has to be the real figure, not the advertised one.
 *
 * ONLY `registered` COUNTS. A refunded registration returned its money and can
 * no longer fund a prize; counting it would let a cancelled entry pay for
 * somebody else's kills.
 *
 * FAILS CLOSED. A registration whose snapshot cannot be read makes the whole
 * pool unknowable, and an unknown pool must never be treated as zero — zero
 * would refuse every payout, which looks like a policy decision rather than the
 * data problem it is.
 */
export function poolFromRegistrations(
  rows: readonly RegistrationForPool[],
  tournamentEconomy: string
): PoolResult {
  let centavos = 0;
  let counted = 0;
  const eligibleUids = new Set<string>();

  for (const row of rows) {
    if (row.status !== "registered") continue;

    /**
     * A registration paid in ANOTHER economy funds nothing here and entitles
     * its holder to nothing. Skipping rather than refusing: a tournament whose
     * economy was flipped can hold stale rows, and one of them must not make
     * the whole settlement impossible — it simply does not participate.
     */
    if (!economyMatches(row.economyType, tournamentEconomy)) continue;

    const seen = inspectReais(row.entryFeeSnapshot, {
      allowZero: true,
      maxCentavos: MAX_BALANCE_CENTAVOS,
    });
    if (!seen.ok) {
      return { ok: false, reason: "unusable-registration" };
    }

    // A registration with no usable uid funds the pool but entitles nobody:
    // dropping the amount would understate the ceiling, while trusting the
    // row's identity would be inventing one.
    if (typeof row.uid === "string" && row.uid.trim() !== "") {
      eligibleUids.add(row.uid.trim());
    }

    centavos += seen.centavos;
    counted += 1;
  }

  return { ok: true, centavos, counted, eligibleUids };
}

/**
 * The registration/tournament economy rule, matching `checkRegistrationEconomy`
 * exactly: an absent provenance is legacy and cash-only; anything else must be
 * the tournament's own economy.
 */
function economyMatches(
  registrationEconomy: unknown,
  tournamentEconomy: string
): boolean {
  if (registrationEconomy === undefined || registrationEconomy === null) {
    return tournamentEconomy === "cash";
  }
  return registrationEconomy === tournamentEconomy;
}

/** True when the tournament is configured to pay per kill. */
export function hasKillPrize(tournamentData: Record<string, unknown>): boolean {
  const seen = inspectReais(tournamentData.kill_prize, {
    allowZero: true,
    maxCentavos: MAX_BALANCE_CENTAVOS,
  });
  return seen.ok && seen.centavos > 0;
}

/** One persisted payout, read back for replay comparison. */
export interface PersistedPayout {
  readonly uid: unknown;
  readonly amount: unknown;
}

/**
 * Whether an already-persisted settlement matches the one just computed.
 *
 * The single-winner path compares `result.prize === tx.amount`, a 1:1 equality
 * that has no meaning once a settlement is N rows. The equivalent question here
 * is whether the SAME players are owed the SAME amounts — order-independent,
 * because the stored array's order is an implementation detail.
 *
 * A replay that disagrees is a divergence, never an equivalent: it means the
 * caller reported different kills for a tournament that is already settled.
 */
export function payoutsMatchPersisted(
  persisted: readonly PersistedPayout[],
  computed: readonly Payout[],
  toCentavos: (reais: unknown) => number | null
): boolean {
  if (persisted.length !== computed.length) return false;

  const expected = new Map<string, number>();
  for (const p of computed) expected.set(p.uid, p.totalCentavos);

  for (const row of persisted) {
    if (typeof row.uid !== "string") return false;
    const want = expected.get(row.uid);
    if (want === undefined) return false;
    const got = toCentavos(row.amount);
    if (got === null || got !== want) return false;
    expected.delete(row.uid);
  }

  return expected.size === 0;
}
