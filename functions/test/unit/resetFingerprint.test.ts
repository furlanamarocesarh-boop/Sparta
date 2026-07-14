import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeFingerprint,
  DocumentStamp,
} from "../../src/reset/fingerprint.js";
import { buildResetPlan, ResetSnapshot } from "../../src/reset/plan.js";

const stamp = (path: string, updateTime: string): DocumentStamp => ({
  path,
  updateTime,
});

const BASE: DocumentStamp[] = [
  stamp("wallets/w1", "2026-07-01T00:00:00.000Z"),
  stamp("tournaments/t1", "2026-07-01T00:00:00.000Z"),
  stamp("transactions/a", "2026-07-01T00:00:00.000Z"),
];

describe("determinism", () => {
  it("is stable across calls", () => {
    assert.equal(computeFingerprint(BASE), computeFingerprint(BASE));
  });

  it("does not depend on the order Firestore returns documents in", () => {
    // Firestore may return documents in any order; an order-dependent hash would
    // abort valid applies at random.
    const shuffled = [BASE[2], BASE[0], BASE[1]];
    assert.equal(computeFingerprint(BASE), computeFingerprint(shuffled));
  });

  it("is a 64-character lowercase SHA-256 hex digest", () => {
    assert.match(computeFingerprint(BASE), /^[0-9a-f]{64}$/);
  });

  it("reveals no path or id — only the digest comes out", () => {
    const fingerprint = computeFingerprint(BASE);
    assert.ok(!fingerprint.includes("w1"));
    assert.ok(!fingerprint.includes("wallets"));
    assert.ok(!fingerprint.includes("transactions"));
  });
});

describe("any change to any document changes the fingerprint", () => {
  const base = computeFingerprint(BASE);

  it("changes when a document is MODIFIED (updateTime moves)", () => {
    const modified = [
      stamp("wallets/w1", "2026-07-02T00:00:00.000Z"), // touched later
      BASE[1],
      BASE[2],
    ];
    assert.notEqual(computeFingerprint(modified), base);
  });

  it("changes when a document is ADDED", () => {
    const added = [...BASE, stamp("transactions/new", "2026-07-02T00:00:00.000Z")];
    assert.notEqual(computeFingerprint(added), base);
  });

  it("changes when a document is REMOVED", () => {
    const removed = [BASE[0], BASE[1]];
    assert.notEqual(computeFingerprint(removed), base);
  });

  it("changes when a document is REPLACED by another with the same time", () => {
    const replaced = [
      BASE[0],
      BASE[1],
      stamp("transactions/b", "2026-07-01T00:00:00.000Z"),
    ];
    assert.notEqual(computeFingerprint(replaced), base);
  });

  it("is empty-safe", () => {
    assert.match(computeFingerprint([]), /^[0-9a-f]{64}$/);
    assert.notEqual(computeFingerprint([]), base);
  });
});

describe("plan fingerprint reacts to real snapshot changes", () => {
  const snapshot = (overrides: Partial<ResetSnapshot> = {}): ResetSnapshot => ({
    userCount: 5,
    wallets: [
      {
        id: "w1",
        data: { balance: 70 },
        updateTime: "2026-07-01T00:00:00.000Z",
        userExists: true,
      },
    ],
    tournaments: [
      {
        id: "t1",
        data: { current_players: 1, max_players: 16 },
        updateTime: "2026-07-01T00:00:00.000Z",
      },
    ],
    ledger: [
      {
        collection: "transactions",
        id: "a",
        updateTime: "2026-07-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  });

  function fingerprintOf(snap: ResetSnapshot): string {
    const result = buildResetPlan(snap);
    assert.equal(result.ok, true);
    if (result.ok !== true) throw new Error("unreachable");
    return result.plan.fingerprint;
  }

  it("a NEW transaction after the dry run changes the fingerprint", () => {
    const before = fingerprintOf(snapshot());

    const after = fingerprintOf(
      snapshot({
        ledger: [
          {
            collection: "transactions",
            id: "a",
            updateTime: "2026-07-01T00:00:00.000Z",
          },
          {
            collection: "transactions",
            id: "brand-new",
            updateTime: "2026-07-02T10:00:00.000Z",
          },
        ],
      })
    );

    assert.notEqual(after, before);
  });

  it("a REMOVED transaction after the dry run changes the fingerprint", () => {
    const before = fingerprintOf(snapshot());
    const after = fingerprintOf(snapshot({ ledger: [] }));
    assert.notEqual(after, before);
  });

  it("an EDITED wallet after the dry run changes the fingerprint", () => {
    const before = fingerprintOf(snapshot());
    const after = fingerprintOf(
      snapshot({
        wallets: [
          {
            id: "w1",
            data: { balance: 999 },
            updateTime: "2026-07-02T10:00:00.000Z",
            userExists: true,
          },
        ],
      })
    );
    assert.notEqual(after, before);
  });
});
