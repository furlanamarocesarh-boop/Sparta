import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DomainError } from "../../src/domain/errors.js";
import { inspectStoredPrize } from "../../src/domain/operations.js";
import { hasValidPublishedCredentials } from "../../src/domain/room.js";
import {
  assertExactPayload,
  checkRegistration,
  checkStartPreconditions,
  decideCompletedReplay,
  documentPath,
  gateSettlementStatus,
  gateStartStatus,
  normalizeTournamentId,
  normalizeWinnerUid,
  prizeTransactionId,
  registrationId,
} from "../../src/domain/settlement.js";

/**
 * Pure settlement rules. These are the exact functions `index.ts` composes
 * inside its Firestore transactions, so a test here tests the shipped decision,
 * not a paraphrase. What needs a database (atomicity, optimistic-retry
 * idempotency) is covered by the emulator suites.
 */

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DomainError, "not a DomainError");
    assert.equal(error.code, code);
    return true;
  });
}

// A stand-in for a Firestore DocumentReference: only `.path` is read.
const ref = (path: string) => ({ path });

describe("assertExactPayload", () => {
  it("rejects non-objects and arrays with invalid-argument", () => {
    assertCode(() => assertExactPayload(null, ["tournamentid"]), "invalid-argument");
    assertCode(() => assertExactPayload(undefined, ["tournamentid"]), "invalid-argument");
    assertCode(() => assertExactPayload("x", ["tournamentid"]), "invalid-argument");
    assertCode(() => assertExactPayload([], ["tournamentid"]), "invalid-argument");
  });

  it("rejects ANY key outside the allowlist (amount/externalid/etc.)", () => {
    for (const extra of ["amount", "externalid", "prize", "transactionid", "status", "winner_ref"]) {
      assertCode(
        () => assertExactPayload({ tournamentid: "t", winneruid: "w", [extra]: 1 }, ["tournamentid", "winneruid"]),
        "invalid-argument"
      );
    }
  });

  it("accepts exactly the allowed keys", () => {
    assert.doesNotThrow(() => assertExactPayload({ tournamentid: "t" }, ["tournamentid"]));
    assert.doesNotThrow(() =>
      assertExactPayload({ tournamentid: "t", winneruid: "w" }, ["tournamentid", "winneruid"])
    );
    // A subset is fine here — the missing key is caught by normalization.
    assert.doesNotThrow(() => assertExactPayload({}, ["tournamentid"]));
  });
});

describe("identifier normalization", () => {
  it("trims and returns a valid id", () => {
    assert.equal(normalizeTournamentId("  t1 "), "t1");
    assert.equal(normalizeWinnerUid(" u1 "), "u1");
  });

  it("rejects empty, slash, and over-long ids with invalid-argument", () => {
    assertCode(() => normalizeTournamentId(""), "invalid-argument");
    assertCode(() => normalizeTournamentId("   "), "invalid-argument");
    assertCode(() => normalizeTournamentId("a/b"), "invalid-argument");
    assertCode(() => normalizeTournamentId("x".repeat(201)), "invalid-argument");
    assertCode(() => normalizeWinnerUid(""), "invalid-argument");
    assertCode(() => normalizeWinnerUid("a/b"), "invalid-argument");
  });
});

describe("documentPath / deterministic ids", () => {
  it("extracts a reference path and rejects non-references", () => {
    assert.equal(documentPath(ref("users/u1")), "users/u1");
    assert.equal(documentPath(null), null);
    assert.equal(documentPath("users/u1"), null);
    assert.equal(documentPath({ nope: 1 }), null);
  });

  it("derives the canonical registration and prize ids", () => {
    assert.equal(registrationId("u1", "t1"), "u1_t1");
    assert.equal(prizeTransactionId("t1"), "prize_t1");
  });
});

describe("gateStartStatus", () => {
  it("routes open -> start, in_progress -> replay, else fail", () => {
    assert.equal(gateStartStatus("open").kind, "start");
    assert.equal(gateStartStatus("in_progress").kind, "replay");
    assert.equal(gateStartStatus("completed").kind, "fail");
    assert.equal(gateStartStatus("weird").kind, "fail");
  });
});

describe("checkStartPreconditions", () => {
  const base = {
    tournamentid: "t1",
    roomExists: true,
    roomId: "ROOM-1",
    roomPassword: "pw-1",
    roomTournamentRefPath: "tournaments/t1",
    prize: 100,
  };

  it("passes when room + prize are valid", () => {
    assert.equal(checkStartPreconditions(base).ok, true);
  });

  it("fails when the room is missing or invalid", () => {
    assert.equal(checkStartPreconditions({ ...base, roomExists: false }).ok, false);
    assert.equal(checkStartPreconditions({ ...base, roomId: "" }).ok, false);
    assert.equal(checkStartPreconditions({ ...base, roomPassword: "" }).ok, false);
  });

  it("fails when the room points at another tournament", () => {
    assert.equal(
      checkStartPreconditions({ ...base, roomTournamentRefPath: "tournaments/other" }).ok,
      false
    );
    assert.equal(checkStartPreconditions({ ...base, roomTournamentRefPath: null }).ok, false);
  });

  it("fails when the prize is absent, zero, negative or invalid", () => {
    assert.equal(checkStartPreconditions({ ...base, prize: undefined }).ok, false);
    assert.equal(checkStartPreconditions({ ...base, prize: 0 }).ok, false);
    assert.equal(checkStartPreconditions({ ...base, prize: -5 }).ok, false);
    assert.equal(checkStartPreconditions({ ...base, prize: 1.234 }).ok, false);
    assert.equal(checkStartPreconditions({ ...base, prize: "100" }).ok, false);
  });
});

