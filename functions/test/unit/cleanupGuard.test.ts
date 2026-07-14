import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLY_FLAG,
  CONFIRM_DELETE_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  containsIdArgument,
  decide,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "../../src/cleanup/guard.js";

/** All four signals required to write. */
const FULL_APPLY = [
  "--project",
  PRODUCTION_PROJECT_ID,
  APPLY_FLAG,
  CONFIRM_DELETE_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
];

const run = (argv: string[]) => decide(parseArgs(argv), argv);

describe("dry run is the default", () => {
  it("runs in dry-run with only --project", () => {
    const decision = run(["--project", PRODUCTION_PROJECT_ID]);
    assert.equal(decision.allowed, true);
    assert.equal(decision.allowed === true && decision.mode, "dry-run");
  });

  it("never writes unless every signal is present", () => {
    const decision = run(FULL_APPLY);
    assert.equal(decision.allowed, true);
    assert.equal(decision.allowed === true && decision.mode, "apply");
  });
});

describe("every flag is mandatory for apply", () => {
  it("refuses --apply without the delete confirmation", () => {
    const decision = run(["--project", PRODUCTION_PROJECT_ID, APPLY_FLAG]);
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "missing-delete-confirmation"
    );
  });

  it("refuses --apply without the confirmation phrase", () => {
    const decision = run([
      "--project",
      PRODUCTION_PROJECT_ID,
      APPLY_FLAG,
      CONFIRM_DELETE_FLAG,
    ]);
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "missing-confirmation-phrase"
    );
  });

  it("refuses a wrong or near-miss confirmation phrase", () => {
    for (const phrase of [
      "all_current_data_is_test",
      "ALL_CURRENT_DATA_IS_TESTS",
      "yes",
      "",
    ]) {
      const decision = run([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRM_DELETE_FLAG,
        CONFIRMATION_FLAG,
        phrase,
      ]);
      assert.equal(decision.allowed, false, `should refuse "${phrase}"`);
    }
  });

  it("refuses the confirmations WITHOUT --apply (no silent downgrade)", () => {
    // A half-typed write command must be refused, not quietly demoted to a dry
    // run that looks like it "worked".
    const decision = run([
      "--project",
      PRODUCTION_PROJECT_ID,
      CONFIRM_DELETE_FLAG,
      CONFIRMATION_FLAG,
      CONFIRMATION_PHRASE,
    ]);
    assert.equal(decision.allowed, false);
    assert.equal(
      decision.allowed === false && decision.reason,
      "missing-apply-flag"
    );
  });
});

describe("project validation", () => {
  it("refuses when no project is given (never uses .firebaserc)", () => {
    const decision = run([APPLY_FLAG, CONFIRM_DELETE_FLAG]);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, "missing-project");
  });

  it("refuses any project that is not sparta-battle — even for a dry run", () => {
    for (const project of [
      "demo-sparta-battle",
      "sparta-battle-8b1c1",
      "spartabattle",
      "Sparta-Battle",
    ]) {
      const decision = run(["--project", project]);
      assert.equal(decision.allowed, false, `should refuse "${project}"`);
      assert.equal(
        decision.allowed === false && decision.reason,
        "wrong-project"
      );
    }
  });

  it("refuses a wrong project even with every confirmation present", () => {
    const decision = run([
      "--project",
      "sparta-battle-8b1c1",
      APPLY_FLAG,
      CONFIRM_DELETE_FLAG,
      CONFIRMATION_FLAG,
      CONFIRMATION_PHRASE,
    ]);
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.reason, "wrong-project");
  });
});

describe("document ids are never accepted", () => {
  it("has no way to parse an id", () => {
    // A mistyped id is exactly how the wrong wallet gets deleted. Targets come
    // from the signature, never from argv.
    const args = parseArgs(["--wallet-id", "abc123"]);
    assert.equal(Object.prototype.hasOwnProperty.call(args, "walletId"), false);
  });

  it("refuses outright when an id-looking argument is passed", () => {
    for (const flag of ["--wallet-id", "--uid", "--doc", "--id"]) {
      assert.equal(containsIdArgument([flag, "abc"]), true);

      const decision = run(["--project", PRODUCTION_PROJECT_ID, flag, "abc"]);
      assert.equal(decision.allowed, false, `should refuse ${flag}`);
      assert.equal(
        decision.allowed === false && decision.reason,
        "ids-not-accepted"
      );
    }
  });
});
