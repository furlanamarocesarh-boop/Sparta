import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DomainError } from "../../src/domain/errors.js";
import {
  isFull,
  newTournamentParticipantFields,
  participantIncrementUpdate,
  readParticipantCounts,
} from "../../src/domain/tournamentFields.js";

function assertFailedPrecondition(fn: () => unknown, message: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof DomainError, `${message}: not a DomainError`);
      assert.equal(error.code, "failed-precondition", `${message}: wrong code`);
      return true;
    },
    message
  );
}

describe("readParticipantCounts", () => {
  it("reads a canonical-only document", () => {
    const counts = readParticipantCounts({
      current_participants: 3,
      max_participants: 10,
    });
    assert.deepEqual(counts, { current: 3, max: 10 });
  });

  it("reads a legacy-only document (created by the deployed createTournament)", () => {
    // This is the exact document shape that the deployed jointournament could
    // not read — it saw max_participants as missing and rejected everyone.
    const counts = readParticipantCounts({
      current_players: 2,
      max_players: 8,
    });
    assert.deepEqual(counts, { current: 2, max: 8 });
  });

  it("reads a dual-field document when both pairs agree", () => {
    const counts = readParticipantCounts({
      current_participants: 5,
      max_participants: 20,
      current_players: 5,
      max_players: 20,
    });
    assert.deepEqual(counts, { current: 5, max: 20 });
  });

  it("fails safely when the two pairs disagree", () => {
    // We cannot know which is true. Guessing could oversell the tournament.
    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: 5,
          max_participants: 20,
          current_players: 5,
          max_players: 16,
        }),
      "mismatched max"
    );

    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: 7,
          max_participants: 20,
          current_players: 5,
          max_players: 20,
        }),
      "mismatched current"
    );
  });

  it("never treats a missing capacity as zero", () => {
    // Defaulting to 0 would make every tournament look full; defaulting to
    // Infinity would oversell it. Both are wrong — this must fail loudly.
    assertFailedPrecondition(
      () => readParticipantCounts({ current_participants: 0 }),
      "missing max"
    );
    assertFailedPrecondition(() => readParticipantCounts({}), "empty doc");
    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: 0,
          max_participants: null,
        }),
      "null max"
    );
  });

  it("rejects a negative capacity or count", () => {
    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: 0,
          max_participants: -5,
        }),
      "negative max"
    );
    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: -1,
          max_participants: 10,
        }),
      "negative current"
    );
  });

  it("rejects a zero capacity", () => {
    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: 0,
          max_participants: 0,
        }),
      "zero max"
    );
  });

  it("rejects non-integer participant counts", () => {
    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: 1.5,
          max_participants: 10,
        }),
      "fractional current"
    );
    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: 0,
          max_participants: "10",
        }),
      "string max"
    );
    assertFailedPrecondition(
      () =>
        readParticipantCounts({
          current_participants: NaN,
          max_participants: 10,
        }),
      "NaN current"
    );
  });
});

describe("isFull", () => {
  it("reports an available tournament", () => {
    assert.equal(isFull({ current: 9, max: 10 }), false);
    assert.equal(isFull({ current: 0, max: 1 }), false);
  });

  it("reports a full tournament", () => {
    assert.equal(isFull({ current: 10, max: 10 }), true);
  });

  it("treats an over-filled tournament as full rather than admitting more", () => {
    assert.equal(isFull({ current: 11, max: 10 }), true);
  });
});

describe("participantIncrementUpdate", () => {
  it("advances both the canonical and the legacy counter together", () => {
    assert.deepEqual(participantIncrementUpdate({ current: 4, max: 10 }), {
      current_participants: 5,
      current_players: 5,
    });
  });
});

describe("newTournamentParticipantFields", () => {
  it("writes both pairs with identical values", () => {
    assert.deepEqual(newTournamentParticipantFields(16), {
      current_participants: 0,
      max_participants: 16,
      current_players: 0,
      max_players: 16,
    });
  });

  it("produces a document that readParticipantCounts can read", () => {
    // Round-trip: what createTournament writes, jointournament must be able to
    // read. This is precisely the invariant the deployed code violated.
    const doc = newTournamentParticipantFields(16);
    assert.deepEqual(readParticipantCounts(doc), { current: 0, max: 16 });
  });
});
