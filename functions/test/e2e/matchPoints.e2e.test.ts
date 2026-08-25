import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * CAMPEONATO DE VÁRIAS PARTIDAS, contra um Firestore real.
 *
 * O que só o emulador prova: que a configuração de pontuação e a divisão da
 * premiação atravessam a criação inteiras, e que uma configuração que não fecha
 * é recusada ANTES de o torneio existir — um torneio criado com divisão
 * quebrada seria impossível de liquidar depois.
 */

const PROJECT_ID = "demo-sparta-battle";
const ADMIN = "e2e-mp-admin";
const created: string[] = [];

const ctx = () => ({ auth: { uid: ADMIN, token: { admin: true } } });

let db: admin.firestore.Firestore;
let createTournament: (d: unknown, c: unknown) => Promise<any>;
let declareMatch: (d: unknown, c: unknown) => Promise<any>;
let settleByPoints: (d: unknown, c: unknown) => Promise<any>;

const PLAYERS = ["e2e-mp-ana", "e2e-mp-bruno", "e2e-mp-caio"];

/** Inscreve um jogador de verdade: é a inscrição que autoriza o pagamento. */
async function register(tournamentId: string, uid: string, fee: number) {
  const ref = db.collection("registrations").doc(`${tournamentId}_${uid}`);
  await ref.set({
    user_ref: db.collection("users").doc(uid),
    tournament_ref: db.collection("tournaments").doc(tournamentId),
    status: "registered",
    entry_fee: fee,
    entry_fee_snapshot: fee,
    economy_type: "beta_credit",
  });
  return ref;
}

const base = () => ({
  name: "Copa Multi",
  description: "",
  economy_type: "beta_credit",
  entry_fee: 5,
  prize: 100,
  max_players: 48,
  game_mode: "squad",
});

async function create(extra: Record<string, unknown>) {
  const out = await createTournament({ ...base(), ...extra }, ctx());
  const id = out.tournament_id;
  if (typeof id === "string") created.push(id);
  return { out, id };
}

