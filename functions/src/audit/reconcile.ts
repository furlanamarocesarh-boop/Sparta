import {
  BETA_KILL_PRIZE_CATEGORY,
  KILL_PRIZE_CATEGORY,
} from "../domain/killPrize.js";
import {
  BETA_REFUND_CATEGORY,
  ENTRY_REFUND_CATEGORY,
} from "../domain/cancellation.js";
import { BETA_GRANT_CATEGORY } from "../domain/betaCredit.js";
import {
  BETA_ENTRY_FEE_CATEGORY,
  BETA_PRIZE_CATEGORY,
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
} from "../domain/economy.js";
import { inspectReais, MAX_BALANCE_CENTAVOS } from "../domain/money.js";
import { WalletField, WALLET_MONEY_FIELDS } from "./walletAudit.js";

/**
 * Wallet reconciliation — pure, no Firebase.
 *
 * SEMANTICS, CONFIRMED IN index.ts (both the deployed b70c159 and the hardened
 * version — they agree). Nothing here is assumed:
 *
 *   balance          current funds. CREDITED by testdeposit and payprize;
 *                    DEBITED by jointournament and requestwithdrawal.
 *   total_deposited  sum of transactions category="deposit"   (status completed)
 *   total_won        sum of transactions category="prize"     (status completed)
 *   total_spent      sum of transactions category="entry_fee" (status completed)
 *   total_withdrawn  sum of transactions category="withdrawal"
 *
 * TWO TRAPS, both verified rather than guessed:
 *
 * 1. A withdrawal is charged IMMEDIATELY. `requestwithdrawal` debits `balance`
 *    and increments `total_withdrawn` inside the same transaction that writes
 *    the transaction doc with `status: "pending"`. No function anywhere
 *    completes, reverses or refunds a withdrawal. So a "pending" withdrawal is
 *    ALREADY paid for by the wallet — treating it as not-yet-charged would
 *    understate `total_withdrawn` and overstate `balance`.
 *
 * 2. A registration means the entry fee was ACTUALLY charged. `jointournament`
 *    writes the registration, debits the balance and writes the `entry_fee`
 *    transaction in one `runTransaction`. It is atomic: a registration cannot
 *    exist without its charge.
 *
 * Therefore the ledger identity holds, starting from a wallet created at zero:
 *
 *   balance == total_deposited + total_won - total_spent - total_withdrawn
 *
 * That identity is what makes a missing field reconstructable at all.
 */

/** Transaction categories that move money. Confirmed: these four, no others. */
export const MONEY_CATEGORIES = [
  "deposit",
  "prize",
  "entry_fee",
  "withdrawal",
  // Per-kill payout. It feeds `total_won` exactly like a placement prize —
  // money won is money won. The two are separate categories only because the
  // season ranking must NOT count a kill as a victory; the ledger identity
  // makes no such distinction.
  KILL_PRIZE_CATEGORY,
] as const;

export type MoneyCategory = (typeof MONEY_CATEGORIES)[number];

/** Which wallet total each category feeds. */
export const CATEGORY_TO_FIELD: Readonly<Record<MoneyCategory, WalletField>> = {
  deposit: "total_deposited",
  prize: "total_won",
  entry_fee: "total_spent",
  withdrawal: "total_withdrawn",
  [KILL_PRIZE_CATEGORY]: "total_won",
};

/** Categories that ADD to the balance. The other two subtract. */
const CREDIT_CATEGORIES: ReadonlySet<string> = new Set([
  "deposit",
  "prize",
  KILL_PRIZE_CATEGORY,
]);

/**
 * The BETA ledger categories, each REQUIRED to carry
 * `economy_type: "beta_credit"`. They feed the SEPARATE beta identity:
 *
 *   beta_balance == beta_grants + beta_prizes + beta_refunds - beta_entry_spend
 *
 * and are completely invisible to the five cash metrics. A beta category can
 * never fall back to cash: without its economy tag it is INVALID, never cash.
 */
export const BETA_CATEGORIES = [
  BETA_GRANT_CATEGORY,
  BETA_ENTRY_FEE_CATEGORY,
  BETA_PRIZE_CATEGORY,
  BETA_REFUND_CATEGORY,
  BETA_KILL_PRIZE_CATEGORY,
] as const;

