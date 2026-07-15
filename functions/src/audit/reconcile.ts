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
] as const;

export type MoneyCategory = (typeof MONEY_CATEGORIES)[number];

/** Which wallet total each category feeds. */
export const CATEGORY_TO_FIELD: Readonly<Record<MoneyCategory, WalletField>> = {
  deposit: "total_deposited",
  prize: "total_won",
  entry_fee: "total_spent",
  withdrawal: "total_withdrawn",
};

/** Categories that ADD to the balance. The other two subtract. */
const CREDIT_CATEGORIES: ReadonlySet<string> = new Set(["deposit", "prize"]);

/** One transaction, reduced to only what reconciliation needs. */
export interface TransactionRecord {
  readonly category: unknown;
  readonly status: unknown;
  readonly amount: unknown;
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

  for (const tx of related.transactions) {
    const category = typeof tx.category === "string" ? tx.category : "";

    if (!MONEY_CATEGORIES.includes(category as MoneyCategory)) {
      // An unrecognized category could move money in a way we cannot model.
      unknownCategory = true;
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

    // A withdrawal is charged at request time, pending or not (see the header).
    if (CREDIT_CATEGORIES.has(category)) {
      derived.balance += amount.centavos;
    } else {
      derived.balance -= amount.centavos;
    }
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

  // --- Cross-checks against the documents that must accompany a charge. ------
  const withdrawalTxCount = related.transactions.filter(
    (tx) => tx.category === "withdrawal"
  ).length;
  const entryFeeTxCount = related.transactions.filter(
    (tx) => tx.category === "entry_fee"
  ).length;

  if (related.withdrawalStatuses.length !== withdrawalTxCount) {
    reasons.push(
      "nº de withdrawals não bate com o nº de transactions category=withdrawal"
    );
  }
  if (related.registrationCount !== entryFeeTxCount) {
    // jointournament writes both atomically; a mismatch means the history is
    // incomplete, so entry fees cannot be trusted to be fully represented.
    reasons.push(
      "nº de registrations não bate com o nº de transactions category=entry_fee"
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
