import { ECONOMY_BETA_CREDIT, ECONOMY_CASH, type EconomyType } from "./economy.js";

/**
 * The admin overview — what moved, how much, and who arrived.
 *
 * AGGREGATED ON READ, exactly. Firestore can `count()` and `sum()` without
 * reading documents, so every figure here is the real total rather than a
 * bounded sample. No trigger maintains a counter, and nothing has to be
 * backfilled: a counter that drifts is worse than a query that costs a few
 * reads, and this is a panel one person opens occasionally.
 *
 * WHERE THE MONEY LIVES IS NOT UNIFORM, and that is the trap this module
 * exists to close. There are two families:
 *
 *   - rows that MOVE A WALLET carry `amount`, a number of reais;
 *   - rows that are the PLATFORM'S OWN — house funding, house margin, partner
 *     commission — carry `amount_centavos`, and have no `user_ref` at all.
 *
 * Summing `amount` across both returns zero for the entire second family,
 * silently. An admin panel that under-reports the house and every commission
 * ever accrued is worse than one that refuses to answer. So the field and the
 * unit are declared per category, in a table, and a category missing from it
 * is REFUSED rather than assumed.
 *
 * THE SIGN IS IN THE CATEGORY, NOT IN THE NUMBER — with ONE exception. Every
 * stored amount is positive: an entry fee of R$ 10 and a prize of R$ 10 both
 * store 10, and the direction is a property of the category. The exception is
 * the house margin, which is `pool - paid` and is stored NEGATIVE when the
 * house subsidised the prize. Treating it as unsigned would report a subsidy as
 * zero and quietly turn a loss into "nothing happened" — so `signed` is
 * declared per category, and volume takes the magnitude while the result takes
 * the sign.
 *
 * THE TWO ECONOMIES ARE NEVER SUMMED TOGETHER. Same rule as the wallet, the
 * season ranking and the creator board: cash and Beta Credits are different
 * units, and a single "total" spanning both would be a lie in either.
 */

/** Which field carries the money, and in which unit. */
export type AmountShape =
  /** `amount`, a number of reais. */
  | "reais"
  /** `amount_centavos`, an integer of centavos. */
  | "centavos";

/** Which way the money moved, from the platform's point of view. */
export type MoneyDirection =
  /** Value entering a player's balance. */
  | "in"
  /** Value leaving a player's balance. */
  | "out"
  /** Neither — an internal move that funds the house. */
  | "internal";

/**
 * How a category enters the profit calculation.
 *
 * `collected` minus `refunded` is what the platform took in; `paid` is what it
 * handed back out as prizes; the difference is the operating result. Anything
 * with no role — a deposit, a withdrawal, a treasury top-up — moves money
 * without the platform earning or losing any.
 */
export type ProfitRole = "collected" | "refunded" | "paid" | "commission";

export interface CategorySpec {
  readonly economy: EconomyType;
  readonly shape: AmountShape;
  readonly direction: MoneyDirection;
  /** What an admin should read it as. */
  readonly label: string;
  /**
   * What this category is, for the profit calculation.
   *
   * DECLARED PER CATEGORY rather than inferred from `direction`, because the
   * two answer different questions: `direction` says which way a WALLET moved,
   * and this says whether the PLATFORM earned or spent. A deposit moves a
   * wallet and earns the platform nothing.
   */
  readonly profitRole?: ProfitRole;
  /**
   * True when the stored amount may legitimately be NEGATIVE.
   *
   * Only the house margin is: `pool - paid` goes below zero whenever the house
   * funded part of a prize. Everything else is a magnitude, and a negative one
   * would be corrupt data rather than a subsidy.
   */
  readonly signed?: true;
}

/**
 * EVERY category this backend writes, and nothing else.
 *
 * A CLOSED TABLE, asserted against reality by a test. A category that starts
 * being written without being added here is REFUSED by `specFor` — visibly —
 * instead of quietly contributing nothing to a total somebody is about to make
 * a decision on.
 */
