import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditWalletDocument,
  WALLET_MONEY_FIELDS,
} from "../../src/audit/walletAudit.js";

/** A wallet exactly as `onUserCreated` writes it: all zeros, all present. */
const healthyWallet = (): Record<string, unknown> => ({
  balance: 0,
  total_deposited: 0,
  total_won: 0,
  total_spent: 0,
  total_withdrawn: 0,
  user_ref: "users/u1",
});

/** The problem reported for `field`, or undefined if that field was fine. */
function problemFor(
  data: Record<string, unknown>,
  field: string
): string | undefined {
  const finding = auditWalletDocument("w1", data);
  return finding?.issues.find((issue) => issue.field === field)?.problem;
}

describe("auditWalletDocument — healthy data", () => {
  it("reports nothing for a freshly created wallet (all zeros)", () => {
    assert.equal(auditWalletDocument("w1", healthyWallet()), null);
  });

  it("reports nothing for a wallet with real balances", () => {
    const wallet = {
      ...healthyWallet(),
      balance: 70.01,
      total_deposited: 100,
      total_spent: 29.99,
    };
    assert.equal(auditWalletDocument("w1", wallet), null);
  });

  it("checks every one of the five monetary fields", () => {
    // Guards against a field being silently dropped from the audit later.
    assert.deepEqual(WALLET_MONEY_FIELDS, [
      "balance",
      "total_deposited",
      "total_won",
      "total_spent",
      "total_withdrawn",
    ]);

    const finding = auditWalletDocument("w1", {});
    assert.ok(finding);
    assert.equal(finding.issues.length, 5);
    assert.ok(finding.issues.every((issue) => issue.problem === "missing"));
  });
});

describe("auditWalletDocument — field defects", () => {
  it("detects a missing field", () => {
    const wallet = healthyWallet();
    delete wallet.total_won;
    assert.equal(problemFor(wallet, "total_won"), "missing");
  });

  it("detects a null field", () => {
    assert.equal(
      problemFor({ ...healthyWallet(), balance: null }, "balance"),
      "missing"
    );
  });

  it("detects a non-number, including a numeric string", () => {
    assert.equal(
      problemFor({ ...healthyWallet(), balance: "10.00" }, "balance"),
      "not-a-number"
    );
    assert.equal(
      problemFor({ ...healthyWallet(), balance: true }, "balance"),
      "not-a-number"
    );
    assert.equal(
      problemFor({ ...healthyWallet(), balance: {} }, "balance"),
      "not-a-number"
    );
  });

  it("detects NaN and Infinity separately", () => {
    assert.equal(
      problemFor({ ...healthyWallet(), balance: NaN }, "balance"),
      "nan"
    );
    assert.equal(
      problemFor({ ...healthyWallet(), balance: Infinity }, "balance"),
      "infinite"
    );
    // -Infinity is reported as `infinite`, not `negative`: finiteness is checked
    // before the sign, and "not a finite number" is the more precise diagnosis.
    assert.equal(
      problemFor({ ...healthyWallet(), balance: -Infinity }, "balance"),
      "infinite"
    );
  });

  it("detects a negative value", () => {
    assert.equal(
      problemFor({ ...healthyWallet(), balance: -0.01 }, "balance"),
      "negative"
    );
    assert.equal(
      problemFor({ ...healthyWallet(), total_spent: -50 }, "total_spent"),
      "negative"
    );
  });

  it("detects more than two decimal places", () => {
    assert.equal(
      problemFor({ ...healthyWallet(), balance: 10.101 }, "balance"),
      "too-many-decimals"
    );
    assert.equal(
      problemFor({ ...healthyWallet(), balance: 0.005 }, "balance"),
      "too-many-decimals"
    );
  });

  it("absorbs ULP-scale float drift instead of raising a false positive", () => {
    // IMPORTANT, and easy to get backwards: a balance of 0.30000000000000004
    // (what the OLD float arithmetic produced for 0.1 + 0.2) is still WORTH
    // exactly 30 centavos. The drift is ~4e-17, far below the epsilon, so it
    // rounds cleanly and the money is intact.
    //
    // Flagging it would be a false positive on healthy money and would bury the
    // genuinely broken documents in noise. The audit must not cry wolf.
    const drifted = 0.1 + 0.2; // 0.30000000000000004
    assert.notEqual(drifted, 0.3);
    assert.equal(auditWalletDocument("w1", { ...healthyWallet(), balance: drifted }), null);

    const drifted2 = 0.3 - 0.1; // 0.19999999999999998
    assert.equal(auditWalletDocument("w1", { ...healthyWallet(), balance: drifted2 }), null);

    // 1.15 * 100 is 114.99999999999999, yet 1.15 is a perfectly valid balance.
    assert.equal(auditWalletDocument("w1", { ...healthyWallet(), balance: 1.15 }), null);
    assert.equal(auditWalletDocument("w1", { ...healthyWallet(), balance: 0.07 }), null);
  });

  it("detects sub-centavo values, which are genuinely unrepresentable", () => {
    // These are the ones that actually break: a real fraction of a centavo,
    // not representation noise. The hardened backend refuses to operate on them.
    for (const broken of [
      1 / 3, // 0.3333333333333333
      10.1 * 1.07, // 10.807 — a percentage/interest calculation
      10.101,
      0.005,
    ]) {
      assert.equal(
        problemFor({ ...healthyWallet(), balance: broken }, "balance"),
        "too-many-decimals",
        `should reject ${broken}`
      );
    }
  });

  it("detects unsafe and over-limit values", () => {
    assert.equal(
      problemFor({ ...healthyWallet(), balance: Number.MAX_SAFE_INTEGER }, "balance"),
      "unsafe"
    );
    // Above MAX_BALANCE_CENTAVOS (R$ 10,000,000.00).
    assert.equal(
      problemFor({ ...healthyWallet(), balance: 10_000_000.01 }, "balance"),
      "above-limit"
    );
  });

  it("reports every defective field of one document at once", () => {
    const finding = auditWalletDocument("w1", {
      balance: -1,
      total_deposited: "x",
      total_won: NaN,
      total_spent: 10.001,
      total_withdrawn: 0,
    });

    assert.ok(finding);
    assert.equal(finding.id, "w1");
    assert.deepEqual(
      finding.issues.map((i) => `${i.field}:${i.problem}`),
      [
        "balance:negative",
        "total_deposited:not-a-number",
        "total_won:nan",
        "total_spent:too-many-decimals",
      ]
    );
  });
});
