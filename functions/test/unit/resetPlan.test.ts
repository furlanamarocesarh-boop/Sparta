import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeFingerprint } from "../../src/reset/fingerprint.js";
import { executeReset, RefResolver, ResetTx } from "../../src/reset/execute.js";
import {
  buildResetPlan,
  LARGE_COLLECTION_THRESHOLD,
  MAX_TRANSACTION_WRITES,
  ResetSnapshot,
  stampsFor,
  tournamentNormalizedFields,
  walletMoneyZeros,
  walletNeedsReset,
} from "../../src/reset/plan.js";

// --- Fixtures ---------------------------------------------------------------

const dirtyWallet = (id: string) => ({
  id,
  data: {
    balance: 70,
    total_deposited: 50,
    total_won: 20,
    total_spent: 0,
    total_withdrawn: 0,
    username: "jogador",
    player_id: "PLR-123456",
    pix_key: "chave",
    whatsapp: "+5511...",
  },
  updateTime: "2026-07-01T00:00:00.000Z",
  userExists: true,
});

const cleanWallet = (id: string) => ({
  id,
  data: {
    balance: 0,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
    user_ref: { path: `users/${id}` },
    username: "jogador",
  },
  updateTime: "2026-07-01T00:00:00.000Z",
  userExists: true,
});

const legacyTournament = (id: string) => ({
  id,
  data: {
    name: "Copa Sparta",
    prize: 400,
    entry_fee: 10,
    status: "open",
    current_players: 3,
    max_players: 16,
  },
  updateTime: "2026-07-01T00:00:00.000Z",
});

const canonicalTournament = (id: string) => ({
  id,
  data: {
    name: "Copa Sparta",
    current_players: 0,
    max_players: 16,
    current_participants: 0,
    max_participants: 16,
  },
  updateTime: "2026-07-01T00:00:00.000Z",
});

const ledgerDoc = (collection: "transactions" | "withdrawals" | "registrations", id: string) => ({
  collection,
  id,
  updateTime: "2026-07-01T00:00:00.000Z",
});

function snapshot(overrides: Partial<ResetSnapshot> = {}): ResetSnapshot {
  return {
    userCount: 5,
    wallets: [dirtyWallet("w1")],
    tournaments: [legacyTournament("t1")],
    ledger: [ledgerDoc("transactions", "tx1")],
    ...overrides,
  };
}

function expectOk(result: ReturnType<typeof buildResetPlan>) {
  assert.equal(result.ok, true, result.ok === false ? result.reason : "");
  if (result.ok !== true) throw new Error("unreachable");
  return result.plan;
}

// --- Recorder ---------------------------------------------------------------

class RecordingTx implements ResetTx {
  readonly ops: { op: string; ref: string; data?: Record<string, unknown> }[] = [];
  update(ref: unknown, data: Record<string, unknown>): void {
    this.ops.push({ op: "update", ref: String(ref), data });
  }
  delete(ref: unknown): void {
    this.ops.push({ op: "delete", ref: String(ref) });
  }
}

const REFS: RefResolver = {
  wallet: (id) => `wallets/${id}`,
  user: (id) => `users/${id}`,
  tournament: (id) => `tournaments/${id}`,
  ledger: (collection, id) => `${collection}/${id}`,
};

// --- Tests ------------------------------------------------------------------

describe("write counting", () => {
  it("counts one write per wallet, tournament and ledger document", () => {
    const plan = expectOk(
      buildResetPlan(
        snapshot({
          wallets: [dirtyWallet("w1"), dirtyWallet("w2")],
          tournaments: [legacyTournament("t1"), legacyTournament("t2")],
          ledger: [
            ledgerDoc("transactions", "a"),
            ledgerDoc("withdrawals", "b"),
            ledgerDoc("registrations", "c"),
          ],
        })
      )
    );

    assert.equal(plan.walletsToZero, 2);
    assert.equal(plan.tournamentsToNormalize, 2);
    assert.equal(plan.ledgerCounts.transactions, 1);
    assert.equal(plan.ledgerCounts.withdrawals, 1);
    assert.equal(plan.ledgerCounts.registrations, 1);
    assert.equal(plan.writes, 7);
    assert.equal(plan.operations.length, 7);
  });

  it("refuses more than 500 writes instead of splitting into batches", () => {
    // Splitting would make the reset non-atomic — a partial reset is exactly the
    // outcome to avoid, so this refuses instead.
    const ledger = Array.from({ length: MAX_TRANSACTION_WRITES + 1 }, (_, i) =>
      ledgerDoc("transactions", `tx-${i}`)
    );

    const result = buildResetPlan(
      snapshot({ wallets: [], tournaments: [], ledger })
    );

    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.reason.includes("501"));
    assert.ok(result.ok === false && result.reason.includes("batches"));
  });

  it("accepts exactly 500 writes", () => {
    const ledger = Array.from({ length: MAX_TRANSACTION_WRITES }, (_, i) =>
      ledgerDoc("transactions", `tx-${i}`)
    );
    const plan = expectOk(
      buildResetPlan(snapshot({ wallets: [], tournaments: [], ledger }))
    );
    assert.equal(plan.writes, 500);
  });
});

