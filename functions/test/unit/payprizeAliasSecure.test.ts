import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

/**
 * `payprize` is now a STRICT, SECURE ALIAS of `declareTournamentResultHandler`.
 *
 * Two guarantees are locked here:
 *  1. STRUCTURAL — the deployable `payprize` export wraps exactly the secure
 *     handler, there is no inline legacy body, and the settlement handler never
 *     reads a client-supplied `amount`/`externalid`/`transactionid`/`prize`/
 *     `status`.
 *  2. RUNTIME — the handler rejects the old contract (amount/externalid or any
 *     extra key) with `invalid-argument` BEFORE touching Firestore, so no
 *     emulator is required here.
 */

function srcDir(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "src", "index.ts"))) return join(cwd, "src");
  if (existsSync(join(cwd, "functions", "src", "index.ts"))) {
    return join(cwd, "functions", "src");
  }
  throw new Error(`cannot locate src from cwd: ${cwd}`);
}

const SOURCE = readFileSync(join(srcDir(), "index.ts"), "utf8");

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;
let declareTournamentResultHandler: Handler;
let startTournamentHandler: Handler;

const adminCtx = { auth: { uid: "admin-1", token: { admin: true } } };

async function expectHttpsCode(
  fn: () => Promise<unknown>,
  code: string
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.equal((error as { code?: unknown }).code, code);
    return;
  }
  assert.fail(`expected the handler to throw ${code}`);
}

before(async () => {
  process.env.GCLOUD_PROJECT =
    process.env.GCLOUD_PROJECT ?? "demo-sparta-battle";
  const mod = (await import("../../src/index.js")) as unknown as {
    declareTournamentResultHandler: Handler;
    startTournamentHandler: Handler;
  };
  declareTournamentResultHandler = mod.declareTournamentResultHandler;
  startTournamentHandler = mod.startTournamentHandler;
});

describe("payprize strict secure alias (structural)", () => {
  it("payprize wraps declareTournamentResultHandler with NO inline legacy body", () => {
    assert.match(
      SOURCE,
      /export const payprize = central\.https\.onCall\(\s*declareTournamentResultHandler\s*\)/
    );
    assert.doesNotMatch(
      SOURCE,
      /export const payprize = central\.https\.onCall\(async/
    );
  });

  it("declareTournamentResult and payprize wrap the SAME handler", () => {
    const wraps = (
      SOURCE.match(
        /central\.https\.onCall\(\s*declareTournamentResultHandler\s*\)/g
      ) || []
    ).length;
    assert.ok(wraps >= 2, "expected two callables over one settlement handler");
  });

  it("the settlement handler never reads client amount/externalid/etc.", () => {
    const start = SOURCE.indexOf("declareTournamentResultHandler = async");
    const end = SOURCE.indexOf("export const createTournamentHandler");
    assert.ok(start >= 0 && end > start, "could not bound the settlement handler");
    const body = SOURCE.slice(start, end);
    assert.doesNotMatch(body, /data\.amount/);
    assert.doesNotMatch(body, /data\.externalid/);
    assert.doesNotMatch(body, /data\.transactionid/);
    assert.doesNotMatch(body, /data\.prize/);
    assert.doesNotMatch(body, /data\.status/);
    assert.match(body, /assertExactPayload/);
  });
});

describe("legacy contract rejected at runtime (no Firestore hit)", () => {
  it("rejects amount/externalid/any extra key with invalid-argument", async () => {
    for (const extra of [
      { amount: 100 },
      { externalid: "x" },
      { transactionid: "x" },
      { prize: 1 },
      { status: "completed" },
      { winner_ref: "users/x" },
      { foo: 1 },
    ]) {
      await expectHttpsCode(
        () =>
          declareTournamentResultHandler(
            { tournamentid: "t1", winneruid: "w1", ...extra },
            adminCtx
          ),
        "invalid-argument"
      );
    }
  });

  it("startTournament rejects any extra key with invalid-argument", async () => {
    await expectHttpsCode(
      () => startTournamentHandler({ tournamentid: "t1", extra: 1 }, adminCtx),
      "invalid-argument"
    );
  });

  it("both reject an unauthenticated caller", async () => {
    await expectHttpsCode(
      () =>
        declareTournamentResultHandler({ tournamentid: "t1", winneruid: "w1" }, {}),
      "unauthenticated"
    );
    await expectHttpsCode(
      () => startTournamentHandler({ tournamentid: "t1" }, {}),
      "unauthenticated"
    );
  });

  it("both reject an authenticated non-admin with permission-denied", async () => {
    const userCtx = { auth: { uid: "u1", token: {} } };
    await expectHttpsCode(
      () =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          userCtx
        ),
      "permission-denied"
    );
    await expectHttpsCode(
      () => startTournamentHandler({ tournamentid: "t1" }, userCtx),
      "permission-denied"
    );
  });
});
