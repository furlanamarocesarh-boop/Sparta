import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { KILL_PRIZE_CATEGORY } from "../../src/domain/killPrize.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * THE WHOLE PER-KILL SETTLEMENT, against a real Firestore.
 *
 * The unit suite proves the arithmetic and every refusal. What it cannot prove
 * is that the transaction actually credits N wallets, that `create` really
 * blocks a double payment on retry, and that the pool guard holds against rows
 * read from a database rather than from a fixture.
 *
 * This suite calls the handler directly — the question here is settlement
 * correctness, not trigger binding, which `partnerAccrualFlow` already covers.
 */

const PROJECT_ID = "demo-sparta-battle";

const TID = "e2e-perkill";
const OVER_TID = "e2e-perkill-over";
const PLAYERS = ["e2e-pk-a", "e2e-pk-b", "e2e-pk-c"];

/** R$ 10,00 x 3 inscritos = pool de R$ 30,00 (3000 centavos). */
const ENTRY_REAIS = 10;
const PLACEMENT_REAIS = 10;
const KILL_REAIS = 1;

const ADMIN_CONTEXT = {
  auth: { uid: "e2e-pk-admin", token: { admin: true } },
};

let db: admin.firestore.Firestore;
let handler: (data: unknown, context: unknown) => Promise<unknown>;

async function seedTournament(
  tid: string,
  opts: { placement: number; killPrize: number }
): Promise<void> {
  await db.collection("tournaments").doc(tid).set({
    name: "E2E per-kill",
    status: "in_progress",
    economy_type: "cash",
    locked_economy_type: "cash",
    entry_fee: ENTRY_REAIS,
    prize: opts.placement,
    kill_prize: opts.killPrize,
  });

  const tournamentRef = db.collection("tournaments").doc(tid);
  await Promise.all(
    PLAYERS.map(async (uid) => {
      await db.collection("wallets").doc(uid).set({
        balance: 0,
        total_deposited: 0,
        total_won: 0,
        total_spent: 0,
        total_withdrawn: 0,
        beta_balance: 0,
      });
      await db
        .collection("registrations")
        .doc(`${uid}_${tid}`)
        .set({
          status: "registered",
          entry_fee_snapshot: ENTRY_REAIS,
          economy_type: "cash",
          user_ref: db.collection("users").doc(uid),
          tournament_ref: tournamentRef,
        });
    })
  );
}

async function cleanup(): Promise<void> {
  const ids = [TID, OVER_TID];
  await Promise.all([
    ...ids.map((t) => db.collection("tournaments").doc(t).delete()),
    ...ids.flatMap((t) =>
      PLAYERS.flatMap((uid) => [
        db.collection("registrations").doc(`${uid}_${t}`).delete(),
        db.collection("transactions").doc(`prize_${t}_${uid}`).delete(),
      ])
    ),
    ...PLAYERS.map((uid) => db.collection("wallets").doc(uid).delete()),
  ]);
}

