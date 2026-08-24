import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import {
  HOUSE_BALANCE_FIELD,
  HOUSE_COLLECTION,
  HOUSE_FUNDING_CATEGORY,
  houseFundingTransactionId,
} from "../../src/domain/house.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * O APORTE SAI DE UMA CARTEIRA DE VERDADE.
 *
 * Antes, `fundHouse` creditava o caixa do nada: o número limitava pagamentos
 * sem nada por trás. O que só um Firestore real prova é que o débito e o
 * crédito acontecem na MESMA transação — e que a identidade contábil da
 * carteira (`balance = depositado + ganho - gasto - sacado`) continua fechando
 * depois, que é o que o reconciliador exige de toda carteira.
 */

const PROJECT_ID = "demo-sparta-battle";
const UID = "e2e-house-funder";
const DEPOSIT = "e2e-deposit-1";

const ADMIN_CONTEXT = { auth: { uid: UID, token: { admin: true } } };

let db: admin.firestore.Firestore;
let fundHouse: (data: unknown, context: unknown) => Promise<any>;

async function cleanup(): Promise<void> {
  await Promise.all([
    db.collection("wallets").doc(UID).delete(),
    db.collection(HOUSE_COLLECTION).doc("cash").delete(),
    db.collection(HOUSE_COLLECTION).doc("beta_credit").delete(),
    db.collection("transactions").doc(houseFundingTransactionId(DEPOSIT)).delete(),
    db.collection("transactions").doc(houseFundingTransactionId("e2e-deposit-2")).delete(),
  ]);
}

describe("E2E — aporte no caixa sai da carteira do criador", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    fundHouse = (mod as any).fundHouseHandler;

    await cleanup();
    await db.collection("wallets").doc(UID).set({
      balance: 100,
      total_deposited: 100,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
      beta_balance: 50,
    });
  });

  after(async () => {
    await cleanup();
  });

  it("debita a carteira e credita o caixa, de uma vez", async () => {
    await fundHouse(
      { economy: "cash", amount: 30, deposit_id: DEPOSIT, note: "teste" },
      ADMIN_CONTEXT
    );

    const [wallet, house] = await Promise.all([
      db.collection("wallets").doc(UID).get(),
      db.collection(HOUSE_COLLECTION).doc("cash").get(),
    ]);
    assert.equal(wallet.get("balance"), 70, "não saiu da carteira");
    assert.equal(house.get(HOUSE_BALANCE_FIELD), 3_000, "não entrou no caixa");
  });

  it("a identidade contábil da carteira continua fechando", async () => {
    // balance == depositado + ganho - gasto - sacado. Se total_spent não
    // tivesse acompanhado o débito, a auditoria acusaria esta carteira.
    const w = (await db.collection("wallets").doc(UID).get()).data()!;
    const derived =
      (w.total_deposited as number) +
      (w.total_won as number) -
      (w.total_spent as number) -
      (w.total_withdrawn as number);
    assert.equal(derived, w.balance);
    assert.equal(w.total_spent, 30);
  });

  it("a linha de razão carrega user_ref — o reconciliador precisa vê-la", async () => {
    const row = await db
      .collection("transactions")
      .doc(houseFundingTransactionId(DEPOSIT))
      .get();
    assert.equal(row.get("category"), HOUSE_FUNDING_CATEGORY);
    assert.equal(row.get("amount"), 30);
    assert.ok(row.get("user_ref"), "sem user_ref a identidade não fecharia");
  });

  it("RECUSA um aporte maior do que o saldo", async () => {
    await assert.rejects(
      () =>
        fundHouse(
          {
            economy: "cash",
            amount: 1_000,
            deposit_id: "e2e-deposit-2",
            note: "grande demais",
          },
          ADMIN_CONTEXT
        ),
      /Saldo insuficiente/i
    );

    const wallet = await db.collection("wallets").doc(UID).get();
    assert.equal(wallet.get("balance"), 70, "moveu mesmo recusando");
  });

  it("repetir o MESMO aporte não debita duas vezes", async () => {
    await fundHouse(
      { economy: "cash", amount: 30, deposit_id: DEPOSIT, note: "teste" },
      ADMIN_CONTEXT
    );
    const wallet = await db.collection("wallets").doc(UID).get();
    assert.equal(wallet.get("balance"), 70, "o replay debitou de novo");
  });

  it("beta sai do saldo beta, nunca do dinheiro", async () => {
    await fundHouse(
      {
        economy: "beta_credit",
        amount: 20,
        deposit_id: "e2e-deposit-beta",
        note: "beta",
      },
      ADMIN_CONTEXT
    );

    const [wallet, house] = await Promise.all([
      db.collection("wallets").doc(UID).get(),
      db.collection(HOUSE_COLLECTION).doc("beta_credit").get(),
    ]);
    assert.equal(wallet.get("beta_balance"), 30);
    assert.equal(wallet.get("balance"), 70, "aporte beta tocou o dinheiro");
    assert.equal(house.get(HOUSE_BALANCE_FIELD), 2_000);

    await db
      .collection("transactions")
      .doc(houseFundingTransactionId("e2e-deposit-beta"))
      .delete();
  });
});
