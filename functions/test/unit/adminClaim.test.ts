import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { computeFingerprint } from "../../src/adminclaim/fingerprint.js";
import { ADMIN_ACCOUNT_UID } from "../../src/adminclaim/target.js";
import {
  APPLY_FLAG,
  CONFIRM_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  EXPECTED_FINGERPRINT_FLAG,
  PRODUCTION_PROJECT_ID,
  decide,
  parseArgs,
} from "../../src/adminclaim/guard.js";
import {
  AdminClaimState,
  buildApplyCommand,
  decideApply,
  exitCodeForPlan,
  exitCodeForWrite,
  planAdminClaim,
  renderDryRun,
  renderWriteSuccess,
} from "../../src/adminclaim/plan.js";

// --- helpers ----------------------------------------------------------------

/** A fully-valid target state; individual tests override single fields. */
function stateWith(overrides: Partial<AdminClaimState> = {}): AdminClaimState {
  return {
    userExists: true,
    disabled: false,
    customClaims: {},
    userDocExists: true,
    walletDocExists: true,
    ...overrides,
  };
}

const APPLY_OK = [
  "--project",
  PRODUCTION_PROJECT_ID,
  APPLY_FLAG,
  CONFIRM_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  EXPECTED_FINGERPRINT_FLAG,
  "abc123",
];

/** Locate the functions directory whether cwd is it or the repo root. */
function functionsDir(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "src", "adminclaim", "cli.ts"))) return cwd;
  if (existsSync(join(cwd, "functions", "src", "adminclaim", "cli.ts"))) {
    return join(cwd, "functions");
  }
  throw new Error(`cannot locate functions dir from cwd: ${cwd}`);
}
const readFn = (rel: string): string =>
  readFileSync(join(functionsDir(), rel), "utf8");
const readRepo = (rel: string): string =>
  readFileSync(join(functionsDir(), "..", rel), "utf8");

/**
 * Strip comments so a source scan asserts on CODE, not on the file's own
 * explanatory prose (which legitimately mentions onCall, firebase-functions,
 * setCustomUserClaims, etc.). Adequate for our own source: no comment markers
 * live inside string literals on the scanned lines.
 */
function codeOf(rel: string): string {
  return readFn(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// --- guard: project ---------------------------------------------------------

describe("guard — project is mandatory and exact", () => {
  it("dry-run is the default with the correct project and nothing else", () => {
    const d = decide(parseArgs(["--project", PRODUCTION_PROJECT_ID]));
    assert.equal(d.allowed, true);
    assert.equal(d.allowed === true && d.mode, "dry-run");
  });

  it("refuses when no project is given (never falls back to .firebaserc)", () => {
    const d = decide(parseArgs([]));
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "missing-project");
  });

  it("refuses any project other than sparta-battle, including demo and typos", () => {
    for (const wrong of [
      "demo-sparta-battle",
      "Sparta-Battle",
      "sparta_battle",
      "sparta-battle-8b1c1",
      "spartabattle",
    ]) {
      const d = decide(parseArgs(["--project", wrong]));
      assert.equal(d.allowed, false, `should refuse "${wrong}"`);
      assert.equal(d.allowed === false && d.reason, "wrong-project");
    }
  });
});

// --- guard: forbidden target arguments --------------------------------------

describe("guard — a target can never come from an argument", () => {
  it("refuses --uid / --email / --id / --target / --user / --account", () => {
    for (const flag of [
      "--uid",
      "--email",
      "--id",
      "--target",
      "--user",
      "--account",
    ]) {
      const spaced = decide(
        parseArgs(["--project", PRODUCTION_PROJECT_ID, flag, "somevalue"])
      );
      assert.equal(spaced.allowed, false, `${flag} <value> must be refused`);
      assert.equal(
        spaced.allowed === false && spaced.reason,
        "forbidden-target-arg"
      );

      const equals = decide(
        parseArgs(["--project", PRODUCTION_PROJECT_ID, `${flag}=somevalue`])
      );
      assert.equal(equals.allowed, false, `${flag}=value must be refused`);
      assert.equal(
        equals.allowed === false && equals.reason,
        "forbidden-target-arg"
      );
    }
  });

  it("the forbidden-arg value is never captured into the parsed args", () => {
    // A clearly-fake value — the point is only that whatever is passed to --uid
    // is dropped, never stored.
    const injected = "injected-uid-should-be-dropped";
    const args = parseArgs(["--project", PRODUCTION_PROJECT_ID, "--uid", injected]);
    assert.ok(!JSON.stringify(args).includes(injected));
    assert.equal(args.forbiddenFlag, "--uid");
  });

  it("refuses a forbidden arg even before a missing project", () => {
    const d = decide(parseArgs(["--uid", "x"]));
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "forbidden-target-arg");
  });
});

