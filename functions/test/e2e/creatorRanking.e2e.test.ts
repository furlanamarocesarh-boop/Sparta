import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import {
  CREATOR_ENTRIES_SUBCOLLECTION,
  CREATOR_RANKINGS_COLLECTION,
  CREATOR_VOLUME_FIELD,
} from "../../src/domain/creatorRanking.js";
import { PUBLIC_PLAYER_ID_COLLECTION } from "../../src/domain/publicPlayerId.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * O RANKING DE CRIADORES, contra um Firestore real.
 *
 * O que só o emulador prova: que o gatilho resolve torneio -> criador, acumula
 * no quadro da economia CERTA, e que o callable devolve o nick sem nunca
 * devolver o uid.
 */

const PROJECT_ID = "demo-sparta-battle";
const CREATOR = "e2e-cr-creator";
const OTHER = "e2e-cr-other";
const PLAYER = "e2e-cr-player";
const T_BETA = "e2e-cr-t-beta";
const T_CASH = "e2e-cr-t-cash";
const PSEUDO = "e2eCreatorAAAAAAAAAAAA";

const ctx = (uid: string) => ({ auth: { uid, token: {} } });

let db: admin.firestore.Firestore;
let accrue: (s: unknown) => Promise<any>;
let board: (d: unknown, c: unknown) => Promise<any>;

/** Um snapshot de transação, como o gatilho o recebe. */
const tx = (fields: Record<string, unknown>) => ({
  data: () => ({
    user_ref: db.collection("users").doc(PLAYER),
    ...fields,
  }),
});

async function wipe(): Promise<void> {
  const boards = ["cash", "beta_credit"];
  await Promise.all([
    ...boards.flatMap((e) =>
      [CREATOR, OTHER].map((uid) =>
        db
          .collection(CREATOR_RANKINGS_COLLECTION)
          .doc(e)
          .collection(CREATOR_ENTRIES_SUBCOLLECTION)
          .doc(uid)
          .delete()
      )
    ),
    db.collection("tournaments").doc(T_BETA).delete(),
    db.collection("tournaments").doc(T_CASH).delete(),
    db.collection("users").doc(CREATOR).delete(),
    db.collection(PUBLIC_PLAYER_ID_COLLECTION).doc(CREATOR).delete(),
  ]);
}

const entry = (economy: string, uid = CREATOR) =>
  db
    .collection(CREATOR_RANKINGS_COLLECTION)
    .doc(economy)
    .collection(CREATOR_ENTRIES_SUBCOLLECTION)
    .doc(uid)
    .get();

