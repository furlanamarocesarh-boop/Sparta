import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";

import {
  COMMISSION_ACCRUED_CATEGORY,
  PARTNERS_COLLECTION,
  PARTNER_TOTAL_FIELD,
  REFERRAL_CODES_COLLECTION,
} from "../../src/domain/partnerReferral.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";
import { fetchWithTimeout } from "../support/httpTimeout.js";

/**
 * THE ACCEPTED PATH — the half the unit tests deliberately cannot reach.
 *
 * `entryFeeAccrualDoor.test.ts` proves every refusal that happens BEFORE any
 * I/O. Past that door the handler reads the user, reads the partner, writes a
 * ledger row and increments a running total, and only a live emulator can show
 * those actually happen — and that Firestore DELIVERS the create event to the
 * deployed trigger at all. A wrong path or `.onWrite` instead of `.onCreate`
 * would pass the entire unit suite.
 *
 * So this file never imports the handler. It writes ONE cash entry-fee row with
 * the Admin SDK and then only observes.
 *
 * IT ALSO PROVES THE ABSENCE OF A LOOP. The accrual is itself a write to
 * `transactions/{id}`, the very collection the trigger watches, so a careless
 * front door would make the feature feed itself forever. The final assertion
 * checks that no accrual was raised for the accrual.
 */

const PROJECT_ID = "demo-sparta-battle";

/** Unique to this suite so no sibling E2E file can collide with it. */
const PARTNER_ID = "e2e-partner-accrual";
const REFERRAL_CODE = "e2e-accrual-code";
const PLAYER_UID = "e2e-partner-accrual-player";
const TOURNAMENT_ID = "e2e-partner-accrual-tournament";
const REGISTRATION_ID = `${PLAYER_UID}_${TOURNAMENT_ID}`;
const ENTRY_TX_ID = `entry_${REGISTRATION_ID}`;
const ACCRUAL_ID = `commission_${REGISTRATION_ID}`;

/** R$ 100,00 -> fee 750 centavos -> commission 300 centavos. */
const ENTRY_REAIS = 100;
const EXPECTED_FEE_CENTAVOS = 750;
const EXPECTED_COMMISSION_CENTAVOS = 300;

const TRIGGER_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const NO_LOOP_SETTLE_MS = 4_000;

const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";

let db: admin.firestore.Firestore;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function awaitDoc(
  path: string,
  timeoutMs = TRIGGER_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await db.doc(path).get();
    if (snap.exists) return snap.data() ?? {};
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `o trigger não entregou em ${timeoutMs}ms: "${path}" nunca apareceu — ` +
      `o binding onCreate de transactions/{transactionId} não disparou`
  );
}

async function cleanup(): Promise<void> {
  await Promise.all([
    db.collection("transactions").doc(ENTRY_TX_ID).delete(),
    db.collection("transactions").doc(ACCRUAL_ID).delete(),
    db.collection("transactions").doc(`commission_${ACCRUAL_ID}`).delete(),
    db.collection("users").doc(PLAYER_UID).delete(),
    db.collection(PARTNERS_COLLECTION).doc(PARTNER_ID).delete(),
    db.collection(REFERRAL_CODES_COLLECTION).doc(REFERRAL_CODE).delete(),
  ]);
}

let accrual: Record<string, unknown>;

describe("E2E — o acúmulo de comissão dispara SOZINHO e é íntegro", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID); // fail-closed ANTES de qualquer uso de SDK

    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    try {
      await fetchWithTimeout(`http://${FUNCTIONS_HOST}/`, {}, 10_000);
    } catch (error) {
      throw new Error(
        `FAIL-CLOSED (E2E aborted): emulador de Functions inacessível em ` +
          `${FUNCTIONS_HOST} — ${(error as Error).message}`
      );
    }

    await cleanup();

    const attributedAt = new Date();
    const expiresAt = new Date(attributedAt);
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);

    // Cenário mínimo: parceiro ativo, código emitido, jogador atribuído dentro
    // da janela. Nenhum campo inventado — os mesmos que os handlers escrevem.
    await Promise.all([
      db.collection(PARTNERS_COLLECTION).doc(PARTNER_ID).set({
        name: "Parceiro E2E",
        code: REFERRAL_CODE,
        owner_uid: null,
        active: true,
        [PARTNER_TOTAL_FIELD]: 0,
      }),
      db
        .collection(REFERRAL_CODES_COLLECTION)
        .doc(REFERRAL_CODE)
        .set({ partner_ref: PARTNER_ID }),
      db.collection("users").doc(PLAYER_UID).set({
        partner_ref: PARTNER_ID,
        referral_code: REFERRAL_CODE,
        attributed_at: Timestamp.fromDate(attributedAt),
        attribution_expires_at: Timestamp.fromDate(expiresAt),
        source: "referral_link",
      }),
    ]);

    // A ÚNICA escrita que dispara algo: um débito de inscrição em cash.
    // Valor NEGATIVO, em reais, como o razão armazena.
    await db
      .collection("transactions")
      .doc(ENTRY_TX_ID)
      .set({
        amount: -ENTRY_REAIS,
        category: "entry_fee",
        status: "completed",
        user_ref: db.collection("users").doc(PLAYER_UID),
        tournament_ref: db.collection("tournaments").doc(TOURNAMENT_ID),
      });

    accrual = await awaitDoc(`transactions/${ACCRUAL_ID}`);
  });

  after(async () => {
    await cleanup();
  });

  it("o trigger entregou e escreveu a linha de comissão", () => {
    assert.equal(accrual.category, COMMISSION_ACCRUED_CATEGORY);
    assert.equal(accrual.partner_ref, PARTNER_ID);
    assert.equal(accrual.status, "accrued");
  });

  it("os valores são os da política, em centavos inteiros", () => {
    assert.equal(accrual.entry_centavos, ENTRY_REAIS * 100);
    assert.equal(accrual.fee_centavos, EXPECTED_FEE_CENTAVOS);
    assert.equal(accrual.amount_centavos, EXPECTED_COMMISSION_CENTAVOS);
    assert.equal(accrual.amount_unit, "centavos");
  });

  it("a linha NÃO carrega user_ref — é o que a torna ilegível ao jogador", () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(accrual, "user_ref"),
      false
    );
  });

  it("o total do parceiro subiu junto, na mesma transação", async () => {
    const partner = await db.collection(PARTNERS_COLLECTION).doc(PARTNER_ID).get();
    assert.equal(partner.get(PARTNER_TOTAL_FIELD), EXPECTED_COMMISSION_CENTAVOS);
  });

  it("o acúmulo NÃO acumula sobre si mesmo", async () => {
    // A linha de comissão é uma escrita em transactions/{id}, a mesma coleção
    // que o trigger observa. Se a porta de entrada não a recusasse, a feature
    // se alimentaria em laço.
    await sleep(NO_LOOP_SETTLE_MS);
    const second = await db
      .collection("transactions")
      .doc(`commission_${ACCRUAL_ID}`)
      .get();
    assert.equal(second.exists, false);

    const partner = await db.collection(PARTNERS_COLLECTION).doc(PARTNER_ID).get();
    assert.equal(
      partner.get(PARTNER_TOTAL_FIELD),
      EXPECTED_COMMISSION_CENTAVOS,
      "o total subiu de novo — houve segunda entrega"
    );
  });
});
