import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

import {
  businessDayKey,
  ACTIVITY_COLLECTION,
} from "../../src/domain/playerActivity.js";
import { STATS_TIMEZONE } from "../../src/domain/engagementStats.js";

/**
 * Behavioral tests for `getPlayerEngagementStats`, against the LOCAL Firestore
 * emulator via the Admin SDK.
 *
 * Proves the real contract: authentication, payload allowlist, owner isolation,
 * the canonical financial mapping end-to-end, activity days for the requested
 * month, and — the core promise of a read-only aggregation — that the callable
 * WRITES NOTHING.
 *
 * NEVER touches production: runs only under `npm run test:rules` and uses a
 * DISTINCT emulator project id.
 */

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let statsHandler: Handler;
let recordOpenHandler: Handler;
let db: admin.firestore.Firestore;

const PLAYER = "stats-player-1";
const OTHER = "stats-player-2";
const playerCtx = { auth: { uid: PLAYER, token: {} } };
const otherCtx = { auth: { uid: OTHER, token: {} } };

const today = () => businessDayKey(new Date(), STATS_TIMEZONE);
const thisMonth = () => today().slice(0, 7);

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
    "transactions",
    "wallets",
    "users",
    "registrations",
    "tournaments",
    ACTIVITY_COLLECTION,
  ]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
}

/** Seeds one canonical ledger row exactly as the deployed handlers write it. */
async function seedTx(
  uid: string,
  id: string,
  category: string,
  amountReais: number,
  at: Date,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await db.collection("transactions").doc(id).set({
    amount: amountReais,
    category,
    user_ref: db.collection("users").doc(uid),
    status: "completed",
    timestamp: at,
    ...extra,
  });
}

/** An instant unambiguously mid-afternoon in São Paulo on that day. */
const sp = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 18));

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-stats-handlers";
  const mod = (await import("../../src/index.js")) as unknown as {
    getPlayerEngagementStatsHandler: Handler;
    recordDailyAppOpenHandler: Handler;
  };
  statsHandler = mod.getPlayerEngagementStatsHandler;
  recordOpenHandler = mod.recordDailyAppOpenHandler;
  db = admin.firestore();
});

beforeEach(clearAll);

describe("getPlayerEngagementStats — autenticação e payload", () => {
  it("não autenticado é rejeitado", async () => {
    assert.equal(
      await expectFailure(() => statsHandler({ month: thisMonth() }, {})),
      "unauthenticated"
    );
    assert.equal(
      await expectFailure(() =>
        statsHandler({ month: thisMonth() }, { auth: null })
      ),
      "unauthenticated"
    );
  });

  it("o UID NÃO pode ser forjado pelo payload", async () => {
    assert.equal(
      await expectFailure(() =>
        statsHandler({ month: thisMonth(), uid: OTHER }, playerCtx)
      ),
      "invalid-argument"
    );
    for (const bad of [
      { month: thisMonth(), user_ref: `users/${OTHER}` },
      { month: thisMonth(), targetUid: OTHER },
      { month: thisMonth(), extra: 1 },
    ]) {
      assert.equal(
        await expectFailure(() => statsHandler(bad, playerCtx)),
        "invalid-argument"
      );
    }
  });

  it("mês malformado é rejeitado", async () => {
    for (const bad of ["2026-7", "07-2026", "2026", "", "julho", "2026-13", "2026-00"]) {
      assert.equal(
        await expectFailure(() => statsHandler({ month: bad }, playerCtx)),
        "invalid-argument",
        `mês ${bad}`
      );
    }
    assert.equal(
      await expectFailure(() => statsHandler({}, playerCtx)),
      "invalid-argument"
    );
  });

  it("responde com o contrato estável", async () => {
    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.equal(r.success, true);
    assert.equal(r.timezone, "America/Sao_Paulo");
    assert.equal(r.month, thisMonth());
    assert.equal(r.amountUnit, "centavos");
    assert.ok(Array.isArray(r.activityDays));
    assert.ok(Array.isArray(r.dailyNet));
    assert.equal(typeof r.currentWeekNet, "number");
    assert.equal(typeof r.currentMonthNet, "number");
    assert.equal(typeof r.lifetimeNet, "number");
    assert.ok(r.cash && r.betaCredit, "as duas economias são expostas");
  });
});