// --- guard: apply needs every confirmation, simultaneously ------------------

describe("guard — apply requires ALL confirmations", () => {
  it("allows apply only with project + apply + confirm + phrase + fingerprint", () => {
    const d = decide(parseArgs(APPLY_OK));
    assert.equal(d.allowed, true);
    assert.equal(d.allowed === true && d.mode, "apply");
    assert.equal(d.allowed === true && d.mode === "apply" && d.expectedFingerprint, "abc123");
  });

  it("refuses apply without the confirm flag", () => {
    const d = decide(
      parseArgs([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRMATION_FLAG,
        CONFIRMATION_PHRASE,
        EXPECTED_FINGERPRINT_FLAG,
        "abc123",
      ])
    );
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "apply-missing-confirm-flag");
  });

  it("refuses apply without the confirmation phrase", () => {
    const d = decide(
      parseArgs([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRM_FLAG,
        EXPECTED_FINGERPRINT_FLAG,
        "abc123",
      ])
    );
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "apply-missing-confirmation");
  });

  it("refuses apply with the wrong confirmation phrase", () => {
    const d = decide(
      parseArgs([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRM_FLAG,
        CONFIRMATION_FLAG,
        "ADD_ADMIN_CLAIM", // near-miss
        EXPECTED_FINGERPRINT_FLAG,
        "abc123",
      ])
    );
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "apply-wrong-confirmation");
  });

  it("refuses apply without an expected fingerprint", () => {
    const d = decide(
      parseArgs([
        "--project",
        PRODUCTION_PROJECT_ID,
        APPLY_FLAG,
        CONFIRM_FLAG,
        CONFIRMATION_FLAG,
        CONFIRMATION_PHRASE,
      ])
    );
    assert.equal(d.allowed, false);
    assert.equal(d.allowed === false && d.reason, "apply-missing-fingerprint");
  });
});

// --- fingerprint ------------------------------------------------------------

describe("fingerprint — deterministic over uid, disabled, and claims", () => {
  const base = { uid: "u", disabled: false, customClaims: { a: 1, b: 2 } };

  it("is stable for the same input and order-independent for claims", () => {
    const f1 = computeFingerprint(base);
    const f2 = computeFingerprint({
      uid: "u",
      disabled: false,
      customClaims: { b: 2, a: 1 },
    });
    assert.equal(f1, f2);
  });

  it("changes when disabled, claims, or uid change", () => {
    const f = computeFingerprint(base);
    assert.notEqual(f, computeFingerprint({ ...base, disabled: true }));
    assert.notEqual(
      f,
      computeFingerprint({ ...base, customClaims: { a: 1, b: 3 } })
    );
    assert.notEqual(f, computeFingerprint({ ...base, uid: "v" }));
  });

  it("treats undefined claims the same as empty claims", () => {
    assert.equal(
      computeFingerprint({ uid: "u", disabled: false, customClaims: undefined }),
      computeFingerprint({ uid: "u", disabled: false, customClaims: {} })
    );
  });
});

// --- plan: preconditions abort ---------------------------------------------

describe("plan — precondition failures abort", () => {
  it("aborts when the Auth user does not exist", () => {
    const p = planAdminClaim(stateWith({ userExists: false }));
    assert.equal(p.kind, "abort");
    assert.equal(p.kind === "abort" && p.reason, "user-not-found");
  });

  it("aborts when the Auth user is disabled", () => {
    const p = planAdminClaim(stateWith({ disabled: true }));
    assert.equal(p.kind === "abort" && p.reason, "user-disabled");
  });

  it("aborts when users/{uid} is missing", () => {
    const p = planAdminClaim(stateWith({ userDocExists: false }));
    assert.equal(p.kind === "abort" && p.reason, "missing-user-doc");
  });

  it("aborts when wallets/{uid} is missing", () => {
    const p = planAdminClaim(stateWith({ walletDocExists: false }));
    assert.equal(p.kind === "abort" && p.reason, "missing-wallet-doc");
  });

  it("a dry-run abort is a failure exit code", () => {
    assert.equal(exitCodeForPlan(planAdminClaim(stateWith({ disabled: true }))), 1);
  });
});

