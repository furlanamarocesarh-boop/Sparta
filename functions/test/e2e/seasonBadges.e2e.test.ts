import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import {
  CREATOR_ENTRIES_SUBCOLLECTION,
  CREATOR_SEASONS_COLLECTION,
  CREATOR_VOLUME_FIELD,
} from "../../src/domain/creatorRanking.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * SELOS DE COLOCAÇÃO, contra um Firestore real.
 *
 * O que só o emulador prova: que uma colocação numa temporada FECHADA vira
 * troféu, que o cursor impede reconferir para sempre, e que o quadro de
 * Créditos Beta nunca concede nada — porque o troféu é só de dinheiro.
 */

const PROJECT_ID = "demo-sparta-battle";
const ME = "e2e-season-badge-me";
const RIVALS = ["e2e-sb-r1", "e2e-sb-r2", "e2e-sb-r3"];
const SEASON = "2026-09"; // primeira temporada ativa; fechada sob AFTER_SEASON

const ctx = (uid: string) => ({ auth: { uid, token: {} } });

let db: admin.firestore.Firestore;
let handler: (d: unknown, c: unknown, o?: unknown) => Promise<any>;

/**
 * 5 DE OUTUBRO DE 2026, injetado.
 *
 * A primeira temporada ranqueada é setembro/2026 e ainda está no futuro — em
 * tempo real NADA pode ser concedido, porque nenhuma temporada fechou. O
 * relógio é o único jeito de provar a liquidação antes de outubro chegar.
 *
 * A data é logo DEPOIS de setembro fechar e ANTES de outubro fechar, de
 * propósito: exatamente uma temporada a liquidar, então o cursor tem uma
 * resposta só e o teste conta uma história simples.
 */
const AFTER_SEASON = new Date(Date.UTC(2026, 9, 5, 12));

/**
 * O motor LIGADO, explicitamente.
 *
 * `SEASON_BADGES_ACTIVE` está false hoje, então em produção nada é concedido.
 * O mecanismo continua sendo provado aqui de propósito: um mecanismo que só é
 * testado quando está ligado é um mecanismo em que ninguém pode confiar no dia
 * em que for ligado.
 */
const getBadges = (d: unknown, c: unknown) =>
  handler(d, c, { now: AFTER_SEASON, seasonBadgesActive: true });

/** O motor como está em produção: sem override nenhum. */
const getBadgesAsShipped = (d: unknown, c: unknown) =>
  handler(d, c, { now: AFTER_SEASON });

const creatorEntries = (economy: string) =>
  db
    .collection(CREATOR_SEASONS_COLLECTION)
    .doc(`${economy}_${SEASON}`)
    .collection(CREATOR_ENTRIES_SUBCOLLECTION);

async function wipe(): Promise<void> {
  await Promise.all([
    db.collection("users").doc(ME).delete(),
    ...["cash", "beta_credit"].flatMap((e) =>
      [ME, ...RIVALS].map((uid) => creatorEntries(e).doc(uid).delete())
    ),
  ]);
}

/** Uma conta limpa, sem cursor e sem selos. */
async function freshAccount(): Promise<void> {
  await db.collection("users").doc(ME).set({
    username: "PLACAR",
    tournaments_played: 0,
  });
}