describe("getPlayerEngagementStats — extrato vazio", () => {
  it("conta sem histórico devolve zeros e listas vazias", async () => {
    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.deepEqual(r.activityDays, []);
    assert.deepEqual(r.dailyNet, []);
    assert.equal(r.currentWeekNet, 0);
    assert.equal(r.currentMonthNet, 0);
    assert.equal(r.lifetimeNet, 0);
    assert.deepEqual((r.betaCredit as any).dailyNet, []);
    assert.equal((r.betaCredit as any).lifetimeNet, 0);
  });
});

describe("getPlayerEngagementStats — mapeamento financeiro real", () => {
  it("taxa de entrada é negativa e prêmio é positivo, em centavos", async () => {
    const now = new Date();
    await seedTx(PLAYER, "t-fee", "entry_fee", 5, now);
    await seedTx(PLAYER, "t-prize", "prize", 20, now);

    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    // -500 + 2000 = 1500
    assert.equal(r.lifetimeNet, 1500);
    assert.equal(r.currentMonthNet, 1500);
    assert.equal(r.currentWeekNet, 1500);
    assert.deepEqual(r.dailyNet, [{ date: today(), amount: 1500 }]);
  });

  it("depósitos, saques e grants beta NÃO entram no resultado", async () => {
    const now = new Date();
    await seedTx(PLAYER, "t-dep", "deposit", 100, now);
    await seedTx(PLAYER, "t-wd", "withdrawal", 30, now, { status: "pending" });
    await seedTx(PLAYER, "t-grant", "beta_grant", 50, now);

    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.equal(r.lifetimeNet, 0);
    assert.equal((r.betaCredit as any).lifetimeNet, 0);
    assert.deepEqual(r.dailyNet, []);
  });

  it("reembolso anula a entrada", async () => {
    const now = new Date();
    await seedTx(PLAYER, "t-fee", "entry_fee", 5, now);
    await seedTx(PLAYER, "t-ref", "entry_refund", 5, now);
    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.equal(r.lifetimeNet, 0);
    assert.deepEqual(r.dailyNet, [], "dia zerado não aparece");
  });

  it("beta é reportado à parte e nunca somado ao cash", async () => {
    const now = new Date();
    await seedTx(PLAYER, "t-prize", "prize", 100, now);
    await seedTx(PLAYER, "t-beta", "beta_entry_fee", 5, now);

    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.equal(r.lifetimeNet, 10000, "topo espelha o CASH");
    assert.equal((r.cash as any).lifetimeNet, 10000);
    assert.equal((r.betaCredit as any).lifetimeNet, -500);
    assert.deepEqual((r.betaCredit as any).dailyNet, [
      { date: today(), amount: -500 },
    ]);
  });

  it("categoria desconhecida é excluída e declarada", async () => {
    await seedTx(PLAYER, "t-adm", "admin_correction", 10, new Date());
    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.equal(r.lifetimeNet, 0);
    assert.equal((r.excluded as any).unknownCategory, 1);
  });

  it("várias transações no mesmo dia são somadas, e a ordem é determinística", async () => {
    const now = new Date();
    await seedTx(PLAYER, "a", "entry_fee", 5, now);
    await seedTx(PLAYER, "b", "entry_fee", 5, now);
    await seedTx(PLAYER, "c", "prize", 30, now);
    // Um dia anterior do mesmo mês, para provar a ordenação.
    const first = `${thisMonth()}-01`;
    if (first !== today()) {
      await seedTx(PLAYER, "d", "prize", 7, sp(
        Number(first.slice(0, 4)),
        Number(first.slice(5, 7)),
        1
      ));
    }

    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    const daily = r.dailyNet as { date: string; amount: number }[];
    const dates = daily.map((d) => d.date);
    assert.deepEqual(dates, [...dates].sort(), "ascendente por data");
    const todayEntry = daily.find((d) => d.date === today());
    assert.equal(todayEntry?.amount, 2000, "-500 -500 +3000");
  });

  it("vida toda inclui meses anteriores; o mês pedido limita apenas dailyNet", async () => {
    await seedTx(PLAYER, "old", "prize", 10, sp(2026, 1, 15));
    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.equal(r.lifetimeNet, 1000);
    assert.deepEqual(r.dailyNet, [], "janeiro não entra no mês pedido");

    const jan = await statsHandler({ month: "2026-01" }, playerCtx);
    assert.deepEqual(jan.dailyNet, [{ date: "2026-01-15", amount: 1000 }]);
    assert.equal(jan.lifetimeNet, 1000, "vida toda não depende do mês pedido");
  });
});

