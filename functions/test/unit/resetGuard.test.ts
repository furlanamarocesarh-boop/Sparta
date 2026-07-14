import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLY_FLAG,
  CONFIRM_RESET_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  containsIdArgument,
  decide,
  FINGERPRINT_FLAG,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "../../src/reset/guard.js";

const FP = "a".repeat(64);

const run = (argv: string[]) => decide(parseArgs(argv), argv);

const fullApply = (overrides: string[] = []) => [
  "--project",
  PRODUCTION_PROJECT_ID,
  APPLY_FLAG,
  CONFIRM_RESET_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  FINGERPRINT_FLAG,
  FP,
  ...overrides,
];

describe("dry run is the default", () => {
  it("runs dry with only --project", () => {
    const decision = run(["--project", PRODUCTION_PROJECT_ID]);
    assert.equal(decision.allowed, true);
    assert.equal(decision.allowed === true && decision.mode, "dry-run");
  });

  it("allows apply only with all five signals", () => {
    const decision = run(fullApply());
    assert.equal(decision.allowed, true);
    assert.equal(decision.allowed === true && decision.mode, "apply");
    assert.equal(
      decision.allowed === true && decision.mode === "apply"
        ? decision.expectedFingerprint
        : undefined,
      FP
    );
  });
});

describe("every apply flag is mandatory", () => {
  it("refuses --apply without the reset confirmation", () => {
    const decision = run(["--project", PRODUCTION_PROJECT_ID, APPLY_FLAG]);
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "missing-reset-confirmation"
    );
  });

  it("refuses without the confirmation phrase", () => {
    const decision = run([
      "--project",
      PRODUCTION_PROJECT_ID,
      APPLY_FLAG,
      CONFIRM_RESET_FLAG,
    ]);
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "missing-confirmation-phrase"
    );
  });

  it("refuses a wrong or near-miss phrase", () => {
    for (const phrase of [
      "reset_all_current_test_financial_data",
      "RESET_ALL_CURRENT_TEST_FINANCIAL_DAT",
      "yes",
    ]) {
      const decision = run([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRM_RESET_FLAG,
        CONFIRMATION_FLAG,
        phrase,
        FINGERPRINT_FLAG,
        FP,
      ]);
      assert.equal(decision.allowed, false, `should refuse "${phrase}"`);
    }
  });

  it("refuses without the fingerprint", () => {
    const decision = run([
      "--project",
      PRODUCTION_PROJECT_ID,
      APPLY_FLAG,
      CONFIRM_RESET_FLAG,
      CONFIRMATION_FLAG,
      CONFIRMATION_PHRASE,
    ]);
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "missing-fingerprint"
    );
  });

  it("refuses a malformed fingerprint", () => {
    for (const bad of ["abc", "z".repeat(64), "A".repeat(64), "a".repeat(63)]) {
      const decision = run([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRM_RESET_FLAG,
        CONFIRMATION_FLAG,
        CONFIRMATION_PHRASE,
        FINGERPRINT_FLAG,
        bad,
      ]);
      assert.equal(decision.allowed, false, `should refuse "${bad}"`);
      assert.equal(
        decision.allowed === false && decision.reason,
        "malformed-fingerprint"
      );
    }
  });

  it("refuses confirmations WITHOUT --apply (no silent downgrade to dry-run)", () => {
    const decision = run([
      "--project",
      PRODUCTION_PROJECT_ID,
      CONFIRM_RESET_FLAG,
      CONFIRMATION_FLAG,
      CONFIRMATION_PHRASE,
      FINGERPRINT_FLAG,
      FP,
    ]);
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "missing-apply-flag"
    );
  });
});

describe("project validation", () => {
  it("refuses without a project (never uses .firebaserc)", () => {
    const decision = run([APPLY_FLAG]);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, "missing-project");
  });

  it("refuses any other project — even for a dry run", () => {
    for (const project of [
      "demo-sparta-battle",
      "sparta-battle-8b1c1",
      "spartabattle",
    ]) {
      const decision = run(["--project", project]);
      assert.equal(decision.allowed, false, project);
      assert.equal(
        decision.allowed === false && decision.reason,
        "wrong-project"
      );
    }
  });

  it("refuses a wrong project even with every other signal present", () => {
    const argv = fullApply();
    argv[1] = "sparta-battle-8b1c1";
    const decision = run(argv);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, "wrong-project");
  });
});

describe("document ids are never accepted", () => {
  it("refuses any id-looking argument", () => {
    for (const flag of ["--wallet-id", "--uid", "--doc", "--id"]) {
      assert.equal(containsIdArgument([flag, "x"]), true);

      const decision = run(["--project", PRODUCTION_PROJECT_ID, flag, "x"]);
      assert.equal(decision.allowed, false, flag);
      assert.equal(
        decision.allowed === false && decision.reason,
        "ids-not-accepted"
      );
    }
  });
});
