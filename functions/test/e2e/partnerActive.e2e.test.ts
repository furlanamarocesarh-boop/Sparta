import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { PARTNERS_COLLECTION } from "../../src/domain/partnerReferral.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * DESLIGAR UM PARCEIRO.
 *
 * `active` era lido em três lugares e escrito num só — sempre como true. Um
 * código de indicação sendo abusado não tinha alavanca nenhuma. Esta suíte
 * prova que agora tem, e que desligar NÃO apaga o que já foi ganho.
 */

const PROJECT_ID = "demo-sparta-battle";
const PARTNER = "e2e-active-partner";
const ADMIN_CONTEXT = { auth: { uid: "e2e-admin", token: { admin: true } } };
const PLAYER_CONTEXT = { auth: { uid: "e2e-player", token: {} } };

let db: admin.firestore.Firestore;
let setActive: (data: unknown, context: unknown) => Promise<any>;

describe("E2E — ligar e desligar um parceiro", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    setActive = (mod as any).setPartnerActiveHandler;

    await db.collection(PARTNERS_COLLECTION).doc(PARTNER).set({
      name: "Parceiro E2E",
      code: "e2e-active-code",
      active: true,
      total_accrued_centavos: 5_000,
    });
  });

  after(async () => {
    await db.collection(PARTNERS_COLLECTION).doc(PARTNER).delete();
  });

  it("desliga, e registra QUEM desligou", async () => {
    // Um flag que vira sem deixar rastro é um flag que ninguém defende depois.
    const r = await setActive(
      { partner_id: PARTNER, active: false },
      ADMIN_CONTEXT
    );
    assert.equal(r.changed, true);

    const p = await db.collection(PARTNERS_COLLECTION).doc(PARTNER).get();
    assert.equal(p.get("active"), false);
    assert.equal(p.get("active_changed_by"), "e2e-admin");
    assert.ok(p.get("active_changed_at"));
  });

  it("desligar NÃO apaga o que o parceiro já ganhou", async () => {
    // Comissão acumulada é fato consumado. Apagá-la seria pior do que deixar.
    const p = await db.collection(PARTNERS_COLLECTION).doc(PARTNER).get();
    assert.equal(p.get("total_accrued_centavos"), 5_000);
  });

  it("repetir o mesmo estado não escreve de novo", async () => {
    const r = await setActive(
      { partner_id: PARTNER, active: false },
      ADMIN_CONTEXT
    );
    assert.equal(r.changed, false);
  });

  it("liga de volta — é reversível, não é exclusão", async () => {
    const r = await setActive(
      { partner_id: PARTNER, active: true },
      ADMIN_CONTEXT
    );
    assert.equal(r.changed, true);
    const p = await db.collection(PARTNERS_COLLECTION).doc(PARTNER).get();
    assert.equal(p.get("active"), true);
  });

  it("jogador comum não desliga parceiro nenhum", async () => {
    await assert.rejects(
      () => setActive({ partner_id: PARTNER, active: false }, PLAYER_CONTEXT),
      /Apenas admin/i
    );
  });

  it('a string "false" NÃO é lida como desligar', async () => {
    // "false" é truthy em JavaScript: lê-la como pedido seria o oposto exato.
    await assert.rejects(
      () =>
        setActive(
          { partner_id: PARTNER, active: "false" },
          ADMIN_CONTEXT
        ),
      /verdadeiro ou falso/i
    );
    const p = await db.collection(PARTNERS_COLLECTION).doc(PARTNER).get();
    assert.equal(p.get("active"), true, "mudou mesmo recusando");
  });

  it("parceiro inexistente é not-found, não criação silenciosa", async () => {
    await assert.rejects(
      () => setActive({ partner_id: "nao-existe", active: true }, ADMIN_CONTEXT),
      /não encontrado/i
    );
  });
});
