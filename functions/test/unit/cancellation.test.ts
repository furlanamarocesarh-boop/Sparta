import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BETA_REFUND_CATEGORY,
  canCancelAtomically,
  checkOriginalEntryLedger,
  checkRefundedRegistration,
  checkRefundLedger,
  ENTRY_REFUND_CATEGORY,
  FIRESTORE_TRANSACTION_WRITE_LIMIT,
  MAX_CANCELLABLE_REGISTRATIONS,
  refundTransactionId,
  resolveRefundPlanItem,
  STATUS_CANCELLED,
  sumRefundCentavos,
  writesRequiredForCancellation,
  type RefundPlanItem,
} from "../../src/domain/cancellation.js";
import { DomainError } from "../../src/domain/errors.js";

describe("limites da transação (48)", () => {
  it("3 escritas por inscrição + 1 do torneio", () => {
    assert.equal(writesRequiredForCancellation(0), 1);
    assert.equal(writesRequiredForCancellation(1), 4);
    assert.equal(writesRequiredForCancellation(150), 451);
  });

  it("o teto cabe com folga no limite clássico de 500 escritas", () => {
    assert.ok(
      writesRequiredForCancellation(MAX_CANCELLABLE_REGISTRATIONS) <=
        FIRESTORE_TRANSACTION_WRITE_LIMIT
    );
    assert.equal(canCancelAtomically(MAX_CANCELLABLE_REGISTRATIONS), true);
    assert.equal(canCancelAtomically(MAX_CANCELLABLE_REGISTRATIONS + 1), false);
    assert.equal(canCancelAtomically(0), true);
  });
});

describe("refundTransactionId", () => {
  it("é determinístico e derivado da inscrição", () => {
    assert.equal(refundTransactionId("u1_t1"), "refund_u1_t1");
  });
  it("o estado terminal é exatamente 'cancelled'", () => {
    assert.equal(STATUS_CANCELLED, "cancelled");
  });
});

describe("resolveRefundPlanItem", () => {
  const base = {
    docId: "u1_t1",
    tournamentid: "t1",
    tournamentEconomy: "cash" as const,
    status: "registered",
    userRefPath: "users/u1",
    tournamentRefPath: "tournaments/t1",
    registrationEconomy: "cash",
    entryFeeSnapshot: 10,
    entryFee: 10,
    transactionRefPath: "transactions/entryfee_abc",
  };

  it("nova inscrição cash válida vira item do plano", () => {
    const r = resolveRefundPlanItem(base);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.item.uid, "u1");
      assert.equal(r.item.amountCentavos, 1000);
      assert.equal(r.item.economy, "cash");
      assert.equal(r.item.legacy, false);
      assert.equal(r.item.entryTransactionPath, "transactions/entryfee_abc");
    }
  });

  it("nova inscrição beta válida vira item do plano", () => {
    const r = resolveRefundPlanItem({
      ...base,
      tournamentEconomy: "beta_credit",
      registrationEconomy: "beta_credit",
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.item.economy, "beta_credit");
  });

  it("status diferente de 'registered' falha (estado divergente)", () => {
    for (const status of ["refunded", "pending", undefined, ""]) {
      assert.equal(resolveRefundPlanItem({ ...base, status }).ok, false);
    }
  });

  it("docId não determinístico ou refs erradas falham", () => {
    assert.equal(
      resolveRefundPlanItem({ ...base, docId: "outro_t1" }).ok,
      false
    );
    assert.equal(
      resolveRefundPlanItem({ ...base, userRefPath: null }).ok,
      false
    );
    assert.equal(
      resolveRefundPlanItem({ ...base, tournamentRefPath: "tournaments/t2" })
        .ok,
      false
    );
  });

  it("(24) inscrição beta sem proveniência falha; (23) proveniência divergente falha", () => {
    assert.equal(
      resolveRefundPlanItem({
        ...base,
        tournamentEconomy: "beta_credit",
        registrationEconomy: undefined,
      }).ok,
      false
    );
    assert.equal(
      resolveRefundPlanItem({
        ...base,
        registrationEconomy: "beta_credit", // torneio cash
      }).ok,
      false
    );
    assert.equal(
      resolveRefundPlanItem({ ...base, registrationEconomy: "CASH" }).ok,
      false
    );
  });

  it("(19) o snapshot é a fonte do valor; nova inscrição sem snapshot falha", () => {
    const noSnapshot = resolveRefundPlanItem({
      ...base,
      entryFeeSnapshot: undefined,
    });
    assert.equal(noSnapshot.ok, false);
    const badSnapshot = resolveRefundPlanItem({
      ...base,
      entryFeeSnapshot: "10",
    });
    assert.equal(badSnapshot.ok, false);
  });

  it("nova inscrição sem transaction_ref falha (ledger original obrigatório)", () => {
    assert.equal(
      resolveRefundPlanItem({ ...base, transactionRefPath: null }).ok,
      false
    );
  });

  it("(25) legado cash SEGURO: sem proveniência/snapshot/ref, entry_fee comprovável reembolsa", () => {
    const r = resolveRefundPlanItem({
      ...base,
      registrationEconomy: undefined,
      entryFeeSnapshot: undefined,
      transactionRefPath: null,
      entryFee: 12.5,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.item.legacy, true);
      assert.equal(r.item.amountCentavos, 1250);
      assert.equal(r.item.entryTransactionPath, null);
    }
  });

  it("(26) legado AMBÍGUO falha fechado: entry_fee ausente, inválido, zero ou negativo", () => {
    for (const entryFee of [undefined, null, "10", 0, -5, 1.234, NaN]) {
      assert.equal(
        resolveRefundPlanItem({
          ...base,
          registrationEconomy: undefined,
          entryFeeSnapshot: undefined,
          transactionRefPath: null,
          entryFee,
        }).ok,
        false,
        `entry_fee=${String(entryFee)}`
      );
    }
  });
});

