import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ADMIN_ACCOUNT_UID } from "../../src/adminclaim/target.js";

/**
 * Authorization tests for `createTournamentHandler` (shared by the
 * `createTournament` and `createtournament` callables).
 *
 * These are BEHAVIORAL: they invoke the real handler with a forged callable
 * context and assert the HttpsError CODE it produces. The security property is
 * that admin authorization runs FIRST — before any payload validation, document
 * read, or write. Every case here throws before the handler ever touches
 * Firestore, so no emulator or credentials are needed: a case that reached
 * Firestore would fail with a connection error, not the authorization code
 * asserted below.
 */

type Handler = (data: unknown, context: unknown) => Promise<unknown>;

let cached: Handler | undefined;

async function handler(): Promise<Handler> {
  if (cached) return cached;
  // Mirror functionRegions.test.ts: set the project so firebase-functions v1
  // initialization does not complain about a missing environment.
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? "demo-sparta-battle";
  const mod = await import("../../src/index.js");
  cached = (mod as unknown as { createTournamentHandler: Handler })
    .createTournamentHandler;
  return cached;
}

/** Invokes the handler and returns the thrown error code (or a sentinel). */
async function codeOf(data: unknown, context: unknown): Promise<string> {
  const fn = await handler();
  try {
    await fn(data, context);
    // A success here means an unauthorized/invalid call was accepted.
    return "ACEITO-INESPERADO";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "SEM-CODIGO";
  }
}

// A payload that WOULD create a tournament if it reached the write. Used to prove
// that a non-admin is stopped at authorization, before any read or write, even
// with input the handler would otherwise accept.
const VALID_PAYLOAD = {
  name: "Copa Teste",
  entry_fee: 0,
  prize: 0,
  max_players: 8,
  game_mode: "solo",
};

describe("createTournamentHandler — unauthenticated", () => {
  it("rejects a call with no auth as unauthenticated", async () => {
    assert.equal(await codeOf({}, {}), "unauthenticated");
    assert.equal(await codeOf({}, { auth: null }), "unauthenticated");
    // Even a valid payload cannot get in without authentication.
    assert.equal(await codeOf(VALID_PAYLOAD, {}), "unauthenticated");
  });
});

describe("createTournamentHandler — authenticated but not admin", () => {
  it("rejects a signed-in user with no claim as permission-denied", async () => {
    assert.equal(await codeOf({}, { auth: { uid: "player-1" } }), "permission-denied");
  });

  it("rejects admin: false / missing / null as permission-denied", async () => {
    assert.equal(
      await codeOf({}, { auth: { uid: "u", token: { admin: false } } }),
      "permission-denied"
    );
    assert.equal(
      await codeOf({}, { auth: { uid: "u", token: {} } }),
      "permission-denied"
    );
    assert.equal(
      await codeOf({}, { auth: { uid: "u", token: { admin: null } } }),
      "permission-denied"
    );
  });

  it("rejects the string \"true\" (truthy non-boolean) as permission-denied", async () => {
    assert.equal(
      await codeOf({}, { auth: { uid: "u", token: { admin: "true" } } }),
      "permission-denied"
    );
  });

  it("rejects the historical admin uid WITHOUT the claim as permission-denied", async () => {
    assert.equal(
      await codeOf({}, { auth: { uid: ADMIN_ACCOUNT_UID } }),
      "permission-denied"
    );
  });

  it("rejects a non-admin BEFORE validation — empty payload is permission-denied, not invalid-argument", async () => {
    // This is the ordering guarantee: authorization precedes name validation.
    assert.equal(await codeOf({}, { auth: { uid: "player-1" } }), "permission-denied");
  });

  it("rejects a non-admin with a VALID payload before any read or write", async () => {
    // A valid payload would otherwise reach the Firestore write. It does not:
    // the code is the authorization code, and no Firestore call is made.
    assert.equal(
      await codeOf(VALID_PAYLOAD, { auth: { uid: "player-1" } }),
      "permission-denied"
    );
  });
});

describe("createTournamentHandler — admin passes authorization", () => {
  it("lets ANY uid with admin: true boolean through the auth gate", async () => {
    // Past authorization, an empty payload fails validation (name required) with
    // invalid-argument — proving the admin cleared the gate, and that an admin's
    // empty payload writes nothing.
    for (const uid of ["some-admin", ADMIN_ACCOUNT_UID, "another"]) {
      assert.equal(
        await codeOf({}, { auth: { uid, token: { admin: true } } }),
        "invalid-argument",
        `uid ${uid} with admin:true should clear auth and hit validation`
      );
    }
  });
});

// Complementary structural defense — not a substitute for the behavioral tests.
describe("createTournamentHandler — structural guarantees", () => {
  function functionsDir(): string {
    const cwd = process.cwd();
    if (existsSync(join(cwd, "src", "index.ts"))) return cwd;
    if (existsSync(join(cwd, "functions", "src", "index.ts"))) {
      return join(cwd, "functions");
    }
    throw new Error(`cannot locate functions dir from cwd: ${cwd}`);
  }
  const indexSrc = (): string =>
    readFileSync(join(functionsDir(), "src", "index.ts"), "utf8");

  it("both callables wrap the same guarded handler", () => {
    const src = indexSrc();
    assert.match(
      src,
      /export const createTournament = central\.https\.onCall\(createTournamentHandler\)/
    );
    assert.match(
      src,
      /export const createtournament = central\.https\.onCall\(createTournamentHandler\)/
    );
  });

  it("assertAdmin appears before any Firestore access in the handler", () => {
    const src = indexSrc();
    const start = src.indexOf("createTournamentHandler = async");
    assert.ok(start !== -1, "handler not found");
    const body = src.slice(start);
    const idxAdmin = body.indexOf("assertAdmin(");
    const firstDb = ["db.collection", "db.doc", "db.runTransaction", ".set(", ".get("]
      .map((token) => body.indexOf(token))
      .filter((i) => i !== -1)
      .reduce((min, i) => Math.min(min, i), Number.POSITIVE_INFINITY);
    assert.ok(idxAdmin !== -1, "assertAdmin not called in the handler");
    assert.ok(
      idxAdmin < firstDb,
      "assertAdmin must precede every Firestore access"
    );
  });

  it("the handler does not call assertSignedIn (admin gate replaced it)", () => {
    const src = indexSrc();
    const start = src.indexOf("createTournamentHandler = async");
    const body = src.slice(start);
    assert.equal(body.includes("assertSignedIn("), false);
  });
});
