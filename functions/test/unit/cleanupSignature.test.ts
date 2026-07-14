import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPlan, CandidateWithId } from "../../src/cleanup/plan.js";
import { classify, WalletCandidate } from "../../src/cleanup/signature.js";

/** Wallet A exactly as the reconciliation observed it in production. */
function walletA(overrides: Partial<WalletCandidate> = {}): WalletCandidate {
  return {
    walletData: {
      balance: 70,
      total_deposited: 50,
      total_won: 20,
      total_spent: 0,
      // total_withdrawn is ABSENT — that is the anomaly.
      username: "jogador-teste", // a non-financial field that must survive
    },
    userRefPath: undefined, // ABSENT
    expectedUserRefPath: "users/uid-a",
    userDocExists: true,
    transactions: [{ category: "prize", status: "completed", amount: 20 }],
    withdrawalCount: 0,
    registrationCount: 0,
    ...overrides,
  };
}

/** Wallet B exactly as observed: orphaned, empty, pointing elsewhere. */
function walletB(overrides: Partial<WalletCandidate> = {}): WalletCandidate {
  return {
    walletData: {}, // all five money fields missing
    userRefPath: "users/someone-else",
    expectedUserRefPath: "users/uid-b",
    userDocExists: false,
    transactions: [],
    withdrawalCount: 0,
    registrationCount: 0,
    ...overrides,
  };
}

describe("signature identifies exactly the two known targets", () => {
  it("matches Wallet A", () => {
    assert.equal(classify(walletA()), "wallet-a");
  });

  it("matches Wallet B", () => {
    assert.equal(classify(walletB()), "wallet-b");
  });

  it("does not match a healthy wallet", () => {
    const healthy: WalletCandidate = {
      walletData: {
        balance: 0,
        total_deposited: 0,
        total_won: 0,
        total_spent: 0,
        total_withdrawn: 0,
      },
      userRefPath: "users/uid-c",
      expectedUserRefPath: "users/uid-c",
      userDocExists: true,
      transactions: [],
      withdrawalCount: 0,
      registrationCount: 0,
    };
    assert.equal(classify(healthy), "not-a-target");
  });
});

describe("Wallet A — any drift aborts the match", () => {
  it("a different balance does not match", () => {
    for (const balance of [70.01, 69.99, 0, 100]) {
      const candidate = walletA({
        walletData: {
          balance,
          total_deposited: 50,
          total_won: 20,
          total_spent: 0,
        },
      });
      assert.equal(classify(candidate), "not-a-target", `balance ${balance}`);
    }
  });

  it("a different total_deposited or total_won does not match", () => {
    assert.equal(
      classify(
        walletA({
          walletData: {
            balance: 70,
            total_deposited: 60,
            total_won: 20,
            total_spent: 0,
          },
        })
      ),
      "not-a-target"
    );
    assert.equal(
      classify(
        walletA({
          walletData: {
            balance: 70,
            total_deposited: 50,
            total_won: 25,
            total_spent: 0,
          },
        })
      ),
      "not-a-target"
    );
  });

  it("new financial activity does not match", () => {
    assert.equal(
      classify(walletA({ withdrawalCount: 1 })),
      "not-a-target",
      "a new withdrawal"
    );
    assert.equal(
      classify(walletA({ registrationCount: 1 })),
      "not-a-target",
      "a new registration"
    );
    assert.equal(
      classify(
        walletA({
          transactions: [
            { category: "prize", status: "completed", amount: 20 },
            { category: "deposit", status: "completed", amount: 10 },
          ],
        })
      ),
      "not-a-target",
      "a second transaction"
    );
  });

  it("a transaction that is not the exact fake prize does not match", () => {
    for (const tx of [
      { category: "deposit", status: "completed", amount: 20 },
      { category: "prize", status: "pending", amount: 20 },
      { category: "prize", status: "completed", amount: 25 },
      { category: "prize", status: "completed", amount: "20" },
    ]) {
      assert.equal(
        classify(walletA({ transactions: [tx] })),
        "not-a-target",
        JSON.stringify(tx)
      );
    }
  });

  it("a user_ref that has since been repaired does not match", () => {
    // If someone already fixed it, this is no longer the document we reconciled.
    assert.equal(
      classify(walletA({ userRefPath: "users/uid-a" })),
      "not-a-target"
    );
  });

  it("a missing users/{uid} does not match", () => {
    assert.equal(classify(walletA({ userDocExists: false })), "not-a-target");
  });

  it("a different set of missing fields does not match", () => {
    // total_withdrawn present, balance missing → not the signature.
    assert.equal(
      classify(
        walletA({
          walletData: {
            total_deposited: 50,
            total_won: 20,
            total_spent: 0,
            total_withdrawn: 0,
          },
        })
      ),
      "not-a-target"
    );
  });
});