// --- plan: claim merge / normalization / no-op ------------------------------

describe("plan — claim assignment is a careful merge", () => {
  it("adds admin: true when no claims exist", () => {
    const p = planAdminClaim(stateWith({ customClaims: {} }));
    assert.equal(p.kind, "add-claim");
    assert.deepEqual(p.kind === "add-claim" && p.nextClaims, { admin: true });
  });

  it("preserves every existing claim and only adds admin", () => {
    const existing = { role: "panel", tier: 2, region: "br" };
    const p = planAdminClaim(stateWith({ customClaims: existing }));
    assert.equal(p.kind, "add-claim");
    assert.deepEqual(p.kind === "add-claim" && p.nextClaims, {
      role: "panel",
      tier: 2,
      region: "br",
      admin: true,
    });
    assert.equal(p.kind === "add-claim" && p.existingClaimCount, 3);
    // The original object is not mutated.
    assert.equal("admin" in existing, false);
  });

  it("normalizes a truthy non-boolean admin (string 'true') to boolean true", () => {
    const p = planAdminClaim(stateWith({ customClaims: { admin: "true" } }));
    assert.equal(p.kind, "add-claim");
    const next = p.kind === "add-claim" ? p.nextClaims : {};
    assert.equal(next.admin, true);
    assert.equal(typeof next.admin, "boolean");
  });

  it("normalizes admin: false and admin: 1 to boolean true as well", () => {
    for (const value of [false, 1, "false", 0, null]) {
      const p = planAdminClaim(
        stateWith({ customClaims: { admin: value as unknown } })
      );
      assert.equal(p.kind, "add-claim", `admin=${String(value)}`);
      assert.equal(p.kind === "add-claim" && p.nextClaims.admin, true);
    }
  });

  it("is a no-op when admin is already EXACTLY boolean true", () => {
    const p = planAdminClaim(stateWith({ customClaims: { admin: true } }));
    assert.equal(p.kind, "noop");
    assert.equal(exitCodeForPlan(p), 0);
  });
});

// --- decideApply: fingerprint / TOCTOU guard --------------------------------

describe("decideApply — the write is gated on a matching fresh fingerprint", () => {
  const addClaim = planAdminClaim(stateWith({ customClaims: {} }));

  it("writes only when the fresh fingerprint matches the expected one", () => {
    const o = decideApply("fp-1", "fp-1", addClaim);
    assert.equal(o.kind, "write");
    assert.deepEqual(o.kind === "write" && o.nextClaims, { admin: true });
  });

  it("aborts on ANY fingerprint divergence — nothing is written", () => {
    const o = decideApply("fp-1", "fp-2", addClaim);
    assert.equal(o.kind, "abort");
    assert.equal(o.kind === "abort" && o.reason, "fingerprint-divergence");
  });

  it("aborts when the fresh plan itself aborts, even with a matching hash", () => {
    const abort = planAdminClaim(stateWith({ disabled: true }));
    const o = decideApply("fp-1", "fp-1", abort);
    assert.equal(o.kind, "abort");
    assert.equal(o.kind === "abort" && o.reason, "user-disabled");
  });

  it("reports a no-op (never a write) when the claim is already set", () => {
    const noop = planAdminClaim(stateWith({ customClaims: { admin: true } }));
    const o = decideApply("fp-1", "fp-1", noop);
    assert.equal(o.kind, "noop");
  });
});

// --- write outcome ----------------------------------------------------------

describe("write outcome — a failed setCustomUserClaims is never success", () => {
  it("maps a failed write to exit 1 and a successful write to exit 0", () => {
    assert.equal(exitCodeForWrite(false), 1);
    assert.equal(exitCodeForWrite(true), 0);
  });
});