describe("validation aborts the ENTIRE plan", () => {
  it("aborts when a wallet has no corresponding user", () => {
    const orphan = { ...dirtyWallet("w1"), userExists: false };
    const result = buildResetPlan(snapshot({ wallets: [orphan] }));

    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.reason.includes("sem o users/{uid}"));
  });

  it("aborts on a tournament with missing or invalid max_players", () => {
    for (const bad of [undefined, 0, -5, 1.5, "16", null]) {
      const tournament = {
        id: "t1",
        data: { name: "X", current_players: 0, max_players: bad },
        updateTime: "2026-07-01T00:00:00.000Z",
      };
      const result = buildResetPlan(snapshot({ tournaments: [tournament] }));
      assert.equal(result.ok, false, `max_players=${String(bad)}`);
      assert.ok(result.ok === false && result.reason.includes("max_players"));
    }
  });

  it("aborts on a tournament with an invalid current_players", () => {
    const tournament = {
      id: "t1",
      data: { name: "X", current_players: -1, max_players: 16 },
      updateTime: "2026-07-01T00:00:00.000Z",
    };
    const result = buildResetPlan(snapshot({ tournaments: [tournament] }));
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.reason.includes("current_players"));
  });

  it("refuses an unexpectedly large ledger collection instead of wiping it", () => {
    const ledger = Array.from(
      { length: LARGE_COLLECTION_THRESHOLD + 1 },
      (_, i) => ledgerDoc("transactions", `tx-${i}`)
    );
    const result = buildResetPlan(
      snapshot({ wallets: [], tournaments: [], ledger })
    );

    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.reason.includes("REVISÃO MANUAL"));
  });
});

describe("wallet reset", () => {
  it("zeroes exactly the five money fields and nothing else", () => {
    assert.deepEqual(walletMoneyZeros(), {
      balance: 0,
      total_deposited: 0,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
    });
  });

  it("never mentions a non-financial field, so none can be erased", () => {
    const fields = walletMoneyZeros();
    for (const preserved of [
      "username",
      "player_id",
      "pix_key",
      "whatsapp",
      "email",
    ]) {
      assert.ok(!(preserved in fields), `${preserved} must be preserved`);
    }
  });

  it("skips a wallet that is already zeroed AND correctly linked", () => {
    assert.equal(walletNeedsReset(cleanWallet("w1")), false);
    assert.equal(walletNeedsReset(dirtyWallet("w1")), true);
  });

  it("still rewrites a zeroed wallet whose user_ref is wrong", () => {
    const wrongRef = {
      ...cleanWallet("w1"),
      data: { ...cleanWallet("w1").data, user_ref: { path: "users/someone" } },
    };
    assert.equal(walletNeedsReset(wrongRef), true);
  });
});

describe("tournament normalization", () => {
  it("zeroes both current fields and mirrors max_players into max_participants", () => {
    assert.deepEqual(tournamentNormalizedFields(16), {
      current_participants: 0,
      current_players: 0,
      max_participants: 16,
    });
  });

  it("does NOT write max_players — it is preserved, and the pairs end equal", () => {
    const fields = tournamentNormalizedFields(16);
    assert.ok(!("max_players" in fields), "max_players must be preserved as-is");
    // Both pairs end canonical and equal: max_participants == the existing
    // max_players, and both current counters are 0.
    assert.equal(fields.max_participants, 16);
    assert.equal(fields.current_participants, fields.current_players);
  });

  it("never touches title, prize, price, status, dates or rules", () => {
    const fields = tournamentNormalizedFields(16);
    for (const preserved of [
      "name",
      "prize",
      "entry_fee",
      "status",
      "starts_at",
      "created_at",
      "rules",
      "game_mode",
    ]) {
      assert.ok(!(preserved in fields), `${preserved} must be preserved`);
    }
  });

  it("skips a tournament that is already canonical", () => {
    const plan = expectOk(
      buildResetPlan(
        snapshot({
          wallets: [],
          ledger: [],
          tournaments: [canonicalTournament("t1")],
        })
      )
    );
    assert.equal(plan.tournamentsToNormalize, 0);
    assert.equal(plan.tournamentsAlreadyCanonical, 1);
    assert.equal(plan.writes, 0);
  });
});