/**
 * Every category the classifier recognizes. Anything else → manual review.
 *
 * `commission_accrued` is DELIBERATELY ABSENT, and adding it would be dead
 * code. The reconciler only ever sees rows returned by
 * `where("user_ref", "==", userRef)` (audit/cli.ts:206), and a commission
 * accrual is written WITHOUT a `user_ref` — the same omission that makes it
 * unreadable to the referred player. So no accrual can reach this set, and
 * listing it here would suggest the reconciler models a row it never receives.
 *
 * That omission is load-bearing twice over: it is the privacy boundary AND the
 * reason a partner's commission can never contaminate a player's wallet
 * identity. If an accrual ever gains a `user_ref`, this comment is the warning
 * that both properties break at once.
 */
export const KNOWN_CATEGORIES: ReadonlySet<string> = new Set([
  ...MONEY_CATEGORIES,
  ENTRY_REFUND_CATEGORY,
  ...BETA_CATEGORIES,
]);

/** One transaction, reduced to only what reconciliation needs. */
export interface TransactionRecord {
  readonly category: unknown;
  readonly status: unknown;
  readonly amount: unknown;
  /** Firestore path of this doc — lets a refund be matched to its original. */
  readonly path?: string;
  readonly economyType?: unknown;
  readonly tournamentRefPath?: string | null;
  readonly registrationRefPath?: string | null;
  readonly entryTransactionRefPath?: string | null;
  /** Are the CASH stamps (previous_balance / balance_after) present? */
  readonly hasCashStamps?: boolean;
  /** Are the BETA stamps (beta_previous_balance / beta_balance_after) present? */
  readonly hasBetaStamps?: boolean;
}

export interface RelatedDocuments {
  readonly transactions: readonly TransactionRecord[];
  /** Only the `status` of each withdrawal is needed. */
  readonly withdrawalStatuses: readonly string[];
  readonly registrationCount: number;
}

/**
 * Why a `user_ref` is not valid — without ever revealing the path it points to.
 *
 * This matters for the diagnosis: a `user_ref` that is simply ABSENT is a
 * different (and much more benign) problem than one pointing at a different
 * user, which would be a data-integrity incident.
 */
export type UserRefStatus =
  | "valid"
  | "missing"
  | "not-a-reference"
  | "points-elsewhere";

export interface WalletContext {
  /** Fields absent from the wallet document. */
  readonly missingFields: readonly WalletField[];
  /** Values of the fields that ARE present, in centavos. Null when unusable. */
  readonly presentCentavos: Readonly<Partial<Record<WalletField, number | null>>>;
  /** Does users/{uid} exist for this wallet id? */
  readonly userDocExists: boolean;
  /** Is wallet.user_ref present AND pointing at users/{walletId}? */
  readonly userRefValid: boolean;
  /** Why it is invalid, when it is. Never carries the offending path. */
  readonly userRefStatus: UserRefStatus;
  /**
   * The stored `beta_balance`, when the field is PRESENT: its centavos, or
   * null when unusable. Absent (undefined) is LEGAL — a pre-beta wallet reads
   * as zero, and only a non-zero derived beta then counts as a conflict.
   */
  readonly betaBalanceCentavos?: number | null;
  /** Whether the wallet document carries the beta_balance field at all. */
  readonly betaBalancePresent?: boolean;
  readonly related: RelatedDocuments;
}

export type Classification =
  | "safe-zero-candidate"
  | "reconstructable"
  | "manual-review";

export interface CategoryCount {
  readonly category: string;
  readonly status: string;
  readonly count: number;
}

export interface ReconciliationResult {
  /** "Wallet A", "Wallet B", ... Never an id. */
  readonly label: string;
  readonly missingFields: readonly WalletField[];
  readonly userDocExists: boolean;
  readonly userRefValid: boolean;
  readonly userRefStatus: UserRefStatus;

  readonly transactionCounts: readonly CategoryCount[];
  readonly withdrawalCounts: Readonly<Record<string, number>>;
  readonly registrationCount: number;
  readonly hasFinancialActivity: boolean;

  /** Derived totals, in centavos, from the transaction history. */
  readonly derivedCentavos: Readonly<Record<WalletField, number>>;
  /**
   * Derived beta balance, in integer units, from the beta ledger identity:
   * grants + prizes + refunds - entry spend. Kept OUTSIDE derivedCentavos so
   * the cash shape (and everything consuming it) is untouched.
   */
  readonly derivedBetaCentavos: number;
  /** Present values that CONTRADICT the derived ones. */
  readonly conflicts: readonly string[];
  /** Why the case was classified as it was. */
  readonly reasons: readonly string[];