describe("E2E — ranking de criadores", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    accrue = (mod as any).onEntryFeeCreatorAccrualHandler;
    board = (mod as any).getCreatorLeaderboardHandler;

    await wipe();
    await Promise.all([
      db.collection("users").doc(CREATOR).set({ username: "RDKILL" }),
      db.collection(PUBLIC_PLAYER_ID_COLLECTION).doc(CREATOR).set({
        publicPlayerId: PSEUDO,
      }),
      db.collection("tournaments").doc(T_BETA).set({
        creator_uid: CREATOR,
        economy_type: "beta_credit",
      }),
      db.collection("tournaments").doc(T_CASH).set({
        creator_uid: CREATOR,
        economy_type: "cash",
      }),
    ]);
  });

  after(async () => {
    await wipe();
  });

  it("uma inscrição paga acumula no criador do torneio", async () => {
    const out = await accrue(
      tx({
        category: "beta_entry_fee",
        amount: -10,
        tournament_ref: db.collection("tournaments").doc(T_BETA),
      })
    );
    assert.deepEqual(out, {
      accrued: true,
      economy: "beta_credit",
      centavos: 1000,
    });

    const doc = await entry("beta_credit");
    assert.equal(doc.get(CREATOR_VOLUME_FIELD), 1000);
    assert.equal(doc.get("entries_count"), 1);
    assert.equal(doc.get("nickname"), "RDKILL");
    assert.equal(doc.get("public_player_id"), PSEUDO);
  });

  it("inscrições somam, não sobrescrevem", async () => {
    await accrue(
      tx({
        category: "beta_entry_fee",
        amount: -5.5,
        tournament_ref: db.collection("tournaments").doc(T_BETA),
      })
    );
    const doc = await entry("beta_credit");
    assert.equal(doc.get(CREATOR_VOLUME_FIELD), 1550);
    assert.equal(doc.get("entries_count"), 2);
  });

  it("AS DUAS ECONOMIAS NUNCA SE ENCOSTAM", async () => {
    // A regra mais dura deste backend, provada contra o banco: o mesmo criador
    // tem dois quadros e um nunca soma no outro.
    await accrue(
      tx({
        category: "entry_fee",
        amount: -3,
        tournament_ref: db.collection("tournaments").doc(T_CASH),
      })
    );

    assert.equal((await entry("cash")).get(CREATOR_VOLUME_FIELD), 300);
    assert.equal((await entry("beta_credit")).get(CREATOR_VOLUME_FIELD), 1550);
  });

  it("categoria e torneio discordando não escreve NADA", async () => {
    const before = (await entry("beta_credit")).get(CREATOR_VOLUME_FIELD);
    const out = await accrue(
      tx({
        category: "beta_entry_fee",
        amount: -99,
        tournament_ref: db.collection("tournaments").doc(T_CASH),
      })
    );
    assert.deepEqual(out, { accrued: false, reason: "economy-mismatch" });
    assert.equal((await entry("beta_credit")).get(CREATOR_VOLUME_FIELD), before);
    assert.equal((await entry("cash")).get(CREATOR_VOLUME_FIELD), 300);
  });

  it("um prêmio não é volume de criador", async () => {
    const out = await accrue(
      tx({
        category: "beta_prize",
        amount: 500,
        tournament_ref: db.collection("tournaments").doc(T_BETA),
      })
    );
    assert.deepEqual(out, { accrued: false, reason: "not-an-entry-fee" });
  });

  it("torneio inexistente não cria entrada fantasma", async () => {
    const out = await accrue(
      tx({
        category: "beta_entry_fee",
        amount: -10,
        tournament_ref: db.collection("tournaments").doc("nao-existe"),
      })
    );
    assert.deepEqual(out, { accrued: false, reason: "tournament-missing" });
  });

  it("o quadro devolve nick e pseudônimo, NUNCA o uid", async () => {
    const page = await board({ economy: "beta_credit" }, ctx(PLAYER));
    const mine = page.rows.find((r: any) => r.nickname === "RDKILL");

    assert.ok(mine, "criador não apareceu no quadro");
    assert.equal(mine.publicPlayerId, PSEUDO);
    assert.equal(mine.volumeCentavos, 1550);
    assert.equal(mine.tournamentsCreated, 2, "contou os campeonatos criados");

    const flat = JSON.stringify(page);
    assert.equal(flat.includes(CREATOR), false, "vazou o uid do criador");
  });

  it("o quadro vem ordenado do servidor, do maior para o menor", async () => {
    await db.collection("users").doc(OTHER).set({ username: "SEGUNDO" });
    await db
      .collection(CREATOR_RANKINGS_COLLECTION)
      .doc("beta_credit")
      .collection(CREATOR_ENTRIES_SUBCOLLECTION)
      .doc(OTHER)
      .set({
        creator_uid: OTHER,
        nickname: "SEGUNDO",
        public_player_id: null,
        [CREATOR_VOLUME_FIELD]: 999_999,
        entries_count: 1,
      });

    const page = await board({ economy: "beta_credit" }, ctx(PLAYER));
    assert.equal(page.rows[0].nickname, "SEGUNDO");
    assert.equal(page.rows[0].position, 1);
    assert.equal(page.rows[1].position, 2);

    await db.collection("users").doc(OTHER).delete();
  });

  it("cada economia responde pelo próprio quadro", async () => {
    const cash = await board({ economy: "cash" }, ctx(PLAYER));
    assert.equal(cash.economy, "cash");
    const mine = cash.rows.find((r: any) => r.nickname === "RDKILL");
    assert.equal(mine.volumeCentavos, 300);
  });

  it("deslogado não lê ranking", async () => {
    await assert.rejects(
      () => board({ economy: "cash" }, { auth: null }),
      /Entre na sua conta/i
    );
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () => board({ economy: "cash", limit: 999 }, ctx(PLAYER)),
      /.+/
    );
  });
});