describe("E2E — campeonato de várias partidas", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();
    const mod = await import("../../src/index.js");
    createTournament = (mod as any).createTournamentHandler;
    declareMatch = (mod as any).declareMatchResultHandler;
    settleByPoints = (mod as any).settleTournamentByPointsHandler;

    // O criador precisa existir: a criação lê o documento dele.
    await db.collection("users").doc(ADMIN).set({ username: "ADMIN" });
    await Promise.all(
      PLAYERS.map((uid) => db.collection("users").doc(uid).set({ username: uid }))
    );
  });

  after(async () => {
    await Promise.all([
      ...created.map((id) => db.collection("tournaments").doc(id).delete()),
      db.collection("users").doc(ADMIN).delete(),
      ...PLAYERS.map((uid) => db.collection("users").doc(uid).delete()),
      ...PLAYERS.map((uid) => db.collection("wallets").doc(uid).delete()),
      db.collection("house").doc("beta_credit").delete(),
    ]);
  });

  it("grava partidas, pontuação e divisão da premiação", async () => {
    const { id } = await create({
      matches_count: 6,
      kill_points: 1,
      placement_points: [12, 9, 8, 7, 6],
      prize_distribution: [
        { position: 1, share_bps: 5000 },
        { position: 2, share_bps: 3000 },
        { position: 3, share_bps: 2000 },
      ],
    });

    const doc = await db.collection("tournaments").doc(id!).get();
    assert.equal(doc.get("matches_count"), 6);
    assert.equal(doc.get("kill_points"), 1);
    assert.deepEqual(doc.get("placement_points"), [12, 9, 8, 7, 6]);
    assert.deepEqual(doc.get("prize_distribution"), [
      { position: 1, share_bps: 5000 },
      { position: 2, share_bps: 3000 },
      { position: 3, share_bps: 2000 },
    ]);
  });

  it("um torneio SEM nada disso continua sendo criado, com 1 partida", async () => {
    // O formato de todo torneio que já existe. Omitir não muda nada.
    const { id } = await create({});
    const doc = await db.collection("tournaments").doc(id!).get();
    assert.equal(doc.get("matches_count"), 1);
    assert.equal(doc.get("kill_points"), 0);
    assert.deepEqual(doc.get("placement_points"), []);
    assert.equal(doc.get("prize_distribution"), null);
  });

  it("UMA partida com divisão por colocação é legítimo", async () => {
    // A opção vale sempre, não só em multi-partida.
    const { id } = await create({
      prize_distribution: [
        { position: 1, share_bps: 7000 },
        { position: 2, share_bps: 3000 },
      ],
    });
    const doc = await db.collection("tournaments").doc(id!).get();
    assert.equal(doc.get("matches_count"), 1);
    assert.equal((doc.get("prize_distribution") as unknown[]).length, 2);
  });

  it("uma divisão que não soma 100% é RECUSADA na criação", async () => {
    // Um torneio criado com divisão quebrada seria impossível de liquidar
    // depois — a recusa tem que vir antes de ele existir.
    await assert.rejects(
      () =>
        create({
          prize_distribution: [
            { position: 1, share_bps: 5000 },
            { position: 2, share_bps: 4000 },
          ],
        }),
      /100%/
    );
  });

  it("posição pulada é recusada", async () => {
    await assert.rejects(
      () =>
        create({
          prize_distribution: [
            { position: 1, share_bps: 5000 },
            { position: 3, share_bps: 5000 },
          ],
        }),
      /pular posições/
    );
  });

  it("dividir premiação ZERO é recusado", async () => {
    await assert.rejects(
      () =>
        create({
          prize: 0,
          kill_prize: 1,
          prize_distribution: [{ position: 1, share_bps: 10000 }],
        }),
      /valor de premiação/
    );
  });

  it("quantidade de partidas impossível é recusada", async () => {
    for (const bad of [0, -1, 1.5, 999]) {
      await assert.rejects(
        () => create({ matches_count: bad }),
        /partidas/,
        String(bad)
      );
    }
  });

  describe("lançando partidas e liquidando", () => {
    let id: string;

    before(async () => {
      const made = await create({
        matches_count: 2,
        kill_points: 1,
        placement_points: [12, 9, 8],
        prize_distribution: [
          { position: 1, share_bps: 6000 },
          { position: 2, share_bps: 4000 },
        ],
      });
      id = made.id!;
      // 3 inscrições de 5 cada: o caixa da liquidação sai daqui.
      await Promise.all(PLAYERS.map((uid) => register(id, uid, 5)));
      for (const uid of PLAYERS) {
        await db.collection("wallets").doc(uid).set({ beta_balance: 0 });
      }
      // O CAIXA BANCA A DIFERENÇA. Prêmio 100 contra 15 arrecadados: a casa
      // subsidia 85, e a liquidação é recusada se ela não tiver isso. Financiar
      // aqui é o que torna o teste sobre a PONTUAÇÃO em vez de sobre o caixa.
      await db
        .collection("house")
        .doc("beta_credit")
        .set({ balance_centavos: 20_000, economy_type: "beta_credit" });
    });

    it("uma partida é lançada e pode ser CORRIGIDA relançando", async () => {
      await declareMatch(
        {
          tournamentid: id,
          match_number: 1,
          entries: [{ uid: PLAYERS[0], kills: 99, placement: 1 }],
        },
        ctx()
      );
      // Errar uma partida é ordinário; o conserto é reenviá-la.
      await declareMatch(
        {
          tournamentid: id,
          match_number: 1,
          entries: [
            { uid: PLAYERS[0], kills: 3, placement: 1 },
            { uid: PLAYERS[1], kills: 1, placement: 2 },
            { uid: PLAYERS[2], kills: 0, placement: 3 },
          ],
        },
        ctx()
      );

      const doc = await db
        .collection("tournaments")
        .doc(id)
        .collection("matches")
        .doc("1")
        .get();
      assert.equal((doc.get("entries") as unknown[]).length, 3);
      assert.equal((doc.get("entries") as any[])[0].kills, 3);
    });

    it("um jogador NÃO inscrito não pode ser lançado", async () => {
      // Mesma invariante do pagamento, uma etapa antes: um erro de digitação
      // é pego enquanto ainda é barato.
      await assert.rejects(
        () =>
          declareMatch(
            {
              tournamentid: id,
              match_number: 2,
              entries: [{ uid: "estranho", kills: 5, placement: 1 }],
            },
            ctx()
          ),
        /não está inscrito/
      );
    });

    it("o mesmo jogador duas vezes na MESMA partida é recusado", async () => {
      // As pontuações somam um uid repetido de propósito, para permitir
      // correções entre lançamentos — aceitar duas linhas num envio só
      // dobraria os abates em silêncio.
      await assert.rejects(
        () =>
          declareMatch(
            {
              tournamentid: id,
              match_number: 2,
              entries: [
                { uid: PLAYERS[0], kills: 1, placement: 1 },
                { uid: PLAYERS[0], kills: 1, placement: 2 },
              ],
            },
            ctx()
          ),
        /duas vezes/
      );
    });

    it("partida além do configurado é recusada", async () => {
      await assert.rejects(
        () =>
          declareMatch(
            {
              tournamentid: id,
              match_number: 3,
              entries: [{ uid: PLAYERS[0], kills: 0, placement: 1 }],
            },
            ctx()
          ),
        /2 partida/
      );
    });

    it("liquida pela SOMA das partidas, e paga as posições configuradas", async () => {
      await declareMatch(
        {
          tournamentid: id,
          match_number: 2,
          entries: [
            { uid: PLAYERS[1], kills: 10, placement: 1 },
            { uid: PLAYERS[0], kills: 0, placement: 3 },
          ],
        },
        ctx()
      );

      // ana: (3+12) + (0+8) = 23 · bruno: (1+9) + (10+12) = 32 · caio: 8
      const out = await settleByPoints({ tournamentid: id }, ctx());
      assert.equal(out.success, true);
      assert.equal(out.awards, 2);

      const doc = await db.collection("tournaments").doc(id).get();
      const result = doc.get("result");
      assert.equal(doc.get("status"), "completed");
      assert.equal(result.mode, "points");
      // Bruno somou mais mesmo tendo perdido a primeira partida.
      assert.equal(result.awards[0].uid, PLAYERS[1]);
      assert.equal(result.awards[1].uid, PLAYERS[0]);
      assert.equal(result.standings[0].points, 32);
    });

    it("o dinheiro chegou na carteira certa, no valor certo", async () => {
      // Prêmio 100, dividido 60/40.
      const bruno = await db.collection("wallets").doc(PLAYERS[1]).get();
      const ana = await db.collection("wallets").doc(PLAYERS[0]).get();
      assert.equal(bruno.get("beta_balance"), 60);
      assert.equal(ana.get("beta_balance"), 40);
      const caio = await db.collection("wallets").doc(PLAYERS[2]).get();
      assert.equal(caio.get("beta_balance"), 0, "3º não estava na divisão");
    });

    it("liquidar DE NOVO é recusado", async () => {
      await assert.rejects(
        () => settleByPoints({ tournamentid: id }, ctx()),
        /já foi encerrado/
      );
    });

    it("um campeonato SEM divisão não usa este caminho", async () => {
      const outro = await create({});
      await assert.rejects(
        () => settleByPoints({ tournamentid: outro.id }, ctx()),
        /não tem divisão/
      );
    });

    it("sem partida lançada, não liquida", async () => {
      const vazio = await create({
        prize_distribution: [{ position: 1, share_bps: 10000 }],
      });
      await assert.rejects(
        () => settleByPoints({ tournamentid: vazio.id }, ctx()),
        /Nenhuma partida/
      );
    });
  });
});
