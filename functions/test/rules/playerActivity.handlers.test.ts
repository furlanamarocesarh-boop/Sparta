import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

import {
  ACTIVITY_COLLECTION,
  activityDocumentId,
  businessDayKey,
} from "../../src/domain/playerActivity.js";

/**
 * Behavioral (execution) tests for `recordDailyAppOpen`, run against the LOCAL
 * Firestore emulator via the Admin SDK — proving the real Firestore side
 * effects: authentication, uid-spoofing rejection, exactly-one record per
 * business day, same-day idempotency, next-day separation, date validation, and
 * the branch's core promise: NO financial document is ever read or written.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 */

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let recordDailyAppOpenHandler: Handler;
let db: admin.firestore.Firestore;

const PLAYER = "player-activity-1";
const OTHER = "player-activity-2";

const playerCtx = { auth: { uid: PLAYER, token: {} } };
const otherCtx = { auth: { uid: OTHER, token: {} } };

/** The business day the handler will use for "now". */
function today(): string {
  return businessDayKey(new Date());
}

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
    ACTIVITY_COLLECTION,
    "wallets",
    "transactions",
    "users",
    "registrations",
    "tournaments",
    "withdrawals",
  ]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }
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

async function countActivity(): Promise<number> {
  return (await db.collection(ACTIVITY_COLLECTION).get()).size;
}

/** Seeds the financial documents this flow must never touch. */
async function seedFinancialWorld(): Promise<void> {
  const userRef = db.collection("users").doc(PLAYER);
  await db.collection("users").doc(PLAYER).set({ email: "p@e2e.test" });
  await db.collection("wallets").doc(PLAYER).set({
    balance: 0,
    beta_balance: 50,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
    user_ref: userRef,
  });
  await db.collection("transactions").doc("beta_grant_seed").set({
    amount: 50,
    category: "beta_grant",
    economy_type: "beta_credit",
    status: "completed",
    user_ref: userRef,
  });
  await db.collection("tournaments").doc("t-1").set({
    name: "Torneio",
    status: "open",
    economy_type: "beta_credit",
    entry_fee: 5,
    prize: 20,
    current_participants: 0,
    max_participants: 50,
    current_players: 0,
    max_players: 50,
  });
}

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-activity-handlers";
  const mod = (await import("../../src/index.js")) as unknown as {
    recordDailyAppOpenHandler: Handler;
  };
  recordDailyAppOpenHandler = mod.recordDailyAppOpenHandler;
  db = admin.firestore();
});

beforeEach(clearAll);

describe("recordDailyAppOpen — autenticação e payload", () => {
  it("não autenticado é rejeitado", async () => {
    assert.equal(
      await expectFailure(() => recordDailyAppOpenHandler({}, {})),
      "unauthenticated"
    );
    assert.equal(
      await expectFailure(() => recordDailyAppOpenHandler({}, { auth: null })),
      "unauthenticated"
    );
    assert.equal(await countActivity(), 0);
  });

  it("o UID NÃO pode ser forjado pelo payload", async () => {
    // `uid` não está na allowlist: mandar um é payload inválido, não um campo
    // silenciosamente ignorado.
    assert.equal(
      await expectFailure(() =>
        recordDailyAppOpenHandler({ uid: OTHER }, playerCtx)
      ),
      "invalid-argument"
    );
    assert.equal(await countActivity(), 0);
  });

  it("rejeita qualquer campo fora da allowlist", async () => {
    for (const bad of [
      { user_ref: "users/victim" },
      { activity_day: "2020-01-01" },
      { granted_by: "someone" },
      { first_opened_at: 1 },
    ]) {
      assert.equal(
        await expectFailure(() => recordDailyAppOpenHandler(bad, playerCtx)),
        "invalid-argument"
      );
    }
    assert.equal(await countActivity(), 0);
  });

  it("aceita um payload vazio, ausente ou só com os campos opcionais", async () => {
    const r1 = await recordDailyAppOpenHandler({}, playerCtx);
    assert.equal(r1.success, true);
    assert.equal(r1.already_recorded, false);

    await clearAll();
    const r2 = await recordDailyAppOpenHandler(undefined, playerCtx);
    assert.equal(r2.success, true);

    await clearAll();
    const r3 = await recordDailyAppOpenHandler(
      { client_day: today(), client_timezone_offset_minutes: -180 },
      playerCtx
    );
    assert.equal(r3.success, true);
  });
});

