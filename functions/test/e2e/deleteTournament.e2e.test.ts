import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * APAGAR UM CAMPEONATO, contra um Firestore real.
 *
 * O que só o emulador prova:
 *
 *  - que o dinheiro VOLTA para a carteira antes de qualquer coisa sumir, no
 *    bolso exato que pagou;
 *  - que o campeonato, as inscrições, a sala e o aviso somem de verdade;
 *  - que as TRANSAÇÕES sobrevivem, com o vínculo anulado — elas são o extrato
 *    de quem pagou, não propriedade do campeonato;
 *  - que apagar duas vezes não reembolsa duas vezes;
 *  - e que apagar não é um jeito de ficar com o dinheiro de quem está jogando
 *    agora.
 */

const PROJECT_ID = "demo-sparta-battle";

const DONO = "e2e-del-dono";
const OUTRO_ADMIN = "e2e-del-outro";
const JOGADOR = "e2e-del-jogador";

const ctx = (uid: string) => ({ auth: { uid, token: { admin: true } } });

type Handler = (d: any, c: any) => Promise<any>;

let db: admin.firestore.Firestore;
let deleteTournament: Handler;
let joinTournament: Handler;

const inbox = (uid: string) =>
  db.collection("notifications").doc(uid).collection("items");

/** Um torneio completo com uma inscrição paga, montado pelo Admin SDK. */
async function seed(
  id: string,
  options: {
    status?: string;
    comInscricao?: boolean;
    inscricaoStatus?: string;
    comResultado?: boolean;
    saldoBeta?: number;
  } = {}
): Promise<void> {
  const {
    status = "open",
    comInscricao = true,
    inscricaoStatus = "registered",
    comResultado = false,
    saldoBeta = 100,
  } = options;

  const tournamentRef = db.collection("tournaments").doc(id);
  const userRef = db.collection("users").doc(JOGADOR);

  await db.collection("users").doc(DONO).set({ username: "DONO" });
  await userRef.set({ username: "JOGADOR" });
  await db.collection("wallets").doc(JOGADOR).set({
    balance: 0,
    beta_balance: saldoBeta,
    total_spent: 0,
    user_ref: userRef,
  });

  await tournamentRef.set({
    title: "Copa Para Apagar",
    status,
    economy_type: "beta_credit",
    locked_economy_type: "beta_credit",
    entry_fee: 10,
    prize: 50,
    kill_prize: 0,
    max_participants: 16,
    current_participants: comInscricao ? 1 : 0,
    creator_uid: DONO,
    created_at: admin.firestore.Timestamp.now(),
    ...(comResultado
      ? { result: { winner_uid: JOGADOR, prize: 50, total_paid: 50 } }
      : {}),
  });

  await db.collection("tournament_rooms").doc(id).set({
    tournament_ref: tournamentRef,
    room_id: "SALA-DEL",
    room_password: "senha-del",
  });

  await inbox(JOGADOR).doc(`room_open_${id}`).set({
    kind: "room_open",
    title: "Copa Para Apagar",
    body: "A sala está aberta.",
    tournament_id: id,
    created_at: admin.firestore.Timestamp.now(),
    read_at: null,
  });

  if (!comInscricao) return;

  const txRef = db.collection("transactions").doc(`entryfee_${id}`);
  await txRef.set({
    category: "beta_entry_fee",
    economy_type: "beta_credit",
    amount: 10,
    user_ref: userRef,
    tournament_ref: tournamentRef,
    status: "completed",
    timestamp: admin.firestore.Timestamp.now(),
  });
  await db
    .collection("registrations")
    .doc(`${JOGADOR}_${id}`)
    .set({
      user_ref: userRef,
      tournament_ref: tournamentRef,
      status: inscricaoStatus,
      economy_type: "beta_credit",
      entry_fee: 10,
      entry_fee_snapshot: 10,
      transaction_ref: txRef,
      created_at: admin.firestore.Timestamp.now(),
    });
}