describe("checkOriginalEntryLedger", () => {
  const item: RefundPlanItem = {
    uid: "u1",
    registrationDocId: "u1_t1",
    amountCentavos: 1000,
    economy: "beta_credit",
    entryTransactionPath: "transactions/entryfee_x",
    legacy: false,
  };
  const good = {
    item,
    tournamentid: "t1",
    txExists: true,
    category: "beta_entry_fee",
    economyType: "beta_credit",
    userRefPath: "users/u1",
    tournamentRefPath: "tournaments/t1",
    amountReais: 10,
    expectedAmountReais: 10,
  };

  it("ledger beta consistente passa; cash idem", () => {
    assert.deepEqual(checkOriginalEntryLedger(good), { ok: true });
    assert.deepEqual(
      checkOriginalEntryLedger({
        ...good,
        item: { ...item, economy: "cash" },
        category: "entry_fee",
        economyType: "cash",
      }),
      { ok: true }
    );
  });

  it("(21) qualquer divergência falha: ausente, categoria, economia, usuário, torneio, valor", () => {
    const cases = [
      { txExists: false },
      { category: "entry_fee" }, // beta item com categoria cash
      { economyType: "cash" },
      { userRefPath: "users/u2" },
      { tournamentRefPath: "tournaments/t2" },
      { amountReais: 8 },
    ];
    for (const diff of cases) {
      assert.equal(
        checkOriginalEntryLedger({ ...good, ...diff }).ok,
        false,
        JSON.stringify(diff)
      );
    }
  });
});

describe("sumRefundCentavos", () => {
  const item = (amountCentavos: number): RefundPlanItem => ({
    uid: "u",
    registrationDocId: "u_t",
    amountCentavos,
    economy: "cash",
    entryTransactionPath: null,
    legacy: true,
  });

  it("soma exata", () => {
    assert.equal(sumRefundCentavos([item(1000), item(2550)]), 3550);
    assert.equal(sumRefundCentavos([]), 0);
  });

  it("total inseguro falha fechado", () => {
    assert.throws(
      () => sumRefundCentavos([item(Number.MAX_SAFE_INTEGER), item(1)]),
      (e: unknown) =>
        e instanceof DomainError && e.code === "failed-precondition"
    );
  });
});

describe("replay — checkRefundedRegistration / checkRefundLedger", () => {
  const reg = {
    docId: "u1_t1",
    status: "refunded",
    refundEconomy: "beta_credit",
    tournamentEconomy: "beta_credit" as const,
    refundedAmount: 10,
    refundTransactionRefPath: "transactions/refund_u1_t1",
  };

  it("inscrição reembolsada consistente passa", () => {
    assert.deepEqual(checkRefundedRegistration(reg), { ok: true });
  });

  it("(31) divergências falham sem reparo: status, economia, valor, ledger", () => {
    const cases = [
      { status: "registered" },
      { refundEconomy: "cash" },
      { refundedAmount: 0 },
      { refundedAmount: "10" },
      { refundTransactionRefPath: "transactions/other" },
      { refundTransactionRefPath: null },
    ];
    for (const diff of cases) {
      assert.equal(
        checkRefundedRegistration({ ...reg, ...diff }).ok,
        false,
        JSON.stringify(diff)
      );
    }
  });

  const ledger = {
    registrationDocId: "u1_t1",
    tournamentid: "t1",
    tournamentEconomy: "beta_credit" as const,
    uid: "u1",
    expectedAmountReais: 10,
    txExists: true,
    category: BETA_REFUND_CATEGORY,
    economyType: "beta_credit",
    amountReais: 10,
    userRefPath: "users/u1",
    tournamentRefPath: "tournaments/t1",
    registrationRefPath: "registrations/u1_t1",
  };

  it("ledger de reembolso consistente passa (beta e cash)", () => {
    assert.deepEqual(checkRefundLedger(ledger), { ok: true });
    assert.deepEqual(
      checkRefundLedger({
        ...ledger,
        tournamentEconomy: "cash",
        category: ENTRY_REFUND_CATEGORY,
        economyType: "cash",
      }),
      { ok: true }
    );
  });

  it("ledger de reembolso divergente falha", () => {
    const cases = [
      { txExists: false },
      { category: ENTRY_REFUND_CATEGORY }, // beta com categoria cash
      { economyType: "cash" },
      { amountReais: 9 },
      { userRefPath: "users/u2" },
      { registrationRefPath: "registrations/u2_t1" },
    ];
    for (const diff of cases) {
      assert.equal(
        checkRefundLedger({ ...ledger, ...diff }).ok,
        false,
        JSON.stringify(diff)
      );
    }
  });
});
