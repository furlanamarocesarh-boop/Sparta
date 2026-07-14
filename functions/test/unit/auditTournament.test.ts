import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditTournamentDocument } from "../../src/audit/tournamentAudit.js";

const audit = (data: Record<string, unknown>) =>
  auditTournamentDocument("t1", data);

describe("shape classification — all pair combinations", () => {
  it("canonical only", () => {
    const finding = audit({ current_participants: 3, max_participants: 10 });
    assert.equal(finding.shape, "canonical-only");
    assert.equal(finding.blocking, false);
  });

  it("legacy only (what the deployed createTournament wrote)", () => {
    // Not blocking: the hardened backend reads it through the legacy fallback.
    // Flagging it as an anomaly would drown the real problems in noise.
    const finding = audit({ current_players: 2, max_players: 8 });
    assert.equal(finding.shape, "legacy-only");
    assert.equal(finding.blocking, false);
  });

  it("both pairs present and matching", () => {
    const finding = audit({
      current_participants: 5,
      max_participants: 20,
      current_players: 5,
      max_players: 20,
    });
    assert.equal(finding.shape, "both-matching");
    assert.equal(finding.blocking, false);
  });

  it("both pairs present but diverging — blocking", () => {
    // The backend refuses to guess which is true, so this must be fixed before
    // those tournaments can be joined.
    const diverging = audit({
      current_participants: 5,
      max_participants: 20,
      current_players: 5,
      max_players: 16,
    });
    assert.equal(diverging.shape, "both-diverging");
    assert.equal(diverging.blocking, true);

    const divergingCurrent = audit({
      current_participants: 7,
      max_participants: 20,
      current_players: 5,
      max_players: 20,
    });
    assert.equal(divergingCurrent.shape, "both-diverging");
    assert.equal(divergingCurrent.blocking, true);
  });

  it("partially filled pair — blocking", () => {
    // A max with no current is a corrupt write, not a legacy one.
    const finding = audit({ max_participants: 10 });
    assert.equal(finding.shape, "partial");
    assert.equal(finding.blocking, true);

    const legacyPartial = audit({ current_players: 1, max_participants: 10 });
    assert.equal(legacyPartial.shape, "partial");
    assert.equal(legacyPartial.blocking, true);
  });

  it("capacity completely missing — blocking", () => {
    const finding = audit({ current_participants: 0 });
    assert.equal(finding.shape, "capacity-missing");
    assert.equal(finding.blocking, true);

    const empty = audit({ name: "Copa sem capacidade" });
    assert.equal(empty.shape, "capacity-missing");
    assert.equal(empty.blocking, true);

    const nulled = audit({
      current_participants: 0,
      max_participants: null,
      max_players: null,
    });
    assert.equal(nulled.shape, "capacity-missing");
    assert.equal(nulled.blocking, true);
  });
});

describe("value problems", () => {
  it("detects a non-integer count — blocking", () => {
    const fractional = audit({
      current_participants: 1.5,
      max_participants: 10,
    });
    assert.deepEqual(fractional.valueProblems, ["non-integer"]);
    assert.equal(fractional.blocking, true);

    const stringy = audit({
      current_participants: 0,
      max_participants: "10",
    });
    assert.ok(stringy.valueProblems.includes("non-integer"));
    assert.equal(stringy.blocking, true);

    const notANumber = audit({
      current_participants: NaN,
      max_participants: 10,
    });
    assert.ok(notANumber.valueProblems.includes("non-integer"));
  });

  it("detects a negative count — blocking", () => {
    const finding = audit({
      current_participants: -1,
      max_participants: 10,
    });
    assert.deepEqual(finding.valueProblems, ["negative"]);
    assert.equal(finding.blocking, true);
  });

  it("detects current greater than max", () => {
    const finding = audit({
      current_participants: 11,
      max_participants: 10,
    });
    assert.deepEqual(finding.valueProblems, ["current-exceeds-max"]);
    // Reported but NOT blocking: jointournament already treats this as "full"
    // and refuses the join, which is the safe outcome rather than a crash.
    assert.equal(finding.blocking, false);
  });

  it("detects current greater than max on the legacy pair too", () => {
    const finding = audit({ current_players: 9, max_players: 8 });
    assert.deepEqual(finding.valueProblems, ["current-exceeds-max"]);
  });

  it("does not report current-exceeds-max when a value is already invalid", () => {
    // Avoid double-reporting: a non-integer is the real defect here.
    const finding = audit({
      current_participants: "many",
      max_participants: 10,
    });
    assert.deepEqual(finding.valueProblems, ["non-integer"]);
  });

  it("reports a full tournament as healthy (current == max)", () => {
    const finding = audit({
      current_participants: 10,
      max_participants: 10,
    });
    assert.deepEqual(finding.valueProblems, []);
    assert.equal(finding.blocking, false);
  });
});