describe("getPlayerEngagementStats — isolamento entre jogadores", () => {
  it("um jogador nunca vê o resultado de outro", async () => {
    const now = new Date();
    await seedTx(OTHER, "other-prize", "prize", 999, now);
    await seedTx(PLAYER, "mine", "entry_fee", 5, now);

    const mine = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.equal(mine.lifetimeNet, -500, "só a minha linha");

    const theirs = await statsHandler({ month: thisMonth() }, otherCtx);
    assert.equal(theirs.lifetimeNet, 99900);
  });

  it("o histórico de acesso também é isolado", async () => {
    await recordOpenHandler({}, otherCtx);
    const mine = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.deepEqual(mine.activityDays, []);

    const theirs = await statsHandler({ month: thisMonth() }, otherCtx);
    assert.deepEqual(theirs.activityDays, [today()]);
  });
});

describe("getPlayerEngagementStats — dias de acesso", () => {
  it("registrar o acesso várias vezes no mesmo dia gera UM dia", async () => {
    await recordOpenHandler({}, playerCtx);
    await recordOpenHandler({}, playerCtx);
    await recordOpenHandler({}, playerCtx);

    const r = await statsHandler({ month: thisMonth() }, playerCtx);
    assert.deepEqual(r.activityDays, [today()]);
    assert.equal((await db.collection(ACTIVITY_COLLECTION).get()).size, 1);
  });

  it("só devolve os dias do mês solicitado, ordenados", async () => {
    const userRef = db.collection("users").doc(PLAYER);
    for (const day of ["2026-03-10", "2026-03-02", "2026-04-01"]) {
      await db
        .collection(ACTIVITY_COLLECTION)
        .doc(`${PLAYER}_${day}`)
        .set({ uid: PLAYER, user_ref: userRef, activity_day: day });
    }
    const r = await statsHandler({ month: "2026-03" }, playerCtx);
    assert.deepEqual(r.activityDays, ["2026-03-02", "2026-03-10"]);
  });
});

describe("getPlayerEngagementStats — é read-only de verdade", () => {
  it("não escreve NADA: nenhum documento criado, alterado ou removido", async () => {
    const now = new Date();
    await seedTx(PLAYER, "t1", "entry_fee", 5, now);
    await db.collection("wallets").doc(PLAYER).set({
      balance: 10,
      beta_balance: 50,
      total_deposited: 0,
      total_spent: 0,
      total_won: 0,
      total_withdrawn: 0,
      user_ref: db.collection("users").doc(PLAYER),
    });
    await recordOpenHandler({}, playerCtx);

    const before = {
      transactions: (await db.collection("transactions").get()).size,
      wallets: (await db.collection("wallets").get()).size,
      activity: (await db.collection(ACTIVITY_COLLECTION).get()).size,
      registrations: (await db.collection("registrations").get()).size,
      wallet: (await db.collection("wallets").doc(PLAYER).get()).data(),
      tx: (await db.collection("transactions").doc("t1").get()).data(),
    };

    await statsHandler({ month: thisMonth() }, playerCtx);
    await statsHandler({ month: thisMonth() }, playerCtx);

    assert.equal((await db.collection("transactions").get()).size, before.transactions);
    assert.equal((await db.collection("wallets").get()).size, before.wallets);
    assert.equal(
      (await db.collection(ACTIVITY_COLLECTION).get()).size,
      before.activity
    );
    assert.equal(
      (await db.collection("registrations").get()).size,
      before.registrations
    );
    assert.deepEqual(
      (await db.collection("wallets").doc(PLAYER).get()).data(),
      before.wallet,
      "a carteira é byte-idêntica"
    );
    assert.deepEqual(
      (await db.collection("transactions").doc("t1").get()).data(),
      before.tx,
      "a transação é byte-idêntica"
    );
  });

  it("não cria nenhum agregado persistido", async () => {
    await seedTx(PLAYER, "t1", "prize", 10, new Date());
    await statsHandler({ month: thisMonth() }, playerCtx);

    for (const col of [
      "player_stats",
      "stats",
      "engagement_stats",
      "aggregates",
    ]) {
      assert.equal(
        (await db.collection(col).get()).size,
        0,
        `nenhum agregado deve existir em ${col}`
      );
    }
  });
});