async function wipe(id: string): Promise<void> {
  const alvos: Array<Promise<unknown>> = [
    db.collection("tournaments").doc(id).delete(),
    db.collection("tournament_rooms").doc(id).delete(),
    db.collection("registrations").doc(`${JOGADOR}_${id}`).delete(),
    db.collection("transactions").doc(`entryfee_${id}`).delete(),
    inbox(JOGADOR).doc(`room_open_${id}`).delete(),
  ];
  const refunds = await db
    .collection("transactions")
    .where("category", "in", ["beta_refund", "entry_refund"])
    .get();
  for (const doc of refunds.docs) alvos.push(doc.ref.delete());
  await Promise.all(alvos);
}

before(async () => {
  assertEmulatorOnly(PROJECT_ID);
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  if (admin.apps.length === 0) admin.initializeApp();
  db = admin.firestore();

  const mod: any = await import("../../src/index.js");
  deleteTournament = mod.deleteTournamentHandler;
  joinTournament = mod.jointournamentHandler;
  void joinTournament;
});

describe("E2E — apagar devolvendo o dinheiro", () => {
  const T = "e2e-del-com-dinheiro";

  before(async () => {
    await wipe(T);
    await seed(T);
  });
  after(async () => {
    await wipe(T);
    await db.collection("wallets").doc(JOGADOR).delete();
  });

  it("o dinheiro volta para a carteira, no bolso que pagou", async () => {
    const antes = await db.collection("wallets").doc(JOGADOR).get();
    assert.equal(antes.get("beta_balance"), 100);

    const res = await deleteTournament({ tournamentid: T }, ctx(DONO));
    assert.equal(res.success, true);
    assert.equal(res.refunded_registrations, 1);

    const depois = await db.collection("wallets").doc(JOGADOR).get();
    assert.equal(depois.get("beta_balance"), 110, "o beta não voltou");
    // E nunca no bolso errado: as duas economias jamais se misturam.
    assert.equal(depois.get("balance"), 0);
  });

  it("o campeonato, a inscrição, a sala e o aviso SOMEM", async () => {
    for (const [rotulo, snap] of [
      ["torneio", await db.collection("tournaments").doc(T).get()],
      ["sala", await db.collection("tournament_rooms").doc(T).get()],
      [
        "inscrição",
        await db.collection("registrations").doc(`${JOGADOR}_${T}`).get(),
      ],
      ["aviso", await inbox(JOGADOR).doc(`room_open_${T}`).get()],
    ] as ReadonlyArray<readonly [string, admin.firestore.DocumentSnapshot]>) {
      assert.equal(snap.exists, false, `${rotulo} sobreviveu`);
    }
  });

  it("as TRANSAÇÕES sobrevivem, com o vínculo anulado", async () => {
    // Elas não são do campeonato: são o extrato de quem pagou. Apagar o
    // histórico financeiro de outra pessoa porque o criador desistiu do
    // torneio seria pior do que qualquer sobra.
    const tx = await db.collection("transactions").doc(`entryfee_${T}`).get();
    assert.equal(tx.exists, true, "o extrato foi apagado");
    assert.equal(tx.get("amount"), 10);

    // E não aponta mais para um documento que não existe.
    assert.equal(tx.get("tournament_ref"), null);
    assert.equal(tx.get("tournament_deleted"), true);
    assert.equal(tx.get("tournament_title"), "Copa Para Apagar");
  });

  it("apagar de novo é sucesso e NÃO reembolsa outra vez", async () => {
    const carteiraAntes = (
      await db.collection("wallets").doc(JOGADOR).get()
    ).get("beta_balance");

    const res = await deleteTournament({ tournamentid: T }, ctx(DONO));
    assert.equal(res.success, true);
    assert.equal(res.already_gone, true);
    assert.equal(res.refunded_registrations, 0);

    assert.equal(
      (await db.collection("wallets").doc(JOGADOR).get()).get("beta_balance"),
      carteiraAntes,
      "reembolsou duas vezes"
    );
  });
});

