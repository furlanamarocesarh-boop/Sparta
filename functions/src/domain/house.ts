import { MAX_BALANCE_CENTAVOS } from "./money.js";

/**
 * THE HOUSE TREASURY — the platform's own money, and the only ceiling on what
 * a tournament may pay.
 *
 * WHY THIS EXISTS. Until now a per-kill tournament could not pay more than it
 * collected, and a single-winner tournament had no ceiling at all. Neither is
 * right. A guaranteed prize pool above the entry fees is ordinary esports
 * practice and the platform wants to offer it; paying an unbounded amount out
 * of nothing is how a platform becomes insolvent.
 *
 * WHERE PRIZE MONEY COMES FROM, STATED PLAINLY. It is credited, not
 * transferred: `credit(previousBalance, amount)` adds to a winner's wallet and
 * debits no source. The pool guard was therefore the ONLY thing tying payouts
 * to inflows anywhere in this backend. Replacing it with a weaker rule would
 * have left prize money mintable; replacing it with THIS one moves the tie from
 * a single tournament to the platform as a whole, which is what the product
 * actually needs.
 *
 * THE WHOLE RULE, IN ONE LINE: a settlement may never leave the house negative.
 *
 * Everything else follows. A tournament that pays less than it collected
 * credits the difference; one that pays more debits it; one that would take the
 * balance below zero is refused entirely, before any wallet moves.
 *
 * WHY THE CREDIT HAPPENS AT SETTLEMENT AND NOT AT JOIN. Entry fees are
 * refundable right up until the result is declared — `cancelTournament` returns
 * every one of them. Money that may still have to go back is a LIABILITY, not
 * the platform's, so counting it as treasury while the tournament is open would
 * let one tournament's refundable pool bankroll another's prize.
 *
 * TWO ECONOMIES, TWO TREASURIES. Cash and Beta Credits are separate pools
 * everywhere else in this system and are separate here. There is no document
 * this module can read that holds both, so a cash prize can never be funded by
 * Beta Credits even by mistake.
 */

/** One treasury document per economy. Never a `wallets/` doc — see below. */
export const HOUSE_COLLECTION = "house";

/**
 * The balance, in INTEGER CENTAVOS.
 *
 * Deliberately not the `balance` field name and deliberately not reais. The
 * audit reconciler walks `wallets/` and derives a player identity from
 * deposits, prizes, spend and withdrawals; a treasury row shaped like a wallet
 * would eventually be swept into that identity and reconcile to a wrong number.
 * A different collection AND a different field name make that mistake take two
 * errors instead of one.
 */
export const HOUSE_BALANCE_FIELD = "balance_centavos";

/** The ledger categories a treasury movement is recorded under. */
export const HOUSE_MARGIN_CATEGORY = "house_margin";
export const HOUSE_BETA_MARGIN_CATEGORY = "beta_house_margin";

export function houseDocId(economy: string): string {
  return economy === "beta_credit" ? "beta_credit" : "cash";
}

export function houseMarginCategoryFor(economy: string): string {
  return economy === "beta_credit"
    ? HOUSE_BETA_MARGIN_CATEGORY
    : HOUSE_MARGIN_CATEGORY;
}

export type HouseFunding =
  | {
      readonly ok: true;
      /**
       * `pool - paid`. Positive when the tournament profited, negative when the
       * house subsidised it, zero when it paid out exactly what it took in.
       */
      readonly marginCentavos: number;
      /** The treasury balance this settlement leaves behind. Never negative. */
      readonly houseAfterCentavos: number;
      /** True when the house funded part of this prize. */
      readonly subsidised: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "house-insolvent";
      /** How much MORE the treasury would need for this to be payable. */
      readonly shortfallCentavos: number;
    }
  | { readonly ok: false; readonly reason: "invalid-amount" };

export interface HouseFundingInput {
  /** What this tournament actually collected in entry fees. */
  readonly poolCentavos: number;
  /** What the settlement is about to pay out, in total. */
  readonly paidCentavos: number;
  /** The treasury balance BEFORE this settlement. */
  readonly houseCentavos: number;
}