  readonly classification: Classification;
}

/**
 * Reconciles one wallet from its related documents.
 *
 * Deliberately conservative. A field is only declared safe to zero when there is
 * POSITIVE evidence of no financial history — never merely because the field is
 * absent. Anything unexplained lands in `manual-review`, because the cost of a
 * wrong backfill is a wrong balance, and a wrong balance is real money.
 */
export function reconcileWallet(
  label: string,
  context: WalletContext
): ReconciliationResult {
  const { related } = context;

  const transactionCounts = countTransactions(related.transactions);
  const withdrawalCounts = countByStatus(related.withdrawalStatuses);

  const hasFinancialActivity =
    related.transactions.length > 0 ||
    related.withdrawalStatuses.length > 0 ||
    related.registrationCount > 0;

  const reasons: string[] = [];
  const conflicts: string[] = [];

  // --- Derive each total from the transaction history. -----------------------
  const derived: Record<WalletField, number> = {
    balance: 0,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
  };

  let unusableTransaction = false;
  let unknownCategory = false;

  // Beta accumulators — a completely separate pool. NOTE for reason strings:
  // the privacy contract forbids certain substrings in the serialized result,
  // so messages below never name reference fields directly.
  let betaGrants = 0;
  let betaPrizes = 0;
  let betaRefunds = 0;
  let betaEntrySpend = 0;
  let entryRefundSum = 0;

  // Refund → original matching happens INSIDE this wallet's own history (an
  // entry charge and its refund always belong to the same owner).
  const byPath = new Map<string, TransactionRecord>();
  for (const tx of related.transactions) {
    if (typeof tx.path === "string") byPath.set(tx.path, tx);
  }
  const usedRefundOriginals = new Set<string>();

  /**
   * Validates a refund's link to its original charge. Returns the validated
   * amount in centavos, or null after pushing the exact reason. NOTHING is
   * ever repaired or estimated — any gap is a finding.
   */
  const validateRefund = (
    tx: TransactionRecord,
    kind: "cash" | "beta"
  ): number | null => {
    const label = kind === "cash" ? "reembolso cash" : "reembolso beta";
    const amount = inspectReais(tx.amount, {
      allowZero: false,
      maxCentavos: MAX_BALANCE_CENTAVOS,
    });
    if (!amount.ok) {
      reasons.push(`${label} com valor inválido — não somável`);
      return null;
    }
    if (
      !tx.tournamentRefPath ||
      !tx.registrationRefPath ||
      !tx.entryTransactionRefPath
    ) {
      reasons.push(`${label} sem as referências obrigatórias`);
      return null;
    }
    if (kind === "cash" && tx.hasBetaStamps === true) {
      reasons.push("reembolso cash com campos beta — inválido");
      return null;
    }
    if (kind === "beta" && tx.hasCashStamps === true) {
      reasons.push("reembolso beta com campos cash — inválido");
      return null;
    }
    const original = byPath.get(tx.entryTransactionRefPath);
    if (!original) {
      reasons.push(`${label} sem ledger original no histórico`);
      return null;
    }
    if (usedRefundOriginals.has(tx.entryTransactionRefPath)) {
      reasons.push(`${label} reutiliza um ledger original — duplicado`);
      return null;
    }
    const expectedOriginalCategory =
      kind === "cash" ? "entry_fee" : BETA_ENTRY_FEE_CATEGORY;
    const originalAmount = inspectReais(original.amount, {
      allowZero: false,
      maxCentavos: MAX_BALANCE_CENTAVOS,
    });
    const originalOk =
      original.category === expectedOriginalCategory &&
      originalAmount.ok &&
      originalAmount.centavos === amount.centavos &&
      original.tournamentRefPath === tx.tournamentRefPath;
    if (!originalOk) {
      reasons.push(`${label} diverge do ledger original`);
      return null;
    }
    usedRefundOriginals.add(tx.entryTransactionRefPath);
    return amount.centavos;
  };

  for (const tx of related.transactions) {
    const category = typeof tx.category === "string" ? tx.category : "";

    if (!KNOWN_CATEGORIES.has(category)) {
      // An unrecognized category could move money in a way we cannot model.
      unknownCategory = true;
      continue;
    }

    // ── The four historical CASH categories — behavior preserved, plus the
    // guard that a cash category can never DECLARE the beta economy.
    if (MONEY_CATEGORIES.includes(category as MoneyCategory)) {
      if (tx.economyType === ECONOMY_BETA_CREDIT) {
        reasons.push(
          "transaction cash declara economia beta — inválida, não somada"
        );
        continue;
      }
      const amount = inspectReais(tx.amount, {
        allowZero: true,
        maxCentavos: MAX_BALANCE_CENTAVOS,
      });
      if (!amount.ok) {
        unusableTransaction = true;
        continue;
      }
      derived[CATEGORY_TO_FIELD[category as MoneyCategory]] += amount.centavos;
      // A withdrawal is charged at request time, pending or not (see header).
      if (CREDIT_CATEGORIES.has(category)) {
        derived.balance += amount.centavos;
      } else {
        derived.balance -= amount.centavos;
      }
      continue;
    }

    // ── entry_refund: cash comes BACK — net spend and balance both adjust.
    if (category === ENTRY_REFUND_CATEGORY) {
      if (tx.economyType !== ECONOMY_CASH) {
        reasons.push("reembolso cash sem economia cash — inválido");
        continue;
      }
      const centavos = validateRefund(tx, "cash");
      if (centavos === null) continue;
      entryRefundSum += centavos;
      derived.balance += centavos;
      continue;
    }

    // ── The four BETA categories: economy_type beta_credit is MANDATORY.
    // Without it the transaction is INVALID — never silently cash.
    if (tx.economyType !== ECONOMY_BETA_CREDIT) {
      reasons.push(
        "transaction beta sem economia beta_credit — inválida, nunca cash"
      );
      continue;
    }
    if (tx.hasCashStamps === true) {
      reasons.push("transaction beta com campos cash — inválida");
      continue;
    }
    if (category === BETA_REFUND_CATEGORY) {
      const centavos = validateRefund(tx, "beta");
      if (centavos === null) continue;
      betaRefunds += centavos;
      continue;
    }
    const amount = inspectReais(tx.amount, {
      allowZero: false,
      maxCentavos: MAX_BALANCE_CENTAVOS,
    });
    if (!amount.ok) {
      reasons.push("transaction beta com valor inválido — não somável");
      continue;
    }
    if (category === BETA_GRANT_CATEGORY) betaGrants += amount.centavos;
    else if (category === BETA_PRIZE_CATEGORY) betaPrizes += amount.centavos;
    // EXPLICIT, never the fall-through below: the final `else` means entry
    // spend, so an unlisted beta credit category would SUBTRACT from the beta
    // balance instead of adding to it — an inverted sign that reconciles to a
    // plausible-looking wrong number.
    else if (category === BETA_KILL_PRIZE_CATEGORY) betaPrizes += amount.centavos;
    else betaEntrySpend += amount.centavos;
  }

  if (unknownCategory) {
    reasons.push(
      "histórico contém transaction com category desconhecida — não modelável"
    );
  }
  if (unusableTransaction) {
    reasons.push(
      "histórico contém transaction com amount inválido — não somável"
    );
  }

  // Net cash spend: gross entry fees minus validated refunds — never negative.
  if (entryRefundSum > derived.total_spent) {
    reasons.push("reembolsos cash excedem o gasto de inscrições — impossível");
  } else {
    derived.total_spent -= entryRefundSum;
  }

  // The separate beta identity: grants + prizes + refunds - entry spend.
  const derivedBeta = betaGrants + betaPrizes + betaRefunds - betaEntrySpend;
  if (
    !Number.isSafeInteger(derivedBeta) ||
    betaGrants + betaPrizes + betaRefunds > Number.MAX_SAFE_INTEGER
  ) {
    reasons.push("saldo beta derivado não é um inteiro seguro");
  } else if (derivedBeta < 0) {
    reasons.push("histórico beta implica saldo negativo — impossível");
  } else if (derivedBeta > MAX_BALANCE_CENTAVOS) {
    reasons.push("saldo beta derivado acima do limite permitido");
  }

  // --- Cross-checks against the documents that must accompany a charge. ------
  const withdrawalTxCount = related.transactions.filter(
    (tx) => tx.category === "withdrawal"
  ).length;
  const entryChargeTxCount = related.transactions.filter(
    (tx) =>
      tx.category === "entry_fee" || tx.category === BETA_ENTRY_FEE_CATEGORY
  ).length;

  if (related.withdrawalStatuses.length !== withdrawalTxCount) {
    reasons.push(
      "nº de withdrawals não bate com o nº de transactions category=withdrawal"
    );
  }
  if (related.registrationCount !== entryChargeTxCount) {
    // jointournament writes both atomically (cash OR beta entry); a mismatch
    // means the history is incomplete, so entry charges cannot be trusted to
    // be fully represented.
    reasons.push(
      "nº de registrations não bate com o nº de transactions de inscrição"
    );
  }

  // --- Does the stored beta balance agree with the beta ledger? --------------
  if (context.betaBalancePresent === true) {
    const presentBeta = context.betaBalanceCentavos;
    if (presentBeta === null || presentBeta === undefined) {
      conflicts.push("beta_balance: valor presente é inválido");
    } else if (presentBeta !== derivedBeta) {
      conflicts.push(
        `beta_balance: presente ${fmt(presentBeta)} ≠ derivado ${fmt(derivedBeta)}`
      );
    }
  } else if (derivedBeta !== 0) {
    // Absent means zero at runtime — a non-zero beta history contradicts it.
    conflicts.push(
      `beta_balance: ausente (= 0), mas o histórico deriva ${fmt(derivedBeta)}`
    );
  }

  // --- Do the present fields agree with what the history implies? -----------
  for (const field of WALLET_MONEY_FIELDS) {
    if (context.missingFields.includes(field)) continue;

    const present = context.presentCentavos[field];
    if (present === null || present === undefined) {
      conflicts.push(`${field}: valor presente é inválido`);
      continue;
    }
    if (present !== derived[field]) {
      // The two numbers ARE printed: you cannot judge a backfill without them,
      // and they are aggregate wallet totals, not personal data.
      conflicts.push(
        `${field}: presente R$ ${fmt(present)} ≠ derivado R$ ${fmt(derived[field])}`
      );
    }
  }

  // --- Classify. ------------------------------------------------------------
  const historyIsSound =
    reasons.length === 0 && conflicts.length === 0 && context.userRefValid;

  let classification: Classification;

  if (!context.userDocExists) {
    reasons.push("users/{uid} correspondente não existe");
    classification = "manual-review";
  } else if (!context.userRefValid) {
    reasons.push(`user_ref inválido (${context.userRefStatus})`);
    classification = "manual-review";
  } else if (!hasFinancialActivity) {
    // POSITIVE evidence: no transactions, no withdrawals, no registrations.
    // Every derived total is 0, so the missing fields provably start at zero.
    if (conflicts.length > 0) {
      reasons.push(
        "sem histórico financeiro, mas um campo presente é diferente de zero"
      );
      classification = "manual-review";
    } else {
      reasons.push(
        "nenhuma transaction, withdrawal ou registration relacionada: " +
          "todos os totais derivados são zero"
      );
      classification = "safe-zero-candidate";
    }
  } else if (historyIsSound) {
    reasons.push(
      "histórico completo e consistente: valores deriváveis deterministicamente"
    );
    classification = "reconstructable";
  } else {
    classification = "manual-review";
  }

  return {
    label,
    missingFields: context.missingFields,
    userDocExists: context.userDocExists,
    userRefValid: context.userRefValid,
    userRefStatus: context.userRefStatus,
    transactionCounts,
    withdrawalCounts,
    registrationCount: related.registrationCount,
    hasFinancialActivity,
    derivedCentavos: derived,
    derivedBetaCentavos: derivedBeta,
    conflicts,
    reasons,
    classification,
  };
}

/** Centavos → "12.34". Used only for wallet totals, never for personal data. */
function fmt(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

function countTransactions(
  transactions: readonly TransactionRecord[]
): CategoryCount[] {
  const counts = new Map<string, number>();

  for (const tx of transactions) {
    const category = typeof tx.category === "string" ? tx.category : "(inválida)";
    const status = typeof tx.status === "string" ? tx.status : "(inválido)";
    const key = `${category} ${status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [category, status] = key.split(" ");
      return { category, status, count };
    })
    .sort((a, b) => a.category.localeCompare(b.category));
}

function countByStatus(statuses: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of statuses) {
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}