describe("E2E — quem pode apagar", () => {
  const T = "e2e-del-permissao";

  before(async () => {
    await wipe(T);
    await seed(T, { comInscricao: false });
  });
  after(async () => {
    await wipe(T);
  });

  it("outro admin NÃO apaga o campeonato alheio", async () => {
    // Em toda a base, creator_uid nunca foi consultado como autorização.
    // Passa numa ação reversível como cancelar; numa irreversível, não.
    await assert.rejects(
      () => deleteTournament({ tournamentid: T }, ctx(OUTRO_ADMIN)),
      /Só quem criou/i
    );
    assert.equal(
      (await db.collection("tournaments").doc(T).get()).exists,
      true,
      "apagou mesmo assim"
    );
  });

  it("deslogado não apaga nada", async () => {
    await assert.rejects(
      () => deleteTournament({ tournamentid: T }, { auth: null }),
      /Você precisa estar logado/i
    );
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () => deleteTournament({ tournamentid: T, force: true }, ctx(DONO)),
      /.+/
    );
    assert.equal(
      (await db.collection("tournaments").doc(T).get()).exists,
      true
    );
  });

  it("o dono apaga o próprio, mesmo sem inscritos", async () => {
    const res = await deleteTournament({ tournamentid: T }, ctx(DONO));
    assert.equal(res.success, true);
    assert.equal(res.refunded_registrations, 0);
    assert.equal(
      (await db.collection("tournaments").doc(T).get()).exists,
      false
    );
  });
});

describe("E2E — em andamento com jogadores", () => {
  const T = "e2e-del-rolando";

  before(async () => {
    await wipe(T);
    await seed(T, { status: "in_progress" });
  });
  after(async () => {
    await wipe(T);
    await db.collection("wallets").doc(JOGADOR).delete();
  });

  it("é RECUSADO — apagar não pode ser um jeito de ficar com o dinheiro",
    async () => {
      // O dinheiro dos inscritos está no bolo e o prêmio ainda não saiu.
      await assert.rejects(
        () => deleteTournament({ tournamentid: T }, ctx(DONO)),
        /em andamento com jogadores/i
      );
    });

  it("e nada foi tocado", async () => {
    assert.equal(
      (await db.collection("tournaments").doc(T).get()).exists,
      true
    );
    assert.equal(
      (await db.collection("registrations").doc(`${JOGADOR}_${T}`).get()).exists,
      true
    );
    assert.equal(
      (await db.collection("wallets").doc(JOGADOR).get()).get("beta_balance"),
      100,
      "mexeu na carteira de quem está jogando"
    );
  });
});

describe("E2E — já liquidado", () => {
  const T = "e2e-del-liquidado";

  before(async () => {
    await wipe(T);
    await seed(T, { status: "completed", comResultado: true });
  });
  after(async () => {
    await wipe(T);
    await db.collection("wallets").doc(JOGADOR).delete();
  });

  it("apaga SEM reembolsar — a entrada já virou prêmio pago", async () => {
    // Devolvê-la agora daria ao jogador o prêmio E a entrada de volta:
    // dinheiro criado do nada.
    const antes = (await db.collection("wallets").doc(JOGADOR).get()).get(
      "beta_balance"
    );

    const res = await deleteTournament({ tournamentid: T }, ctx(DONO));
    assert.equal(res.success, true);
    assert.equal(res.refunded_registrations, 0);

    assert.equal(
      (await db.collection("wallets").doc(JOGADOR).get()).get("beta_balance"),
      antes,
      "reembolsou um torneio já liquidado"
    );
    assert.equal(
      (await db.collection("tournaments").doc(T).get()).exists,
      false
    );
  });
});
