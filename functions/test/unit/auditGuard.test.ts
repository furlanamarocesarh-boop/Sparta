import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decide,
  parseArgs,
  PRODUCTION_CONFIRM_FLAG,
  PRODUCTION_PROJECT_ID,
} from "../../src/audit/guard.js";

const NO_EMULATOR = {};
const WITH_EMULATOR = { firestoreEmulatorHost: "127.0.0.1:8080" };

describe("parseArgs", () => {
  it("parses --project in both forms", () => {
    assert.equal(parseArgs(["--project", "demo-x"]).project, "demo-x");
    assert.equal(parseArgs(["--project=demo-x"]).project, "demo-x");
  });

  it("defaults every switch to the safe value", () => {
    const args = parseArgs([]);
    assert.equal(args.project, undefined);
    assert.equal(args.confirmProduction, false);
    assert.equal(args.showIds, false);
  });

  it("recognizes the confirmation flag and --show-ids", () => {
    const args = parseArgs([
      "--project",
      PRODUCTION_PROJECT_ID,
      PRODUCTION_CONFIRM_FLAG,
      "--show-ids",
    ]);
    assert.equal(args.confirmProduction, true);
    assert.equal(args.showIds, true);
  });

  it("does not accept a lookalike confirmation flag", () => {
    // Only the exact long flag counts. A near-miss must NOT confirm.
    const args = parseArgs(["--project", PRODUCTION_PROJECT_ID, "--confirm"]);
    assert.equal(args.confirmProduction, false);
  });
});

describe("decide — refuses by default", () => {
  it("refuses when no project is given (never falls back to .firebaserc)", () => {
    const decision = decide(parseArgs([]), NO_EMULATOR);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, "missing-project");
  });

  it("refuses production without the explicit confirmation flag", () => {
    const decision = decide(
      parseArgs(["--project", PRODUCTION_PROJECT_ID]),
      NO_EMULATOR
    );
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "unconfirmed-production"
    );
  });

  it("refuses a project id that is neither production nor demo-*", () => {
    const decision = decide(
      parseArgs(["--project", "sparta-battle-8b1c1", PRODUCTION_CONFIRM_FLAG]),
      NO_EMULATOR
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, "unknown-project");
  });

  it("refuses a near-miss of the production id even when confirmed", () => {
    // A typo must not silently audit some other project.
    for (const wrong of ["Sparta-Battle", "sparta_battle", "spartabattle"]) {
      const decision = decide(
        parseArgs(["--project", wrong, PRODUCTION_CONFIRM_FLAG]),
        NO_EMULATOR
      );
      assert.equal(decision.allowed, false, `should refuse "${wrong}"`);
    }
  });

  it("refuses a demo project when the emulator is not running", () => {
    const decision = decide(
      parseArgs(["--project", "demo-sparta-battle"]),
      NO_EMULATOR
    );
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "emulator-not-running"
    );
  });
});

describe("decide — allows only the two intended paths", () => {
  it("allows the emulator with a demo-* project", () => {
    const decision = decide(
      parseArgs(["--project", "demo-sparta-battle"]),
      WITH_EMULATOR
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.allowed === true && decision.target, "emulator");
  });

  it("allows production ONLY with the exact project id and confirmation", () => {
    const decision = decide(
      parseArgs(["--project", PRODUCTION_PROJECT_ID, PRODUCTION_CONFIRM_FLAG]),
      NO_EMULATOR
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.allowed === true && decision.target, "production");
  });

  it("the confirmation flag alone, without the project, is not enough", () => {
    const decision = decide(parseArgs([PRODUCTION_CONFIRM_FLAG]), NO_EMULATOR);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, "missing-project");
  });
});
