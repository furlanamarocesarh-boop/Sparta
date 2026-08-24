import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import {
  PARTNERS_COLLECTION,
  REFERRAL_CODES_COLLECTION,
} from "../../src/domain/partnerReferral.js";
import { PARTNER_APPLICATIONS_COLLECTION } from "../../src/domain/partnerApplication.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * O CICLO INTEIRO: candidatar-se, ser aprovado, virar parceiro.
 *
 * O que só o Firestore real prova é que aprovar REUSA o caminho de registro —
 * incluindo a reserva de código — e que dois candidatos querendo o mesmo
 * código não podem ambos ficar com ele.
 */

const PROJECT_ID = "demo-sparta-battle";
const APPLICANT = "e2e-applicant";
const RIVAL = "e2e-applicant-rival";
const CODE = "e2e-code-disputado";

const adminCtx = { auth: { uid: "e2e-admin", token: { admin: true } } };
const userCtx = (uid: string) => ({ auth: { uid, token: {} } });

let db: admin.firestore.Firestore;
let apply: (d: unknown, c: unknown) => Promise<any>;
let review: (d: unknown, c: unknown) => Promise<any>;

const form = (code: string) => ({
  platform: "tiktok",
  handle: "@candidato",
  followers: 50_000,
  average_views: 8_000,
  expected_players: 120,
  proposed_code: code,
});

async function cleanup(): Promise<void> {
  const partners = await db.collection(PARTNERS_COLLECTION).get();
  await Promise.all([
    ...[APPLICANT, RIVAL].map((u) =>
      db.collection(PARTNER_APPLICATIONS_COLLECTION).doc(u).delete()
    ),
    ...partners.docs
      .filter((d) => [APPLICANT, RIVAL].includes(d.get("owner_uid")))
      .map((d) => d.ref.delete()),
    db.collection(REFERRAL_CODES_COLLECTION).doc(CODE).delete(),
  ]);
}

describe("E2E — candidatura a colaborador", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    apply = (mod as any).applyForPartnerHandler;
    review = (mod as any).reviewPartnerApplicationHandler;
    await cleanup();
  });

  after(async () => {
    await cleanup();
  });

  it("qualquer jogador logado se candidata, e o uid vem do TOKEN", async () => {
    // Não há uid no payload: uma candidatura só pode ser sobre quem a envia.
    await apply(form(CODE), userCtx(APPLICANT));

    const doc = await db
      .collection(PARTNER_APPLICATIONS_COLLECTION)
      .doc(APPLICANT)
      .get();
    assert.equal(doc.exists, true);
    assert.equal(doc.get("uid"), APPLICANT);
    assert.equal(doc.get("status"), "pending");
    assert.equal(doc.get("followers"), 50_000);
  });

  it("reenviar enquanto pendente CORRIGE, não duplica", async () => {
    await apply({ ...form(CODE), followers: 60_000 }, userCtx(APPLICANT));

    const all = await db
      .collection(PARTNER_APPLICATIONS_COLLECTION)
      .where("uid", "==", APPLICANT)
      .get();
    assert.equal(all.size, 1, "criou uma segunda candidatura");
    assert.equal(all.docs[0].get("followers"), 60_000);
  });

  it("jogador comum NÃO avalia candidatura", async () => {
    await assert.rejects(
      () => review({ uid: APPLICANT, approve: true }, userCtx(APPLICANT)),
      /Apenas admin/i
    );
  });

  it("aprovar cria o parceiro com o código pedido", async () => {
    const r = await review({ uid: APPLICANT, approve: true }, adminCtx);
    assert.equal(r.status, "approved");

    const partners = await db
      .collection(PARTNERS_COLLECTION)
      .where("owner_uid", "==", APPLICANT)
      .get();
    assert.equal(partners.size, 1, "aprovou sem criar o parceiro");
    assert.equal(partners.docs[0].get("active"), true);

    // A reserva do código é a mesma do registro manual.
    const reserved = await db
      .collection(REFERRAL_CODES_COLLECTION)
      .doc(CODE)
      .get();
    assert.equal(reserved.exists, true);
  });

  it("um segundo candidato NÃO fica com o mesmo código", async () => {
    // Sem isso, a segunda aprovação sobrescreveria o link do primeiro.
    await apply(form(CODE), userCtx(RIVAL));
    await assert.rejects(
      () => review({ uid: RIVAL, approve: true }, adminCtx),
      /.+/
    );

    const partners = await db
      .collection(PARTNERS_COLLECTION)
      .where("owner_uid", "==", RIVAL)
      .get();
    assert.equal(partners.size, 0, "criou parceiro com código já tomado");
  });

  it("aprovado não reabre a própria candidatura", async () => {
    await assert.rejects(
      () => apply(form("outro-codigo"), userCtx(APPLICANT)),
      /já é parceiro/i
    );
  });

  it("avaliar duas vezes é recusado", async () => {
    await assert.rejects(
      () => review({ uid: APPLICANT, approve: false }, adminCtx),
      /já foi avaliada/i
    );
  });

  it("recusar MARCA a candidatura, não apaga", async () => {
    // Apagar deixaria a pessoa recandidatar-se na hora e apagaria o porquê.
    await review({ uid: RIVAL, approve: false }, adminCtx);
    const doc = await db
      .collection(PARTNER_APPLICATIONS_COLLECTION)
      .doc(RIVAL)
      .get();
    assert.equal(doc.exists, true);
    assert.equal(doc.get("status"), "rejected");
    assert.equal(doc.get("reviewed_by"), "e2e-admin");
  });
});
