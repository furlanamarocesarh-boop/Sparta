import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * O AVISO DE SALA ABERTA, contra um Firestore real.
 *
 * O que só o emulador prova:
 *
 *  - que iniciar o torneio escreve UM aviso na caixa de CADA inscrito, e de
 *    mais ninguém;
 *  - que reiniciar não duplica, porque o id do aviso vem do torneio;
 *  - que o aviso NÃO carrega o ID nem a senha da sala — a garantia inteira do
 *    `room.ts` depende disso;
 *  - e que o torneio começa e a caixa é escrita mesmo quando NENHUM push pode
 *    ser enviado. O FCM não tem emulador: uma chamada daqui alcançaria o
 *    serviço de produção com a credencial da máquina, então o envio é suprimido
 *    em projeto demo. A suíte prova o que dá para provar aqui — que a entrega
 *    durável não depende do push. Que uma FALHA de push seja engolida é
 *    estrutural, não observável no emulador: a caixa é escrita ANTES do envio,
 *    e o envio inteiro está dentro de um try/catch.
 */

const PROJECT_ID = "demo-sparta-battle";

const ADMIN = "e2e-notif-admin";
const P1 = "e2e-notif-p1";
const P2 = "e2e-notif-p2";
const REEMBOLSADO = "e2e-notif-refunded";
const DE_FORA = "e2e-notif-outsider";

const T = "e2e-notif-t1";
const ROOM_ID = "E2E-SALA-42";
const ROOM_PASSWORD = "e2e-senha-secreta";

const TOKEN_P1 = "e2e-token-p1:APA91b-aaa";
const TOKEN_P2 = "e2e-token-p2:APA91b-bbb";

type Handler = (d: any, c: any) => Promise<any>;

const ctx = (uid: string, isAdmin = false) => ({
  auth: { uid, token: isAdmin ? { admin: true } : {} },
});

let db: admin.firestore.Firestore;
let startTournament: Handler;
let registerDeviceToken: Handler;
let unregisterDeviceToken: Handler;
let markNotificationsRead: Handler;

const inbox = (uid: string) =>
  db.collection("notifications").doc(uid).collection("items");

async function limpar(): Promise<void> {
  const alvos = [
    db.collection("tournaments").doc(T).delete(),
    db.collection("tournament_rooms").doc(T).delete(),
    db.collection("device_tokens").doc(TOKEN_P1).delete(),
    db.collection("device_tokens").doc(TOKEN_P2).delete(),
  ];
  for (const uid of [P1, P2, REEMBOLSADO, DE_FORA]) {
    alvos.push(db.collection("registrations").doc(`${uid}_${T}`).delete());
    alvos.push(db.collection("users").doc(uid).delete());
    const itens = await inbox(uid).get();
    for (const doc of itens.docs) alvos.push(doc.ref.delete());
  }
  await Promise.all(alvos);
}

/** Inscreve direto pelo Admin SDK: o assunto aqui é o aviso, não a inscrição. */
async function inscrever(uid: string, status: string): Promise<void> {
  await db.collection("users").doc(uid).set({ username: uid });
  await db
    .collection("registrations")
    .doc(`${uid}_${T}`)
    .set({
      user_ref: db.collection("users").doc(uid),
      tournament_ref: db.collection("tournaments").doc(T),
      status,
      economy_type: "beta_credit",
      entry_fee: 10,
      created_at: admin.firestore.Timestamp.now(),
    });
}

before(async () => {
  assertEmulatorOnly(PROJECT_ID);
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  if (admin.apps.length === 0) admin.initializeApp();
  db = admin.firestore();

  const mod: any = await import("../../src/index.js");
  startTournament = mod.startTournamentHandler;
  registerDeviceToken = mod.registerDeviceTokenHandler;
  unregisterDeviceToken = mod.unregisterDeviceTokenHandler;
  markNotificationsRead = mod.markNotificationsReadHandler;

  await limpar();

  await db.collection("tournaments").doc(T).set({
    title: "Copa do Aviso",
    status: "open",
    economy_type: "beta_credit",
    locked_economy_type: "beta_credit",
    prize: 100,
    kill_prize: 0,
    entry_fee: 10,
    max_participants: 16,
    current_participants: 3,
    created_at: admin.firestore.Timestamp.now(),
  });
  await db
    .collection("tournament_rooms")
    .doc(T)
    .set({
      room_id: ROOM_ID,
      room_password: ROOM_PASSWORD,
      tournament_ref: db.collection("tournaments").doc(T),
    });

  await inscrever(P1, "registered");
  await inscrever(P2, "registered");
  await inscrever(REEMBOLSADO, "refunded");
});

after(async () => {
  await limpar();
});

