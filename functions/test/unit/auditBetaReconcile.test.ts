import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BETA_CATEGORIES,
  KNOWN_CATEGORIES,
  reconcileWallet,
  TransactionRecord,
  WalletContext,
} from "../../src/audit/reconcile.js";
import { auditWalletDocument } from "../../src/audit/walletAudit.js";

/**
 * FASE 8 — reconciliação cash+beta e classificador, 100% puro (sem Firebase).
 *
 * Identidades sob teste:
 *   cash: balance == total_deposited + total_won - total_spent - total_withdrawn
 *         com total_spent = entry_fees - entry_refunds (nunca negativo)
 *   beta: beta_balance == beta_grants + beta_prizes + beta_refunds - beta_entry_spend
 *
 * O reconciliador é SOMENTE LEITURA: nada é reparado, estimado ou normalizado;
 * toda ambiguidade vira achado (reason/conflict) e manual-review.
 */

const T1 = "tournaments/t1";
const T2 = "tournaments/t2";

function cash(
  category: string,
  amount: number,
  extra: Partial<TransactionRecord> = {}
): TransactionRecord {
  return { category, status: "completed", amount, ...extra };
}

function entryFee(
  amount: number,
  path: string,
  extra: Partial<TransactionRecord> = {}
): TransactionRecord {
  return {
    category: "entry_fee",
    status: "completed",
    amount,
    path,
    economyType: "cash",
    tournamentRefPath: T1,
    hasCashStamps: true,
    ...extra,
  };
}

function entryRefund(
  amount: number,
  entryPath: string,
  extra: Partial<TransactionRecord> = {}
): TransactionRecord {
  return {
    category: "entry_refund",
    status: "completed",
    amount,
    path: `transactions/refund_${entryPath.split("/")[1]}`,
    economyType: "cash",
    tournamentRefPath: T1,
    registrationRefPath: "registrations/u_t1",
    entryTransactionRefPath: entryPath,
    hasCashStamps: true,
    ...extra,
  };
}

function beta(
  category: string,
  amount: number,
  extra: Partial<TransactionRecord> = {}
): TransactionRecord {
  return {
    category,
    status: "completed",
    amount,
    economyType: "beta_credit",
    tournamentRefPath: T1,
    hasBetaStamps: true,
    ...extra,
  };
}

function betaEntry(
  amount: number,
  path: string,
  extra: Partial<TransactionRecord> = {}
): TransactionRecord {
  return beta("beta_entry_fee", amount, { path, ...extra });
}

function betaRefund(
  amount: number,
  entryPath: string,
  extra: Partial<TransactionRecord> = {}
): TransactionRecord {
  return beta("beta_refund", amount, {
    path: `transactions/refund_beta_${entryPath.split("/")[1]}`,
    registrationRefPath: "registrations/u_t1",
    entryTransactionRefPath: entryPath,
    ...extra,
  });
}

interface CtxOptions {
  transactions?: TransactionRecord[];
  present?: Partial<
    Record<
      "balance" | "total_deposited" | "total_won" | "total_spent" | "total_withdrawn",
      number
    >
  >;
  registrationCount?: number;
  withdrawalStatuses?: string[];
  betaPresent?: number | null | false;
}

/** Full, consistent wallet context; centavos in `present`, reais in txs. */
function ctx(options: CtxOptions = {}): WalletContext {
  const present = {
    balance: 0,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
    ...options.present,
  };
  const betaPresent = options.betaPresent;
  return {
    missingFields: [],
    presentCentavos: present,
    userDocExists: true,
    userRefValid: true,
    userRefStatus: "valid",
    betaBalancePresent: betaPresent !== false && betaPresent !== undefined,
    betaBalanceCentavos:
      betaPresent === false || betaPresent === undefined ? null : betaPresent,
    related: {
      transactions: options.transactions ?? [],
      withdrawalStatuses: options.withdrawalStatuses ?? [],
      registrationCount: options.registrationCount ?? 0,
    },
  };
}

function run(options: CtxOptions = {}) {
  return reconcileWallet("Wallet A", ctx(options));
}

// ─────────────────────────────────────────────────────────────────────────────
// (1)-(6) entry_refund na identidade cash.
// ─────────────────────────────────────────────────────────────────────────────

