import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLY_FLAG,
  CONFIRM_DELETE_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  containsIdentifierArgument,
  decide,
  FINGERPRINT_FLAG,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "../../src/authcleanup/guard.js";

const FP = "b".repeat(64);
const run = (argv: string[]) => decide(parseArgs(argv), argv);

const fullApply = () => [
  "--project",
  PRODUCTION_PROJECT_ID,
  APPLY_FLAG,
  CONFIRM_DELETE_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  FINGERPRINT_FLAG,
  FP,
];

describe("dry run is the default", () => {
  it("runs dry with only --project", () => {
    const d = run(["--project", PRODUCTION_PROJECT_ID]);
    assert.equal(d.allowed, true);
    assert.equal(d.allowed === true && d.mode, "dry-run");
  });

  it("allows apply only with all five signals", () => {
    const d = run(fullApply());
    assert.equal(d.allowed, true);
    assert.equal(d.allowed === true && d.mode, "apply");
    assert.equal(
      d.allowed === true && d.mode === "apply" ? d.expectedFingerprint : "",
      FP
    );
  });
});

describe("every apply flag is mandatory", () => {
  it("refuses --apply without the delete confirmation", () => {
    const d = run(["--project", PRODUCTION_PROJECT_ID, APPLY_FLAG]);
    assert.equal(d.allowed, false);
    assert.equal(
      d.allowed === false && d.reason,
      "missing-delete-confirmation"
    );
  });

  it("refuses without the confirmation phrase", () => {
    const d = run([
      "--project",
      PRODUCTION_PROJECT_ID,
      APPLY_FLAG,
      CONFIRM_DELETE_FLAG,
    ]);
    assert.equal(d.allowed, false);
    assert.equal(
      d.allowed === false && d.reason,
      "missing-confirmation-phrase"
    );
  });

  it("refuses a wrong phrase", () => {
    for (const phrase of [
      "delete_single_orphan_test_auth",
      "DELETE_SINGLE_ORPHAN_TEST_AUT",
      "sim",
    ]) {
      const d = run([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRM_DELETE_FLAG,
        CONFIRMATION_FLAG,
        phrase,
        FINGERPRINT_FLAG,
        FP,
      ]);
      assert.equal(d.allowed, false, phrase);
    }
  });

  it("refuses without the fingerprint", () => {
    const d = run([
      "--project",
      PRODUCTION_PROJECT_ID,
      APPLY_FLAG,
      CONFIRM_DELETE_FLAG,
      CONFIRMATION_FLAG,
      CONFIRMATION_PHRASE,
    ]);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "missing-fingerprint");
  });

  it("refuses a malformed fingerprint", () => {
    for (const bad of ["abc", "z".repeat(64), "B".repeat(64), "b".repeat(63)]) {
      const d = run([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRM_DELETE_FLAG,
        CONFIRMATION_FLAG,
        CONFIRMATION_PHRASE,
        FINGERPRINT_FLAG,
        bad,
      ]);
      assert.equal(d.allowed, false, bad);
      assert.equal(d.allowed === false && d.reason, "malformed-fingerprint");
    }
  });

  it("refuses confirmations WITHOUT --apply (no silent downgrade)", () => {
    const d = run([
      "--project",
      PRODUCTION_PROJECT_ID,
      CONFIRM_DELETE_FLAG,
      CONFIRMATION_FLAG,
      CONFIRMATION_PHRASE,
      FINGERPRINT_FLAG,
      FP,
    ]);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "missing-apply-flag");
  });
});

describe("project validation", () => {
  it("refuses without a project", () => {
    const d = run([APPLY_FLAG]);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "missing-project");
  });

  it("refuses any project other than sparta-battle, even for a dry run", () => {
    for (const p of ["demo-sparta-battle", "sparta-battle-8b1c1", "spartabattle"]) {
      const d = run(["--project", p]);
      assert.equal(d.allowed, false, p);
      assert.equal(d.allowed === false && d.reason, "wrong-project");
    }
  });

  it("refuses a wrong project even with every signal", () => {
    const argv = fullApply();
    argv[1] = "sparta-battle-8b1c1";
    const d = run(argv);
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "wrong-project");
  });
});

describe("UID and e-mail are never accepted", () => {
  it("refuses any identifier-looking argument", () => {
    for (const flag of ["--uid", "--email", "--e-mail", "--user", "--id"]) {
      assert.equal(containsIdentifierArgument([flag, "x"]), true);

      const d = run(["--project", PRODUCTION_PROJECT_ID, flag, "x"]);
      assert.equal(d.allowed, false, flag);
      assert.equal(
        d.allowed === false && d.reason,
        "identifier-not-accepted"
      );
    }
  });

  it("has no way to parse a uid or email into args", () => {
    const args = parseArgs(["--uid", "abc", "--email", "a@b.co"]);
    assert.equal(Object.prototype.hasOwnProperty.call(args, "uid"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(args, "email"), false);
  });
});
