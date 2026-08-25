import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import {
  PUBLIC_PLAYER_ID_COLLECTION,
  PUBLIC_PLAYER_ID_INDEX_COLLECTION,
} from "../../src/domain/publicPlayerId.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * O PERFIL PÚBLICO, contra um Firestore real.
 *
 * O que só o emulador prova: que o pseudônimo resolve para a conta certa pelo
 * índice server-only, que um estranho consegue ler o perfil, e que o uid — a
 * chave de todas as outras coleções — nunca sai na resposta.
 */

const PROJECT_ID = "demo-sparta-battle";
const OWNER = "e2e-profile-owner";
const STRANGER = "e2e-profile-stranger";
const PSEUDO = "e2eProfileAAAAAAAAAAAA"; // 22 chars, formato congelado

const ctx = (uid: string) => ({ auth: { uid, token: {} } });

let db: admin.firestore.Firestore;
let getProfile: (d: unknown, c: unknown) => Promise<any>;

async function cleanup(): Promise<void> {
  await Promise.all([
    db.collection("users").doc(OWNER).delete(),
    db.collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION).doc(PSEUDO).delete(),
  ]);
}

describe("E2E — perfil público", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    getProfile = (mod as any).getPublicProfileHandler;

    await cleanup();
    await db.collection("users").doc(OWNER).set({
      username: "RDKILL",
      badges: ["creator_verified", "spartan_noobie"],
      tournaments_played: 12,
      created_at: admin.firestore.Timestamp.fromDate(
        new Date(Date.UTC(2026, 7, 3))
      ),
      // Privado. Nada disto pode atravessar.
      email: "dono@sparta.gg",
      partner_ref: "parceiro-1",
      kyc_verified: true,
    });
    await db
      .collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION)
      .doc(PSEUDO)
      .set({ uid: OWNER });
  });

  after(async () => {
    await cleanup();
  });

  it("um ESTRANHO logado consegue ver o perfil", async () => {
    // É o ponto da feature: um perfil é uma página que se manda para alguém.
    const p = await getProfile({ public_player_id: PSEUDO }, ctx(STRANGER));
    assert.equal(p.nickname, "RDKILL");
    assert.deepEqual(p.badges, ["creator_verified", "spartan_noobie"]);
    assert.equal(p.tournamentsPlayed, 12);
    assert.equal(p.memberSince, "agosto de 2026");
  });

  it("o uid NÃO sai — nem o e-mail, nem o parceiro, nem o KYC", async () => {
    const p = await getProfile({ public_player_id: PSEUDO }, ctx(STRANGER));
    const flat = JSON.stringify(p);
    for (const secret of [OWNER, "dono@sparta.gg", "parceiro-1", "kyc"]) {
      assert.equal(flat.includes(secret), false, `vazou "${secret}"`);
    }
  });

  it("deslogado não lê perfil nenhum", async () => {
    // Endpoint aberto sobre um id de 22 caracteres é superfície de raspagem;
    // exigir conta põe nome em quem percorre o espaço.
    await assert.rejects(
      () => getProfile({ public_player_id: PSEUDO }, { auth: null }),
      /Entre na sua conta/i
    );
  });

  it("pseudônimo fora do formato é recusado antes de qualquer leitura", async () => {
    for (const bad of ["curto", "", "a".repeat(23), "com espaco aqui!!!!!!!"]) {
      await assert.rejects(
        () => getProfile({ public_player_id: bad }, ctx(STRANGER)),
        /Perfil inválido/i,
        bad
      );
    }
  });

  it("pseudônimo válido mas inexistente é not-found", async () => {
    await assert.rejects(
      () =>
        getProfile(
          { public_player_id: "naoExisteAAAAAAAAAAAAA" },
          ctx(STRANGER)
        ),
      /não encontrado/i
    );
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () =>
        getProfile(
          { public_player_id: PSEUDO, uid: OWNER },
          ctx(STRANGER)
        ),
      /.+/
    );
  });
});

/**
 * O PRÓPRIO PERFIL — a metade que faltava.
 *
 * Antes disto o pseudônimo era cunhado só pela liquidação de prêmio, então
 * quem nunca ganhou não tinha endereço nenhum e não tinha link para mandar.
 * Estes testes provam as duas coisas que só o emulador prova: que a chamada
 * CUNHA a identidade quando ela não existe, e que chamar de novo devolve a
 * MESMA — porque um link de perfil que muda é um link quebrado.
 */
