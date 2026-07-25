import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

/**
 * Behavioral (execution) tests for `cancelTournament` — atomic cancellation +
 * deterministic refunds — against the LOCAL Firestore emulator, with full
 * before/after snapshots proving economic isolation, atomicity, idempotency
 * and the terminal `cancelled` state across join/start/declare/room.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 */

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let cancelTournamentHandler: Handler;
let startTournamentHandler: Handler;
let declareTournamentResultHandler: Handler;
let setTournamentRoomHandler: Handler;
let getTournamentRoomHandler: Handler;
let jointournamentRun: (data: any, context: any) => Promise<any>;
let db: admin.firestore.Firestore;

const ADMIN_UID = "admin-1";
const adminCtx = { auth: { uid: ADMIN_UID, token: { admin: true } } };
const ctxOf = (uid: string) => ({ auth: { uid, token: {} } });

const A = "player-a";
const B = "player-b";
const ENTRY = 10;

async function expectFailure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "NO_CODE";
  }
  return assert.fail("expected the handler to throw, but it resolved");
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
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }
}

async function seedUser(uid: string): Promise<void> {
  await db.collection("users").doc(uid).set({ email: `${uid}@e2e.test` });
}

async function seedWallet(
  uid: string,
  opts: {
    balance?: number;
    beta?: number;
    totalSpent?: number;
    totalWon?: number;
  } = {}
): Promise<void> {
  const data: Record<string, unknown> = {
    balance: opts.balance ?? 0,
    total_deposited: 1,
    total_won: opts.totalWon ?? 2,
    total_spent: opts.totalSpent ?? 3,
    total_withdrawn: 4,
    user_ref: db.collection("users").doc(uid),
  };
  if (opts.beta !== undefined) data.beta_balance = opts.beta;
  await db.collection("wallets").doc(uid).set(data);
}

async function seedTournament(
  id: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  await db
    .collection("tournaments")
    .doc(id)
    .set({
      name: "Cancel Flow",
      entry_fee: ENTRY,
      prize: 100,
      status: "open",
      current_participants: 0,
      max_participants: 8,
      current_players: 0,
      max_players: 8,
      created_at: admin.firestore.Timestamp.fromMillis(1_000_000),
      starts_at: null,
      ...fields,
    });
}

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

async function countTxWhere(category: string): Promise<number> {
  const snap = await db
    .collection("transactions")
    .where("category", "==", category)
    .get();
  return snap.size;
}

function omit(
  doc: Record<string, unknown> | null,
  ...fields: string[]
): Record<string, unknown> {
  const out = { ...(doc ?? {}) };
  for (const f of fields) delete out[f];
  return out;
}

/** Beta tournament + funded player joined via the REAL flow. */
async function seedJoinedBeta(
  tid: string,
  players: string[]
): Promise<void> {
  await seedTournament(tid, {
    economy_type: "beta_credit",
    locked_economy_type: "beta_credit",
  });
  for (const uid of players) {
    await seedUser(uid);
    await seedWallet(uid, { beta: 30 });
    await jointournamentRun({ tournamentid: tid }, ctxOf(uid));
  }
}

/** Cash tournament (new-style) + funded player joined via the REAL flow. */
async function seedJoinedCash(tid: string, players: string[]): Promise<void> {
  await seedTournament(tid, {
    economy_type: "cash",
    locked_economy_type: "cash",
  });
  for (const uid of players) {
    await seedUser(uid);
    await seedWallet(uid, { balance: 50, beta: 70, totalSpent: 3 });
    await jointournamentRun({ tournamentid: tid }, ctxOf(uid));
  }
}

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-cancel-handlers";
  const mod = (await import("../../src/index.js")) as unknown as {
    cancelTournamentHandler: Handler;
    startTournamentHandler: Handler;
    declareTournamentResultHandler: Handler;
    setTournamentRoomHandler: Handler;
    getTournamentRoomHandler: Handler;
    jointournament: { run: (data: any, context: any) => Promise<any> };
  };
  cancelTournamentHandler = mod.cancelTournamentHandler;
  startTournamentHandler = mod.startTournamentHandler;
  declareTournamentResultHandler = mod.declareTournamentResultHandler;
  setTournamentRoomHandler = mod.setTournamentRoomHandler;
  getTournamentRoomHandler = mod.getTournamentRoomHandler;
  jointournamentRun = (data, context) => mod.jointournament.run(data, context);
  db = admin.firestore();
});

