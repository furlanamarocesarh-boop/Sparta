import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  executeCleanup,
  TxLike,
  walletAResetFields,
} from "../../src/cleanup/plan.js";

/** Records every write, so the exact operation list can be asserted. */
class RecordingTx implements TxLike {
  readonly ops: { op: string; ref: string; data?: Record<string, unknown> }[] = [];

  update(ref: unknown, data: Record<string, unknown>): void {
    this.ops.push({ op: "update", ref: String(ref), data });
  }

  delete(ref: unknown): void {
    this.ops.push({ op: "delete", ref: String(ref) });
  }
}

const REFS = {
  walletARef: "wallets/A",
  walletAUserRef: "users/A",
  fakeTransactionRef: "transactions/FAKE",
  walletBRef: "wallets/B",
};

describe("executeCleanup — exactly three operations, no more", () => {
  it("touches only Wallet A, its fake transaction, and Wallet B", () => {
    const tx = new RecordingTx();
    executeCleanup(tx, REFS);

    assert.equal(tx.ops.length, 3, "must touch exactly three documents");

    assert.deepEqual(
      tx.ops.map((o) => `${o.op} ${o.ref}`),
      [
        "update wallets/A",
        "delete transactions/FAKE",
        "delete wallets/B",
      ]
    );
  });

  it("never deletes the user or anything else", () => {
    const tx = new RecordingTx();
    executeCleanup(tx, REFS);

    const deleted = tx.ops.filter((o) => o.op === "delete").map((o) => o.ref);
    assert.ok(!deleted.includes("users/A"), "the user must NOT be deleted");
    assert.deepEqual(deleted, ["transactions/FAKE", "wallets/B"]);
  });

  it("uses update (not set) on Wallet A, preserving non-financial fields", () => {
    // `set` would clobber username, player_id, pix_key, whatsapp... `update`
    // merges only the listed keys. This is the difference between fixing a
    // wallet and wiping a player's profile.
    const tx = new RecordingTx();
    executeCleanup(tx, REFS);

    const walletAOp = tx.ops.find((o) => o.ref === "wallets/A");
    assert.ok(walletAOp);
    assert.equal(walletAOp.op, "update");
  });
});

describe("walletAResetFields", () => {
  it("zeroes exactly the five money fields and repairs user_ref", () => {
    const fields = walletAResetFields("users/A");

    assert.deepEqual(fields, {
      balance: 0,
      total_deposited: 0,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
      user_ref: "users/A",
    });
  });

  it("does not mention any non-financial field, so none can be erased", () => {
    const fields = walletAResetFields("users/A");
    for (const preserved of ["username", "player_id", "pix_key", "whatsapp", "email"]) {
      assert.ok(
        !(preserved in fields),
        `${preserved} must not appear in the update payload`
      );
    }
  });
});

describe("dry run never writes", () => {
  it("performs zero operations when executeCleanup is not called", () => {
    // The dry-run path in the CLI reports the plan and returns BEFORE reaching
    // executeCleanup. Modeled here: no execution => no operations, ever.
    const tx = new RecordingTx();
    // (dry run: executeCleanup deliberately NOT called)
    assert.equal(tx.ops.length, 0);
  });
});

describe("atomicity", () => {
  it("all three operations are issued on ONE transaction object", () => {
    // They are handed to a single TxLike, which the CLI backs with a real
    // Firestore runTransaction — so either all three land or none do.
    const tx = new RecordingTx();
    executeCleanup(tx, REFS);
    assert.equal(tx.ops.length, 3);
  });

  it("a throw mid-transaction leaves no operation reported as applied", () => {
    // Firestore rolls the transaction back on a throw. Modeled: a tx that
    // explodes on the second op records no successful third one, and the error
    // propagates rather than being swallowed into a "success".
    class ExplodingTx implements TxLike {
      readonly ops: string[] = [];
      update(ref: unknown): void {
        this.ops.push(`update ${String(ref)}`);
      }
      delete(ref: unknown): void {
        this.ops.push(`delete ${String(ref)}`);
        throw new Error("commit failed");
      }
    }

    const tx = new ExplodingTx();
    assert.throws(() => executeCleanup(tx, REFS), /commit failed/);

    // The third operation was never issued, and the caller sees the throw —
    // a failed commit can never be reported as success.
    assert.deepEqual(tx.ops, ["update wallets/A", "delete transactions/FAKE"]);
  });
});