export const CATEGORY_SPECS: Readonly<Record<string, CategorySpec>> = {
  deposit: {
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "in",
    label: "Depósito",
  },
  withdrawal: {
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "out",
    label: "Saque",
  },
  entry_fee: {
    profitRole: "collected",
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "out",
    label: "Inscrição",
  },
  prize: {
    profitRole: "paid",
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "in",
    label: "Prêmio",
  },
  /**
   * LEGADA: existe em dados de produção e NADA no backend atual a escreve.
   * Veio de uma correção manual. Fica na tabela porque as linhas existem de
   * verdade, e deixá-la de fora faria o painel recusar dinheiro real.
   */
  admin_correction: {
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "in",
    label: "Correção manual",
  },
  entry_refund: {
    profitRole: "refunded",
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "in",
    label: "Estorno de inscrição",
  },
  kill_prize: {
    profitRole: "paid",
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "in",
    label: "Prêmio por abate",
  },

  // ── A FAMÍLIA DA PLATAFORMA. Sem `user_ref`, valor em `amount_centavos`.
  // São elas que um painel somando `amount` reportaria como zero.
  house_funding: {
    economy: ECONOMY_CASH,
    shape: "centavos",
    direction: "internal",
    label: "Aporte no caixa",
  },
  house_margin: {
    economy: ECONOMY_CASH,
    shape: "centavos",
    direction: "internal",
    label: "Margem da casa",
    signed: true,
  },
  beta_house_funding: {
    economy: ECONOMY_BETA_CREDIT,
    shape: "centavos",
    direction: "internal",
    label: "Aporte no caixa (beta)",
  },
  beta_house_margin: {
    economy: ECONOMY_BETA_CREDIT,
    shape: "centavos",
    direction: "internal",
    label: "Margem da casa (beta)",
    signed: true,
  },
  commission_accrued: {
    profitRole: "commission",
    economy: ECONOMY_CASH,
    shape: "centavos",
    direction: "internal",
    label: "Comissão de colaborador",
  },
  beta_entry_fee: {
    profitRole: "collected",
    economy: ECONOMY_BETA_CREDIT,
    shape: "reais",
    direction: "out",
    label: "Inscrição (beta)",
  },
  beta_prize: {
    profitRole: "paid",
    economy: ECONOMY_BETA_CREDIT,
    shape: "reais",
    direction: "in",
    label: "Prêmio (beta)",
  },
  beta_grant: {
    economy: ECONOMY_BETA_CREDIT,
    shape: "reais",
    direction: "in",
    label: "Crédito beta concedido",
  },
  beta_refund: {
    profitRole: "refunded",
    economy: ECONOMY_BETA_CREDIT,
    shape: "reais",
    direction: "in",
    label: "Estorno de inscrição (beta)",
  },
  beta_kill_prize: {
    profitRole: "paid",
    economy: ECONOMY_BETA_CREDIT,
    shape: "reais",
    direction: "in",
    label: "Prêmio por abate (beta)",
  },
};

/** Every category the panel knows how to total, in a stable order. */
export const KNOWN_CATEGORIES: readonly string[] =
  Object.keys(CATEGORY_SPECS).sort();

/** The spec for a category, or null when it is not one this panel knows. */
export function specFor(category: unknown): CategorySpec | null {
  if (typeof category !== "string") return null;
  return Object.prototype.hasOwnProperty.call(CATEGORY_SPECS, category)
    ? CATEGORY_SPECS[category]
    : null;
}

/** The time windows the panel reports, shortest first. */
export type WindowKey = "day" | "week" | "month" | "year" | "all";

export const WINDOW_KEYS: readonly WindowKey[] = [
  "day",
  "week",
  "month",
  "year",
  "all",
];