beforeEach(clearAll);

// ─────────────────────────────────────────────────────────────────────────────
// (1)(2)(3) Autorização, payload, inexistente.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelTournament — autorização e payload", () => {
  it("(1) não autenticado / não admin são rejeitados", async () => {
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t" }, {})
      ),
      "unauthenticated"
    );
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t" }, ctxOf(A))
      ),
      "permission-denied"
    );
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler(
          { tournamentid: "t" },
          { auth: { uid: "u", token: { admin: "true" } } }
        )
      ),
      "permission-denied"
    );
  });

  it("(2) payload ausente, inválido e com campo extra", async () => {
    assert.equal(
      await expectFailure(() => cancelTournamentHandler({}, adminCtx)),
      "invalid-argument"
    );
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "a/b" }, adminCtx)
      ),
      "invalid-argument"
    );
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t", foo: 1 }, adminCtx)
      ),
      "invalid-argument"
    );
  });

  it("(3) torneio inexistente → not-found", async () => {
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "ghost" }, adminCtx)
      ),
      "not-found"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) Cancelamento sem inscrições + contrato público.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelTournament — torneio vazio", () => {
  it("(4) cancela um torneio aberto sem inscrições e reporta o contrato público", async () => {
    await seedTournament("t-empty", {
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });

    const res = await cancelTournamentHandler(
      { tournamentid: "t-empty" },
      adminCtx
    );
    assert.deepEqual(Object.keys(res).sort(), [
      "economy_type",
      "idempotent",
      "message",
      "refunded_amount",
      "refunded_registrations",
      "success",
      "tournament_id",
    ]);
    assert.equal(res.success, true);
    assert.equal(res.tournament_id, "t-empty");
    assert.equal(res.economy_type, "beta_credit");
    assert.equal(res.refunded_registrations, 0);
    assert.equal(res.refunded_amount, 0);
    assert.equal(res.idempotent, false);

    const t = await readDoc("tournaments/t-empty");
    assert.equal(t?.status, "cancelled");
    assert.equal(t?.cancelled_by, ADMIN_UID);
    assert.ok((t?.cancelled_at as any)?.__ts > 0);
    assert.equal(t?.refunded_registration_count, 0);
    assert.equal(t?.refunded_total, 0);
    assert.equal(t?.refund_economy_type, "beta_credit");
    assert.equal(t?.current_participants, 0);
    assert.equal(t?.current_players, 0);
    // Economia e trava preservadas.
    assert.equal(t?.economy_type, "beta_credit");
    assert.equal(t?.locked_economy_type, "beta_credit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5)(6)(9)(12)(13)(16)(17)(18)(19) Reembolso cash.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelTournament — reembolso cash", () => {
  it("(5)(9)(12)(13)(16)(17)(18) uma inscrição cash: só balance/total_spent voltam; schema exato; ledgers originais intactos", async () => {
    await seedJoinedCash("t-cash", [A]);
    // Pós-join: balance 40, total_spent 13, beta 70.
    const walletAfterJoin = await readDoc(`wallets/${A}`);
    const regBefore = await readDoc(`registrations/${A}_t-cash`);
    const entryTxPath = (regBefore?.transaction_ref as any).__ref as string;
    const entryTxBefore = await readDoc(entryTxPath);

    const res = await cancelTournamentHandler(
      { tournamentid: "t-cash" },
      adminCtx
    );
    assert.equal(res.refunded_registrations, 1);
    assert.equal(res.refunded_amount, ENTRY);
    assert.equal(res.economy_type, "cash");

    // (9)(12) balance 40→50, total_spent 13→3; beta_balance e o resto intactos.
    const wallet = await readDoc(`wallets/${A}`);
    assert.equal(wallet?.balance, 50);
    assert.equal(wallet?.total_spent, 3);
    assert.equal(wallet?.beta_balance, 70);
    assert.deepEqual(
      omit(wallet, "balance", "total_spent"),
      omit(walletAfterJoin, "balance", "total_spent")
    );

    // (13)(16) schema EXATO do entry_refund — cash puro, sem campos beta.
    const refundTx = await readDoc(`transactions/refund_${A}_t-cash`);
    assert.deepEqual(Object.keys(refundTx ?? {}).sort(), [
      "amount",
      "balance_after",
      "category",
      "created_at",
      "display_name",
      "economy_type",
      "entry_transaction_ref",
      "external_id",
      "previous_balance",
      "registration_ref",
      "status",
      "timestamp",
      "tournament_ref",
      "user_ref",
    ]);
    assert.equal(refundTx?.category, "entry_refund");
    assert.equal(refundTx?.economy_type, "cash");
    assert.equal(refundTx?.amount, ENTRY);
    assert.equal(refundTx?.previous_balance, 40);
    assert.equal(refundTx?.balance_after, 50);
    assert.deepEqual(refundTx?.entry_transaction_ref, { __ref: entryTxPath });
    assert.deepEqual(refundTx?.registration_ref, {
      __ref: `registrations/${A}_t-cash`,
    });

    // (17) o ledger original de entrada permanece byte-for-byte inalterado.
    assert.deepEqual(await readDoc(entryTxPath), entryTxBefore);

    // (18) a inscrição preserva TODOS os campos originais e ganha os de refund.
    const reg = await readDoc(`registrations/${A}_t-cash`);
    assert.equal(reg?.status, "refunded");
    assert.equal(reg?.refunded_amount, ENTRY);
    assert.equal(reg?.refund_economy_type, "cash");
    assert.deepEqual(reg?.refund_transaction_ref, {
      __ref: `transactions/refund_${A}_t-cash`,
    });
    // transaction_ref original preservado e DIFERENTE do refund.
    assert.deepEqual(reg?.transaction_ref, { __ref: entryTxPath });
    assert.deepEqual(reg?.economy_type, regBefore?.economy_type);
    assert.deepEqual(reg?.entry_fee_snapshot, regBefore?.entry_fee_snapshot);
    assert.deepEqual(reg?.created_at, regBefore?.created_at);
  });

  it("(6) múltiplas inscrições cash reembolsam todas exatamente uma vez", async () => {
    await seedJoinedCash("t-cash", [A, B]);
    const res = await cancelTournamentHandler(
      { tournamentid: "t-cash" },
      adminCtx
    );
    assert.equal(res.refunded_registrations, 2);
    assert.equal(res.refunded_amount, 2 * ENTRY);
    assert.equal((await readDoc(`wallets/${A}`))?.balance, 50);
    assert.equal((await readDoc(`wallets/${B}`))?.balance, 50);
    assert.equal(await countTxWhere("entry_refund"), 2);
    assert.equal(
      (await readDoc("tournaments/t-cash"))?.current_participants,
      0
    );
  });

  it("(20) o preço ATUAL do torneio não altera o reembolso — vale o snapshot", async () => {
    await seedJoinedCash("t-cash", [A]);
    await db.collection("tournaments").doc("t-cash").update({ entry_fee: 50 });

    const res = await cancelTournamentHandler(
      { tournamentid: "t-cash" },
      adminCtx
    );
    assert.equal(res.refunded_amount, ENTRY); // 10, não 50
    assert.equal((await readDoc(`wallets/${A}`))?.balance, 50); // 40 + 10
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (7)(8)(10)(11)(14)(15)(17) Reembolso beta.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelTournament — reembolso beta", () => {
  it("(7)(10)(11)(14)(15)(17) uma inscrição beta: só beta_balance volta; cinco campos cash byte-idênticos; beta_refund sem campos cash", async () => {
    await seedJoinedBeta("t-beta", [A]);
    // Pós-join: beta 20; cash fields intactos do seed.
    const walletAfterJoin = await readDoc(`wallets/${A}`);
    const regBefore = await readDoc(`registrations/${A}_t-beta`);
    const entryTxPath = (regBefore?.transaction_ref as any).__ref as string;
    const entryTxBefore = await readDoc(entryTxPath);

    const res = await cancelTournamentHandler(
      { tournamentid: "t-beta" },
      adminCtx
    );
    assert.equal(res.economy_type, "beta_credit");
    assert.equal(res.refunded_amount, ENTRY);

    // (10)(11) beta 20→30; os CINCO campos cash + user_ref byte-idênticos.
    const wallet = await readDoc(`wallets/${A}`);
    assert.equal(wallet?.beta_balance, 30);
    assert.deepEqual(
      omit(wallet, "beta_balance"),
      omit(walletAfterJoin, "beta_balance")
    );

    // (14)(15) schema EXATO do beta_refund — sem previous_balance cash.
    const refundTx = await readDoc(`transactions/refund_${A}_t-beta`);
    assert.deepEqual(Object.keys(refundTx ?? {}).sort(), [
      "amount",
      "beta_balance_after",
      "beta_previous_balance",
      "category",
      "created_at",
      "display_name",
      "economy_type",
      "entry_transaction_ref",
      "external_id",
      "registration_ref",
      "status",
      "timestamp",
      "tournament_ref",
      "user_ref",
    ]);
    assert.equal(refundTx?.category, "beta_refund");
    assert.equal(refundTx?.economy_type, "beta_credit");
    assert.equal(refundTx?.beta_previous_balance, 20);
    assert.equal(refundTx?.beta_balance_after, 30);
    assert.equal(refundTx?.previous_balance, undefined);
    assert.equal(refundTx?.balance_after, undefined);

    // (17) ledger beta_entry_fee original intacto.
    assert.deepEqual(await readDoc(entryTxPath), entryTxBefore);
  });

  it("(8) múltiplas inscrições beta reembolsam todas", async () => {
    await seedJoinedBeta("t-beta", [A, B]);
    const res = await cancelTournamentHandler(
      { tournamentid: "t-beta" },
      adminCtx
    );
    assert.equal(res.refunded_registrations, 2);
    assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 30);
    assert.equal((await readDoc(`wallets/${B}`))?.beta_balance, 30);
    assert.equal(await countTxWhere("beta_refund"), 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (21)(22)(23)(24)(25)(26) Proveniência, legado e divergências.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelTournament — proveniência e legado", () => {
  it("(21) snapshot divergente do ledger original falha ATOMICAMENTE", async () => {
    await seedJoinedBeta("t-beta", [A]);
    // Adultera o snapshot da inscrição: 10 → 25 (≠ ledger original de 10).
    await db
      .collection("registrations")
      .doc(`${A}_t-beta`)
      .update({ entry_fee_snapshot: 25 });

    const wBefore = await readDoc(`wallets/${A}`);
    const tBefore = await readDoc("tournaments/t-beta");
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.deepEqual(await readDoc("tournaments/t-beta"), tBefore);
    assert.equal(await countTxWhere("beta_refund"), 0);
  });

  it("(22) economia/trava inválida ou divergente falha fechado", async () => {
    await seedTournament("t-corrupt", { economy_type: "CASH" });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-corrupt" }, adminCtx)
      ),
      "failed-precondition"
    );

    await seedTournament("t-flip", {
      economy_type: "cash",
      locked_economy_type: "beta_credit",
    });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-flip" }, adminCtx)
      ),
      "failed-precondition"
    );
  });

  it("(23)(24) inscrição divergente da economia, ou beta sem proveniência, falha", async () => {
    // Torneio beta com inscrição SEM proveniência (seed manual).
    await seedTournament("t-beta", {
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
      current_participants: 1,
      current_players: 1,
    });
    await seedUser(A);
    await seedWallet(A, { beta: 30 });
    await db.collection("registrations").doc(`${A}_t-beta`).set({
      user_ref: db.collection("users").doc(A),
      tournament_ref: db.collection("tournaments").doc("t-beta"),
      entry_fee: ENTRY,
      status: "registered",
    });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.equal(await countTxWhere("beta_refund"), 0);
  });

  /** Seeds a LEGACY cash scenario: tournament + registration sem proveniência. */
  async function seedLegacyCash(): Promise<void> {
    await seedTournament("t-legacy", {
      current_participants: 1,
      current_players: 1,
    });
    await seedUser(A);
    await seedWallet(A, { balance: 40, beta: 70, totalSpent: 13 });
    await db.collection("registrations").doc(`${A}_t-legacy`).set({
      user_ref: db.collection("users").doc(A),
      tournament_ref: db.collection("tournaments").doc("t-legacy"),
      entry_fee: ENTRY,
      status: "registered",
    });
  }

  /** Seeds a pre-economy entry_fee ledger with a random-style id. */
  async function seedLegacyEntryLedger(
    id: string,
    overrides: Record<string, unknown> = {}
  ): Promise<void> {
    await db
      .collection("transactions")
      .doc(id)
      .set({
        amount: ENTRY,
        category: "entry_fee",
        user_ref: db.collection("users").doc(A),
        display_name: "Entrada em torneio",
        tournament_ref: db.collection("tournaments").doc("t-legacy"),
        previous_balance: 50,
        balance_after: 40,
        timestamp: admin.firestore.Timestamp.fromMillis(2_000_000),
        status: "completed",
        external_id: id,
        ...overrides,
      });
  }

  it("(25) legado cash SEGURO: o ledger original é LOCALIZADO, validado e referenciado", async () => {
    await seedLegacyCash();
    await seedLegacyEntryLedger("entryfee_legacy_1");
    const entryBefore = await readDoc("transactions/entryfee_legacy_1");

    const res = await cancelTournamentHandler(
      { tournamentid: "t-legacy" },
      adminCtx
    );
    assert.equal(res.refunded_amount, ENTRY);
    const wallet = await readDoc(`wallets/${A}`);
    assert.equal(wallet?.balance, 50);
    assert.equal(wallet?.total_spent, 3);
    assert.equal(wallet?.beta_balance, 70);

    // (F3-8) o reembolso referencia o ledger original validado — nunca null.
    const refundTx = await readDoc(`transactions/refund_${A}_t-legacy`);
    assert.deepEqual(refundTx?.entry_transaction_ref, {
      __ref: "transactions/entryfee_legacy_1",
    });
    assert.equal(refundTx?.category, "entry_refund");
    // (17) o ledger original permanece byte-for-byte inalterado.
    assert.deepEqual(
      await readDoc("transactions/entryfee_legacy_1"),
      entryBefore
    );
  });

  it("(F3-2) legado sem ledger original falha fechado, estado intacto", async () => {
    await seedLegacyCash(); // NENHUM ledger seeded
    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-legacy" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal((await readDoc("tournaments/t-legacy"))?.status, "open");
    assert.equal(await countTxWhere("entry_refund"), 0);
  });

  it("(F3-3) ledger duplicado é AMBÍGUO: falha fechado", async () => {
    await seedLegacyCash();
    await seedLegacyEntryLedger("entryfee_legacy_1");
    await seedLegacyEntryLedger("entryfee_legacy_2"); // duplicata
    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-legacy" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal(await countTxWhere("entry_refund"), 0);
  });

  it("(F3-4) valor divergente entre ledger e inscrição falha fechado", async () => {
    await seedLegacyCash();
    await seedLegacyEntryLedger("entryfee_legacy_1", { amount: 8 });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-legacy" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.equal(await countTxWhere("entry_refund"), 0);
  });

  it("(F3-5,6,7) ledger de outro usuário, outro torneio ou outra categoria não prova a cobrança", async () => {
    await seedLegacyCash();
    // Outro usuário.
    await seedLegacyEntryLedger("entryfee_other_user", {
      user_ref: db.collection("users").doc(B),
    });
    // Outro torneio.
    await seedLegacyEntryLedger("entryfee_other_t", {
      tournament_ref: db.collection("tournaments").doc("t-other"),
    });
    // Outra categoria.
    await seedLegacyEntryLedger("deposit_x", { category: "deposit" });

    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-legacy" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal((await readDoc("tournaments/t-legacy"))?.status, "open");
    assert.equal(await countTxWhere("entry_refund"), 0);
  });

  it("(26) legado AMBÍGUO falha fechado (entry_fee ausente/inválido)", async () => {
    await seedTournament("t-legacy", {
      current_participants: 1,
      current_players: 1,
    });
    await seedUser(A);
    await seedWallet(A, { balance: 40 });
    await db.collection("registrations").doc(`${A}_t-legacy`).set({
      user_ref: db.collection("users").doc(A),
      tournament_ref: db.collection("tournaments").doc("t-legacy"),
      status: "registered", // sem entry_fee
    });
    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-legacy" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal((await readDoc("tournaments/t-legacy"))?.status, "open");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (27)(28)(29)(46)(47)(48) Guardas de carteira, atomicidade e limites.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelTournament — guardas atômicas", () => {
  it("(27) total_spent insuficiente falha atomicamente", async () => {
    await seedJoinedCash("t-cash", [A]);
    // Adultera total_spent para menos que o reembolso.
    await db.collection("wallets").doc(A).update({ total_spent: 4 });

    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-cash" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal((await readDoc("tournaments/t-cash"))?.status, "open");
    assert.equal(await countTxWhere("entry_refund"), 0);
  });

  it("(28) overflow cash falha atomicamente", async () => {
    await seedJoinedCash("t-cash", [A]);
    await db
      .collection("wallets")
      .doc(A)
      .update({ balance: 10_000_000 }); // teto
    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-cash" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal(await countTxWhere("entry_refund"), 0);
  });

  it("(29) overflow beta falha atomicamente", async () => {
    await seedJoinedBeta("t-beta", [A]);
    await db.collection("wallets").doc(A).update({ beta_balance: 10_000_000 });
    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal(await countTxWhere("beta_refund"), 0);
  });

  it("(46) falha intermediária (uma carteira ausente) não deixa NENHUMA escrita parcial", async () => {
    await seedJoinedBeta("t-beta", [A, B]);
    // Remove a carteira de B: a validação pré-escrita falha o todo.
    await db.collection("wallets").doc(B).delete();

    const wABefore = await readDoc(`wallets/${A}`);
    const regABefore = await readDoc(`registrations/${A}_t-beta`);
    const regBBefore = await readDoc(`registrations/${B}_t-beta`);
    const tBefore = await readDoc("tournaments/t-beta");

    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx)
      ),
      "not-found"
    );

    assert.deepEqual(await readDoc(`wallets/${A}`), wABefore);
    assert.deepEqual(await readDoc(`registrations/${A}_t-beta`), regABefore);
    assert.deepEqual(await readDoc(`registrations/${B}_t-beta`), regBBefore);
    assert.deepEqual(await readDoc("tournaments/t-beta"), tBefore);
    assert.equal(await countTxWhere("beta_refund"), 0);
  });

  it("(47) contagem de participantes divergente das inscrições falha", async () => {
    await seedJoinedBeta("t-beta", [A]);
    await db
      .collection("tournaments")
      .doc("t-beta")
      .update({ current_participants: 5, current_players: 5 });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.equal(await countTxWhere("beta_refund"), 0);
  });

  it("(48) acima do teto atômico (151 inscrições) recusa ANTES de qualquer escrita", async () => {
    await seedTournament("t-big", {
      current_participants: 151,
      current_players: 151,
      max_participants: 200,
      max_players: 200,
    });
    const batch: Array<Promise<unknown>> = [];
    for (let i = 0; i < 151; i++) {
      batch.push(
        db
          .collection("registrations")
          .doc(`u${i}_t-big`)
          .set({
            user_ref: db.collection("users").doc(`u${i}`),
            tournament_ref: db.collection("tournaments").doc("t-big"),
            entry_fee: ENTRY,
            status: "registered",
          })
      );
    }
    await Promise.all(batch);

    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-big" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.equal((await readDoc("tournaments/t-big"))?.status, "open");
    assert.equal(await countTxWhere("entry_refund"), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (30)(31)(32)(33)(34) Idempotência e concorrência.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelTournament — replay e concorrência", () => {
  it("(30) replay idêntico: idempotent:true, zero escrita, zero timestamps novos", async () => {
    await seedJoinedBeta("t-beta", [A]);
    const first = await cancelTournamentHandler(
      { tournamentid: "t-beta" },
      adminCtx
    );
    assert.equal(first.idempotent, false);

    const tAfter = await readDoc("tournaments/t-beta");
    const wAfter = await readDoc(`wallets/${A}`);
    const regAfter = await readDoc(`registrations/${A}_t-beta`);
    const txAfter = await readDoc(`transactions/refund_${A}_t-beta`);

    const replay = await cancelTournamentHandler(
      { tournamentid: "t-beta" },
      adminCtx
    );
    assert.equal(replay.success, true);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.refunded_registrations, 1);
    assert.equal(replay.refunded_amount, ENTRY);

    assert.deepEqual(await readDoc("tournaments/t-beta"), tAfter);
    assert.deepEqual(await readDoc(`wallets/${A}`), wAfter);
    assert.deepEqual(await readDoc(`registrations/${A}_t-beta`), regAfter);
    assert.deepEqual(await readDoc(`transactions/refund_${A}_t-beta`), txAfter);
    assert.equal(await countTxWhere("beta_refund"), 1);
  });

  it("(31) replay com ledger de reembolso divergente falha SEM reparo", async () => {
    await seedJoinedBeta("t-beta", [A]);
    await cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx);
    // Adultera o ledger persistido.
    await db
      .collection("transactions")
      .doc(`refund_${A}_t-beta`)
      .update({ amount: 99 });

    const txBefore = await readDoc(`transactions/refund_${A}_t-beta`);
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx)
      ),
      "failed-precondition"
    );
    // Nenhum reparo automático: o valor adulterado continua lá.
    assert.deepEqual(await readDoc(`transactions/refund_${A}_t-beta`), txBefore);
  });

  it("(32) cancelamentos concorrentes reembolsam exatamente uma vez", async () => {
    await seedJoinedBeta("t-beta", [A]);
    const results = await Promise.allSettled([
      cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx),
      cancelTournamentHandler({ tournamentid: "t-beta" }, adminCtx),
    ]);
    for (const r of results) assert.equal(r.status, "fulfilled");
    const flags = results.map(
      (r) => (r as PromiseFulfilledResult<any>).value.idempotent
    );
    assert.equal(flags.filter((f) => f === false).length, 1);
    assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 30); // uma vez
    assert.equal(await countTxWhere("beta_refund"), 1);
  });

  it("(33) cancelamento concorrente com join: nunca sobra inscrição paga sem reembolso", async () => {
    await seedTournament("t-race", {
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });
    await seedUser(A);
    await seedWallet(A, { beta: 30 });

    await Promise.allSettled([
      cancelTournamentHandler({ tournamentid: "t-race" }, adminCtx),
      jointournamentRun({ tournamentid: "t-race" }, ctxOf(A)),
    ]);

    // Invariante pós-corrida, para QUALQUER intercalação:
    const t = await readDoc("tournaments/t-race");
    assert.equal(t?.status, "cancelled");
    // Nenhuma inscrição 'registered' sobrevive num torneio cancelado…
    const regs = await db
      .collection("registrations")
      .where(
        "tournament_ref",
        "==",
        db.collection("tournaments").doc("t-race")
      )
      .get();
    for (const doc of regs.docs) {
      assert.equal(doc.data().status, "refunded");
    }
    // …e o saldo do jogador termina íntegro (debitado+reembolsado ou intocado).
    assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 30);
  });

  it("(34) cancelamento concorrente com start: exatamente UMA transição vence", async () => {
    await seedJoinedBeta("t-race", [A]);
    // Sala publicada para o start poder vencer.
    await db.collection("tournament_rooms").doc("t-race").set({
      tournament_ref: db.collection("tournaments").doc("t-race"),
      room_id: "R-1",
      room_password: "P-1",
    });

    const [cancelRes, startRes] = await Promise.allSettled([
      cancelTournamentHandler({ tournamentid: "t-race" }, adminCtx),
      startTournamentHandler({ tournamentid: "t-race" }, adminCtx),
    ]);

    const fulfilled = [cancelRes, startRes].filter(
      (r) => r.status === "fulfilled"
    );
    assert.equal(fulfilled.length, 1, "exactly one transition wins");

    const status = (await readDoc("tournaments/t-race"))?.status;
    if (cancelRes.status === "fulfilled") {
      assert.equal(status, "cancelled");
      assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 30);
      assert.equal(await countTxWhere("beta_refund"), 1);
    } else {
      assert.equal(status, "in_progress");
      assert.equal(await countTxWhere("beta_refund"), 0);
      assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 20);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (35)-(41) Estado terminal e bloqueios.
// ─────────────────────────────────────────────────────────────────────────────

describe("cancelTournament — terminalidade", () => {
  it("(35) torneio iniciado não pode ser cancelado", async () => {
    await seedTournament("t-started", { status: "in_progress" });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-started" }, adminCtx)
      ),
      "failed-precondition"
    );
  });

  it("(36) evidência de liquidação bloqueia mesmo com status adulterado para 'open'", async () => {
    // Caso 1: result persistido com status "open" (adulterado).
    await seedTournament("t-tampered", {
      status: "open",
      result: { winner_uid: A, prize: 100 },
    });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-tampered" }, adminCtx)
      ),
      "failed-precondition"
    );

    // Caso 2: prize tx determinística persistida, sem result e status "open".
    await seedTournament("t-tampered2", { status: "open" });
    await db.collection("transactions").doc("prize_t-tampered2").set({
      category: "prize",
      amount: 100,
    });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-tampered2" }, adminCtx)
      ),
      "failed-precondition"
    );

    // Caso 3: completed de verdade.
    await seedTournament("t-done", { status: "completed" });
    assert.equal(
      await expectFailure(() =>
        cancelTournamentHandler({ tournamentid: "t-done" }, adminCtx)
      ),
      "failed-precondition"
    );
  });

  it("(37)(38)(39) cancelled rejeita join, start e declare/payprize", async () => {
    await seedJoinedBeta("t-term", [A]);
    await cancelTournamentHandler({ tournamentid: "t-term" }, adminCtx);

    // (37) novo jogador não entra.
    await seedUser(B);
    await seedWallet(B, { beta: 30 });
    assert.equal(
      await expectFailure(() =>
        jointournamentRun({ tournamentid: "t-term" }, ctxOf(B))
      ),
      "failed-precondition"
    );
    assert.equal((await readDoc(`wallets/${B}`))?.beta_balance, 30);

    // (38) não inicia.
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t-term" }, adminCtx)
      ),
      "failed-precondition"
    );

    // (39) não declara/paga (payprize é o MESMO handler).
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t-term", winneruid: A },
          adminCtx
        )
      ),
      "failed-precondition"
    );
    assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 30);
    assert.equal(await countTxWhere("beta_prize"), 0);
  });

  it("(40) inscrição reembolsada NÃO obtém credenciais de sala", async () => {
    await seedJoinedBeta("t-term", [A]);
    // Sala publicada ANTES do cancelamento (não é apagada).
    await db.collection("tournament_rooms").doc("t-term").set({
      tournament_ref: db.collection("tournaments").doc("t-term"),
      room_id: "R-1",
      room_password: "P-1",
    });
    await cancelTournamentHandler({ tournamentid: "t-term" }, adminCtx);

    // A sala continua existindo (não deletada)…
    assert.notEqual(await readDoc("tournament_rooms/t-term"), null);
    // …mas a inscrição refunded é tratada como não-inscrito.
    assert.equal(
      await expectFailure(() =>
        getTournamentRoomHandler({ tournamentid: "t-term" }, ctxOf(A))
      ),
      "permission-denied"
    );
  });

  it("(41) setTournamentRoom rejeita torneio cancelado (sem deletar a sala)", async () => {
    await seedTournament("t-term", {
      economy_type: "cash",
      locked_economy_type: "cash",
    });
    await cancelTournamentHandler({ tournamentid: "t-term" }, adminCtx);
    assert.equal(
      await expectFailure(() =>
        setTournamentRoomHandler(
          { tournamentid: "t-term", roomid: "R-2", roompassword: "P-2" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
    assert.equal(await readDoc("tournament_rooms/t-term"), null);
  });
});