describe("E2E — meu próprio perfil", () => {
  const ME = "e2e-profile-me";
  let getMine: (d: unknown, c: unknown) => Promise<any>;

  async function wipeIdentity(): Promise<void> {
    const map = await db.collection(PUBLIC_PLAYER_ID_COLLECTION).doc(ME).get();
    const minted = map.exists ? String(map.get("publicPlayerId") ?? "") : "";
    await Promise.all([
      db.collection("users").doc(ME).delete(),
      map.ref.delete(),
      minted
        ? db
            .collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION)
            .doc(minted)
            .delete()
        : Promise.resolve(),
    ]);
  }

  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    getMine = (mod as any).getMyProfileHandler;

    await wipeIdentity();
    await db.collection("users").doc(ME).set({
      username: "LEONIDAS",
      badges: ["spartan_noobie"],
      tournaments_played: 5,
      created_at: admin.firestore.Timestamp.fromDate(
        new Date(Date.UTC(2026, 0, 20))
      ),
      email: "eu@sparta.gg",
    });
  });

  after(async () => {
    await wipeIdentity();
  });

  it("CUNHA o pseudônimo de quem nunca ganhou nada", async () => {
    // O caso que motivou a função: sem isto o jogador não tem endereço.
    const before = await db
      .collection(PUBLIC_PLAYER_ID_COLLECTION)
      .doc(ME)
      .get();
    assert.equal(before.exists, false, "o teste começou sujo");

    const mine = await getMine({}, ctx(ME));
    assert.match(mine.publicPlayerId, /^[A-Za-z0-9_-]{22}$/);

    const after = await db
      .collection(PUBLIC_PLAYER_ID_COLLECTION)
      .doc(ME)
      .get();
    assert.equal(after.get("publicPlayerId"), mine.publicPlayerId);
  });

  it("chamar de novo devolve o MESMO — um link de perfil não muda", async () => {
    const first = await getMine({}, ctx(ME));
    const second = await getMine({}, ctx(ME));
    assert.equal(first.publicPlayerId, second.publicPlayerId);
  });

  it("o dono vê EXATAMENTE o que o estranho vê", async () => {
    // É a razão de os dois compartilharem o mesmo carregador: uma prévia que
    // discorda do que o estranho recebe é pior do que não ter prévia.
    const mine = await getMine({}, ctx(ME));
    const theirs = await getProfile(
      { public_player_id: mine.publicPlayerId },
      ctx(STRANGER)
    );
    assert.deepEqual(theirs, mine);
  });

  it("nada privado atravessa, nem para o próprio dono", async () => {
    // Não é o perfil da conta: é a prévia do que vai ser publicado.
    const flat = JSON.stringify(await getMine({}, ctx(ME)));
    for (const secret of [ME, "eu@sparta.gg"]) {
      assert.equal(flat.includes(secret), false, `vazou "${secret}"`);
    }
  });

  it("uma conta inexistente NÃO ganha um pseudônimo órfão", async () => {
    // A identidade é create-only e nunca liberada, então cunhar uma antes de
    // saber que a conta existe deixaria um par de documentos que nada limpa.
    const ghost = "e2e-profile-ghost";
    await assert.rejects(() => getMine({}, ctx(ghost)), /não foi encontrada/i);

    const map = await db
      .collection(PUBLIC_PLAYER_ID_COLLECTION)
      .doc(ghost)
      .get();
    assert.equal(map.exists, false, "cunhou identidade para conta inexistente");
  });

  it("deslogado não tem perfil para ver", async () => {
    await assert.rejects(
      () => getMine({}, { auth: null }),
      /Entre na sua conta/i
    );
  });

  it("chave a mais no payload derruba a chamada", async () => {
    // Sem isto, `{ public_player_id: <de outro> }` passaria despercebido e a
    // função pareceria aceitar um alvo que ela nunca honra.
    await assert.rejects(() => getMine({ public_player_id: PSEUDO }, ctx(ME)), /.+/);
  });
});