// --- anonymized output ------------------------------------------------------

describe("output — never leaks uid, email, token, or full claims", () => {
  const SENSITIVE_VALUE = "sensitive-claim-value-zzz";
  const SENSITIVE_KEY = "secretclaimkey";

  it("renderDryRun emits counts and booleans, not the uid or claim contents", () => {
    const state = stateWith({
      customClaims: { [SENSITIVE_KEY]: SENSITIVE_VALUE, admin: false },
    });
    const out = renderDryRun({
      fingerprint: "FP-HASH",
      state,
      plan: planAdminClaim(state),
    });
    assert.ok(!out.includes(ADMIN_ACCOUNT_UID), "must not print the account uid");
    assert.ok(!out.includes(SENSITIVE_VALUE), "must not print a claim value");
    assert.ok(!out.includes(SENSITIVE_KEY), "must not print a claim key");
    // It DOES surface the safe, non-identifying facts.
    assert.ok(out.includes("FP-HASH"));
    assert.ok(out.includes("2 claim(s)"));
  });

  it("renderWriteSuccess reports only a count, no claim contents", () => {
    const out = renderWriteSuccess({
      [SENSITIVE_KEY]: SENSITIVE_VALUE,
      admin: true,
    });
    assert.ok(!out.includes(SENSITIVE_VALUE));
    assert.ok(!out.includes(SENSITIVE_KEY));
    assert.ok(out.includes("1 outra(s) claim"));
  });

  it("the future apply command carries the hash but never a uid", () => {
    const cmd = buildApplyCommand("FP-HASH");
    assert.ok(cmd.includes(CONFIRMATION_PHRASE));
    assert.ok(cmd.includes("FP-HASH"));
    assert.ok(cmd.includes(`--project ${PRODUCTION_PROJECT_ID}`));
    assert.ok(!cmd.includes(ADMIN_ACCOUNT_UID));
  });
});

// --- the tool is not, and cannot become, deployable -------------------------

describe("non-deployable — this tool can never become an endpoint", () => {
  it("its compiled output is excluded from the deploy package", () => {
    const firebaseJson = JSON.parse(readRepo("firebase.json")) as {
      functions: Array<{ ignore: string[] }>;
    };
    assert.ok(
      firebaseJson.functions[0].ignore.includes("lib/adminclaim"),
      "firebase.json must ignore lib/adminclaim"
    );
  });

  it("cli.ts imports no firebase-functions and declares no trigger", () => {
    const cli = codeOf("src/adminclaim/cli.ts");
    assert.ok(!cli.includes("firebase-functions"), "no firebase-functions");
    assert.ok(!/\bonCall\b/.test(cli), "no onCall");
    assert.ok(!/\bonRequest\b/.test(cli), "no onRequest");
  });

  it("index.ts does not reference the adminclaim tool", () => {
    const index = readFn("src/index.ts");
    assert.ok(!index.includes("adminclaim"));
  });

  it("exposes an admin:claim npm script wired to the compiled cli", () => {
    const pkg = JSON.parse(readFn("package.json")) as {
      scripts: Record<string, string>;
    };
    assert.ok("admin:claim" in pkg.scripts);
    assert.ok(pkg.scripts["admin:claim"].includes("lib/adminclaim/cli.js"));
  });

  it("has exactly one possible write and never revokes tokens", () => {
    const cli = codeOf("src/adminclaim/cli.ts");
    const writes = cli.match(/setCustomUserClaims/g) ?? [];
    assert.equal(writes.length, 1, "exactly one setCustomUserClaims call");
    assert.ok(!cli.includes("revokeRefreshTokens"), "never revokes tokens");
    assert.ok(
      !cli.includes(".set(") &&
        !cli.includes(".update(") &&
        !cli.includes(".delete("),
      "no Firestore writes"
    );
  });

  it("the dry-run branch returns before the single write is reached", () => {
    const cli = codeOf("src/adminclaim/cli.ts");
    const dryRunReturn = cli.indexOf('decision.mode === "dry-run"');
    const write = cli.indexOf("setCustomUserClaims");
    assert.ok(dryRunReturn !== -1 && write !== -1);
    assert.ok(dryRunReturn < write, "dry-run is handled before any write path");
  });
});
