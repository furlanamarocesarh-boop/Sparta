import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CATEGORY_TO_FIELD,
  reconcileWallet,
  TransactionRecord,
  WalletContext,
} from "../../src/audit/reconcile.js";
import { anonymousLabel } from "../../src/audit/reconcileReport.js";
import { WalletField } from "../../src/audit/walletAudit.js";

const tx = (
  category: string,
  status: string,
  amount: unknown
): TransactionRecord => ({ category, status, amount });

const ALL_FIELDS: WalletField[] = [
  "balance",
  "total_deposited",
  "total_won",
  "total_spent",
  "total_withdrawn",
];

/**
 * Builds a context the way the CLI really does: every field that is NOT missing
 * has a value read from the document. Defaults to 0, which is what a wallet with
 * no history actually holds; a test overrides only what it cares about.
 */
function context(overrides: Partial<WalletContext> = {}): WalletContext {
  const missingFields = overrides.missingFields ?? ["total_withdrawn"];

  const presentCentavos: Partial<Record<WalletField, number | null>> = {};
  for (const field of ALL_FIELDS) {
    if (!missingFields.includes(field)) presentCentavos[field] = 0;
  }

  const userRefValid = overrides.userRefValid ?? true;

  return {
    userDocExists: true,
    userRefStatus: userRefValid ? "valid" : "missing",
    related: {
      transactions: [],
      withdrawalStatuses: [],
      registrationCount: 0,
    },
    ...overrides,
    userRefValid,
    missingFields,
    presentCentavos: { ...presentCentavos, ...(overrides.presentCentavos ?? {}) },
  };
}

describe("category → wallet field mapping (confirmed against index.ts)", () => {
  it("maps each money category to the total it feeds", () => {
    assert.deepEqual(CATEGORY_TO_FIELD, {
      deposit: "total_deposited",
      prize: "total_won",
      entry_fee: "total_spent",
      withdrawal: "total_withdrawn",
      // Premiação por abate alimenta o MESMO total: dinheiro ganho é dinheiro
      // ganho. A separação entre as duas categorias existe só para o ranking,
      // que precisa distinguir vitória de valor recebido — a identidade
      // contábil da carteira não faz essa distinção.
      kill_prize: "total_won",
    });
  });
});

describe("safe-zero-candidate", () => {
  it("requires POSITIVE evidence of no financial history", () => {
    const result = reconcileWallet("Wallet A", context());

    assert.equal(result.classification, "safe-zero-candidate");
    assert.equal(result.hasFinancialActivity, false);
    assert.deepEqual(result.derivedCentavos, {
      balance: 0,
      total_deposited: 0,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
    });
  });

  it("is NOT declared merely because a field is absent", () => {
    // The whole trap: a missing field plus real history is NOT safe to zero.
    const result = reconcileWallet(
      "Wallet A",
      context({
        related: {
          transactions: [tx("deposit", "completed", 50)],
          withdrawalStatuses: [],
          registrationCount: 0,
        },
      })
    );

    assert.notEqual(result.classification, "safe-zero-candidate");
    assert.equal(result.hasFinancialActivity, true);
  });

  it("is refused when a present field is non-zero despite no history", () => {
    // A balance of R$10 with no transactions at all is unexplained money.
    const result = reconcileWallet(
      "Wallet A",
      context({
        missingFields: ["total_withdrawn"],
        presentCentavos: { balance: 1000 },
      })
    );

    assert.equal(result.classification, "manual-review");
    assert.ok(result.conflicts.some((c) => c.startsWith("balance")));
  });

  it("is refused when a registration exists (a charge DID happen)", () => {
    const result = reconcileWallet(
      "Wallet A",
      context({
        related: {
          transactions: [],
          withdrawalStatuses: [],
          registrationCount: 1,
        },
      })
    );

    assert.equal(result.hasFinancialActivity, true);
    assert.equal(result.classification, "manual-review");
  });
});

describe("reconstructable — the ledger identity", () => {
  it("derives every total, and balance, from a complete history", () => {
    // deposit 100 + prize 40 - entry_fee 10 - withdrawal 30 = balance 100
    const result = reconcileWallet(
      "Wallet A",
      context({
        missingFields: ["total_withdrawn"],
        presentCentavos: {
          balance: 10_000,
          total_deposited: 10_000,
          total_won: 4_000,
          total_spent: 1_000,
        },
        related: {
          transactions: [
            tx("deposit", "completed", 100),
            tx("prize", "completed", 40),
            tx("entry_fee", "completed", 10),
            tx("withdrawal", "pending", 30),
          ],
          withdrawalStatuses: ["pending"],
          registrationCount: 1,
        },
      })
    );

    assert.deepEqual(result.derivedCentavos, {
      balance: 10_000,
      total_deposited: 10_000,
      total_won: 4_000,
      total_spent: 1_000,
      total_withdrawn: 3_000,
    });
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.classification, "reconstructable");
  });

  it("counts a PENDING withdrawal as already charged", () => {
    // Confirmed in index.ts: requestwithdrawal debits balance and increments
    // total_withdrawn at request time, writing status "pending". Nothing ever
    // completes or reverses it. Treating pending as not-yet-charged would
    // overstate the balance by the withdrawn amount — real money, wrong.
    const result = reconcileWallet(
      "Wallet A",
      context({
        missingFields: ["total_withdrawn"],
        presentCentavos: {
          balance: 7_000,
          total_deposited: 10_000,
          total_won: 0,
          total_spent: 0,
        },
        related: {
          transactions: [
            tx("deposit", "completed", 100),
            tx("withdrawal", "pending", 30),
          ],
          withdrawalStatuses: ["pending"],
          registrationCount: 0,
        },
      })
    );

    assert.equal(result.derivedCentavos.total_withdrawn, 3_000);
    assert.equal(result.derivedCentavos.balance, 7_000);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.classification, "reconstructable");
  });
});

