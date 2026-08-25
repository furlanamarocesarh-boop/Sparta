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

    // O criador precisa existir: a criação lê o documento dele.
    await db.collection("users").doc(ADMIN).set({ username: "ADMIN" });
  });

  after(async () => {
    await Promise.all([
      ...created.map((id) => db.collection("tournaments").doc(id).delete()),
      db.collection("users").doc(ADMIN).delete(),
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
});
