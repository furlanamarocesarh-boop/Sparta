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
 * THE SIGN IS IN THE CATEGORY, NOT IN THE NUMBER. Every stored amount is
 * positive — an entry fee of R$ 10 and a prize of R$ 10 both store 10. So the
 * direction of money is a property of the category, declared here, and totals
 * are reported as VOLUME (what moved) with the direction available separately.
 * Netting them without saying so would produce a number that means nothing.
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

export interface CategorySpec {
  readonly economy: EconomyType;
  readonly shape: AmountShape;
  readonly direction: MoneyDirection;
  /** What an admin should read it as. */
  readonly label: string;
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
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "out",
    label: "Inscrição",
  },
  prize: {
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
    economy: ECONOMY_CASH,
    shape: "reais",
    direction: "in",
    label: "Estorno de inscrição",
  },
  kill_prize: {
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
  },
  commission_accrued: {
    economy: ECONOMY_CASH,
    shape: "centavos",
    direction: "internal",
    label: "Comissão de colaborador",
  },
  beta_entry_fee: {
    economy: ECONOMY_BETA_CREDIT,
    shape: "reais",
    direction: "out",
    label: "Inscrição (beta)",
  },
  beta_prize: {
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
    economy: ECONOMY_BETA_CREDIT,
    shape: "reais",
    direction: "in",
    label: "Estorno de inscrição (beta)",
  },
  beta_kill_prize: {
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
    bucket.volume += total.centavos;
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
