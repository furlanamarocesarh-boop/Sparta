import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import * as admin from "firebase-admin";

/**
 * END-TO-END result flow, run ENTIRELY against the local Firebase Emulator Suite
 * (Auth + Firestore + Functions) under the demo project `demo-sparta-battle`.
 *
 * HYBRID INVOCATION (authorized option 1). The Functions emulator's admin stub
 * drops `admin.firestore.FieldValue` for firebase-admin v13 (a firebase-tools
 * bug: it `.bind()`s the non-constructor `admin.firestore`, losing its statics),
 * so every MUTATING callable throws through the HTTP/onCall transport. Therefore:
 *
 *  - NON-MUTATING checks run through the real HTTP/onCall transport (Functions
 *    emulator), proving Auth-emulator tokens reach the callable layer;
 *  - MUTATING operations invoke the SAME real, compiled production handlers
 *    directly, in this process (real un-stubbed admin), with a context built
 *    ONLY from a VERIFIED Auth-emulator token (`admin.auth().verifyIdToken`).
 *    Nothing is reimplemented; the same payloads, handlers, Admin SDK, Firestore
 *    emulator, transactions and documents are used. The only layer bypassed for
 *    mutations is the buggy Functions-emulator HTTP transport.
 *
 * SAFETY — never touches the cloud: `demo-*` project id (Firebase blocks real
 * backends), plus a fail-closed guard on the Auth+Firestore emulator hosts.
 * `payprize` is never invoked. Run with:  npm run test:e2e
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECT_ID = "demo-sparta-battle";
const REGION = "us-central1";

const ENTRY_FEE = 10; // R$ 10,00 (money is stored in reais, as the backend does)
const PRIZE = 100; // R$ 100,00
const FUND = ENTRY_FEE; // fund each player with exactly the entry fee

const TID = "e2e-tid-result-flow";
const PW = "E2e-Passw0rd"; // LOCAL emulator password — not a real credential

const ADMIN = { uid: "e2e-admin", email: "admin@e2e.test", playerId: "PLR-000001" };
const A = { uid: "e2e-player-a", email: "player-a@e2e.test", playerId: "PLR-000002" };
const B = { uid: "e2e-player-b", email: "player-b@e2e.test", playerId: "PLR-000003" };

const REG_A = `${A.uid}_${TID}`;
const REG_B = `${B.uid}_${TID}`;
const PRIZE_TX = `prize_${TID}`;

// ─── Fail-closed guard ───────────────────────────────────────────────────────

function localHost(h: string): boolean {
  const bare = h.replace(/^https?:\/\//, "");
  return /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|$)/.test(bare);
}

function assertEmulatorOnly(): void {
  const fail = (m: string): never => {
    throw new Error(`FAIL-CLOSED (E2E aborted): ${m}`);
  };
  const projectId =
    process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PROJECT_ID;
  if (!projectId.startsWith("demo-")) {
    fail(`project id "${projectId}" must start with "demo-"`);
  }
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!fsHost) fail("FIRESTORE_EMULATOR_HOST is not set");
  if (!authHost) fail("FIREBASE_AUTH_EMULATOR_HOST is not set");
  if (!localHost(fsHost!)) fail(`FIRESTORE_EMULATOR_HOST "${fsHost}" is not local`);
  if (!localHost(authHost!)) fail(`FIREBASE_AUTH_EMULATOR_HOST "${authHost}" not local`);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    fail("GOOGLE_APPLICATION_CREDENTIALS is set — refusing to run with a possible real credential");
  }
}

const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = () => process.env.FIREBASE_AUTH_EMULATOR_HOST!;

// ─── HTTP transport (real Functions emulator) ────────────────────────────────

interface CallResult {
  ok: boolean;
  result?: any;
  code?: string;
  message?: string;
  httpStatus: number;
}

/** Real Auth-emulator sign-in → a real ID token carrying the user's claims. */
async function signIn(email: string): Promise<string> {
  const url = `http://${AUTH_HOST()}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`emulator sign-in failed for ${email}: ${res.status}`);
  const body = (await res.json()) as { idToken?: string };
  if (!body.idToken) throw new Error(`no idToken for ${email}`);
  return body.idToken;
}

/** Invokes a callable over the real HTTP/onCall transport as a signed-in identity. */
async function callAs(
  idToken: string,
  name: string,
  data: Record<string, unknown>
): Promise<CallResult> {
  const url = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (res.ok && body && "result" in body) {
    return { ok: true, result: body.result, httpStatus: res.status };
  }
  const err = body?.error ?? {};
  return {
    ok: false,
    code: typeof err.status === "string" ? err.status : "UNKNOWN",
    message: typeof err.message === "string" ? err.message : "",
    httpStatus: res.status,
  };
}

function expectHttpCode(r: CallResult, code: string): void {
  assert.equal(r.ok, false, `expected HTTP failure ${code}, but it succeeded`);
  assert.equal(r.code, code, `expected ${code}, got ${r.code} (${r.message})`);
}

// ─── Verified-token handler invocation (real handlers, this process) ─────────

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let startTournamentHandler: Handler;
let declareTournamentResultHandler: Handler;
let setTournamentRoomHandler: Handler;
let jointournamentRun: (data: any, context: any) => Promise<any>;

/**
 * Builds a handler context EXCLUSIVELY from a VERIFIED Auth-emulator token.
 * `uid` and `token` come straight from the decoded token — no claim is injected,
 * modified or fabricated. `admin:true` is present only if the real token carries it.
 */
async function verifiedCtx(idToken: string): Promise<{ auth: { uid: string; token: any } }> {
  const decoded = await admin.auth().verifyIdToken(idToken);
  return { auth: { uid: decoded.uid, token: decoded } };
}

function expectSuccess(res: Record<string, unknown>): void {
  assert.equal(res.success, true, "expected handler {success:true}");
}

/** Asserts a real handler throws a DomainError with the given (lowercase) code. */
async function expectHandlerThrows(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    assert.equal(e?.code, code, `expected ${code}, got ${e?.code}: ${e?.message}`);
    return;
  }
  assert.fail(`expected handler to throw ${code}, but it resolved`);
}

// ─── Firestore snapshots ─────────────────────────────────────────────────────

let db: admin.firestore.Firestore;

async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(path).get();
  return snap.exists ? normalize(snap.data()) : null;
}

function normalize(value: unknown): any {
  if (value instanceof admin.firestore.DocumentReference) return { __ref: value.path };
  if (value instanceof admin.firestore.Timestamp) return { __ts: value.toMillis() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

async function countPrizeTxForTid(): Promise<number> {
  const tRef = db.collection("tournaments").doc(TID);
  const snap = await db
    .collection("transactions")
    .where("tournament_ref", "==", tRef)
    .where("category", "==", "prize")
    .get();
  return snap.size;
}

async function clearAll(): Promise<void> {
  for (const col of [
    "tournaments",
    "tournament_rooms",
    "registrations",
    "wallets",
    "transactions",
    "users",
  ]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

function wallet(balanceReais: number, uid: string) {
  return {
    balance: balanceReais,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
    user_ref: db.collection("users").doc(uid),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until a document exists (or the timeout lapses; never throws). */
async function waitForDoc(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await db.doc(path).get()).exists) return;
    await sleep(200);
  }
}

// ─── Shared state ────────────────────────────────────────────────────────────

let tokenAdmin = "";
let tokenA = "";
let tokenB = "";
let ctxAdmin: { auth: { uid: string; token: any } };
let ctxA: { auth: { uid: string; token: any } };
let ctxB: { auth: { uid: string; token: any } };

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("E2E — tournament result flow (emulator, verified-token hybrid)", () => {
  before(async () => {
    assertEmulatorOnly(); // fail-closed BEFORE any SDK use

    // The Admin SDK, Auth-token audience and the Functions emulator must all
    // agree on the demo project id.
    process.env.GCLOUD_PROJECT = PROJECT_ID;

    // Import the REAL production module. Its top-level `admin.initializeApp()`
    // wires the default app to the emulators (env already set) — so we never
    // initialize admin ourselves, and we run the exact shipped handlers.
    const mod = (await import("../../src/index.js")) as unknown as {
      startTournamentHandler: Handler;
      declareTournamentResultHandler: Handler;
      setTournamentRoomHandler: Handler;
      jointournament: { run: (data: any, context: any) => Promise<any> };
    };
    startTournamentHandler = mod.startTournamentHandler;
    declareTournamentResultHandler = mod.declareTournamentResultHandler;
    setTournamentRoomHandler = mod.setTournamentRoomHandler;
    jointournamentRun = (data, context) => mod.jointournament.run(data, context);

    db = admin.firestore();

    // Functions-emulator reachability (fail-closed).
    try {
      await fetch(`http://${FUNCTIONS_HOST}/`).catch(() => {
        throw new Error("unreachable");
      });
    } catch {
      throw new Error(
        `FAIL-CLOSED (E2E aborted): Functions emulator not reachable at ${FUNCTIONS_HOST}`
      );
    }

    await clearAll();

    // Real Auth-emulator identities.
    const auth = admin.auth();
    for (const u of [ADMIN, A, B]) {
      await auth.createUser({ uid: u.uid, email: u.email, password: PW });
    }
    await auth.setCustomUserClaims(ADMIN.uid, { admin: true });
    await auth.setCustomUserClaims(A.uid, {});
    await auth.setCustomUserClaims(B.uid, {});

    // onUserCreated fires asynchronously and would clobber funded balances to 0.
    // Wait until it has created each wallet, THEN write authoritative fixtures.
    for (const u of [ADMIN, A, B]) {
      await waitForDoc(`wallets/${u.uid}`, 15000);
    }

    for (const u of [ADMIN, A, B]) {
      await db.collection("users").doc(u.uid).set({
        email: u.email,
        username: "",
        player_id: u.playerId,
        pix_key: "",
        whatsapp: "",
      });
    }
    await db.collection("wallets").doc(ADMIN.uid).set(wallet(0, ADMIN.uid));
    await db.collection("wallets").doc(A.uid).set(wallet(FUND, A.uid));
    await db.collection("wallets").doc(B.uid).set(wallet(FUND, B.uid));

    await db
      .collection("tournaments")
      .doc(TID)
      .set({
        name: "E2E Result Flow",
        description: "",
        entry_fee: ENTRY_FEE,
        prize: PRIZE,
        status: "open",
        creator_ref: db.collection("users").doc(ADMIN.uid),
        creator_uid: ADMIN.uid,
        creator_name: "E2E Admin",
        game_mode: "solo",
        game_mode_label: "Solo",
        team_size: 1,
        format_type: "battle_royale",
        current_participants: 0,
        max_participants: 8,
        current_players: 0,
        max_players: 8,
        starts_at: null,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Real tokens, then VERIFIED contexts (uid + claims from the decoded token).
    tokenAdmin = await signIn(ADMIN.email);
    tokenA = await signIn(A.email);
    tokenB = await signIn(B.email);
    ctxAdmin = await verifiedCtx(tokenAdmin);
    ctxA = await verifiedCtx(tokenA);
    ctxB = await verifiedCtx(tokenB);
  });

  it("VERIFIED TOKENS: admin carries admin:true; players do not", () => {
    assert.equal(ctxAdmin.auth.uid, ADMIN.uid);
    assert.equal(ctxAdmin.auth.token.admin, true);
    assert.equal(ctxA.auth.uid, A.uid);
    assert.notEqual(ctxA.auth.token.admin, true);
    assert.notEqual(ctxB.auth.token.admin, true);
  });

  it("FIXTURES: open tournament, funded players, no result/room/prize tx", async () => {
    const t = await readDoc(`tournaments/${TID}`);
    assert.equal(t?.status, "open");
    assert.equal(t?.prize, PRIZE);
    assert.equal(t?.entry_fee, ENTRY_FEE);
    assert.equal(t?.result, undefined);
    assert.equal(await readDoc(`tournament_rooms/${TID}`), null);
    assert.equal(await readDoc(`transactions/${PRIZE_TX}`), null);
    assert.equal((await readDoc(`wallets/${A.uid}`))?.balance, FUND);
    assert.equal((await readDoc(`wallets/${B.uid}`))?.balance, FUND);
  });

  // ── HTTP transport coverage (proves tokens reach the callable layer) ──
  it("[HTTP] a non-admin cannot start the tournament → permission-denied", async () => {
    expectHttpCode(
      await callAs(tokenA, "startTournament", { tournamentid: TID }),
      "PERMISSION_DENIED"
    );
    assert.equal((await readDoc(`tournaments/${TID}`))?.status, "open");
  });

  // ── Mutating flow via VERIFIED-token handlers ──
  it("[handler] PLAYER_A and PLAYER_B join; both 'registered' with correct refs and debited once", async () => {
    assert.equal((await readDoc(`wallets/${A.uid}`))?.balance, FUND);
    assert.equal((await readDoc(`wallets/${B.uid}`))?.balance, FUND);

    expectSuccess(await jointournamentRun({ tournamentid: TID }, ctxA));
    expectSuccess(await jointournamentRun({ tournamentid: TID }, ctxB));

    for (const [reg, u] of [
      [REG_A, A],
      [REG_B, B],
    ] as const) {
      const r = await readDoc(`registrations/${reg}`);
      assert.equal(r?.status, "registered", `${reg} must be exactly "registered"`);
      assert.deepEqual(r?.user_ref, { __ref: `users/${u.uid}` });
      assert.deepEqual(r?.tournament_ref, { __ref: `tournaments/${TID}` });
    }
    // Entry fee debited exactly once each: FUND - ENTRY_FEE = 0.
    assert.equal((await readDoc(`wallets/${A.uid}`))?.balance, FUND - ENTRY_FEE);
    assert.equal((await readDoc(`wallets/${B.uid}`))?.balance, FUND - ENTRY_FEE);
  });

  it("[handler] ADMIN publishes the room", async () => {
    expectSuccess(
      await setTournamentRoomHandler(
        { tournamentid: TID, roomid: "E2E-ROOM", roompassword: "e2e-secret" },
        ctxAdmin
      )
    );
    assert.notEqual(await readDoc(`tournament_rooms/${TID}`), null);
  });

  it("[HTTP] registered players get room access; a non-registered user is rejected", async () => {
    assert.equal((await callAs(tokenA, "getTournamentRoom", { tournamentid: TID })).ok, true);
    assert.equal((await callAs(tokenB, "getTournamentRoom", { tournamentid: TID })).ok, true);
    // ADMIN is signed in but not registered → denied (credentials never inspected).
    expectHttpCode(
      await callAs(tokenAdmin, "getTournamentRoom", { tournamentid: TID }),
      "PERMISSION_DENIED"
    );
  });

  it("[handler] ADMIN starts: open → in_progress (no money moved)", async () => {
    const before = [await readDoc(`wallets/${A.uid}`), await readDoc(`wallets/${B.uid}`)];
    expectSuccess(await startTournamentHandler({ tournamentid: TID }, ctxAdmin));
    assert.equal((await readDoc(`tournaments/${TID}`))?.status, "in_progress");
    assert.deepEqual(
      [await readDoc(`wallets/${A.uid}`), await readDoc(`wallets/${B.uid}`)],
      before
    );
    assert.equal(await countPrizeTxForTid(), 0);
  });

  it("[handler] repeating startTournament is idempotent (no doc change)", async () => {
    const before = await readDoc(`tournaments/${TID}`);
    expectSuccess(await startTournamentHandler({ tournamentid: TID }, ctxAdmin));
    assert.deepEqual(await readDoc(`tournaments/${TID}`), before);
    assert.equal(await countPrizeTxForTid(), 0);
  });

  it("[HTTP] a non-admin cannot declare → permission-denied", async () => {
    expectHttpCode(
      await callAs(tokenA, "declareTournamentResult", { tournamentid: TID, winneruid: A.uid }),
      "PERMISSION_DENIED"
    );
  });

  it("[HTTP] an unregistered winner is rejected → failed-precondition, no write", async () => {
    const tBefore = await readDoc(`tournaments/${TID}`);
    const wBefore = await readDoc(`wallets/${ADMIN.uid}`);
    // ADMIN is not a registrant of TID.
    expectHttpCode(
      await callAs(tokenAdmin, "declareTournamentResult", {
        tournamentid: TID,
        winneruid: ADMIN.uid,
      }),
      "FAILED_PRECONDITION"
    );
    assert.deepEqual(await readDoc(`tournaments/${TID}`), tBefore);
    assert.deepEqual(await readDoc(`wallets/${ADMIN.uid}`), wBefore);
    assert.equal(await countPrizeTxForTid(), 0);
  });

  it("[handler] ADMIN declares PLAYER_A winner: completed, prize credited exactly once", async () => {
    const balancePostJoin = (await readDoc(`wallets/${A.uid}`))?.balance as number;
    const totalWon0 = (await readDoc(`wallets/${A.uid}`))?.total_won as number;
    assert.equal(balancePostJoin, FUND - ENTRY_FEE); // 0
    assert.equal(totalWon0, 0);

    expectSuccess(
      await declareTournamentResultHandler({ tournamentid: TID, winneruid: A.uid }, ctxAdmin)
    );

    const t = await readDoc(`tournaments/${TID}`);
    assert.equal(t?.status, "completed");
    const result = t?.result as Record<string, unknown>;
    assert.deepEqual(result.winner_uid, A.uid);
    assert.equal(result.prize, PRIZE);

    const wA = await readDoc(`wallets/${A.uid}`);
    assert.equal(wA?.balance, balancePostJoin + PRIZE); // 0 + 100
    assert.equal(wA?.total_won, totalWon0 + PRIZE); // 0 + 100

    assert.equal(await countPrizeTxForTid(), 1);
    const tx = await readDoc(`transactions/${PRIZE_TX}`);
    assert.equal(tx?.amount, PRIZE);
    assert.equal(tx?.category, "prize");
    assert.deepEqual(tx?.user_ref, { __ref: `users/${A.uid}` });
    assert.deepEqual(tx?.tournament_ref, { __ref: `tournaments/${TID}` });
    assert.equal(tx?.previous_balance, balancePostJoin); // 0
    assert.equal(tx?.balance_after, balancePostJoin + PRIZE); // 100
  });

  it("[handler] re-declaring PLAYER_A is idempotent: no second credit, no new tx, no doc change", async () => {
    const tBefore = await readDoc(`tournaments/${TID}`);
    const wBefore = await readDoc(`wallets/${A.uid}`);
    const txBefore = await readDoc(`transactions/${PRIZE_TX}`);

    expectSuccess(
      await declareTournamentResultHandler({ tournamentid: TID, winneruid: A.uid }, ctxAdmin)
    );

    assert.deepEqual(await readDoc(`tournaments/${TID}`), tBefore);
    assert.deepEqual(await readDoc(`wallets/${A.uid}`), wBefore);
    assert.deepEqual(await readDoc(`transactions/${PRIZE_TX}`), txBefore);
    assert.equal(await countPrizeTxForTid(), 1);
  });

  it("[handler] declaring a DIFFERENT winner (PLAYER_B) is rejected with no write, no credit to B", async () => {
    const wBBefore = await readDoc(`wallets/${B.uid}`);
    const wABefore = await readDoc(`wallets/${A.uid}`);
    const tBefore = await readDoc(`tournaments/${TID}`);

    await expectHandlerThrows(
      () => declareTournamentResultHandler({ tournamentid: TID, winneruid: B.uid }, ctxAdmin),
      "failed-precondition"
    );

    assert.deepEqual(await readDoc(`wallets/${B.uid}`), wBBefore);
    assert.equal((await readDoc(`wallets/${B.uid}`))?.total_won, 0);
    assert.deepEqual(await readDoc(`wallets/${A.uid}`), wABefore);
    assert.deepEqual(await readDoc(`tournaments/${TID}`), tBefore);
    assert.equal(await countPrizeTxForTid(), 1);
  });
});