/** How far back each window reaches, in days. `all` reaches forever. */
const WINDOW_DAYS: Readonly<Record<WindowKey, number | null>> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
  all: null,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The instant a window starts, or null for "since the beginning".
 *
 * ROLLING, NOT CALENDAR. "Últimas 24 horas" means the last 24 hours, not
 * "today" — an admin looking at 10am wants the previous day and night, not the
 * ten hours since midnight. The same reasoning makes a month 30 days rather
 * than "this month", which on the 1st would report almost nothing.
 */
export function windowStart(key: WindowKey, now: Date): Date | null {
  const days = WINDOW_DAYS[key];
  if (days === null) return null;
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/**
 * Converts one aggregate result into integer centavos.
 *
 * ROUNDED AT THE BOUNDARY, once. Reais are stored as floating point, so a sum
 * of thousands of them carries a fraction of a centavo of error; rounding here
 * turns that into the exact figure a person can read, and doing it once at the
 * edge means no downstream arithmetic ever compounds it.
 */
export function aggregateToCentavos(
  shape: AmountShape,
  sum: unknown
): number {
  if (typeof sum !== "number" || !Number.isFinite(sum)) return 0;
  return shape === "centavos" ? Math.round(sum) : Math.round(sum * 100);
}

/**
 * The margin categories, and the one that funds partners.
 *
 * NAMED HERE rather than matched by string at the call site, so "what counts as
 * profit" is a decision with one home.
 */
/**
 * What the platform actually kept, and what it owes for it.
 *
 * MARGIN IS THE ONLY PROFIT WITH A LEDGER BEHIND IT. The 7,5 % Sparta fee is
 * PRODUCT POLICY, not bookkeeping: settlement credits the winner the full prize
 * and retains nothing, so no row anywhere records a fee being taken. What the
 * house really keeps is `pool - paid` per settlement — whatever a creator left
 * on the table — and that is what `house_margin` records. Reporting the 7,5 %
 * as revenue would be inventing money that was never set aside.
 *
 * IT CAN BE NEGATIVE, and saying so is the point: a subsidised tournament is a
 * loss, and a panel that floors it at zero would hide exactly the number an
 * operator needs to see.
 *
 * THE COMMISSION IS A LIABILITY, NOT A PAYMENT. Nothing in this backend ever
 * pays a partner — `requestwithdrawal` writes `pending` and no code moves it
 * on. So this is what is OWED, and the owner's share is what is left after
 * honouring it.
 */
export interface ProfitSplit {
  readonly economy: EconomyType;
  /** Entry fees taken in, net of refunds. */
  readonly collectedCentavos: number;
  /** Prize money handed out. */
  readonly paidCentavos: number;
  /** `collected - paid`. Negative when prizes exceeded what came in. */
  readonly grossCentavos: number;
  /** Accrued and unpaid. Always zero or more. */
  readonly commissionCentavos: number;
  /** Gross minus commissions. What is left for the owner. */
  readonly ownerCentavos: number;
}

/**
 * What the platform actually earned, straight from the ledger.
 *
 * COMPUTED FROM ENTRY FEES AND PRIZES, not from `house_margin`. The margin row
 * is only written by settlements that happened AFTER the treasury shipped — so
 * reading it reports zero for every tournament that came before, which in
 * practice means every tournament so far. The entry fees and the prizes are in
 * the ledger from the first day, so the profit derived from them covers all of
 * history. That is why the margin category carries NO profit role: counting it
 * would double the same money for the settlements that do have one.
 *
 * A DEPOSIT IS NOT REVENUE, and neither is a treasury top-up. Money moving into
 * a wallet or into the house is the operator's own money changing pockets. Only
 * an entry fee is somebody paying the platform, and only a prize is the
 * platform paying out.
 *
 * IT CAN BE NEGATIVE, and that is the number worth having. Prize money is
 * CREDITED with no source debited, so a tournament that pays more than it
 * collected is funded out of nothing — exactly the hole the treasury was built
 * to close. A panel that floored this at zero would hide it.
 *
 * THE COMMISSION IS A LIABILITY, NOT A PAYMENT. Nothing in this backend ever
 * pays a partner, so this is what is OWED, and the owner's share is what
 * remains after honouring it.
 */
export function splitProfit(
  totals: readonly CategoryTotal[]
): ProfitSplit[] {
  return [ECONOMY_CASH, ECONOMY_BETA_CREDIT].map((economy) => {
    let collected = 0;
    let paid = 0;
    let commission = 0;

    for (const total of totals) {
      if (total.economy !== economy) continue;
      const role = specFor(total.category)?.profitRole;
      const value = Math.abs(total.centavos);
      if (role === "collected") collected += value;
      else if (role === "refunded") collected -= value;
      else if (role === "paid") paid += value;
      else if (role === "commission") commission += value;
    }

    const gross = collected - paid;
    return {
      economy,
      collectedCentavos: collected,
      paidCentavos: paid,
      grossCentavos: gross,
      commissionCentavos: commission,
      // NOT floored at zero: a period where prizes exceeded entries leaves the
      // owner negative, and that is the fact.
      ownerCentavos: gross - commission,
    };
  });
}

/** One category's activity inside one window. */
export interface CategoryTotal {
  readonly category: string;
  readonly label: string;
  readonly economy: EconomyType;
  readonly direction: MoneyDirection;
  readonly count: number;
  readonly centavos: number;
}

/** What one economy did inside one window. */
export interface EconomyTotal {
  readonly economy: EconomyType;
  readonly count: number;
  /** Everything that moved, regardless of direction. */
  readonly volumeCentavos: number;
  readonly inCentavos: number;
  readonly outCentavos: number;
}

/**
 * Rolls category totals up per economy.
 *
 * VOLUME IS THE HEADLINE because it is the only figure that means the same
 * thing for every category: how much money moved. `in` and `out` are reported
 * beside it rather than netted, since a net of zero can mean "nothing happened"
 * or "a thousand reais came in and a thousand went out", and those are very
 * different days.
 */
export function rollUpByEconomy(
  totals: readonly CategoryTotal[]
): EconomyTotal[] {
  const byEconomy = new Map<EconomyType, {
    count: number;
    volume: number;
    inC: number;
    outC: number;
  }>();

  for (const total of totals) {
    const bucket = byEconomy.get(total.economy) ?? {
      count: 0,
      volume: 0,
      inC: 0,
      outC: 0,
    };
    bucket.count += total.count;
    /**
     * MAGNITUDE, not the signed value: a loss must not shrink the volume and
     * make a busy month look quiet.
     *
     * FOR A SIGNED CATEGORY THIS IS |NET|, NOT THE SUM OF EACH ROW'S
     * MAGNITUDE. The figure arrives already summed by Firestore, so a month of
     * +R$ 2,50 kept and -R$ 1,00 subsidised contributes R$ 1,50 here, not
     * R$ 3,50. Recovering per-row magnitudes would mean reading every document,
     * which is the entire cost this panel avoids — and the net is the figure
     * that answers "what did the house end up with", which is the question.
     */
    bucket.volume += Math.abs(total.centavos);
    if (total.direction === "in") bucket.inC += total.centavos;
    if (total.direction === "out") bucket.outC += total.centavos;
    byEconomy.set(total.economy, bucket);
  }

  // Both economies are ALWAYS reported, even at zero. A missing row reads as
  // "no data" when the truth is "nothing happened", and those differ.
  return [ECONOMY_CASH, ECONOMY_BETA_CREDIT].map((economy) => {
    const b = byEconomy.get(economy) ?? { count: 0, volume: 0, inC: 0, outC: 0 };
    return {
      economy,
      count: b.count,
      volumeCentavos: b.volume,
      inCentavos: b.inC,
      outCentavos: b.outC,
    };
  });
}
