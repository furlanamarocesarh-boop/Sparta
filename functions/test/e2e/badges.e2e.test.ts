import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { NICKNAMES_COLLECTION } from "../../src/domain/nickname.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * SELOS E NICK, contra um Firestore real.
 *
 * O que só o emulador prova: que a reserva de nick é atômica (dois jogadores
 * não ficam com o mesmo), que a concessão é idempotente (abrir a tela duas
 * vezes escreve uma), e que a marca d'água alta resiste à contagem cair de
 * verdade — não só na função pura.
 */

const PROJECT_ID = "demo-sparta-battle";
const PLAYER = "e2e-badge-player";
const RIVAL = "e2e-badge-rival";

const ctx = (uid: string) => ({ auth: { uid, token: {} } });

let db: admin.firestore.Firestore;
let setNickname: (d: unknown, c: unknown) => Promise<any>;
let getMyBadges: (d: unknown, c: unknown) => Promise<any>;

async function cleanup(): Promise<void> {
  const nicks = await db.collection(NICKNAMES_COLLECTION).get();
  const created = await db
    .collection("tournaments")
    .where("creator_uid", "==", PLAYER)
    .get();
  await Promise.all([
    ...[PLAYER, RIVAL].map((u) => db.collection("users").doc(u).delete()),
    ...nicks.docs
      .filter((d) => [PLAYER, RIVAL].includes(d.get("uid")))
      .map((d) => d.ref.delete()),
    ...created.docs.map((d) => d.ref.delete()),
  ]);
}

describe("E2E — nick e selos", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    setNickname = (mod as any).setNicknameHandler;
    getMyBadges = (mod as any).getMyBadgesHandler;

    await cleanup();
    await Promise.all(
      [PLAYER, RIVAL].map((uid) =>
        db.collection("users").doc(uid).set({ email: "", username: "" })
      )
    );
  });

  after(async () => {
    await cleanup();
  });

  it("define o nick e o guarda no Firestore, não no perfil do Auth", async () => {
    // O defeito que docs/username.md descreve: o nome ficava só no Auth, onde
    // nenhuma feature de servidor consegue lê-lo.
    await setNickname({ nickname: "Spartano" }, ctx(PLAYER));

    const user = await db.collection("users").doc(PLAYER).get();
    assert.equal(user.get("username"), "Spartano", "não guardou o que digitou");
    assert.equal(user.get("username_normalized"), "spartano");
  });

  it("um segundo jogador NÃO fica com o mesmo nick", async () => {
    await assert.rejects(
      () => setNickname({ nickname: "spartano" }, ctx(RIVAL)),
      /já está em uso/i
    );
  });

  it("acento e caixa colidem com o mesmo nick", async () => {
    // "Spártano" e "spartano" numa lista de inscritos são indistinguíveis.
    await assert.rejects(
      () => setNickname({ nickname: "Spártano" }, ctx(RIVAL)),
      /já está em uso/i
    );
  });

  it("redefinir o PRÓPRIO nick é sucesso, não erro", async () => {
    // Uma requisição repetida não pode dizer ao jogador que o nome dele
    // mesmo está tomado.
    await setNickname({ nickname: "Spartano" }, ctx(PLAYER));
    const user = await db.collection("users").doc(PLAYER).get();
    assert.equal(user.get("username"), "Spartano");
  });

  it("trocar de nick LIBERA o antigo, na mesma transação", async () => {
    await setNickname({ nickname: "Outro_Nick" }, ctx(PLAYER));

    const [antigo, novo] = await Promise.all([
      db.collection(NICKNAMES_COLLECTION).doc("spartano").get(),
      db.collection(NICKNAMES_COLLECTION).doc("outro_nick").get(),
    ]);
    assert.equal(antigo.exists, false, "o nick antigo ficou preso");
    assert.equal(novo.get("uid"), PLAYER);

    // E agora o rival consegue tomá-lo.
    await setNickname({ nickname: "Spartano" }, ctx(RIVAL));
    const rival = await db.collection("users").doc(RIVAL).get();
    assert.equal(rival.get("username"), "Spartano");
  });

  it("sem nada feito, nenhum selo é concedido", async () => {
    const r = await getMyBadges({}, ctx(PLAYER));
    assert.deepEqual(r.badges, []);
    assert.deepEqual(r.awarded, []);
  });

  it("criar 10 campeonatos concede o selo de verificação", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db
          .collection("tournaments")
          .doc(`e2e-badge-t${i}`)
          .set({ name: `T${i}`, creator_uid: PLAYER, status: "open" })
      )
    );

    const r = await getMyBadges({}, ctx(PLAYER));
    assert.deepEqual(r.awarded, ["creator_verified"]);
    assert.equal(r.counts.tournamentsCreated, 10);
  });

  it("abrir a tela DE NOVO não concede nada — é idempotente", async () => {
    const r = await getMyBadges({}, ctx(PLAYER));
    assert.deepEqual(r.awarded, [], "concedeu duas vezes");
    assert.deepEqual(r.badges, ["creator_verified"]);
  });

  it("jogar 50 campeonatos concede o Spartano noobie", async () => {
    await db
      .collection("users")
      .doc(PLAYER)
      .set({ tournaments_played: 50 }, { merge: true });

    const r = await getMyBadges({}, ctx(PLAYER));
    assert.deepEqual(r.awarded, ["spartan_noobie"]);
  });

  it("a contagem CAIR não tira o selo já ganho", async () => {
    // Torneios apagados, contagem a zero — e o selo continua.
    const created = await db
      .collection("tournaments")
      .where("creator_uid", "==", PLAYER)
      .get();
    await Promise.all(created.docs.map((d) => d.ref.delete()));
    await db
      .collection("users")
      .doc(PLAYER)
      .set({ tournaments_played: 0 }, { merge: true });

    const r = await getMyBadges({}, ctx(PLAYER));
    assert.equal(r.counts.tournamentsCreated, 0);
    assert.ok(
      r.badges.includes("creator_verified"),
      "revogou um selo já conquistado"
    );
    assert.ok(r.badges.includes("spartan_noobie"));
  });
});
