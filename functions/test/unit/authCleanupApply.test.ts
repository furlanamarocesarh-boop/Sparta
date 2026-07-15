import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyOrphanDeletion } from "../../src/authcleanup/apply.js";
import { AuthSnapshot, computeAuthFingerprint } from "../../src/authcleanup/detect.js";

const account = (uid: string, created = "2026-07-01T00:00:00.000Z", lastSignIn = "") => ({
  uid,
  createdAt: created,
  lastSignInAt: lastSignIn,
});

function snapshotWithOrphan(orphanUid = "orphan"): AuthSnapshot {
  const linked = ["uid-0", "uid-1", "uid-2", "uid-3", "uid-4"];
  return {
    accounts: [...linked.map((u) => account(u)), account(orphanUid)],
    userUids: new Set(linked),
    walletUids: new Set(linked),
    financiallyReferencedUids: new Set(linked),
    firestoreStamps: linked.map((u) => ({
      path: `users/${u}`,
      updateTime: "2026-07-01T00:00:00.000Z",
    })),
  };
}

function snapshotNoOrphans(): AuthSnapshot {
  const linked = ["uid-0", "uid-1", "uid-2", "uid-3", "uid-4"];
  return {
    accounts: linked.map((u) => account(u)),
    userUids: new Set(linked),
    walletUids: new Set(linked),
    financiallyReferencedUids: new Set(linked),
    firestoreStamps: [],
  };
}

/** Records deleteUser calls; a Firestore write surface is deliberately absent. */
class AuthRecorder {
  readonly deleted: string[] = [];
  deleteUser = async (uid: string): Promise<void> => {
    this.deleted.push(uid);
  };
}

describe("apply — exactly one deleteUser, no Firestore writes", () => {
  it("deletes exactly the single orphan when the fingerprint matches", async () => {
    const snap = snapshotWithOrphan();
    const rec = new AuthRecorder();

    const outcome = await applyOrphanDeletion(
      snap,
      computeAuthFingerprint(snap),
      rec.deleteUser
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok === true && outcome.deletedCount, 1);
    assert.deepEqual(rec.deleted, ["orphan"]);
  });

  it("has no Firestore write capability at all", () => {
    // applyOrphanDeletion's signature accepts only a deleteUser callback. There
    // is no parameter through which a Firestore write could be requested — the
    // read-only-over-Firestore guarantee is structural, not a convention.
    assert.equal(applyOrphanDeletion.length, 3); // (fresh, fingerprint, deleteUser)
  });
});

describe("apply — refusals never delete", () => {
  it("does NOT delete when the fingerprint does not match", async () => {
    const snap = snapshotWithOrphan();
    const rec = new AuthRecorder();

    const outcome = await applyOrphanDeletion(snap, "0".repeat(64), rec.deleteUser);

    assert.equal(outcome.ok, false);
    assert.ok(outcome.ok === false && outcome.reason.includes("fingerprint"));
    assert.deepEqual(rec.deleted, [], "nothing may be deleted on a mismatch");
  });

  it("does NOT delete when a login moved lastSignInAt after the dry-run", async () => {
    const before = snapshotWithOrphan();
    const dryRunFingerprint = computeAuthFingerprint(before);

    // The orphan signed in between dry-run and apply.
    const after = snapshotWithOrphan();
    const mutated: AuthSnapshot = {
      ...after,
      accounts: after.accounts.map((a) =>
        a.uid === "orphan"
          ? account("orphan", a.createdAt, "2026-07-09T12:00:00.000Z")
          : a
      ),
    };

    const rec = new AuthRecorder();
    const outcome = await applyOrphanDeletion(
      mutated,
      dryRunFingerprint,
      rec.deleteUser
    );

    assert.equal(outcome.ok, false);
    assert.deepEqual(rec.deleted, []);
  });

  it("does NOT delete when there are zero orphans (idempotent)", async () => {
    const snap = snapshotNoOrphans();
    const rec = new AuthRecorder();

    const outcome = await applyOrphanDeletion(
      snap,
      computeAuthFingerprint(snap),
      rec.deleteUser
    );

    assert.equal(outcome.ok, false);
    assert.ok(outcome.ok === false && outcome.reason.includes("Nenhuma conta órfã"));
    assert.deepEqual(rec.deleted, []);
  });

  it("does NOT delete when two orphans exist", async () => {
    const linked = ["uid-0", "uid-1"];
    const snap: AuthSnapshot = {
      accounts: [...linked.map((u) => account(u)), account("o1"), account("o2")],
      userUids: new Set(linked),
      walletUids: new Set(linked),
      financiallyReferencedUids: new Set(linked),
      firestoreStamps: [],
    };

    const rec = new AuthRecorder();
    const outcome = await applyOrphanDeletion(
      snap,
      computeAuthFingerprint(snap),
      rec.deleteUser
    );

    assert.equal(outcome.ok, false);
    assert.deepEqual(rec.deleted, []);
  });

  it("does NOT delete when the orphan gained a users/{uid} after the dry-run", async () => {
    const before = snapshotWithOrphan();
    const dryRunFingerprint = computeAuthFingerprint(before);

    // The account now has a users doc, so it is no longer an orphan.
    const after: AuthSnapshot = {
      ...before,
      userUids: new Set([...before.userUids, "orphan"]),
      firestoreStamps: [
        ...before.firestoreStamps,
        { path: "users/orphan", updateTime: "2026-07-09T00:00:00.000Z" },
      ],
    };

    const rec = new AuthRecorder();
    const outcome = await applyOrphanDeletion(after, dryRunFingerprint, rec.deleteUser);

    assert.equal(outcome.ok, false);
    assert.deepEqual(rec.deleted, []);
  });
});

describe("apply — a failed delete is never a success", () => {
  it("returns failure and does not claim a deletion when deleteUser throws", async () => {
    const snap = snapshotWithOrphan();
    let called = 0;
    const failing = async (): Promise<void> => {
      called++;
      throw new Error("auth/internal-error");
    };

    const outcome = await applyOrphanDeletion(
      snap,
      computeAuthFingerprint(snap),
      failing
    );

    assert.equal(called, 1);
    assert.equal(outcome.ok, false);
    assert.ok(outcome.ok === false && outcome.reason.includes("falhou"));
  });
});