describe("Wallet B — any activity aborts the match", () => {
  it("any transaction, withdrawal or registration does not match", () => {
    assert.equal(
      classify(
        walletB({
          transactions: [{ category: "deposit", status: "completed", amount: 1 }],
        })
      ),
      "not-a-target"
    );
    assert.equal(classify(walletB({ withdrawalCount: 1 })), "not-a-target");
    assert.equal(classify(walletB({ registrationCount: 1 })), "not-a-target");
  });

  it("an existing users/{uid} does not match (it is no longer orphaned)", () => {
    assert.equal(classify(walletB({ userDocExists: true })), "not-a-target");
  });

  it("a correct user_ref does not match", () => {
    assert.equal(classify(walletB({ userRefPath: "users/uid-b" })), "not-a-target");
  });

  it("an absent user_ref does not match (the signature requires one)", () => {
    assert.equal(classify(walletB({ userRefPath: undefined })), "not-a-target");
  });

  it("any money field present does not match", () => {
    assert.equal(classify(walletB({ walletData: { balance: 0 } })), "not-a-target");
  });
});

describe("buildPlan requires exactly one of each", () => {
  const entry = (id: string, candidate: WalletCandidate): CandidateWithId => ({
    id,
    candidate,
  });

  it("accepts exactly one Wallet A and one Wallet B", () => {
    const plan = buildPlan([
      entry("a", walletA()),
      entry("b", walletB()),
      entry("healthy", {
        walletData: {
          balance: 0,
          total_deposited: 0,
          total_won: 0,
          total_spent: 0,
          total_withdrawn: 0,
        },
        userRefPath: "users/uid-c",
        expectedUserRefPath: "users/uid-c",
        userDocExists: true,
        transactions: [],
        withdrawalCount: 0,
        registrationCount: 0,
      }),
    ]);

    assert.equal(plan.ok, true);
    assert.equal(plan.ok === true && plan.targets.walletA.id, "a");
    assert.equal(plan.ok === true && plan.targets.walletB.id, "b");
  });

  it("aborts when a target is missing", () => {
    const onlyA = buildPlan([entry("a", walletA())]);
    assert.equal(onlyA.ok, false);
    assert.ok(onlyA.ok === false && onlyA.reason.includes("Wallet B"));

    const onlyB = buildPlan([entry("b", walletB())]);
    assert.equal(onlyB.ok, false);
    assert.ok(onlyB.ok === false && onlyB.reason.includes("Wallet A"));
  });

  it("aborts when there is more than one of either", () => {
    const twoA = buildPlan([
      entry("a1", walletA()),
      entry("a2", walletA()),
      entry("b", walletB()),
    ]);
    assert.equal(twoA.ok, false);
    assert.ok(twoA.ok === false && twoA.reason.includes("encontrei 2"));
  });

  it("reports 'nothing to do' when no target matches — the idempotent case", () => {
    // This is what a SECOND run after a successful apply looks like: the
    // documents no longer match the signature, so there is nothing to write.
    const plan = buildPlan([]);
    assert.equal(plan.ok, false);
    assert.ok(plan.ok === false && plan.reason.includes("Nenhum alvo"));
    assert.ok(plan.ok === false && plan.reason.includes("Nada a fazer"));
  });

  it("a cleaned-up Wallet A no longer matches (idempotency, concretely)", () => {
    // After the apply: all fields zeroed, user_ref repaired, fake tx gone.
    const cleaned = walletA({
      walletData: {
        balance: 0,
        total_deposited: 0,
        total_won: 0,
        total_spent: 0,
        total_withdrawn: 0,
        username: "jogador-teste",
      },
      userRefPath: "users/uid-a",
      transactions: [],
    });
    assert.equal(classify(cleaned), "not-a-target");
  });
});
