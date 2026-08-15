import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { assertEmulatorOnly } from "../support/emulatorGuard.js";
import { fetchWithTimeout } from "../support/httpTimeout.js";
import {
  reconcileWallet,
  TransactionRecord,
} from "../../src/audit/reconcile.js";

/**
 * BETA ECONOMY END-TO-END, run ENTIRELY against the local Firebase Emulator
 * Suite (Auth + Firestore + Functions) under the demo project
 * `demo-sparta-battle` — the full approved beta cycle:
 *
 *   grant → beta join → start → beta prize        (Tournament A)
 *   grant → beta join → cancel → beta refund      (Tournament B)
 *   withdrawal stays BLIND to beta_balance
 *   final read-only reconciliation of BOTH identities
 *
 * CONVENTION: the same verified-token hybrid as the approved cash E2E
 * (resultFlow.e2e.test.ts). MUTATING operations invoke the REAL compiled
 * production handlers with a context built ONLY from a VERIFIED Auth-emulator
 * token; NON-mutating rejections also travel the real HTTP/onCall transport.
 * Nothing financial is simulated: beta funding goes through the real
 * `grantBetaCredit`, entries through `jointournament`, the room through
 * `setTournamentRoom`, lifecycle through `startTournament` /
 * `declareTournamentResult` (+ `payprize` alias) / `cancelTournament`, and the
 * withdrawal attempt through `requestwithdrawal`. The Admin SDK is used ONLY
 * for identities/claims, reading snapshots, fixture cleanup, and the one
 * prerequisite with no public flow (the players' CASH baseline).
 *
 * SAFETY: `demo-*` project id + fail-closed guard on emulator hosts; the
 * final audit runs the real read-only CLI and the database is byte-compared
 * before/after to prove it wrote nothing.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const PROJECT_ID = "demo-sparta-battle";
const REGION = "us-central1";

const GRANT = 100; // beta units granted per player (stored as reais-like number)
const ENTRY = 10; // beta entry fee per tournament
const PRIZE = 50; // beta prize of tournament A
const CAMPAIGN = "beta-e2e";

const PW = "E2e-Passw0rd"; // LOCAL emulator password — not a real credential

const ADMIN = { uid: "e2e-beta-admin", email: "beta-admin@e2e.test" };
const A = { uid: "e2e-beta-player-a", email: "beta-a@e2e.test" };
const B = { uid: "e2e-beta-player-b", email: "beta-b@e2e.test" };
const C = { uid: "e2e-beta-common", email: "beta-common@e2e.test" };

/** Cash baselines seeded as identity-consistent fixtures (no public flow). */
const CASH_BASELINE: Record<string, Record<string, number>> = {
  [ADMIN.uid]: {
    balance: 0,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
  },
  [A.uid]: {
    balance: 5,
    total_deposited: 5,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
  },
  [B.uid]: {
    balance: 5,
    total_deposited: 5,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
  },
  [C.uid]: {
    balance: 100,
    total_deposited: 100,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
  },
};

const CASH_FIELDS = [
  "balance",
  "total_deposited",
  "total_won",
  "total_spent",
  "total_withdrawn",
] as const;

// ─── Fail-closed guard (shared: test/support/emulatorGuard.ts) ───────────────

const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = () => process.env.FIREBASE_AUTH_EMULATOR_HOST!;

// ─── HTTP transport (real onCall layer) ──────────────────────────────────────

interface CallResult {
  ok: boolean;
  result?: any;
  code?: string;
  message?: string;
}