describe("manual-review — anything not provable", () => {
  it("flags a present field that contradicts the derived value", () => {
    const result = reconcileWallet(
      "Wallet A",
      context({
        missingFields: ["total_withdrawn"],
        presentCentavos: { balance: 99_999, total_deposited: 10_000 },
        related: {
          transactions: [tx("deposit", "completed", 100)],
          withdrawalStatuses: [],
          registrationCount: 0,
        },
      })
    );

    assert.equal(result.classification, "manual-review");
    assert.ok(result.conflicts.some((c) => c.startsWith("balance")));
  });

  it("flags a withdrawal doc with no matching transaction", () => {
    const result = reconcileWallet(
      "Wallet A",
      context({
        related: {
          transactions: [],
          withdrawalStatuses: ["pending"],
          registrationCount: 0,
        },
      })
    );

    assert.equal(result.classification, "manual-review");
    assert.ok(result.reasons.some((r) => r.includes("withdrawals")));
  });

  it("flags a registration with no matching entry_fee transaction", () => {
    // jointournament writes both atomically, so a mismatch means the history is
    // incomplete and entry fees cannot be trusted.
    const result = reconcileWallet(
      "Wallet A",
      context({
        related: {
          transactions: [tx("deposit", "completed", 10)],
          withdrawalStatuses: [],
          registrationCount: 2,
        },
      })
    );

    assert.equal(result.classification, "manual-review");
    assert.ok(result.reasons.some((r) => r.includes("registrations")));
  });

  it("flags an unknown transaction category", () => {
    const result = reconcileWallet(
      "Wallet A",
      context({
        related: {
          transactions: [tx("cashback", "completed", 10)],
          withdrawalStatuses: [],
          registrationCount: 0,
        },
      })
    );

    assert.equal(result.classification, "manual-review");
    assert.ok(result.reasons.some((r) => r.includes("desconhecida")));
  });

  it("flags a transaction with an unusable amount", () => {
    const result = reconcileWallet(
      "Wallet A",
      context({
        related: {
          transactions: [tx("deposit", "completed", "100")],
          withdrawalStatuses: [],
          registrationCount: 0,
        },
      })
    );

    assert.equal(result.classification, "manual-review");
    assert.ok(result.reasons.some((r) => r.includes("amount inválido")));
  });

  it("flags a missing users/{uid}", () => {
    const result = reconcileWallet(
      "Wallet A",
      context({ userDocExists: false })
    );
    assert.equal(result.classification, "manual-review");
    assert.ok(result.reasons.some((r) => r.includes("users/{uid}")));
  });

  it("flags an invalid user_ref and says WHY, without revealing the path", () => {
    for (const status of [
      "missing",
      "not-a-reference",
      "points-elsewhere",
    ] as const) {
      const result = reconcileWallet(
        "Wallet A",
        context({ userRefValid: false, userRefStatus: status })
      );

      assert.equal(result.classification, "manual-review");
      assert.ok(
        result.reasons.some((r) => r.includes(status)),
        `should report the reason "${status}"`
      );
      // The diagnosis is a category, never the offending path.
      assert.ok(!JSON.stringify(result).includes("users/"));
    }
  });
});

describe("anonymousLabel", () => {
  it("labels wallets A, B, C ... without ever using an id", () => {
    assert.equal(anonymousLabel(0), "Wallet A");
    assert.equal(anonymousLabel(1), "Wallet B");
    assert.equal(anonymousLabel(25), "Wallet Z");
    assert.equal(anonymousLabel(26), "Wallet AA");
  });
});

describe("privacy of the reconciliation result", () => {
  it("carries no id, uid, e-mail, PIX or WhatsApp", () => {
    const result = reconcileWallet("Wallet A", context());
    const serialized = JSON.stringify(result);

    // The result type simply has nowhere to put them: it is built from counts,
    // booleans and derived centavos only.
    for (const forbidden of ["uid", "email", "pix", "whatsapp", "user_ref"]) {
      assert.ok(
        !serialized.toLowerCase().includes(forbidden),
        `result must not carry "${forbidden}"`
      );
    }

    const fields: WalletField[] = ["balance"];
    assert.ok(fields.length > 0);
  });
});
