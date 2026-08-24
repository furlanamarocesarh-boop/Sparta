import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { DEMO_PROJECT_REFUSED_MESSAGE } from "../../src/domain/demoProject.js";

/**
 * Behavioral (execution) tests for `testdepositHandler`, run against the LOCAL
 * Firestore emulator via the Admin SDK — proving the REAL side effects of the
 * two gates, not just the codes they throw.
 *
 * The property that matters is asymmetric, so both halves are proven here:
 *  - REFUSED  => the wallet, the ledger and the whole database are byte-identical
 *                afterwards. Not "no error surfaced": nothing was written.
 *  - ALLOWED  => the credit lands exactly once, on the CALLER'S OWN wallet, and a
 *                replay of the same `externalid` cannot double it.
 *
 * NEVER touches production:
 *  - it runs only under `npm run test:rules`, which sets FIRESTORE_EMULATOR_HOST
 *    (the `before` hook asserts it is present and aborts otherwise);
 *  - it uses a DISTINCT emulator project id, so it shares no data with the other
 *    suites running in the same emulator.
 */

type Handler = (
  data: any,
  context: any,
  options?: { projectCandidates?: readonly unknown[] }
) => Promise<Record<string, unknown>>;

const PROJECT_ID = "demo-sparta-battle-testdeposit-handlers";
const REAL = "sparta-battle";

/**
 * The gate's input is injected EXPLICITLY in every test, so each case states the
 * environment it is proving instead of inheriting one. `DEMO` deliberately
 * differs from PROJECT_ID: any `demo-` project must be accepted, and nothing may
 * depend on this suite's own namespace.
 */
const DEMO = "demo-sparta-battle";
const ALLOWED = { projectCandidates: [DEMO] };
const PRODUCTION = { projectCandidates: [REAL] };

let testdepositHandler: Handler;
let db: admin.firestore.Firestore;

const ADMIN = "testdeposit-admin";
const adminCtx = { auth: { uid: ADMIN, token: { admin: true } } };
const playerCtx = (uid: string) => ({ auth: { uid, token: {} } });

const COLLECTIONS = ["wallets", "transactions", "users"] as const;

interface Failure {
  code: string;
  message: string;
}

async function expectFailure(fn: () => Promise<unknown>): Promise<Failure> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : "NO_CODE",
      message: typeof e.message === "string" ? e.message : "",
    };
  }
  return assert.fail("esperava uma recusa, mas a chamada resolveu");
}

/** Full normalized dump of every collection this handler could touch. */
async function snapshotAll(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const col of COLLECTIONS) {
    const snap = await db.collection(col).get();
    for (const doc of snap.docs) out[`${col}/${doc.id}`] = normalize(doc.data());
  }
  return out;
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

async function clearAll(): Promise<void> {
  for (const col of COLLECTIONS) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  // O caixa da plataforma, reposto a cada teste.
  //
  // A liquidação passou a exigir que a plataforma consiga cobrir a premiação:
  // um prêmio fixo acima do arrecadado sai do caixa, e o caixa começa vazio.
  // Estas suítes premiam generosamente contra pools pequenos, então cada uma
  // aporta antes — exatamente o que o operador terá de fazer em produção.
  await Promise.all([
    db
      .collection("house")
      .doc("cash")
      .set({ balance_centavos: 100_000_00, economy_type: "cash" }),
    db
      .collection("house")
      .doc("beta_credit")
      .set({ balance_centavos: 100_000_00, economy_type: "beta_credit" }),
  ]);
}

async function seedWallet(uid: string, balance: number): Promise<void> {
  await db
    .collection("wallets")
    .doc(uid)
    .set({
      balance,
      total_deposited: 0,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
      user_ref: db.collection("users").doc(uid),
    });
}

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  const mod = (await import("../../src/index.js")) as unknown as {
    testdepositHandler: Handler;
  };
  testdepositHandler = mod.testdepositHandler;
  db = admin.firestore();
});

beforeEach(async () => {
  await clearAll();
  await seedWallet(ADMIN, 0);
});