describe("E2E — iniciar o torneio avisa os inscritos", () => {
  it("registrar um token põe o caminho do push em jogo", async () => {
    const r = await registerDeviceToken(
      { token: TOKEN_P1, platform: "android" },
      ctx(P1)
    );
    assert.equal(r.success, true);

    const doc = await db.collection("device_tokens").doc(TOKEN_P1).get();
    assert.equal(doc.get("uid"), P1);
    assert.equal(doc.get("platform"), "android");
  });

  it("o torneio COMEÇA sem depender de push nenhum", async () => {
    const res = await startTournament({ tournamentid: T }, ctx(ADMIN, true));
    assert.equal(res.success, true);

    const t = await db.collection("tournaments").doc(T).get();
    assert.equal(t.get("status"), "in_progress");
  });

  it("nenhuma chamada saiu para o FCM de PRODUÇÃO", async () => {
    // A guarda de projeto demo. Sem ela o emulador alcança o serviço real com
    // a credencial local — e a resposta de produção para um token falso é
    // "não registrado", que faria o código podar o token aqui embaixo. O token
    // continuar vivo é a evidência de que nada saiu da máquina.
    const token = await db.collection("device_tokens").doc(TOKEN_P1).get();
    assert.equal(token.exists, true, "o token foi podado por uma resposta real");
  });

  it("cada inscrito recebeu UM aviso", async () => {
    for (const uid of [P1, P2]) {
      const itens = await inbox(uid).get();
      assert.equal(itens.size, 1, `caixa de ${uid}`);
      assert.equal(itens.docs[0].get("kind"), "room_open");
      assert.equal(itens.docs[0].get("tournament_id"), T);
      assert.equal(itens.docs[0].get("read_at"), null);
    }
  });

  it("o aviso NÃO carrega o ID nem a senha da sala", async () => {
    // É a razão de o aviso existir nesta forma. Um push aparece na tela de
    // bloqueio e sobrevive a uma troca de chip: a credencial ali entregaria a
    // sala a quem estiver com o telefone, inscrito ou não.
    const item = (await inbox(P1).get()).docs[0].data();
    const plano = JSON.stringify(item);
    assert.equal(plano.includes(ROOM_ID), false, "vazou o ID da sala");
    assert.equal(plano.includes(ROOM_PASSWORD), false, "vazou a senha");
  });

  it("o nome do torneio está no aviso, para distinguir na bandeja", async () => {
    const item = (await inbox(P1).get()).docs[0].data();
    assert.equal(item.title, "Copa do Aviso");
  });

  it("quem foi REEMBOLSADO não é avisado", async () => {
    // Quem saiu do torneio não tem vaga na sala; mandá-lo para lá é pior do
    // que não avisar.
    assert.equal((await inbox(REEMBOLSADO).get()).size, 0);
  });

  it("quem nunca se inscreveu não é avisado", async () => {
    assert.equal((await inbox(DE_FORA).get()).size, 0);
  });

  it("REINICIAR não duplica o aviso", async () => {
    // O id vem do torneio, então a segunda passada reescreve o mesmo
    // documento — é o que faz de reiniciar o conserto de uma entrega perdida,
    // e não uma notificação a mais.
    const antes = (await inbox(P1).get()).docs[0].id;

    const res = await startTournament({ tournamentid: T }, ctx(ADMIN, true));
    assert.equal(res.success, true);

    const depois = await inbox(P1).get();
    assert.equal(depois.size, 1);
    assert.equal(depois.docs[0].id, antes);
  });
});

describe("E2E — tokens de aparelho", () => {
  it("registrar o MESMO token noutra conta TROCA o dono", async () => {
    // Um aparelho pertence a uma conta por vez. Sem a troca, a conta anterior
    // continuaria recebendo aviso no celular de outra pessoa.
    await registerDeviceToken({ token: TOKEN_P2, platform: "web" }, ctx(P1));
    assert.equal(
      (await db.collection("device_tokens").doc(TOKEN_P2).get()).get("uid"),
      P1
    );

    await registerDeviceToken({ token: TOKEN_P2, platform: "web" }, ctx(P2));
    const doc = await db.collection("device_tokens").doc(TOKEN_P2).get();
    assert.equal(doc.get("uid"), P2);

    // E não sobrou um segundo documento com o dono antigo.
    const daConta = await db
      .collection("device_tokens")
      .where("uid", "==", P1)
      .get();
    assert.equal(
      daConta.docs.some((d) => d.id === TOKEN_P2),
      false
    );
  });

  it("só o DONO apaga o próprio token", async () => {
    // Apagar o token alheio silenciaria os avisos de outra pessoa, e o id é
    // adivinhável por quem já viu um token.
    await unregisterDeviceToken({ token: TOKEN_P2 }, ctx(P1));
    assert.equal(
      (await db.collection("device_tokens").doc(TOKEN_P2).get()).exists,
      true,
      "conta errada conseguiu apagar"
    );

    await unregisterDeviceToken({ token: TOKEN_P2 }, ctx(P2));
    assert.equal(
      (await db.collection("device_tokens").doc(TOKEN_P2).get()).exists,
      false
    );
  });

  it("deslogado não registra token", async () => {
    await assert.rejects(
      () => registerDeviceToken({ token: "x", platform: "web" }, { auth: null }),
      /Entre na sua conta/i
    );
  });

  it("plataforma desconhecida é recusada", async () => {
    await assert.rejects(
      () =>
        registerDeviceToken(
          { token: "e2e-token-lixo", platform: "windows" },
          ctx(P1)
        ),
      /Plataforma desconhecida/i
    );
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () =>
        registerDeviceToken(
          { token: "e2e-token-lixo", platform: "web", uid: P2 },
          ctx(P1)
        ),
      /.+/
    );
  });
});

describe("E2E — marcar como lido", () => {
  it("marca os da PRÓPRIA caixa e não toca na dos outros", async () => {
    const antesP2 = (await inbox(P2).get()).docs[0].get("read_at");
    assert.equal(antesP2, null, "o teste começou sujo");

    const res = await markNotificationsRead({}, ctx(P1));
    assert.equal(res.marked, 1);

    assert.notEqual((await inbox(P1).get()).docs[0].get("read_at"), null);
    assert.equal((await inbox(P2).get()).docs[0].get("read_at"), null);
  });

  it("marcar de novo não conta nada — não há o que marcar", async () => {
    const res = await markNotificationsRead({}, ctx(P1));
    assert.equal(res.marked, 0);
  });

  it("deslogado não marca nada", async () => {
    await assert.rejects(
      () => markNotificationsRead({}, { auth: null }),
      /Entre na sua conta/i
    );
  });
});