describe("recordDailyAppOpen — um registro determinístico por dia", () => {
  it("o primeiro acesso do dia cria EXATAMENTE um registro determinístico", async () => {
    const result = await recordDailyAppOpenHandler({}, playerCtx);

    const day = today();
    assert.equal(result.success, true);
    assert.equal(result.already_recorded, false);
    assert.equal(result.activity_day, day);
    assert.equal(result.timezone, "America/Sao_Paulo");

    assert.equal(await countActivity(), 1);

    const id = activityDocumentId(PLAYER, day);
    const doc = await readDoc(`${ACTIVITY_COLLECTION}/${id}`);
    assert.ok(doc, "o documento determinístico deve existir");
    assert.equal(doc!.uid, PLAYER);
    assert.equal(doc!.activity_day, day);
    assert.equal(doc!.timezone, "America/Sao_Paulo");
    assert.deepEqual(doc!.user_ref, { __ref: `users/${PLAYER}` });
    assert.ok(doc!.first_opened_at, "first_opened_at deve ser um server timestamp");
  });

  it("o replay do MESMO dia é idempotente: nenhuma escrita nova", async () => {
    await recordDailyAppOpenHandler({}, playerCtx);
    const day = today();
    const id = activityDocumentId(PLAYER, day);
    const first = await readDoc(`${ACTIVITY_COLLECTION}/${id}`);

    for (let i = 0; i < 3; i++) {
      const replay = await recordDailyAppOpenHandler({}, playerCtx);
      assert.equal(replay.success, true);
      assert.equal(replay.already_recorded, true);
    }

    assert.equal(await countActivity(), 1);
    // Byte-idêntico: first_opened_at continua apontando para o PRIMEIRO acesso.
    assert.deepEqual(await readDoc(`${ACTIVITY_COLLECTION}/${id}`), first);
  });

  it("chamadas concorrentes do mesmo dia ainda produzem UM registro", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => recordDailyAppOpenHandler({}, playerCtx))
    );
    assert.ok(results.some((r) => r.status === "fulfilled"));
    assert.equal(await countActivity(), 1);
  });

  it("um registro de OUTRO dia não impede o de hoje; os dois coexistem", async () => {
    // Semeia ontem exatamente como o handler o teria escrito.
    const yesterdayKey = businessDayKey(
      new Date(Date.now() - 24 * 60 * 60 * 1000)
    );
    const day = today();
    assert.notEqual(yesterdayKey, day);

    await db
      .collection(ACTIVITY_COLLECTION)
      .doc(activityDocumentId(PLAYER, yesterdayKey))
      .set({
        uid: PLAYER,
        user_ref: db.collection("users").doc(PLAYER),
        activity_day: yesterdayKey,
        timezone: "America/Sao_Paulo",
        first_opened_at: admin.firestore.FieldValue.serverTimestamp(),
      });

    const result = await recordDailyAppOpenHandler({}, playerCtx);
    assert.equal(result.already_recorded, false);

    assert.equal(await countActivity(), 2);
    assert.ok(
      await readDoc(
        `${ACTIVITY_COLLECTION}/${activityDocumentId(PLAYER, yesterdayKey)}`
      )
    );
    assert.ok(
      await readDoc(`${ACTIVITY_COLLECTION}/${activityDocumentId(PLAYER, day)}`)
    );
  });

  it("jogadores diferentes têm registros separados no mesmo dia", async () => {
    await recordDailyAppOpenHandler({}, playerCtx);
    await recordDailyAppOpenHandler({}, otherCtx);

    const day = today();
    assert.equal(await countActivity(), 2);
    const mine = await readDoc(
      `${ACTIVITY_COLLECTION}/${activityDocumentId(PLAYER, day)}`
    );
    const theirs = await readDoc(
      `${ACTIVITY_COLLECTION}/${activityDocumentId(OTHER, day)}`
    );
    assert.equal(mine!.uid, PLAYER);
    assert.equal(theirs!.uid, OTHER);
  });

  it("um documento existente DIVERGENTE falha fechado, sem sobrescrever", async () => {
    const day = today();
    const id = activityDocumentId(PLAYER, day);
    // Documento corrompido: vive sob o id do PLAYER mas aponta para outro uid.
    await db.collection(ACTIVITY_COLLECTION).doc(id).set({
      uid: OTHER,
      user_ref: db.collection("users").doc(OTHER),
      activity_day: day,
    });
    const before = await readDoc(`${ACTIVITY_COLLECTION}/${id}`);

    assert.equal(
      await expectFailure(() => recordDailyAppOpenHandler({}, playerCtx)),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`${ACTIVITY_COLLECTION}/${id}`), before);
  });
});