describe("testdeposit — recusa não escreve NADA", () => {
  it("projeto real: banco byte-idêntico antes e depois", async () => {
    const before = await snapshotAll();

    const failure = await expectFailure(() =>
      testdepositHandler({ amount: 100 }, adminCtx, PRODUCTION)
    );

    assert.equal(failure.code, "failed-precondition");
    assert.equal(failure.message, DEMO_PROJECT_REFUSED_MESSAGE);
    assert.deepEqual(await snapshotAll(), before, "nenhuma escrita é permitida");
    assert.equal((await db.collection("transactions").get()).size, 0);
  });

  it("projectId ausente: banco byte-idêntico antes e depois", async () => {
    const before = await snapshotAll();

    const failure = await expectFailure(() =>
      testdepositHandler({ amount: 100 }, adminCtx, { projectCandidates: [] })
    );

    assert.equal(failure.code, "failed-precondition");
    assert.deepEqual(await snapshotAll(), before);
  });

  it("projectId ambíguo: banco byte-idêntico antes e depois", async () => {
    const before = await snapshotAll();

    const failure = await expectFailure(() =>
      testdepositHandler({ amount: 100 }, adminCtx, {
        projectCandidates: [DEMO, REAL],
      })
    );

    assert.equal(failure.code, "failed-precondition");
    assert.deepEqual(await snapshotAll(), before);
  });

  it("um externalid escolhido pelo cliente não é reservado na recusa", async () => {
    // A recusa não pode deixar rastro nem sequer no espaço de nomes do ledger.
    await expectFailure(() =>
      testdepositHandler(
        { amount: 100, externalid: "deposit-recusado" },
        adminCtx,
        PRODUCTION
      )
    );

    const doc = await db.collection("transactions").doc("deposit-recusado").get();
    assert.equal(doc.exists, false);
  });

  it("não autenticado e não admin também não escrevem", async () => {
    const before = await snapshotAll();

    assert.equal(
      (await expectFailure(() => testdepositHandler({ amount: 100 }, {}, ALLOWED)))
        .code,
      "unauthenticated"
    );
    assert.equal(
      (
        await expectFailure(() =>
          testdepositHandler({ amount: 100 }, playerCtx("player-1"), ALLOWED)
        )
      ).code,
      "permission-denied"
    );

    assert.deepEqual(await snapshotAll(), before);
  });
});

describe("testdeposit — projeto demo é autorizado", () => {
  it("credita a carteira do próprio caller e escreve um ledger correto", async () => {
    const result = await testdepositHandler(
      { amount: 100, externalid: "deposit-ok-1" },
      adminCtx,
      ALLOWED
    );

    assert.equal(result.success, true);
    assert.equal(result.amount, 100);
    assert.equal(result.externalid, "deposit-ok-1");

    const wallet = (await db.collection("wallets").doc(ADMIN).get()).data() ?? {};
    assert.equal(wallet.balance, 100);
    assert.equal(wallet.total_deposited, 100);

    const tx = (
      await db.collection("transactions").doc("deposit-ok-1").get()
    ).data() ?? {};
    assert.equal(tx.amount, 100);
    assert.equal(tx.category, "deposit");
    assert.equal(tx.previous_balance, 0);
    assert.equal(tx.balance_after, 100);
    assert.equal(tx.status, "completed");
    assert.deepEqual(normalize(tx.user_ref), { __ref: `users/${ADMIN}` });
  });

  it("qualquer projeto demo serve — não só o desta suíte", async () => {
    const result = await testdepositHandler({ amount: 25 }, adminCtx, {
      projectCandidates: [PROJECT_ID],
    });
    assert.equal(result.success, true);
    assert.equal(
      (await db.collection("wallets").doc(ADMIN).get()).data()?.balance,
      25
    );
  });

  it("credita SOMENTE o caller, mesmo com outra carteira no payload", async () => {
    await seedWallet("outro-jogador", 0);

    await testdepositHandler(
      { amount: 50, uid: "outro-jogador", user_id: "outro-jogador" },
      adminCtx,
      ALLOWED
    );

    assert.equal(
      (await db.collection("wallets").doc(ADMIN).get()).data()?.balance,
      50,
      "o caller foi creditado"
    );
    assert.equal(
      (await db.collection("wallets").doc("outro-jogador").get()).data()?.balance,
      0,
      "a carteira indicada no payload NÃO pode ser creditada"
    );
  });
});

describe("testdeposit — as validações financeiras seguem intactas", () => {
  it("o replay do mesmo externalid é recusado sem creditar duas vezes", async () => {
    await testdepositHandler({ amount: 100, externalid: "dep-replay" }, adminCtx, ALLOWED);
    const afterFirst = await snapshotAll();

    const failure = await expectFailure(() =>
      testdepositHandler({ amount: 100, externalid: "dep-replay" }, adminCtx, ALLOWED)
    );

    assert.equal(failure.code, "already-exists");
    assert.deepEqual(await snapshotAll(), afterFirst, "o replay não altera nada");
    assert.equal(
      (await db.collection("wallets").doc(ADMIN).get()).data()?.balance,
      100,
      "o saldo foi creditado exatamente uma vez"
    );
  });

  it("valores inválidos continuam sendo recusados no projeto demo", async () => {
    for (const amount of [0, -1, "100", null, undefined, 10.005]) {
      const before = await snapshotAll();
      const failure = await expectFailure(() =>
        testdepositHandler({ amount }, adminCtx, ALLOWED)
      );
      assert.equal(failure.code, "invalid-argument", String(amount));
      assert.deepEqual(await snapshotAll(), before, String(amount));
    }
  });

  it("depósitos sucessivos acumulam exatamente", async () => {
    await testdepositHandler({ amount: 10.5 }, adminCtx, ALLOWED);
    await testdepositHandler({ amount: 20.25 }, adminCtx, ALLOWED);

    const wallet = (await db.collection("wallets").doc(ADMIN).get()).data() ?? {};
    assert.equal(wallet.balance, 30.75);
    assert.equal(wallet.total_deposited, 30.75);
  });
});