describe("E2E — liquidação por abate", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    handler = (
      mod as unknown as Record<string, typeof handler>
    ).declareTournamentResultWithKillsHandler;

    await cleanup();
    await seedTournament(TID, {
      placement: PLACEMENT_REAIS,
      killPrize: KILL_REAIS,
    });

    // a: 5 abates + colocação = 5 + 10 = R$ 15,00
    // b: 3 abates            = R$ 3,00
    // c: 0 abates            = nada, e nenhuma linha de razão
    await handler(
      {
        tournamentid: TID,
        winneruid: PLAYERS[0],
        kills: [
          { uid: PLAYERS[0], kills: 5 },
          { uid: PLAYERS[1], kills: 3 },
          { uid: PLAYERS[2], kills: 0 },
        ],
      },
      ADMIN_CONTEXT
    );
  });

  after(async () => {
    await cleanup();
  });

  it("credita cada jogador o que ganhou, e ninguém mais", async () => {
    const [a, b, c] = await Promise.all(
      PLAYERS.map((uid) => db.collection("wallets").doc(uid).get())
    );
    assert.equal(a.get("balance"), 15);
    assert.equal(a.get("total_won"), 15);
    assert.equal(b.get("balance"), 3);
    assert.equal(c.get("balance"), 0, "quem não pontuou não recebe");
  });

  it("escreve uma linha de razão POR JOGADOR pago", async () => {
    const [a, b, c] = await Promise.all(
      PLAYERS.map((uid) =>
        db.collection("transactions").doc(`prize_${TID}_${uid}`).get()
      )
    );
    assert.equal(a.exists, true);
    assert.equal(b.exists, true);
    assert.equal(c.exists, false, "zero ganho não vira documento");

    assert.equal(a.get("category"), KILL_PRIZE_CATEGORY);
    assert.equal(a.get("amount"), 15);
    assert.equal(a.get("kills"), 5);
    assert.equal(b.get("amount"), 3);
  });

  it("o total pago respeita o arrecadado", async () => {
    const t = await db.collection("tournaments").doc(TID).get();
    const result = t.get("result") as Record<string, unknown>;
    assert.equal(result.mode, "per_kill");
    assert.equal(result.pool, 30);
    assert.equal(result.total_paid, 18);
    assert.ok(
      (result.total_paid as number) <= (result.pool as number),
      "pagou mais do que arrecadou"
    );
    assert.equal(t.get("status"), "completed");
    assert.equal((result.payouts as unknown[]).length, 2);
  });

  it("repetir a MESMA declaração não paga de novo", async () => {
    await handler(
      {
        tournamentid: TID,
        winneruid: PLAYERS[0],
        kills: [
          { uid: PLAYERS[0], kills: 5 },
          { uid: PLAYERS[1], kills: 3 },
          { uid: PLAYERS[2], kills: 0 },
        ],
      },
      ADMIN_CONTEXT
    );

    const a = await db.collection("wallets").doc(PLAYERS[0]).get();
    assert.equal(a.get("balance"), 15, "o replay creditou duas vezes");
  });

  it("repetir com abates DIFERENTES é divergência, não novo pagamento", async () => {
    await assert.rejects(
      () =>
        handler(
          {
            tournamentid: TID,
            winneruid: PLAYERS[0],
            kills: [{ uid: PLAYERS[0], kills: 9 }],
          },
          ADMIN_CONTEXT
        ),
      /diverge/i
    );

    const a = await db.collection("wallets").doc(PLAYERS[0]).get();
    assert.equal(a.get("balance"), 15);
  });

  it("estourar o pool recusa TUDO — nenhuma carteira se move", async () => {
    await seedTournament(OVER_TID, { placement: 10, killPrize: 1 });

    // 100 abates x R$1 + R$10 = R$110 contra um pool de R$30.
    await assert.rejects(
      () =>
        handler(
          {
            tournamentid: OVER_TID,
            winneruid: PLAYERS[0],
            kills: [{ uid: PLAYERS[0], kills: 100 }],
          },
          ADMIN_CONTEXT
        ),
      /maior do que o total arrecadado/i
    );

    const [wallet, tx, tournament] = await Promise.all([
      db.collection("wallets").doc(PLAYERS[0]).get(),
      db.collection("transactions").doc(`prize_${OVER_TID}_${PLAYERS[0]}`).get(),
      db.collection("tournaments").doc(OVER_TID).get(),
    ]);
    // `seedTournament` zera as carteiras, então zero aqui é a prova de que a
    // recusa não creditou ninguém — nem parcialmente.
    assert.equal(wallet.get("balance"), 0);
    assert.equal(tx.exists, false);
    assert.equal(tournament.get("status"), "in_progress");
    assert.equal(tournament.get("result"), undefined);
  });

  it("o caminho de vencedor único RECUSA um torneio por abate", async () => {
    const mod = await import("../../src/index.js");
    const single = (
      mod as unknown as Record<string, typeof handler>
    ).declareTournamentResultHandler;

    await assert.rejects(
      () =>
        single(
          { tournamentid: OVER_TID, winneruid: PLAYERS[0] },
          ADMIN_CONTEXT
        ),
      /paga por abate/i
    );
  });
});