describe("cash — entry_refund", () => {
  it("(1)-(6) reduz SOMENTE o gasto líquido; identidade fecha após cancelamento; beta intacto", () => {
    const result = run({
      transactions: [
        cash("deposit", 50),
        entryFee(10, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1"),
      ],
      present: {
        balance: 5000, // 50 − 10 + 10
        total_deposited: 5000,
        total_won: 0,
        total_spent: 0, // 10 − 10
        total_withdrawn: 0,
      },
      registrationCount: 1, // a registration (refunded) still exists
      betaPresent: false,
    });

    assert.deepEqual(result.derivedCentavos, {
      balance: 5000,
      total_deposited: 5000, // (2) depósitos intactos
      total_won: 0, // (3) ganhos intactos
      total_spent: 0, // (1) gasto líquido: 10 − 10
      total_withdrawn: 0, // (4) saques intactos
    });
    assert.equal(result.derivedBetaCentavos, 0); // (5) beta intacto
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.classification, "reconstructable"); // (6) fecha
  });

  it("(7)(33) reembolso validado maior que o gasto somável falha — nunca vira cash silencioso", () => {
    // A entry_fee está adulterada com economia beta → NÃO é somada como cash;
    // o refund que a referencia continua validável → o gasto líquido ficaria
    // negativo → achado explícito, sem estimativa.
    const result = run({
      transactions: [
        entryFee(10, "transactions/entry_1", { economyType: "beta_credit" }),
        entryRefund(10, "transactions/entry_1"),
      ],
      registrationCount: 1,
    });
    assert.equal(result.classification, "manual-review");
    assert.ok(
      result.reasons.some((r) => r.includes("declara economia beta")),
      "cash com economia beta é achado"
    );
    assert.ok(
      result.reasons.some((r) => r.includes("excedem o gasto")),
      "gasto líquido negativo é achado"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (8)-(14)(30) Identidade beta.
// ─────────────────────────────────────────────────────────────────────────────

describe("beta — identidade separada", () => {
  it("(8)-(12)(30) grants+prizes+refunds−entry fecham a identidade e NÃO caem em manual-review", () => {
    const result = run({
      transactions: [
        beta("beta_grant", 30),
        betaEntry(10, "transactions/bentry_1"),
        beta("beta_prize", 50),
        betaRefund(10, "transactions/bentry_1"),
      ],
      registrationCount: 1, // o beta_entry_fee corresponde a uma registration
      betaPresent: 8000, // 30 − 10 + 50 + 10 = 80
    });
    assert.equal(result.derivedBetaCentavos, 8000);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.reasons.filter((r) => r.includes("beta")), []);
    assert.equal(result.classification, "reconstructable"); // (30)
  });

  it("(13) os cinco campos cash ficam zerados/intactos num histórico só-beta", () => {
    const result = run({
      transactions: [beta("beta_grant", 100)],
      betaPresent: 10000,
    });
    assert.deepEqual(result.derivedCentavos, {
      balance: 0,
      total_deposited: 0,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
    });
    assert.deepEqual(result.conflicts, []);
  });

  it("(14) beta_balance fica FORA do cálculo cash: histórico só-cash deriva beta 0", () => {
    const result = run({
      transactions: [cash("deposit", 25)],
      present: { balance: 2500, total_deposited: 2500 },
      betaPresent: false, // carteira pré-beta, sem o campo
    });
    assert.equal(result.derivedBetaCentavos, 0);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.classification, "reconstructable");
  });

  it("beta_balance ausente com histórico beta não-zero é CONFLITO", () => {
    const result = run({
      transactions: [beta("beta_grant", 10)],
      betaPresent: false,
    });
    assert.ok(result.conflicts.some((c) => c.includes("beta_balance: ausente")));
    assert.equal(result.classification, "manual-review");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (15)-(17) Mistura categoria × economia.
// ─────────────────────────────────────────────────────────────────────────────

describe("mistura categoria × economia", () => {
  it("(15)(17) categoria cash declarando economia beta é inválida e não é somada", () => {
    const result = run({
      transactions: [cash("deposit", 100, { economyType: "beta_credit" })],
    });
    assert.equal(result.derivedCentavos.total_deposited, 0);
    assert.equal(result.derivedCentavos.balance, 0);
    assert.equal(result.derivedBetaCentavos, 0);
    assert.ok(result.reasons.some((r) => r.includes("declara economia beta")));
    assert.equal(result.classification, "manual-review");
  });

  it("(16)(33) categoria beta SEM economy_type é inválida — nunca cai para cash", () => {
    for (const economyType of [undefined, "cash", "BETA_CREDIT", null]) {
      const result = run({
        transactions: [
          { category: "beta_grant", status: "completed", amount: 10, economyType },
        ],
      });
      assert.equal(result.derivedBetaCentavos, 0, String(economyType));
      assert.deepEqual(result.derivedCentavos, {
        balance: 0,
        total_deposited: 0,
        total_won: 0,
        total_spent: 0,
        total_withdrawn: 0,
      });
      assert.ok(
        result.reasons.some((r) => r.includes("nunca cash")),
        String(economyType)
      );
      assert.equal(result.classification, "manual-review");
    }
  });

  it("entry_refund sem economia cash é inválido", () => {
    const result = run({
      transactions: [
        entryFee(10, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1", { economyType: undefined }),
      ],
      registrationCount: 1,
    });
    assert.ok(result.reasons.some((r) => r.includes("sem economia cash")));
    assert.equal(result.classification, "manual-review");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (18)-(26) Ledger original dos reembolsos.
// ─────────────────────────────────────────────────────────────────────────────

describe("reembolsos — ledger original obrigatório", () => {
  it("(18) entry_refund sem ledger original no histórico falha", () => {
    const result = run({
      transactions: [entryRefund(10, "transactions/ghost")],
    });
    assert.ok(
      result.reasons.some((r) =>
        r.includes("reembolso cash sem ledger original")
      )
    );
    assert.equal(result.classification, "manual-review");
  });

  it("(19) beta_refund sem ledger original no histórico falha", () => {
    const result = run({
      transactions: [betaRefund(10, "transactions/ghost")],
    });
    assert.ok(
      result.reasons.some((r) =>
        r.includes("reembolso beta sem ledger original")
      )
    );
  });

  it("(20) ledger original de categoria incompatível falha", () => {
    const deposit = cash("deposit", 10, { path: "transactions/dep_1" });
    const result = run({
      transactions: [deposit, entryRefund(10, "transactions/dep_1")],
    });
    assert.ok(result.reasons.some((r) => r.includes("diverge do ledger original")));
  });

  it("(21) valor divergente do original falha", () => {
    const result = run({
      transactions: [
        entryFee(8, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1"),
      ],
      registrationCount: 1,
    });
    assert.ok(result.reasons.some((r) => r.includes("diverge do ledger original")));
  });

  it("(23) torneio divergente do original falha", () => {
    const result = run({
      transactions: [
        entryFee(10, "transactions/entry_1", { tournamentRefPath: T2 }),
        entryRefund(10, "transactions/entry_1"),
      ],
      registrationCount: 1,
    });
    assert.ok(result.reasons.some((r) => r.includes("diverge do ledger original")));
  });

  it("(22)(24) referências obrigatórias ausentes falham (registration/entrada)", () => {
    // Nota: usuário divergente é estruturalmente impossível aqui — o histórico
    // é coletado POR usuário; a divergência de usuário é bloqueada no handler.
    const noReg = run({
      transactions: [
        entryFee(10, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1", { registrationRefPath: null }),
      ],
      registrationCount: 1,
    });
    assert.ok(
      noReg.reasons.some((r) => r.includes("sem as referências obrigatórias"))
    );

    const noEntryRef = run({
      transactions: [
        entryFee(10, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1", {
          entryTransactionRefPath: null,
        }),
      ],
      registrationCount: 1,
    });
    assert.ok(
      noEntryRef.reasons.some((r) => r.includes("sem as referências obrigatórias"))
    );
  });

  it("dois reembolsos sobre o MESMO ledger original são duplicados e falham", () => {
    const result = run({
      transactions: [
        entryFee(10, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1", {
          path: "transactions/refund_dup",
        }),
      ],
      registrationCount: 1,
    });
    assert.ok(result.reasons.some((r) => r.includes("duplicado")));
  });

  it("(25) beta_refund com campos cash falsificados falha", () => {
    const result = run({
      transactions: [
        betaEntry(10, "transactions/bentry_1"),
        betaRefund(10, "transactions/bentry_1", { hasCashStamps: true }),
      ],
      registrationCount: 1,
    });
    // O guard genérico de transações beta captura os campos cash forjados
    // ANTES da validação específica do reembolso — ambos são fail-closed.
    assert.ok(
      result.reasons.some((r) => r.includes("beta com campos cash")),
      result.reasons.join("; ")
    );
  });

  it("(26) entry_refund com campos beta falsificados falha", () => {
    const result = run({
      transactions: [
        entryFee(10, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1", { hasBetaStamps: true }),
      ],
      registrationCount: 1,
    });
    assert.ok(
      result.reasons.some((r) => r.includes("reembolso cash com campos beta"))
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (27)-(29) Overflow e valores não seguros.
// ─────────────────────────────────────────────────────────────────────────────

describe("valores inseguros", () => {
  it("(27)(29) amounts cash acima do limite ou fracionários são não-somáveis", () => {
    const above = run({
      transactions: [cash("deposit", 10_000_001)], // acima de R$10M
    });
    assert.ok(above.reasons.some((r) => r.includes("não somável")));

    const fractional = run({ transactions: [cash("deposit", 1.234)] });
    assert.ok(fractional.reasons.some((r) => r.includes("não somável")));
  });

  it("(28) saldo beta derivado acima do limite falha", () => {
    const result = run({
      transactions: [beta("beta_grant", 10_000_000), beta("beta_prize", 1)],
      betaPresent: null,
    });
    assert.ok(
      result.reasons.some((r) => r.includes("acima do limite")),
      result.reasons.join("; ")
    );
  });

  it("(29) amount beta fracionário/zero/negativo é inválido", () => {
    for (const amount of [1.234, 0, -5]) {
      const result = run({ transactions: [beta("beta_grant", amount)] });
      assert.ok(
        result.reasons.some((r) => r.includes("beta com valor inválido")),
        String(amount)
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (31)(32)(34)(35) Classificador, legado, pureza e snapshot completo.
// ─────────────────────────────────────────────────────────────────────────────

describe("classificador e compatibilidade", () => {
  it("(31) categoria desconhecida continua em manual-review", () => {
    const result = run({ transactions: [cash("cashback", 10)] });
    assert.ok(!KNOWN_CATEGORIES.has("cashback"));
    assert.ok(result.reasons.some((r) => r.includes("desconhecida")));
    assert.equal(result.classification, "manual-review");
  });

  it("as categorias beta estão TODAS no conjunto conhecido", () => {
    for (const category of ["entry_refund", ...BETA_CATEGORIES]) {
      assert.ok(KNOWN_CATEGORIES.has(category), category);
    }
  });

  it("(32) histórico cash legado (sem economia) continua reconstruível", () => {
    const result = run({
      transactions: [
        cash("deposit", 100),
        cash("prize", 40),
        cash("entry_fee", 10),
        cash("withdrawal", 30),
      ],
      present: {
        balance: 10000, // 100 + 40 − 10 − 30
        total_deposited: 10000,
        total_won: 4000,
        total_spent: 1000,
        total_withdrawn: 3000,
      },
      registrationCount: 1,
      withdrawalStatuses: ["pending"],
      betaPresent: false,
    });
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.classification, "reconstructable");
  });

  it("(34) o reconciliador é puro: entrada congelada não é mutada nem escrita", () => {
    const frozen = ctx({
      transactions: [beta("beta_grant", 10), cash("deposit", 5)],
      betaPresent: 1000,
      present: { balance: 500, total_deposited: 500 },
    });
    Object.freeze(frozen);
    Object.freeze(frozen.related);
    Object.freeze(frozen.related.transactions);
    for (const tx of frozen.related.transactions) Object.freeze(tx);
    // Uma mutação lançaria em strict mode; o resultado sai íntegro.
    const result = reconcileWallet("Wallet A", frozen);
    assert.equal(result.derivedBetaCentavos, 1000);
    assert.equal(result.derivedCentavos.balance, 500);
  });

  it("(35) snapshot completo cash+beta: as duas identidades fecham sem contaminação", () => {
    const result = run({
      transactions: [
        cash("deposit", 100),
        entryFee(10, "transactions/entry_1"),
        entryRefund(10, "transactions/entry_1"),
        beta("beta_grant", 30),
        betaEntry(10, "transactions/bentry_1"),
        beta("beta_prize", 50),
        betaRefund(10, "transactions/bentry_1"),
      ],
      present: {
        balance: 10000, // 100 − 10 + 10
        total_deposited: 10000,
        total_won: 0,
        total_spent: 0,
        total_withdrawn: 0,
      },
      registrationCount: 2, // entry_fee + beta_entry_fee
      betaPresent: 8000, // 30 − 10 + 50 + 10
    });
    assert.deepEqual(result.derivedCentavos, {
      balance: 10000,
      total_deposited: 10000,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
    });
    assert.equal(result.derivedBetaCentavos, 8000);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.classification, "reconstructable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// walletAudit — beta_balance opcional.
// ─────────────────────────────────────────────────────────────────────────────

describe("walletAudit — beta_balance opcional", () => {
  const fullWallet = {
    balance: 0,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
  };

  it("ausência de beta_balance NÃO é achado (carteira pré-beta)", () => {
    assert.equal(auditWalletDocument("w1", { ...fullWallet }), null);
  });

  it("beta_balance presente e válido não é achado", () => {
    assert.equal(
      auditWalletDocument("w1", { ...fullWallet, beta_balance: 12.5 }),
      null
    );
  });

  it("beta_balance presente e inválido É achado", () => {
    for (const bad of ["x", -1, 1.234, Number.NaN]) {
      const finding = auditWalletDocument("w1", {
        ...fullWallet,
        beta_balance: bad,
      });
      assert.ok(finding, String(bad));
      assert.ok(
        finding!.issues.some((issue) => issue.field === "beta_balance"),
        String(bad)
      );
    }
  });
});