/**
 * The solvency decision for one settlement.
 *
 * Pure and total: it reads three numbers and answers whether the platform can
 * afford this payout, plus what the treasury becomes. It never reads an
 * economy, so it cannot be the place the two economies get mixed — the caller
 * supplies figures already scoped to one.
 */
export function decideHouseFunding(input: HouseFundingInput): HouseFunding {
  const { poolCentavos, paidCentavos, houseCentavos } = input;

  if (
    !isWholeNonNegative(poolCentavos) ||
    !isWholeNonNegative(paidCentavos) ||
    !isWholeNonNegative(houseCentavos)
  ) {
    return { ok: false, reason: "invalid-amount" };
  }

  const marginCentavos = poolCentavos - paidCentavos;
  const houseAfterCentavos = houseCentavos + marginCentavos;

  if (houseAfterCentavos < 0) {
    // The shortfall, not the payout, is the actionable number: it is what the
    // operator has to put in, or cut the prize by, for this to go through.
    return {
      ok: false,
      reason: "house-insolvent",
      shortfallCentavos: -houseAfterCentavos,
    };
  }

  // A treasury larger than the money ceiling is a corruption, not a fortune.
  if (houseAfterCentavos > MAX_BALANCE_CENTAVOS) {
    return { ok: false, reason: "invalid-amount" };
  }

  return {
    ok: true,
    marginCentavos,
    houseAfterCentavos,
    subsidised: marginCentavos < 0,
  };
}

/** The frozen operator-facing message for each refusal. */
export function houseFundingMessage(
  decision: Extract<HouseFunding, { ok: false }>,
  formatAmount: (centavos: number) => string
): string {
  if (decision.reason === "invalid-amount") {
    return "Valor inválido no caixa da plataforma.";
  }
  return (
    "O caixa da plataforma não cobre esta premiação. " +
    `Faltam ${formatAmount(decision.shortfallCentavos)}.`
  );
}

function isWholeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** The ledger categories a capital injection is recorded under. */
export const HOUSE_FUNDING_CATEGORY = "house_funding";
export const HOUSE_BETA_FUNDING_CATEGORY = "beta_house_funding";

export function houseFundingCategoryFor(economy: string): string {
  return economy === "beta_credit"
    ? HOUSE_BETA_FUNDING_CATEGORY
    : HOUSE_FUNDING_CATEGORY;
}

/** The deterministic id of one capital injection. */
export function houseFundingTransactionId(depositId: string): string {
  if (!depositId) {
    throw new Error("depositId é obrigatório.");
  }
  return `house_funding_${depositId}`;
}

export type HouseDeposit =
  | { readonly ok: true; readonly houseAfterCentavos: number }
  | { readonly ok: false; readonly message: string };

/**
 * Adds capital to a treasury.
 *
 * WHY THIS HAS TO EXIST. The treasury only grows from the margin of settled
 * tournaments, so from a standing start it is empty — and an empty treasury
 * means no tournament may pay a centavo more than it collected, which is the
 * exact restriction the house account was introduced to lift. Without a way to
 * put money in, the feature is a door that never opens.
 *
 * WHAT IT MEANS, PER ECONOMY. For cash it is the operator declaring capital
 * they have put behind guaranteed prizes — this backend has no payment rail, so
 * the figure is a statement of intent that bounds payouts, not a transfer it
 * can verify. For Beta Credits it is minting, which an admin already does
 * freely through `grantBetaCredit`; routing it through the same rule keeps one
 * ceiling instead of carving out an exception that would become the bypass.
 */
export function decideHouseDeposit(input: {
  readonly amountCentavos: number;
  readonly houseCentavos: number;
}): HouseDeposit {
  const { amountCentavos, houseCentavos } = input;

  if (!isWholeNonNegative(amountCentavos) || amountCentavos === 0) {
    return { ok: false, message: "O aporte precisa ser maior que zero." };
  }
  if (!isWholeNonNegative(houseCentavos)) {
    return {
      ok: false,
      message: "O caixa da plataforma está com valor inválido.",
    };
  }

  const houseAfterCentavos = houseCentavos + amountCentavos;
  if (houseAfterCentavos > MAX_BALANCE_CENTAVOS) {
    return { ok: false, message: "O aporte excede o limite do caixa." };
  }

  return { ok: true, houseAfterCentavos };
}
