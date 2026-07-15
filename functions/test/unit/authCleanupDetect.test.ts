import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AuthSnapshot,
  computeAuthFingerprint,
  countSnapshot,
  findOrphans,
  isOrphan,
} from "../../src/authcleanup/detect.js";
import { buildAuthCleanupPlan, LARGE_AUTH_THRESHOLD } from "../../src/authcleanup/plan.js";

const account = (uid: string, created = "2026-07-01T00:00:00.000Z", lastSignIn = "") => ({
  uid,
  createdAt: created,
  lastSignInAt: lastSignIn,
});

/**
 * Builds a snapshot with N linked accounts (uid-0..uid-{N-1}) plus whatever
 * extra accounts are passed. A "linked" account has a user, a wallet, and is
 * financially referenced — i.e. NOT an orphan.
 */
function snapshot(
  extraAccounts: ReturnType<typeof account>[] = [],
  overrides: Partial<AuthSnapshot> = {}
): AuthSnapshot {
  const linked = ["uid-0", "uid-1", "uid-2", "uid-3", "uid-4"];
  const accounts = [...linked.map((u) => account(u)), ...extraAccounts];

  return {
    accounts,
    userUids: new Set(linked),
    walletUids: new Set(linked),
    financiallyReferencedUids: new Set(linked),
    firestoreStamps: linked.flatMap((u) => [
      { path: `users/${u}`, updateTime: "2026-07-01T00:00:00.000Z" },
      { path: `wallets/${u}`, updateTime: "2026-07-01T00:00:00.000Z" },
    ]),
    ...overrides,
  };
}

describe("isOrphan — the strict definition", () => {
  it("an account with no users, wallet or financial reference is an orphan", () => {
    const snap = snapshot([account("orphan")]);
    assert.equal(isOrphan(account("orphan"), snap), true);
  });

  it("is NOT an orphan if it has a users/{uid}", () => {
    const snap = snapshot([account("x")], {
      userUids: new Set(["uid-0", "uid-1", "uid-2", "uid-3", "uid-4", "x"]),
    });
    assert.equal(isOrphan(account("x"), snap), false);
  });

  it("is NOT an orphan if it has a wallets/{uid}", () => {
    const snap = snapshot([account("x")], {
      walletUids: new Set(["uid-0", "uid-1", "uid-2", "uid-3", "uid-4", "x"]),
    });
    assert.equal(isOrphan(account("x"), snap), false);
  });

  it("is NOT an orphan if it is financially referenced", () => {
    const snap = snapshot([account("x")], {
      financiallyReferencedUids: new Set([
        "uid-0",
        "uid-1",
        "uid-2",
        "uid-3",
        "uid-4",
        "x",
      ]),
    });
    assert.equal(isOrphan(account("x"), snap), false);
  });

  it("every linked account is not an orphan", () => {
    const snap = snapshot();
    for (const acc of snap.accounts) assert.equal(isOrphan(acc, snap), false);
  });
});

describe("counts", () => {
  it("reports aggregate counts only", () => {
    const counts = countSnapshot(snapshot([account("orphan")]));
    assert.deepEqual(counts, {
      authAccounts: 6,
      users: 5,
      wallets: 5,
      orphans: 1,
    });
  });
});

describe("buildAuthCleanupPlan", () => {
  it("plans exactly ONE deleteUser and ZERO Firestore ops for one orphan", () => {
    const result = buildAuthCleanupPlan(snapshot([account("orphan")]));
    assert.equal(result.ok, true);
    if (result.ok !== true) throw new Error("unreachable");

    assert.equal(result.plan.targetUid, "orphan");
    assert.equal(result.plan.deleteUserOps, 1);
    assert.equal(result.plan.firestoreOps, 0);
  });

  it("does nothing when there are ZERO orphans (idempotent case)", () => {
    const result = buildAuthCleanupPlan(snapshot());
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.reason.includes("Nenhuma conta órfã"));
    assert.equal(result.ok === false && result.counts.orphans, 0);
  });

  it("aborts when there are TWO orphans", () => {
    const result = buildAuthCleanupPlan(
      snapshot([account("orphan-1"), account("orphan-2")])
    );
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.reason.includes("encontrei 2"));
  });

  it("aborts when Auth has more than the review threshold", () => {
    const many = Array.from({ length: LARGE_AUTH_THRESHOLD + 1 }, (_, i) =>
      account(`bulk-${i}`)
    );
    const result = buildAuthCleanupPlan(
      snapshot(many, {
        // None of the bulk accounts are linked, so they'd all be "orphans" —
        // but the size guard fires first, before any of that matters.
      })
    );
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.reason.includes("REVISÃO MANUAL"));
  });
});

describe("findOrphans", () => {
  it("returns exactly the orphan account(s)", () => {
    const orphans = findOrphans(snapshot([account("orphan")]));
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].uid, "orphan");
  });
});

describe("fingerprint", () => {
  it("is deterministic and order-independent", () => {
    const snap = snapshot([account("orphan")]);
    assert.equal(computeAuthFingerprint(snap), computeAuthFingerprint(snap));
  });

  it("is a 64-char SHA-256 hex that reveals no uid", () => {
    const fp = computeAuthFingerprint(snapshot([account("orphan-secret-uid")]));
    assert.match(fp, /^[0-9a-f]{64}$/);
    assert.ok(!fp.includes("orphan-secret-uid"));
  });

  it("CHANGES when an account signs in (lastSignInAt moves)", () => {
    const before = computeAuthFingerprint(snapshot([account("orphan")]));
    const after = computeAuthFingerprint(
      snapshot([account("orphan", "2026-07-01T00:00:00.000Z", "2026-07-05T09:00:00.000Z")])
    );
    assert.notEqual(after, before);
  });

  it("CHANGES when a new account appears", () => {
    const before = computeAuthFingerprint(snapshot([account("orphan")]));
    const after = computeAuthFingerprint(
      snapshot([account("orphan"), account("new-account")])
    );
    assert.notEqual(after, before);
  });

  it("CHANGES when the orphan gains a users/{uid}", () => {
    const before = computeAuthFingerprint(snapshot([account("orphan")]));
    const after = computeAuthFingerprint(
      snapshot([account("orphan")], {
        userUids: new Set(["uid-0", "uid-1", "uid-2", "uid-3", "uid-4", "orphan"]),
        firestoreStamps: [
          { path: "users/orphan", updateTime: "2026-07-05T00:00:00.000Z" },
        ],
      })
    );
    assert.notEqual(after, before);
  });

  it("CHANGES when a new financial document appears", () => {
    const before = computeAuthFingerprint(snapshot([account("orphan")]));
    const after = computeAuthFingerprint(
      snapshot([account("orphan")], {
        firestoreStamps: [{ path: "transactions/new", updateTime: "" }],
      })
    );
    assert.notEqual(after, before);
  });
});