describe("recordDailyAppOpen — validação de data e fuso do cliente", () => {
  it("rejeita datas malformadas", async () => {
    for (const bad of ["28/07/2026", "2026-7-28", "hoje", "", "   "]) {
      assert.equal(
        await expectFailure(() =>
          recordDailyAppOpenHandler({ client_day: bad }, playerCtx)
        ),
        "invalid-argument"
      );
    }
    assert.equal(await countActivity(), 0);
  });

  it("rejeita datas bem formadas que não existem", async () => {
    assert.equal(
      await expectFailure(() =>
        recordDailyAppOpenHandler({ client_day: "2026-02-30" }, playerCtx)
      ),
      "invalid-argument"
    );
  });

  it("rejeita um relógio implausivelmente distante do servidor", async () => {
    assert.equal(
      await expectFailure(() =>
        recordDailyAppOpenHandler({ client_day: "1999-01-01" }, playerCtx)
      ),
      "invalid-argument"
    );
    assert.equal(
      await expectFailure(() =>
        recordDailyAppOpenHandler({ client_day: "2099-01-01" }, playerCtx)
      ),
      "failed-precondition"
    );
    assert.equal(await countActivity(), 0);
  });

  it("rejeita um offset de fuso inválido", async () => {
    for (const bad of [-721, 841, -180.5, "-180"]) {
      assert.equal(
        await expectFailure(() =>
          recordDailyAppOpenHandler(
            { client_timezone_offset_minutes: bad },
            playerCtx
          )
        ),
        "invalid-argument"
      );
    }
    assert.equal(await countActivity(), 0);
  });

  it("a data do cliente NUNCA escolhe o documento — o servidor decide", async () => {
    // Um dia de deriva é tolerado, mas o registro vai para o dia do SERVIDOR.
    const serverDay = today();
    const driftedDay = businessDayKey(
      new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    const result = await recordDailyAppOpenHandler(
      { client_day: driftedDay },
      playerCtx
    );

    assert.equal(result.activity_day, serverDay);
    assert.equal(await countActivity(), 1);
    const doc = await readDoc(
      `${ACTIVITY_COLLECTION}/${activityDocumentId(PLAYER, serverDay)}`
    );
    assert.ok(doc, "o registro deve viver sob o dia do servidor");
    assert.equal(doc!.activity_day, serverDay);
    // O valor do cliente é guardado apenas como diagnóstico.
    assert.equal(doc!.client_day, driftedDay);
  });
});

describe("recordDailyAppOpen — isolamento financeiro total", () => {
  it("NÃO lê nem escreve carteira, transação, inscrição ou torneio", async () => {
    await seedFinancialWorld();

    const walletBefore = await readDoc(`wallets/${PLAYER}`);
    const txBefore = await readDoc("transactions/beta_grant_seed");
    const tournamentBefore = await readDoc("tournaments/t-1");
    const userBefore = await readDoc(`users/${PLAYER}`);

    await recordDailyAppOpenHandler({}, playerCtx);
    await recordDailyAppOpenHandler({}, playerCtx);

    assert.deepEqual(await readDoc(`wallets/${PLAYER}`), walletBefore);
    assert.deepEqual(await readDoc("transactions/beta_grant_seed"), txBefore);
    assert.deepEqual(await readDoc("tournaments/t-1"), tournamentBefore);
    assert.deepEqual(await readDoc(`users/${PLAYER}`), userBefore);

    // Nenhuma coleção financeira ganhou documentos.
    assert.equal((await db.collection("wallets").get()).size, 1);
    assert.equal((await db.collection("transactions").get()).size, 1);
    assert.equal((await db.collection("registrations").get()).size, 0);
    assert.equal((await db.collection("withdrawals").get()).size, 0);
    assert.equal((await db.collection("tournaments").get()).size, 1);
    // E exatamente um registro de atividade foi criado.
    assert.equal(await countActivity(), 1);
  });

  it("o registro de atividade não carrega valor, saldo nem economia", async () => {
    await recordDailyAppOpenHandler({}, playerCtx);
    const doc = await readDoc(
      `${ACTIVITY_COLLECTION}/${activityDocumentId(PLAYER, today())}`
    );
    for (const forbidden of [
      "amount",
      "balance",
      "beta_balance",
      "economy_type",
      "category",
      "tournament_ref",
      "previous_balance",
      "balance_after",
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(doc!, forbidden),
        false,
        `o registro de atividade nunca deve ter o campo ${forbidden}`
      );
    }
  });

  it("funciona mesmo sem carteira: acesso não depende de estado financeiro", async () => {
    assert.equal((await db.collection("wallets").get()).size, 0);
    const result = await recordDailyAppOpenHandler({}, playerCtx);
    assert.equal(result.success, true);
    assert.equal(await countActivity(), 1);
    // E continua sem criar carteira nenhuma.
    assert.equal((await db.collection("wallets").get()).size, 0);
  });
});