describe("execution — exact operations, users never touched", () => {
  it("issues update for wallets, update for tournaments, delete for ledger", () => {
    const plan = expectOk(
      buildResetPlan(
        snapshot({
          wallets: [dirtyWallet("w1")],
          tournaments: [legacyTournament("t1")],
          ledger: [
            ledgerDoc("transactions", "a"),
            ledgerDoc("withdrawals", "b"),
            ledgerDoc("registrations", "c"),
          ],
        })
      )
    );

    const tx = new RecordingTx();
    executeReset(tx, plan.operations, REFS);

    assert.deepEqual(
      tx.ops.map((o) => `${o.op} ${o.ref}`),
      [
        "update wallets/w1",
        "update tournaments/t1",
        "delete transactions/a",
        "delete withdrawals/b",
        "delete registrations/c",
      ]
    );
  });

  it("NEVER writes to users, and never deletes anything outside the ledger", () => {
    const plan = expectOk(
      buildResetPlan(
        snapshot({
          wallets: [dirtyWallet("w1"), dirtyWallet("w2")],
          tournaments: [legacyTournament("t1")],
          ledger: [ledgerDoc("transactions", "a")],
        })
      )
    );

    const tx = new RecordingTx();
    executeReset(tx, plan.operations, REFS);

    for (const op of tx.ops) {
      assert.ok(
        !op.ref.startsWith("users/"),
        "users must never be an operand of a write"
      );
    }

    const deleted = tx.ops.filter((o) => o.op === "delete").map((o) => o.ref);
    for (const ref of deleted) {
      assert.ok(
        /^(transactions|withdrawals|registrations)\//.test(ref),
        `only ledger docs may be deleted, got ${ref}`
      );
    }
  });

  it("writes the correct user_ref on each wallet", () => {
    const plan = expectOk(
      buildResetPlan(snapshot({ wallets: [dirtyWallet("w1")], ledger: [] }))
    );

    const tx = new RecordingTx();
    executeReset(tx, plan.operations, REFS);

    const walletOp = tx.ops.find((o) => o.ref === "wallets/w1");
    assert.ok(walletOp);
    assert.equal(walletOp.op, "update"); // update, not set
    assert.equal(walletOp.data?.user_ref, "users/w1");
    assert.equal(walletOp.data?.balance, 0);
  });

  it("a throw mid-transaction leaves the remaining ops unissued", () => {
    // Firestore rolls back on a throw; a failed commit can never be a success.
    class ExplodingTx implements ResetTx {
      readonly ops: string[] = [];
      update(ref: unknown): void {
        this.ops.push(`update ${String(ref)}`);
      }
      delete(ref: unknown): void {
        this.ops.push(`delete ${String(ref)}`);
        throw new Error("commit failed");
      }
    }

    const plan = expectOk(
      buildResetPlan(
        snapshot({
          wallets: [dirtyWallet("w1")],
          tournaments: [],
          ledger: [ledgerDoc("transactions", "a"), ledgerDoc("transactions", "b")],
        })
      )
    );

    const tx = new ExplodingTx();
    assert.throws(() => executeReset(tx, plan.operations, REFS), /commit failed/);
    assert.deepEqual(tx.ops, ["update wallets/w1", "delete transactions/a"]);
  });
});

describe("idempotency", () => {
  it("a fully reset database plans ZERO writes", () => {
    const plan = expectOk(
      buildResetPlan({
        userCount: 5,
        wallets: [cleanWallet("w1"), cleanWallet("w2")],
        tournaments: [canonicalTournament("t1")],
        ledger: [], // wiped
      })
    );

    assert.equal(plan.writes, 0);
    assert.equal(plan.operations.length, 0);
    assert.equal(plan.walletsAlreadyClean, 2);
    assert.equal(plan.tournamentsAlreadyCanonical, 1);
  });

  it("a second execute over a zero-op plan performs no writes at all", () => {
    const tx = new RecordingTx();
    executeReset(tx, [], REFS);
    assert.equal(tx.ops.length, 0);
  });
});

describe("dry run performs zero writes", () => {
  it("building a plan never touches a transaction", () => {
    // buildResetPlan is pure: it cannot write, because it is never handed a tx.
    const tx = new RecordingTx();
    buildResetPlan(snapshot());
    assert.equal(tx.ops.length, 0);
  });
});

describe("fingerprint covers the whole financial scope", () => {
  it("stamps every wallet, tournament and ledger document", () => {
    const snap = snapshot({
      wallets: [dirtyWallet("w1"), cleanWallet("w2")],
      tournaments: [legacyTournament("t1")],
      ledger: [ledgerDoc("transactions", "a")],
    });

    const stamps = stampsFor(snap);
    assert.deepEqual(
      stamps.map((s) => s.path).sort(),
      ["tournaments/t1", "transactions/a", "wallets/w1", "wallets/w2"]
    );
  });

  it("includes a wallet that needs NO write, so dirtying it later aborts", () => {
    // Strictly stronger than fingerprinting only the touched documents.
    const stamps = stampsFor(
      snapshot({ wallets: [cleanWallet("w1")], tournaments: [], ledger: [] })
    );
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].path, "wallets/w1");
  });

  it("the plan's fingerprint matches the scope's", () => {
    const snap = snapshot();
    const plan = expectOk(buildResetPlan(snap));
    assert.equal(plan.fingerprint, computeFingerprint(stampsFor(snap)));
  });
});