describe("gateSettlementStatus", () => {
  it("routes completed -> replay", () => {
    assert.equal(gateSettlementStatus("completed", true, true).kind, "replay");
  });

  it("routes in_progress with a clean slate -> settle", () => {
    assert.equal(gateSettlementStatus("in_progress", false, false).kind, "settle");
  });

  it("fails a partial in_progress (only result OR only transaction)", () => {
    assert.equal(gateSettlementStatus("in_progress", true, false).kind, "fail");
    assert.equal(gateSettlementStatus("in_progress", false, true).kind, "fail");
    assert.equal(gateSettlementStatus("in_progress", true, true).kind, "fail");
  });

  it("fails open and unknown statuses", () => {
    assert.equal(gateSettlementStatus("open", false, false).kind, "fail");
    assert.equal(gateSettlementStatus("weird", false, false).kind, "fail");
  });
});

describe("checkRegistration", () => {
  const base = {
    exists: true,
    status: "registered",
    userRefPath: "users/w1",
    tournamentRefPath: "tournaments/t1",
    winneruid: "w1",
    tournamentid: "t1",
  };

  it("passes a confirmed registration that matches winner + tournament", () => {
    assert.equal(checkRegistration(base).ok, true);
  });

  it("fails when missing, unconfirmed, or mismatched", () => {
    assert.equal(checkRegistration({ ...base, exists: false }).ok, false);
    assert.equal(checkRegistration({ ...base, status: "pending" }).ok, false);
    assert.equal(checkRegistration({ ...base, userRefPath: "users/other" }).ok, false);
    assert.equal(checkRegistration({ ...base, tournamentRefPath: "tournaments/other" }).ok, false);
  });
});

describe("decideCompletedReplay", () => {
  const equivalent = {
    winneruid: "w1",
    tournamentid: "t1",
    resultExists: true,
    txExists: true,
    result: {
      winner_uid: "w1",
      winner_ref: "users/w1",
      registration_ref: "registrations/w1_t1",
      transaction_ref: "transactions/prize_t1",
      prize: 40,
    },
    tx: {
      category: "prize",
      external_id: "prize_t1",
      user_ref: "users/w1",
      tournament_ref: "tournaments/t1",
      amount: 40,
    },
  };

  it("returns ok for a fully equivalent completed state", () => {
    assert.equal(decideCompletedReplay(equivalent).ok, true);
  });

  it("fails a partial state (missing result or transaction)", () => {
    assert.equal(decideCompletedReplay({ ...equivalent, resultExists: false, result: null }).ok, false);
    assert.equal(decideCompletedReplay({ ...equivalent, txExists: false, tx: null }).ok, false);
  });

  it("fails when the persisted winner differs", () => {
    const r = decideCompletedReplay({
      ...equivalent,
      result: { ...equivalent.result, winner_uid: "w2" },
    });
    assert.equal(r.ok, false);
  });

  it("fails on any reference or amount divergence", () => {
    assert.equal(
      decideCompletedReplay({ ...equivalent, tx: { ...equivalent.tx, tournament_ref: "tournaments/other" } }).ok,
      false
    );
    assert.equal(
      decideCompletedReplay({ ...equivalent, result: { ...equivalent.result, transaction_ref: "transactions/other" } }).ok,
      false
    );
    assert.equal(
      decideCompletedReplay({ ...equivalent, tx: { ...equivalent.tx, amount: 41 } }).ok,
      false
    );
    assert.equal(
      decideCompletedReplay({ ...equivalent, tx: { ...equivalent.tx, category: "deposit" } }).ok,
      false
    );
  });
});

describe("inspectStoredPrize", () => {
  it("accepts a valid strictly-positive prize and returns centavos", () => {
    const r = inspectStoredPrize(40);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.centavos, 4000);
  });

  it("rejects missing, zero, negative, 3-decimal and above-limit", () => {
    assert.equal(inspectStoredPrize(undefined).ok, false);
    assert.equal(inspectStoredPrize(null).ok, false);
    assert.equal(inspectStoredPrize(0).ok, false);
    assert.equal(inspectStoredPrize(-1).ok, false);
    assert.equal(inspectStoredPrize(1.234).ok, false);
    assert.equal(inspectStoredPrize("40").ok, false);
    assert.equal(inspectStoredPrize(10_000_000).ok, false); // > R$1.000.000
  });
});

describe("hasValidPublishedCredentials", () => {
  it("accepts non-empty, bounded, control-char-free strings", () => {
    assert.equal(hasValidPublishedCredentials("ROOM-1", "pw-1"), true);
  });

  it("rejects empty, non-string, over-long, or control-char fields", () => {
    assert.equal(hasValidPublishedCredentials("", "pw"), false);
    assert.equal(hasValidPublishedCredentials("room", ""), false);
    assert.equal(hasValidPublishedCredentials(123, "pw"), false);
    assert.equal(hasValidPublishedCredentials("x".repeat(201), "pw"), false);
    assert.equal(hasValidPublishedCredentials("room\n", "pw"), false);
  });
});