async function signIn(email: string): Promise<string> {
  const url = `http://${AUTH_HOST()}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`emulator sign-in failed for ${email}: ${res.status}`);
  const body = (await res.json()) as { idToken?: string };
  if (!body.idToken) throw new Error(`no idToken for ${email}`);
  return body.idToken;
}

/** Invokes a callable over the real HTTP transport; null token = unauthenticated. */
async function callHttp(
  idToken: string | null,
  name: string,
  data: Record<string, unknown>
): Promise<CallResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const res = await fetchWithTimeout(
    `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/${name}`,
    { method: "POST", headers, body: JSON.stringify({ data }) }
  );
  const body = (await res.json().catch(() => ({}))) as any;
  if (res.ok && body && "result" in body) return { ok: true, result: body.result };
  const err = body?.error ?? {};
  return {
    ok: false,
    code: typeof err.status === "string" ? err.status : "UNKNOWN",
    message: typeof err.message === "string" ? err.message : "",
  };
}

function expectHttpCode(r: CallResult, code: string): void {
  assert.equal(r.ok, false, `expected HTTP failure ${code}, but it succeeded`);
  assert.equal(r.code, code, `expected ${code}, got ${r.code} (${r.message})`);
}

// ─── Verified-token handler invocation ───────────────────────────────────────

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let grantBetaCreditHandler: Handler;
let createTournamentHandler: Handler;
let startTournamentHandler: Handler;
let declareTournamentResultHandler: Handler;
let cancelTournamentHandler: Handler;
let setTournamentRoomHandler: Handler;
let jointournamentRun: (data: any, context: any) => Promise<any>;
let requestwithdrawalRun: (data: any, context: any) => Promise<any>;

async function verifiedCtx(
  idToken: string
): Promise<{ auth: { uid: string; token: any } }> {
  const decoded = await admin.auth().verifyIdToken(idToken);
  return { auth: { uid: decoded.uid, token: decoded } };
}

async function expectHandlerThrows(
  fn: () => Promise<unknown>,
  code: string
): Promise<void> {
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

function normalize(value: unknown): any {
  if (value instanceof admin.firestore.DocumentReference) {
    return { __ref: value.path };
  }
  if (value instanceof admin.firestore.Timestamp) {
    return { __ts: value.toMillis() };
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(path).get();
  return snap.exists ? normalize(snap.data()) : null;
}

const AFFECTED_COLLECTIONS = [
  "wallets",
  "transactions",
  "registrations",
  "tournaments",
  "withdrawals",
  "tournament_rooms",
  "users",
] as const;

/** Full normalized dump of every affectable collection, keyed by path. */
async function snapshotAll(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const col of AFFECTED_COLLECTIONS) {
    const snap = await db.collection(col).get();
    for (const doc of snap.docs) {
      out[`${col}/${doc.id}`] = normalize(doc.data());
    }
  }
  return out;
}

async function countTxWhere(category: string): Promise<number> {
  const snap = await db
    .collection("transactions")
    .where("category", "==", category)
    .get();
  return snap.size;
}

/** The five cash fields of a wallet doc — the isolation invariant. */
function cashFive(doc: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of CASH_FIELDS) out[field] = (doc ?? {})[field];
  return out;
}

async function assertCashUntouched(uid: string): Promise<void> {
  assert.deepEqual(
    cashFive(await readDoc(`wallets/${uid}`)),
    CASH_BASELINE[uid],
    `cash fields of ${uid} must equal the baseline byte-for-byte`
  );
}

async function clearAll(): Promise<void> {
  for (const col of AFFECTED_COLLECTIONS) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForDoc(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await db.doc(path).get()).exists) return;
    await sleep(200);
  }
}

// ─── Shared state (built sequentially, deterministic per scenario) ───────────

let tokenAdmin = "";
let tokenA = "";
let tokenB = "";
let tokenC = "";
let ctxAdmin: { auth: { uid: string; token: any } };
let ctxA: { auth: { uid: string; token: any } };
let ctxB: { auth: { uid: string; token: any } };
let ctxC: { auth: { uid: string; token: any } };

/** Tournament ids come from the REAL createTournament responses. */
let TA = ""; // beta — result/prize flow
let TB = ""; // beta — cancellation/refund flow
let TC = ""; // cash — isolation control

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("BETA E2E — grant → join → start → prize; join → cancel → refund; withdrawal blind; reconciliation", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;

    const mod = (await import("../../src/index.js")) as unknown as {
      grantBetaCreditHandler: Handler;
      createTournamentHandler: Handler;
      startTournamentHandler: Handler;
      declareTournamentResultHandler: Handler;
      cancelTournamentHandler: Handler;
      setTournamentRoomHandler: Handler;
      jointournament: { run: (d: any, c: any) => Promise<any> };
      requestwithdrawal: { run: (d: any, c: any) => Promise<any> };
    };
    grantBetaCreditHandler = mod.grantBetaCreditHandler;
    createTournamentHandler = mod.createTournamentHandler;
    startTournamentHandler = mod.startTournamentHandler;
    declareTournamentResultHandler = mod.declareTournamentResultHandler;
    cancelTournamentHandler = mod.cancelTournamentHandler;
    setTournamentRoomHandler = mod.setTournamentRoomHandler;
    jointournamentRun = (d, c) => mod.jointournament.run(d, c);
    requestwithdrawalRun = (d, c) => mod.requestwithdrawal.run(d, c);

    db = admin.firestore();

    try {
      await fetchWithTimeout(`http://${FUNCTIONS_HOST}/`, {}, 10_000).catch(() => {
        throw new Error("unreachable");
      });
    } catch {
      throw new Error(
        `FAIL-CLOSED (E2E aborted): Functions emulator not reachable at ${FUNCTIONS_HOST}`
      );
    }

    await clearAll();

    // Real Auth-emulator identities; only ADMIN carries the admin claim.
    const auth = admin.auth();
    for (const u of [ADMIN, A, B, C]) {
      await auth
        .createUser({ uid: u.uid, email: u.email, password: PW })
        .catch(async () => {
          // A prior isolated run of THIS file may have left the account: reset.
          await auth.deleteUser(u.uid);
          await auth.createUser({ uid: u.uid, email: u.email, password: PW });
        });
    }
    await auth.setCustomUserClaims(ADMIN.uid, { admin: true });
    for (const u of [A, B, C]) await auth.setCustomUserClaims(u.uid, {});

    // onUserCreated (REAL trigger) creates users/ + zeroed wallets async.
    for (const u of [ADMIN, A, B, C]) {
      await waitForDoc(`wallets/${u.uid}`, 15000);
      await waitForDoc(`users/${u.uid}`, 15000);
    }

    // CASH baseline fixture — the one prerequisite with no public flow for a
    // PLAYER (testdeposit only credits the admin caller's own wallet).
    // Identity-consistent AND ledger-backed on purpose: each non-zero balance
    // is accompanied by its `deposit` ledger, so the final read-only
    // reconciliation must close with zero conflicts. beta_balance starts 0 and
    // is funded ONLY via the real grantBetaCredit.
    for (const u of [ADMIN, A, B, C]) {
      const userRef = db.collection("users").doc(u.uid);
      await db
        .collection("wallets")
        .doc(u.uid)
        .set({
          ...CASH_BASELINE[u.uid],
          beta_balance: 0,
          user_ref: userRef,
        });
      const deposited = CASH_BASELINE[u.uid].total_deposited;
      if (deposited > 0) {
        await db
          .collection("transactions")
          .doc(`e2e-seed-deposit-${u.uid}`)
          .set({
            amount: deposited,
            category: "deposit",
            status: "completed",
            user_ref: userRef,
            external_id: `e2e-seed-deposit-${u.uid}`,
          });
      }
    }

    tokenAdmin = await signIn(ADMIN.email);
    tokenA = await signIn(A.email);
    tokenB = await signIn(B.email);
    tokenC = await signIn(C.email);
    ctxAdmin = await verifiedCtx(tokenAdmin);
    ctxA = await verifiedCtx(tokenA);
    ctxB = await verifiedCtx(tokenB);
    ctxC = await verifiedCtx(tokenC);
  });

  it("T01 BASELINE: wallets seeded, identities coerentes, beta zerado", async () => {
    for (const u of [ADMIN, A, B, C]) {
      const wallet = await readDoc(`wallets/${u.uid}`);
      assert.deepEqual(cashFive(wallet), CASH_BASELINE[u.uid]);
      assert.equal(wallet?.beta_balance, 0);
    }
    assert.equal(ctxAdmin.auth.token.admin, true);
    assert.notEqual(ctxA.auth.token.admin, true);
  });

  // ── FASE 6 — Concessão beta ────────────────────────────────────────────────

  it("T02 [HTTP] grant rejeitado: comum, não autenticado e payload inválido — tudo atômico", async () => {
    const beforeState = await snapshotAll();

    const payload = {
      uid: A.uid,
      amount: GRANT,
      grant_id: "e2e-g-reject",
      campaign_id: CAMPAIGN,
      reason: "Rejeição esperada",
    };
    expectHttpCode(
      await callHttp(tokenC, "grantBetaCredit", payload),
      "PERMISSION_DENIED"
    );
    expectHttpCode(
      await callHttp(null, "grantBetaCredit", payload),
      "UNAUTHENTICATED"
    );
    // granted_by nunca é aceito no payload.
    expectHttpCode(
      await callHttp(tokenAdmin, "grantBetaCredit", {
        ...payload,
        granted_by: "attacker",
      }),
      "INVALID_ARGUMENT"
    );

    assert.deepEqual(await snapshotAll(), beforeState);
  });

  it("T03 grant real para A e B: só beta_balance muda; ledger beta_grant com schema/proveniência corretos", async () => {
    const resA = await grantBetaCreditHandler(
      {
        uid: A.uid,
        amount: GRANT,
        grant_id: "e2e-g-a",
        campaign_id: CAMPAIGN,
        reason: "Créditos do beta fechado",
      },
      ctxAdmin
    );
    assert.equal(resA.success, true);
    assert.equal(resA.idempotent, false);
    assert.equal(resA.beta_balance, GRANT);

    const resB = await grantBetaCreditHandler(
      {
        uid: B.uid,
        amount: GRANT,
        grant_id: "e2e-g-b",
        campaign_id: CAMPAIGN,
        reason: "Créditos do beta fechado",
      },
      ctxAdmin
    );
    assert.equal(resB.beta_balance, GRANT);

    for (const u of [A, B]) {
      const wallet = await readDoc(`wallets/${u.uid}`);
      assert.equal(wallet?.beta_balance, GRANT);
      await assertCashUntouched(u.uid);
    }

    const tx = await readDoc("transactions/beta_grant_e2e-g-a");
    assert.equal(tx?.category, "beta_grant");
    assert.equal(tx?.economy_type, "beta_credit");
    assert.equal(tx?.amount, GRANT);
    assert.ok(Number.isSafeInteger((tx?.amount as number) * 100));
    assert.equal(tx?.granted_by, ADMIN.uid);
    assert.equal(tx?.campaign_id, CAMPAIGN);
    assert.deepEqual(tx?.user_ref, { __ref: `users/${A.uid}` });
    assert.equal(tx?.beta_previous_balance, 0);
    assert.equal(tx?.beta_balance_after, GRANT);
    assert.equal(tx?.external_id, "beta_grant_e2e-g-a");
    assert.ok((tx?.created_at as any).__ts > 0);
    // Nenhum campo cash proibido no ledger beta.
    assert.equal(tx?.previous_balance, undefined);
    assert.equal(tx?.balance_after, undefined);

    assert.equal(await countTxWhere("beta_grant"), 2);
  });

  it("T04 grant replay idêntico: sem segundo crédito, docs byte-idênticos", async () => {
    const walletBefore = await readDoc(`wallets/${A.uid}`);
    const txBefore = await readDoc("transactions/beta_grant_e2e-g-a");

    const replay = await grantBetaCreditHandler(
      {
        uid: A.uid,
        amount: GRANT,
        grant_id: "e2e-g-a",
        campaign_id: CAMPAIGN,
        reason: "Créditos do beta fechado",
      },
      ctxAdmin
    );
    assert.equal(replay.success, true);
    assert.equal(replay.idempotent, true);

    assert.deepEqual(await readDoc(`wallets/${A.uid}`), walletBefore);
    assert.deepEqual(await readDoc("transactions/beta_grant_e2e-g-a"), txBefore);
    assert.equal(await countTxWhere("beta_grant"), 2);
  });

  // ── FASE 7 — Torneio A (beta) e entradas ───────────────────────────────────

  it("T05 createTournament real (beta): economy_type e trava persistidos iguais", async () => {
    const res = await createTournamentHandler(
      {
        name: "E2E Beta — Resultado",
        description: "",
        entry_fee: ENTRY,
        prize: PRIZE,
        max_players: 8,
        game_mode: "solo",
        economy_type: "beta_credit",
      },
      ctxAdmin
    );
    assert.equal(res.success, true);
    TA = res.tournament_id as string;

    const doc = await readDoc(`tournaments/${TA}`);
    assert.equal(doc?.status, "open");
    assert.equal(doc?.economy_type, "beta_credit");
    assert.equal(doc?.locked_economy_type, "beta_credit");
    assert.equal(doc?.entry_fee, ENTRY);
    assert.ok(Number.isSafeInteger((doc?.entry_fee as number) * 100));
    assert.equal(doc?.prize, PRIZE);
  });

  it("T06 joins beta reais (A e B): débito exato do beta, cash intacto, ledger e registration coerentes", async () => {
    for (const [player, ctx] of [
      [A, ctxA],
      [B, ctxB],
    ] as const) {
      const res = await jointournamentRun({ tournamentid: TA }, ctx);
      assert.equal(res.success, true);

      const wallet = await readDoc(`wallets/${player.uid}`);
      assert.equal(wallet?.beta_balance, GRANT - ENTRY); // 100 → 90
      await assertCashUntouched(player.uid);

      const reg = await readDoc(`registrations/${player.uid}_${TA}`);
      assert.equal(reg?.status, "registered");
      assert.equal(reg?.economy_type, "beta_credit");
      assert.equal(reg?.entry_fee_snapshot, ENTRY);
      assert.deepEqual(reg?.user_ref, { __ref: `users/${player.uid}` });
      assert.deepEqual(reg?.tournament_ref, { __ref: `tournaments/${TA}` });

      const txPath = (reg?.transaction_ref as any).__ref as string;
      const tx = await readDoc(txPath);
      assert.equal(tx?.category, "beta_entry_fee");
      assert.equal(tx?.economy_type, "beta_credit");
      assert.equal(tx?.amount, ENTRY);
      assert.equal(tx?.beta_previous_balance, GRANT);
      assert.equal(tx?.beta_balance_after, GRANT - ENTRY);
      assert.equal(tx?.previous_balance, undefined);
      assert.equal(tx?.balance_after, undefined);
    }

    const t = await readDoc(`tournaments/${TA}`);
    assert.equal(t?.current_participants, 2);
    assert.equal(t?.current_players, 2);
    assert.equal(await countTxWhere("beta_entry_fee"), 2);
    assert.equal(await countTxWhere("entry_fee"), 0); // nenhum ledger cash
  });

  it("T07 join replay (A): already-exists, estado completo byte-idêntico", async () => {
    const beforeState = await snapshotAll();
    await expectHandlerThrows(
      () => jointournamentRun({ tournamentid: TA }, ctxA),
      "already-exists"
    );
    assert.deepEqual(await snapshotAll(), beforeState);
  });

  // ── FASE 8 — Isolamento nas duas direções ──────────────────────────────────

  it("T08 CASH NÃO FINANCIA BETA: C (cash 100, beta 0) não entra no torneio beta", async () => {
    const beforeState = await snapshotAll();
    await expectHandlerThrows(
      () => jointournamentRun({ tournamentid: TA }, ctxC),
      "failed-precondition"
    );
    assert.deepEqual(await snapshotAll(), beforeState);
    assert.equal(await readDoc(`registrations/${C.uid}_${TA}`), null);
    assert.equal((await readDoc(`tournaments/${TA}`))?.current_participants, 2);
  });

  it("T09 BETA NÃO FINANCIA CASH: A (beta 90, cash 5) não entra em torneio cash de entrada 10", async () => {
    const res = await createTournamentHandler(
      {
        name: "E2E Cash — Controle",
        description: "",
        entry_fee: ENTRY,
        prize: PRIZE,
        max_players: 8,
        game_mode: "solo",
        economy_type: "cash",
      },
      ctxAdmin
    );
    TC = res.tournament_id as string;
    assert.equal((await readDoc(`tournaments/${TC}`))?.economy_type, "cash");

    const beforeState = await snapshotAll();
    await expectHandlerThrows(
      () => jointournamentRun({ tournamentid: TC }, ctxA),
      "failed-precondition"
    );
    assert.deepEqual(await snapshotAll(), beforeState);
    assert.equal(await readDoc(`registrations/${A.uid}_${TC}`), null);
    assert.equal((await readDoc(`tournaments/${TC}`))?.current_participants, 0);
    assert.equal(await countTxWhere("entry_fee"), 0);
  });

  // ── FASE 9 — Início do Torneio A ───────────────────────────────────────────

  it("T10 start: não-admin rejeitado no transporte; sem sala é failed-precondition atômico", async () => {
    expectHttpCode(
      await callHttp(tokenA, "startTournament", { tournamentid: TA }),
      "PERMISSION_DENIED"
    );

    const beforeState = await snapshotAll();
    await expectHandlerThrows(
      () => startTournamentHandler({ tournamentid: TA }, ctxAdmin),
      "failed-precondition" // a sala ainda não foi publicada
    );
    assert.deepEqual(await snapshotAll(), beforeState);
  });

  it("T11 sala real + start real: open → in_progress sem QUALQUER efeito financeiro", async () => {
    await setTournamentRoomHandler(
      { tournamentid: TA, roomid: "E2E-ROOM-A", roompassword: "e2e-room-secret" },
      ctxAdmin
    );

    const walletsBefore = [
      await readDoc(`wallets/${A.uid}`),
      await readDoc(`wallets/${B.uid}`),
    ];
    const regsBefore = [
      await readDoc(`registrations/${A.uid}_${TA}`),
      await readDoc(`registrations/${B.uid}_${TA}`),
    ];
    const txCount = (await db.collection("transactions").get()).size;

    const res = await startTournamentHandler({ tournamentid: TA }, ctxAdmin);
    assert.equal(res.success, true);

    const t = await readDoc(`tournaments/${TA}`);
    assert.equal(t?.status, "in_progress");
    assert.equal(t?.economy_type, "beta_credit");
    assert.equal(t?.locked_economy_type, "beta_credit");

    assert.deepEqual(
      [await readDoc(`wallets/${A.uid}`), await readDoc(`wallets/${B.uid}`)],
      walletsBefore
    );
    assert.deepEqual(
      [
        await readDoc(`registrations/${A.uid}_${TA}`),
        await readDoc(`registrations/${B.uid}_${TA}`),
      ],
      regsBefore
    );
    assert.equal((await db.collection("transactions").get()).size, txCount);
  });

  it("T12 start replay: sucesso idempotente sem reescrever o documento", async () => {
    const before = await readDoc(`tournaments/${TA}`);
    const res = await startTournamentHandler({ tournamentid: TA }, ctxAdmin);
    assert.equal(res.success, true);
    assert.deepEqual(await readDoc(`tournaments/${TA}`), before);
  });

  // ── FASE 10 — Resultado e prêmio beta ──────────────────────────────────────

  it("T13 vencedor NÃO registrado (C) é rejeitado atomicamente", async () => {
    const beforeState = await snapshotAll();
    await expectHandlerThrows(
      () =>
        declareTournamentResultHandler(
          { tournamentid: TA, winneruid: C.uid },
          ctxAdmin
        ),
      "failed-precondition"
    );
    assert.deepEqual(await snapshotAll(), beforeState);
  });

  it("T14 declare real: A vence, prêmio beta exato, fórmula fecha, B e o cash intocados", async () => {
    const res = await declareTournamentResultHandler(
      { tournamentid: TA, winneruid: A.uid },
      ctxAdmin
    );
    assert.equal(res.success, true);

    const t = await readDoc(`tournaments/${TA}`);
    assert.equal(t?.status, "completed");
    const result = t?.result as Record<string, unknown>;
    assert.equal(result.winner_uid, A.uid);
    assert.equal(result.prize, PRIZE);
    assert.equal(result.economy_type, "beta_credit");
    assert.equal(t?.economy_type, "beta_credit");
    assert.equal(t?.locked_economy_type, "beta_credit");

    // Fórmula com valores reais: 100 (grant) − 10 (entry) + 50 (prize) = 140.
    const walletA = await readDoc(`wallets/${A.uid}`);
    assert.equal(walletA?.beta_balance, GRANT - ENTRY + PRIZE);
    assert.equal(walletA?.beta_balance, 140);
    await assertCashUntouched(A.uid); // total_won e balance cash intactos

    // Jogador não premiado: absolutamente nada muda.
    const walletB = await readDoc(`wallets/${B.uid}`);
    assert.equal(walletB?.beta_balance, GRANT - ENTRY);
    await assertCashUntouched(B.uid);

    const tx = await readDoc(`transactions/prize_${TA}`);
    assert.equal(tx?.category, "beta_prize");
    assert.equal(tx?.economy_type, "beta_credit");
    assert.equal(tx?.amount, PRIZE);
    assert.equal(tx?.beta_previous_balance, GRANT - ENTRY);
    assert.equal(tx?.beta_balance_after, 140);
    assert.equal(tx?.previous_balance, undefined);
    assert.equal(tx?.balance_after, undefined);
    assert.deepEqual(tx?.tournament_ref, { __ref: `tournaments/${TA}` });
    assert.deepEqual(tx?.user_ref, { __ref: `users/${A.uid}` });

    assert.equal(await countTxWhere("beta_prize"), 1);
    assert.equal(await countTxWhere("prize"), 0); // nenhum prêmio cash
  });

  it("T15 replay do settlement + payprize (alias real via HTTP): idempotentes, sem segundo prêmio", async () => {
    const beforeState = await snapshotAll();

    const replay = await declareTournamentResultHandler(
      { tournamentid: TA, winneruid: A.uid },
      ctxAdmin
    );
    assert.equal(replay.success, true);
    assert.deepEqual(await snapshotAll(), beforeState);

    // payprize é alias ESTRITO do mesmo handler: o replay idempotente (sem
    // escrita) atravessa o transporte HTTP real e não move nada.
    const alias = await callHttp(tokenAdmin, "payprize", {
      tournamentid: TA,
      winneruid: A.uid,
    });
    assert.equal(alias.ok, true, `${alias.code}: ${alias.message}`);
    assert.equal((alias.result as any)?.success, true);
    assert.deepEqual(await snapshotAll(), beforeState);
    assert.equal(await countTxWhere("beta_prize"), 1);
  });

  it("T16 cancelar torneio CONCLUÍDO é rejeitado atomicamente", async () => {
    const beforeState = await snapshotAll();
    await expectHandlerThrows(
      () => cancelTournamentHandler({ tournamentid: TA }, ctxAdmin),
      "failed-precondition"
    );
    assert.deepEqual(await snapshotAll(), beforeState);
  });

  // ── FASE 11 — Torneio B: cancelamento e refund beta ────────────────────────

  it("T17 Torneio B (beta): criação e entradas reais de A e B", async () => {
    const res = await createTournamentHandler(
      {
        name: "E2E Beta — Cancelamento",
        description: "",
        entry_fee: ENTRY,
        prize: PRIZE,
        max_players: 8,
        game_mode: "solo",
        economy_type: "beta_credit",
      },
      ctxAdmin
    );
    TB = res.tournament_id as string;

    await jointournamentRun({ tournamentid: TB }, ctxA);
    await jointournamentRun({ tournamentid: TB }, ctxB);

    assert.equal((await readDoc(`wallets/${A.uid}`))?.beta_balance, 130); // 140 − 10
    assert.equal((await readDoc(`wallets/${B.uid}`))?.beta_balance, 80); // 90 − 10
    assert.equal(
      (await readDoc(`tournaments/${TB}`))?.current_participants,
      2
    );
    assert.equal(await countTxWhere("beta_entry_fee"), 4);
  });

  it("T18 cancelTournament real: refund beta exato para cada entrada, cash intocado", async () => {
    // Captura as entradas originais para provar as referências do refund.
    const entryPathA = (
      (await readDoc(`registrations/${A.uid}_${TB}`))?.transaction_ref as any
    ).__ref as string;
    const entryPathB = (
      (await readDoc(`registrations/${B.uid}_${TB}`))?.transaction_ref as any
    ).__ref as string;
    const entryTxABefore = await readDoc(entryPathA);

    const res = await cancelTournamentHandler({ tournamentid: TB }, ctxAdmin);
    assert.equal(res.success, true);
    assert.equal(res.idempotent, false);
    assert.equal(res.economy_type, "beta_credit");
    assert.equal(res.refunded_registrations, 2);
    assert.equal(res.refunded_amount, 2 * ENTRY);

    const t = await readDoc(`tournaments/${TB}`);
    assert.equal(t?.status, "cancelled");
    assert.equal(t?.refund_economy_type, "beta_credit");
    assert.equal(t?.refunded_registration_count, 2);
    assert.equal(t?.refunded_total, 2 * ENTRY);
    assert.equal(t?.current_participants, 0);
    assert.equal(t?.current_players, 0);

    for (const [player, entryPath, expectedBeta] of [
      [A, entryPathA, 140],
      [B, entryPathB, 90],
    ] as const) {
      const wallet = await readDoc(`wallets/${player.uid}`);
      assert.equal(wallet?.beta_balance, expectedBeta); // entry devolvido
      await assertCashUntouched(player.uid);

      const refund = await readDoc(
        `transactions/refund_${player.uid}_${TB}`
      );
      assert.equal(refund?.category, "beta_refund");
      assert.equal(refund?.economy_type, "beta_credit");
      assert.equal(refund?.amount, ENTRY);
      assert.deepEqual(refund?.entry_transaction_ref, { __ref: entryPath });
      assert.deepEqual(refund?.registration_ref, {
        __ref: `registrations/${player.uid}_${TB}`,
      });
      assert.deepEqual(refund?.user_ref, { __ref: `users/${player.uid}` });
      assert.deepEqual(refund?.tournament_ref, { __ref: `tournaments/${TB}` });
      assert.equal(refund?.previous_balance, undefined); // sem campos cash
      assert.equal(refund?.balance_after, undefined);

      const reg = await readDoc(`registrations/${player.uid}_${TB}`);
      assert.equal(reg?.status, "refunded");
      assert.equal(reg?.refund_economy_type, "beta_credit");
      assert.equal(reg?.refunded_amount, ENTRY);
      assert.deepEqual(reg?.transaction_ref, { __ref: entryPath }); // preservado
    }

    // A entrada original permanece byte-for-byte intacta.
    assert.deepEqual(await readDoc(entryPathA), entryTxABefore);

    assert.equal(await countTxWhere("beta_refund"), 2);
    assert.equal(await countTxWhere("entry_refund"), 0); // nenhum refund cash
  });

  it("T19 cancel replay: idempotente, banco byte-idêntico", async () => {
    const beforeState = await snapshotAll();
    const replay = await cancelTournamentHandler(
      { tournamentid: TB },
      ctxAdmin
    );
    assert.equal(replay.success, true);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.refunded_registrations, 2);
    assert.deepEqual(await snapshotAll(), beforeState);
  });

  // ── FASE 12 — Saque cego ao beta ───────────────────────────────────────────

  it("T20 requestwithdrawal real: beta 140 NÃO conta como sacável; falha atômica", async () => {
    const walletBefore = await readDoc(`wallets/${A.uid}`);
    assert.equal(walletBefore?.beta_balance, 140);
    assert.equal(walletBefore?.balance, 5); // < 10 pedidos

    const beforeState = await snapshotAll();
    await expectHandlerThrows(
      () =>
        requestwithdrawalRun(
          { amount: 10, pixkey: "chave-pix-de-teste-e2e" },
          ctxA
        ),
      "failed-precondition" // Saldo insuficiente — o contrato cash vigente
    );
    assert.deepEqual(await snapshotAll(), beforeState);
    assert.equal((await db.collection("withdrawals").get()).size, 0);
    assert.equal(await countTxWhere("withdrawal"), 0);
  });

  // ── FASE 14 — Reconciliação final ──────────────────────────────────────────

  it("T21 reconciliação PURA por jogador: as duas identidades fecham exatamente, sem manual-review", async () => {
    // Projeta as transactions EXATAMENTE como o cli do audit faz.
    const refPath = (value: unknown): string | null => {
      const path = (value as { path?: unknown } | null | undefined)?.path;
      return typeof path === "string" ? path : null;
    };

    for (const [player, expectedBetaCentavos] of [
      [A, 14000],
      [B, 9000],
      [C, 0],
    ] as const) {
      const userRef = db.collection("users").doc(player.uid);

      const transactions: TransactionRecord[] = [];
      const txSnap = await db
        .collection("transactions")
        .where("user_ref", "==", userRef)
        .get();
      for (const doc of txSnap.docs) {
        const data = doc.data();
        transactions.push({
          category: data.category,
          status: data.status,
          amount: data.amount,
          path: `transactions/${doc.id}`,
          economyType: data.economy_type,
          tournamentRefPath: refPath(data.tournament_ref),
          registrationRefPath: refPath(data.registration_ref),
          entryTransactionRefPath: refPath(data.entry_transaction_ref),
          hasCashStamps:
            data.previous_balance !== undefined ||
            data.balance_after !== undefined,
          hasBetaStamps:
            data.beta_previous_balance !== undefined ||
            data.beta_balance_after !== undefined,
        });
      }

      const registrationCount = (
        await db
          .collection("registrations")
          .where("user_ref", "==", userRef)
          .get()
      ).size;

      const wallet = (await db.doc(`wallets/${player.uid}`).get()).data() ?? {};
      const toCent = (v: unknown): number => Math.round((v as number) * 100);

      const result = reconcileWallet(`Wallet ${player.uid}`, {
        missingFields: [],
        presentCentavos: {
          balance: toCent(wallet.balance),
          total_deposited: toCent(wallet.total_deposited),
          total_won: toCent(wallet.total_won),
          total_spent: toCent(wallet.total_spent),
          total_withdrawn: toCent(wallet.total_withdrawn),
        },
        userDocExists: true,
        userRefValid: true,
        userRefStatus: "valid",
        betaBalancePresent: true,
        betaBalanceCentavos: toCent(wallet.beta_balance),
        related: { transactions, withdrawalStatuses: [], registrationCount },
      });

      // Identidade cash reconstruída == wallet, sem categorias beta.
      assert.deepEqual(
        result.derivedCentavos,
        {
          balance: toCent(wallet.balance),
          total_deposited: toCent(wallet.total_deposited),
          total_won: toCent(wallet.total_won),
          total_spent: toCent(wallet.total_spent),
          total_withdrawn: toCent(wallet.total_withdrawn),
        },
        `cash identity of ${player.uid}`
      );
      // Identidade beta reconstruída == wallet.
      assert.equal(
        result.derivedBetaCentavos,
        expectedBetaCentavos,
        `beta identity of ${player.uid}`
      );
      assert.deepEqual(result.conflicts, [], player.uid);
      assert.equal(
        result.classification,
        "reconstructable",
        `${player.uid}: ${result.reasons.join("; ")}`
      );
    }

    // Fórmulas explícitas com os valores reais:
    // A: 100 (grants) − 20 (entries) + 50 (prize) + 10 (refund) = 140
    // B: 100 (grants) − 20 (entries) +  0          + 10 (refund) =  90
    assert.equal(100 - 20 + 50 + 10, 140);
    assert.equal(100 - 20 + 0 + 10, 90);

    // Contagem final exata das categorias.
    assert.equal(await countTxWhere("beta_grant"), 2);
    assert.equal(await countTxWhere("beta_entry_fee"), 4);
    assert.equal(await countTxWhere("beta_prize"), 1);
    assert.equal(await countTxWhere("beta_refund"), 2);
    // Cash: apenas os 3 depósitos-fixture de baseline; nenhum movimento cash
    // foi produzido por QUALQUER fluxo beta.
    assert.equal(await countTxWhere("deposit"), 3);
    for (const cashCategory of [
      "prize",
      "entry_fee",
      "withdrawal",
      "entry_refund",
    ]) {
      assert.equal(await countTxWhere(cashCategory), 0, cashCategory);
    }
  });

  it("T22 audit CLI real (read-only): exit 0 e banco byte-idêntico antes/depois", async () => {
    const beforeState = await snapshotAll();

    // O guard do CLI exige --project demo-* + FIRESTORE_EMULATOR_HOST (herdado).
    const run = spawnSync(
      process.execPath,
      ["lib/audit/cli.js", "--project", PROJECT_ID],
      { encoding: "utf8", env: process.env }
    );
    assert.equal(
      run.status,
      0,
      `audit must find no anomalies:\n${run.stdout}\n${run.stderr}`
    );

    // O audit é somente leitura: NADA mudou em NENHUMA coleção.
    assert.deepEqual(await snapshotAll(), beforeState);
  });
});