describe("E2E — selos de colocação de temporada", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    handler = (mod as any).getMyBadgesHandler;

    await wipe();
  });

  after(async () => {
    await wipe();
  });

  it("primeiro lugar numa temporada fechada vira TOP 1", async () => {
    await freshAccount();
    await creatorEntries("cash").doc(ME).set({
      creator_uid: ME,
      [CREATOR_VOLUME_FIELD]: 500_000,
    });

    const out = await getBadges({}, ctx(ME));
    assert.ok(
      out.badges.includes(`season_creator_top1_${SEASON}`),
      `não concedeu top1: ${JSON.stringify(out.badges)}`
    );
  });

  it("o troféu entra na fila de comemoração, como qualquer outro", async () => {
    // Sem `isKnownBadgeId` conhecendo a segunda família de ids, este selo
    // seria descartado da fila e a dívida nunca seria paga.
    await wipe();
    await freshAccount();
    await creatorEntries("cash").doc(ME).set({
      creator_uid: ME,
      [CREATOR_VOLUME_FIELD]: 500_000,
    });

    const out = await getBadges({}, ctx(ME));
    assert.ok(out.unseen.includes(`season_creator_top1_${SEASON}`));
  });

  it("quarto lugar cai na faixa TOP 10, não em quatro troféus", async () => {
    await wipe();
    await freshAccount();
    await Promise.all(
      RIVALS.map((uid, i) =>
        creatorEntries("cash").doc(uid).set({
          creator_uid: uid,
          [CREATOR_VOLUME_FIELD]: 900_000 - i,
        })
      )
    );
    await creatorEntries("cash").doc(ME).set({
      creator_uid: ME,
      [CREATOR_VOLUME_FIELD]: 100_000,
    });

    const out = await getBadges({}, ctx(ME));
    const mine = out.badges.filter((b: string) => b.startsWith("season_"));
    assert.deepEqual(mine, [`season_creator_top10_${SEASON}`]);
  });

  it("o CURSOR impede reconferir a mesma temporada para sempre", async () => {
    const stored = await db.collection("users").doc(ME).get();
    assert.equal(stored.get("season_badges_through"), SEASON);

    const again = await getBadges({}, ctx(ME));
    assert.deepEqual(again.awarded, [], "concedeu de novo");
  });

  it("o cursor avança mesmo sem ter ganhado nada", async () => {
    // Não colocar é o desfecho comum. Reconferir a mesma temporada fechada em
    // toda leitura, para sempre, seria custo crescente que não compra nada.
    await wipe();
    await freshAccount();

    const out = await getBadges({}, ctx(ME));
    assert.deepEqual(
      out.badges.filter((b: string) => b.startsWith("season_")),
      []
    );
    const stored = await db.collection("users").doc(ME).get();
    assert.equal(stored.get("season_badges_through"), SEASON);
  });

  it("o quadro de Créditos Beta NÃO concede troféu", async () => {
    // O selo é permanente e público: conceder por liderar dinheiro de mentira
    // gastaria o significado dele antes de a economia real existir.
    await wipe();
    await freshAccount();
    await creatorEntries("beta_credit").doc(ME).set({
      creator_uid: ME,
      [CREATOR_VOLUME_FIELD]: 9_000_000,
    });

    const out = await getBadges({}, ctx(ME));
    assert.deepEqual(
      out.badges.filter((b: string) => b.startsWith("season_")),
      []
    );
  });

  it("DESLIGADO, uma vitória não vira troféu — e o cursor não anda", async () => {
    // É o estado de produção hoje. O cursor ficar parado é o que torna ligar
    // retroativo: quem venceu setembro não perde por a feature estar apagada.
    await wipe();
    await freshAccount();
    await creatorEntries("cash").doc(ME).set({
      creator_uid: ME,
      [CREATOR_VOLUME_FIELD]: 500_000,
    });

    const out = await getBadgesAsShipped({}, ctx(ME));
    assert.deepEqual(
      out.badges.filter((b: string) => b.startsWith("season_")),
      []
    );

    const stored = await db.collection("users").doc(ME).get();
    assert.equal(stored.get("season_badges_through"), undefined);
  });

  it("e ligar depois concede a MESMA vitória, retroativamente", async () => {
    const out = await getBadges({}, ctx(ME));
    assert.ok(out.badges.includes(`season_creator_top1_${SEASON}`));
  });

  it("os quinze selos fixos continuam funcionando ao lado", async () => {
    await wipe();
    await db.collection("users").doc(ME).set({
      username: "PLACAR",
      tournaments_played: 50,
    });

    const out = await getBadges({}, ctx(ME));
    assert.ok(out.badges.includes("spartan_noobie"));
  });
});
