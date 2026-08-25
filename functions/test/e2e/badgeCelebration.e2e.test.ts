import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * O MOMENTO DA CONQUISTA, contra um Firestore real.
 *
 * O que só o emulador prova: que a dívida de comemorar é GRAVADA junto com a
 * concessão, sobrevive ao app fechar, e some quando — e só quando — alguém diz
 * que mostrou. Conceder acontece uma vez; se o momento vivesse apenas na
 * resposta, um app morto no instante errado o perderia para sempre.
 */

const PROJECT_ID = "demo-sparta-battle";
const UID = "e2e-celebration";

const ctx = (uid: string) => ({ auth: { uid, token: {} } });

let db: admin.firestore.Firestore;
let getBadges: (d: unknown, c: unknown) => Promise<any>;
let ack: (d: unknown, c: unknown) => Promise<any>;

/** Uma conta que acabou de cruzar o limiar de "Spartano noobie" (50 jogos). */
async function seed(played: number, extra: Record<string, unknown> = {}) {
  await db
    .collection("users")
    .doc(UID)
    .set({ username: "NOOB", tournaments_played: played, ...extra });
}

describe("E2E — o momento da conquista", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    getBadges = (mod as any).getMyBadgesHandler;
    ack = (mod as any).acknowledgeBadgesHandler;
  });

  after(async () => {
    await db.collection("users").doc(UID).delete();
  });

  it("conceder GRAVA a dívida de comemorar", async () => {
    await seed(50);
    const first = await getBadges({}, ctx(UID));

    assert.deepEqual(first.awarded, ["spartan_noobie"]);
    assert.deepEqual(first.unseen, ["spartan_noobie"]);

    const stored = await db.collection("users").doc(UID).get();
    assert.deepEqual(stored.get("badges_unseen"), ["spartan_noobie"]);
  });

  it("SOBREVIVE ao app fechar: ler de novo ainda deve a comemoração", async () => {
    // O teste que justifica o campo existir. `awarded` fica vazio porque não há
    // nada novo a conceder — mas o momento continua devido.
    const second = await getBadges({}, ctx(UID));
    assert.deepEqual(second.awarded, [], "concedeu duas vezes");
    assert.deepEqual(second.unseen, ["spartan_noobie"]);
  });

  it("LER não gasta a comemoração — só reconhecer gasta", async () => {
    // Se olhar os selos limpasse a dívida, qualquer tela que apenas exibisse a
    // coleção apagaria em silêncio o momento que ela deveria celebrar.
    await getBadges({}, ctx(UID));
    await getBadges({}, ctx(UID));
    const still = await getBadges({}, ctx(UID));
    assert.deepEqual(still.unseen, ["spartan_noobie"]);
  });

  it("reconhecer limpa, e a leitura seguinte não deve mais nada", async () => {
    const done = await ack({ badge_ids: ["spartan_noobie"] }, ctx(UID));
    assert.deepEqual(done.acknowledged, ["spartan_noobie"]);

    const after = await getBadges({}, ctx(UID));
    assert.deepEqual(after.unseen, []);
    assert.deepEqual(after.badges, ["spartan_noobie"], "perdeu o selo");
  });

  it("reconhecer de novo é sucesso silencioso, não erro", async () => {
    // Dois aparelhos comemorando a mesma coisa é o caso comum; devolver erro
    // faria o app tentar para sempre.
    const again = await ack({ badge_ids: ["spartan_noobie"] }, ctx(UID));
    assert.deepEqual(again.acknowledged, []);
  });

  it("não dá para reconhecer um selo que não está pendente", async () => {
    await seed(50, { badges: ["spartan_noobie"], badges_unseen: [] });
    const out = await ack({ badge_ids: ["creator_legend"] }, ctx(UID));
    assert.deepEqual(out.acknowledged, []);

    const stored = await db.collection("users").doc(UID).get();
    assert.deepEqual(stored.get("badges_unseen"), []);
  });

  it("uma conta antiga com todos os selos NÃO é inundada de comemorações", async () => {
    // Quem já tinha tudo antes deste campo existir não ganha nada novo, então
    // não há dívida nenhuma a pagar — e não leva quinze diálogos na cara.
    const { BADGES } = await import("../../src/domain/badges.js");
    await seed(99_999, { badges: BADGES.map((b) => b.id) });

    const out = await getBadges({}, ctx(UID));
    assert.deepEqual(out.awarded, []);
    assert.deepEqual(out.unseen, []);
  });

  it("deslogado não reconhece nada", async () => {
    await assert.rejects(
      () => ack({ badge_ids: ["spartan_noobie"] }, { auth: null }),
      /Entre na sua conta/i
    );
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () => ack({ badge_ids: [], uid: UID }, ctx(UID)),
      /.+/
    );
  });
});
