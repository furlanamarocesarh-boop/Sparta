import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PAYOUT_PLAYERS,
  WRITES_PER_PAYOUT,
  assertPayoutDecision,
  canSettleAtomically,
  decidePayouts,
  payoutRefusalMessage,
  writesRequiredForSettlement,
  BETA_KILL_PRIZE_CATEGORY,
  KILL_PRIZE_CATEGORY,
  isPayoutTransactionId,
  killPrizeCategoryFor,
  payoutTransactionId,
  poolFromRegistrations,
  type PayoutInput,
} from "../../src/domain/killPrize.js";
import {
  classifyPrizeCategory,
  decideEntry,
  prizeCountsAsWin,
} from "../../src/domain/seasonRanking.js";
import {
  CATEGORY_TO_FIELD,
  KNOWN_CATEGORIES,
} from "../../src/audit/reconcile.js";
import { classifyCategory } from "../../src/domain/engagementStats.js";

/** R$ 10,00 por inscrição, 10 inscritos: pool de R$ 100,00. */
function base(overrides: Partial<PayoutInput> = {}): PayoutInput {
  return {
    winnerUid: "uid-a",
    placementCentavos: 5_000,
    killPrizeCentavos: 100,
    reports: [
      { uid: "uid-a", kills: 8 },
      { uid: "uid-b", kills: 5 },
      { uid: "uid-c", kills: 0 },
    ],
    poolCentavos: 10_000,
    ...overrides,
  };
}

describe("cálculo do pagamento", () => {
  it("soma abate e colocação, e paga só quem ganhou algo", () => {
    const d = decidePayouts(base());
    assert.equal(d.ok, true);
    if (!d.ok) return;

    // uid-a: 8 abates x 100 = 800, mais 5000 de colocação.
    assert.deepEqual(d.payouts[0], {
      uid: "uid-a",
      kills: 8,
      killCentavos: 800,
      placementCentavos: 5_000,
      totalCentavos: 5_800,
    });
    // uid-b: só abates.
    assert.deepEqual(d.payouts[1], {
      uid: "uid-b",
      kills: 5,
      killCentavos: 500,
      placementCentavos: 0,
      totalCentavos: 500,
    });
    // uid-c não ganhou nada e não vira linha de razão.
    assert.equal(d.payouts.length, 2);
    assert.equal(d.totalCentavos, 6_300);
  });

  it("torneio só por colocação continua funcionando como hoje", () => {
    const d = decidePayouts(base({ killPrizeCentavos: 0 }));
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.payouts.length, 1);
    assert.equal(d.payouts[0].uid, "uid-a");
    assert.equal(d.payouts[0].totalCentavos, 5_000);
  });

  it("torneio 100% por abate não precisa de prêmio de colocação", () => {
    const d = decidePayouts(base({ placementCentavos: 0 }));
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.totalCentavos, 1_300);
    assert.ok(d.payouts.every((p) => p.placementCentavos === 0));
  });

  it("tudo em centavos inteiros, nunca fração", () => {
    const d = decidePayouts(base({ killPrizeCentavos: 33 }));
    assert.equal(d.ok, true);
    if (!d.ok) return;
    for (const p of d.payouts) {
      assert.ok(Number.isInteger(p.killCentavos));
      assert.ok(Number.isInteger(p.totalCentavos));
    }
  });
});

describe("A TRAVA: nunca paga mais do que arrecadou", () => {
  it("recusa quando os abates estouram o pool", () => {
    // 60 abates x 100 = 6000, mais 5000 de colocação = 11000 > pool 10000.
    const d = decidePayouts(
      base({ reports: [{ uid: "uid-a", kills: 60 }] })
    );
    assert.deepEqual(d, { ok: false, reason: "exceeds-pool" });
  });

  it("aceita exatamente no limite do pool", () => {
    // 50 abates x 100 = 5000, mais 5000 = 10000 == pool.
    const d = decidePayouts(
      base({ reports: [{ uid: "uid-a", kills: 50 }] })
    );
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.totalCentavos, d.poolCentavos);
  });

  it("recusa por INTEIRO — ninguém recebe nada", () => {
    // A alternativa rejeitada era pagar proporcionalmente. Se algum dia
    // alguém a implementar, este teste quebra e obriga a decisão a ser
    // retomada de propósito, em vez de mudar de lado sem ninguém notar.
    const d = decidePayouts(
      base({
        reports: [
          { uid: "uid-a", kills: 60 },
          { uid: "uid-b", kills: 1 },
        ],
      })
    );
    assert.equal(d.ok, false);
    assert.equal("payouts" in d, false);
  });

  it("pool zero recusa qualquer pagamento", () => {
    const d = decidePayouts(base({ poolCentavos: 0 }));
    assert.deepEqual(d, { ok: false, reason: "exceeds-pool" });
  });

  it("a checagem do pool vem DEPOIS das de forma", () => {
    // Números malformados E estourando: o motivo precisa ser a forma, para o
    // operador corrigir a causa e não o sintoma.
    const d = decidePayouts(
      base({ reports: [{ uid: "uid-a", kills: -5 }], poolCentavos: 0 })
    );
    assert.deepEqual(d, { ok: false, reason: "invalid-kills" });
  });
});

describe("integridade do resultado informado", () => {
  it("recusa abate negativo ou fracionário", () => {
    for (const kills of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = decidePayouts(base({ reports: [{ uid: "uid-a", kills }] }));
      assert.deepEqual(
        d,
        { ok: false, reason: "invalid-kills" },
        `deveria recusar ${kills}`
      );
    }
  });

  it("recusa o mesmo jogador duas vezes", () => {
    const d = decidePayouts(
      base({
        reports: [
          { uid: "uid-a", kills: 1 },
          { uid: "uid-a", kills: 2 },
        ],
      })
    );
    assert.deepEqual(d, { ok: false, reason: "duplicate-player" });
  });

  it("exige o vencedor no resultado quando há prêmio de colocação", () => {
    const d = decidePayouts(
      base({ winnerUid: "uid-ausente", reports: [{ uid: "uid-b", kills: 3 }] })
    );
    assert.deepEqual(d, { ok: false, reason: "winner-not-reported" });
  });

  it("sem prêmio de colocação, o vencedor não precisa constar", () => {
    const d = decidePayouts(
      base({
        winnerUid: "uid-ausente",
        placementCentavos: 0,
        reports: [{ uid: "uid-b", kills: 3 }],
      })
    );
    assert.equal(d.ok, true);
  });

  it("recusa quando ninguém ganharia nada", () => {
    const d = decidePayouts(
      base({
        placementCentavos: 0,
        reports: [
          { uid: "uid-a", kills: 0 },
          { uid: "uid-b", kills: 0 },
        ],
      })
    );
    assert.deepEqual(d, { ok: false, reason: "nothing-to-pay" });
  });

  it("recusa valores de premiação malformados", () => {
    assert.deepEqual(decidePayouts(base({ placementCentavos: -1 })), {
      ok: false,
      reason: "invalid-amount",
    });
    assert.deepEqual(decidePayouts(base({ killPrizeCentavos: 1.5 })), {
      ok: false,
      reason: "invalid-amount",
    });
  });
});

describe("orçamento de escrita da transação", () => {
  it("cabe no teto do Firestore com folga", () => {
    assert.equal(WRITES_PER_PAYOUT, 2);
    assert.equal(
      writesRequiredForSettlement(MAX_PAYOUT_PLAYERS),
      MAX_PAYOUT_PLAYERS * 2 + 2
    );
    assert.ok(
      writesRequiredForSettlement(MAX_PAYOUT_PLAYERS) < 500,
      "o teto precisa caber numa transação atômica"
    );
  });

  it("recusa antes de calcular quando há gente demais", () => {
    const reports = Array.from(
      { length: MAX_PAYOUT_PLAYERS + 1 },
      (_, i) => ({ uid: `uid-${i}`, kills: 0 })
    );
    assert.deepEqual(decidePayouts(base({ reports })), {
      ok: false,
      reason: "too-many-players",
    });
    assert.equal(canSettleAtomically(MAX_PAYOUT_PLAYERS), true);
    assert.equal(canSettleAtomically(MAX_PAYOUT_PLAYERS + 1), false);
  });
});

describe("mensagens de recusa", () => {
  it("toda recusa tem mensagem própria", () => {
    const reasons = [
      "exceeds-pool",
      "too-many-players",
      "duplicate-player",
      "invalid-kills",
      "invalid-amount",
      "winner-not-reported",
      "nothing-to-pay",
    ] as const;
    const seen = new Set<string>();
    for (const r of reasons) {
      const message = payoutRefusalMessage(r);
      assert.ok(message.length > 0);
      assert.equal(seen.has(message), false, `mensagem repetida para ${r}`);
      seen.add(message);
    }
  });

  it("o wrapper lança na recusa e passa no sucesso", () => {
    assert.throws(() =>
      assertPayoutDecision({ ok: false, reason: "exceeds-pool" })
    );
    assert.doesNotThrow(() => assertPayoutDecision(decidePayouts(base())));
  });
});

describe("identidade e categoria do pagamento", () => {
  it("o id é por JOGADOR, não por torneio", () => {
    assert.equal(
      payoutTransactionId("torneio-1", "uid-a"),
      "prize_torneio-1_uid-a"
    );
    assert.notEqual(
      payoutTransactionId("torneio-1", "uid-a"),
      payoutTransactionId("torneio-1", "uid-b")
    );
  });

  it("é determinístico — um replay cai no mesmo documento", () => {
    assert.equal(
      payoutTransactionId("t", "u"),
      payoutTransactionId("t", "u")
    );
  });

  it("mantém o prefixo que o gatilho do ranking exige", () => {
    // seasonRanking.ts:85-91 só aceita id começando com "prize_".
    assert.ok(payoutTransactionId("t", "u").startsWith("prize_"));
  });

  it("distingue o id legado de slot único do id por jogador", () => {
    assert.equal(isPayoutTransactionId("prize_t", "t"), false);
    assert.equal(isPayoutTransactionId("prize_t_u", "t"), true);
    assert.equal(isPayoutTransactionId("prize_t_", "t"), false);
    assert.equal(isPayoutTransactionId("prize_outro_u", "t"), false);
    assert.equal(isPayoutTransactionId(null, "t"), false);
  });

  it("exige torneio e jogador", () => {
    assert.throws(() => payoutTransactionId("", "u"));
    assert.throws(() => payoutTransactionId("t", ""));
  });

  it("abate tem categoria PRÓPRIA, separada de prêmio", () => {
    // Reusar "prize" faria o ranking contar vitória para quem só matou
    // alguém — seasonRanking.ts:446 incrementa winsCount em toda linha aceita.
    assert.equal(KILL_PRIZE_CATEGORY, "kill_prize");
    assert.equal(BETA_KILL_PRIZE_CATEGORY, "beta_kill_prize");
    assert.notEqual(KILL_PRIZE_CATEGORY, "prize");
    assert.notEqual(BETA_KILL_PRIZE_CATEGORY, "beta_prize");
  });

  it("a categoria segue a economia, sem misturar os pools", () => {
    assert.equal(killPrizeCategoryFor("cash"), KILL_PRIZE_CATEGORY);
    assert.equal(killPrizeCategoryFor("beta_credit"), BETA_KILL_PRIZE_CATEGORY);
  });
});

describe("abate no ranking: dinheiro sim, vitória não", () => {
  it("só colocação conta como vitória", () => {
    assert.equal(prizeCountsAsWin("prize"), true);
    assert.equal(prizeCountsAsWin("beta_prize"), true);
    assert.equal(prizeCountsAsWin(KILL_PRIZE_CATEGORY), false);
    assert.equal(prizeCountsAsWin(BETA_KILL_PRIZE_CATEGORY), false);
    assert.equal(prizeCountsAsWin("entry_fee"), false);
    assert.equal(prizeCountsAsWin(null), false);
  });

  it("mas abate É reconhecido pelo ranking, na economia certa", () => {
    // Se não fosse, a linha seria ignorada em silêncio e o dinheiro ganho
    // simplesmente não apareceria na pontuação da temporada.
    assert.equal(classifyPrizeCategory(KILL_PRIZE_CATEGORY), "cash");
    assert.equal(
      classifyPrizeCategory(BETA_KILL_PRIZE_CATEGORY),
      "beta_credit"
    );
  });

  it("uma entrada criada só por abate nasce com zero vitórias", () => {
    const plan = decideEntry({
      event: {
        transactionId: "prize_t1_uid-a",
        publicPlayerId: "A7fQ2_kB9xLm3NpQr5TzUw",
        economy: "cash",
        amountCentavos: 500,
        seasonId: "2026-09",
        dayKey: "2026-09-04",
        prizeAt: new Date("2026-09-04T12:00:00.000Z"),
        countsAsWin: false,
      },
      stored: null,
    });
    assert.equal(plan.kind, "create");
    if (plan.kind !== "create") return;
    assert.equal(plan.winsCount, 0);
    assert.equal(plan.scoreCentavos, 500);
  });

  it("e NÃO é tratada como corrompida quando o próximo prêmio chega", () => {
    // O defeito que este teste trava: a validação exigia winsCount >= 1, então
    // a primeira linha de abate envenenaria a entrada para todo prêmio
    // seguinte daquele jogador na temporada.
    const plan = decideEntry({
      event: {
        transactionId: "prize_t2",
        publicPlayerId: "A7fQ2_kB9xLm3NpQr5TzUw",
        economy: "cash",
        amountCentavos: 50_000,
        seasonId: "2026-09",
        dayKey: "2026-09-05",
        prizeAt: new Date("2026-09-05T12:00:00.000Z"),
        countsAsWin: true,
      },
      stored: {
        publicPlayerId: "A7fQ2_kB9xLm3NpQr5TzUw",
        economy: "cash",
        seasonId: "2026-09",
        scoreCentavos: 500,
        winsCount: 0,
        firstPrizeAt: new Date("2026-09-04T12:00:00.000Z"),
        lastPrizeAt: new Date("2026-09-04T12:00:00.000Z"),
      } as never,
    });
    assert.equal(plan.kind, "update");
    if (plan.kind !== "update") return;
    assert.equal(plan.scoreCentavos, 50_500);
    assert.equal(plan.winsCount, 1);
  });
});

describe("abate nas allowlists fechadas", () => {
  it("a auditoria reconhece as duas categorias", () => {
    // Categoria desconhecida faz o histórico da carteira virar "não modelável".
    assert.ok(KNOWN_CATEGORIES.has(KILL_PRIZE_CATEGORY));
    assert.ok(KNOWN_CATEGORIES.has(BETA_KILL_PRIZE_CATEGORY));
  });

  it("abate em cash alimenta total_won, como o prêmio de colocação", () => {
    assert.equal(CATEGORY_TO_FIELD[KILL_PRIZE_CATEGORY], "total_won");
    assert.equal(CATEGORY_TO_FIELD.prize, "total_won");
  });

  it("abate beta SOMA ao saldo beta — nunca subtrai", () => {
    // O alçapão: o ramo final da classificação beta é um `else` que significa
    // GASTO de inscrição. Uma categoria de crédito não listada explicitamente
    // cairia nele e inverteria o sinal, reconciliando para um número errado
    // que parece plausível.
    const mapping = classifyCategory(BETA_KILL_PRIZE_CATEGORY);
    assert.equal(mapping.role, "prize");
    assert.equal(mapping.sign, 1);
    assert.equal(mapping.economy, "beta_credit");
  });

  it("as estatísticas contam abate como valor ganho", () => {
    const cash = classifyCategory(KILL_PRIZE_CATEGORY);
    assert.equal(cash.role, "prize");
    assert.equal(cash.sign, 1);
    assert.equal(cash.economy, "cash");
  });
});

describe("pool arrecadado", () => {
  it("soma o que cada inscrição realmente pagou", () => {
    const r = poolFromRegistrations([
      { status: "registered", entryFeeSnapshot: 10 },
      { status: "registered", entryFeeSnapshot: 10 },
      { status: "registered", entryFeeSnapshot: 5.5 },
    ]);
    assert.deepEqual(r, { ok: true, centavos: 2_550, counted: 3 });
  });

  it("NÃO conta inscrição reembolsada", () => {
    // Contá-la deixaria uma inscrição cancelada financiar o abate de outro.
    const r = poolFromRegistrations([
      { status: "registered", entryFeeSnapshot: 10 },
      { status: "refunded", entryFeeSnapshot: 10 },
    ]);
    assert.deepEqual(r, { ok: true, centavos: 1_000, counted: 1 });
  });

  it("pool vazio é zero, não erro", () => {
    assert.deepEqual(poolFromRegistrations([]), {
      ok: true,
      centavos: 0,
      counted: 0,
    });
  });

  it("falha FECHADO quando uma inscrição é ilegível", () => {
    // Tratar pool desconhecido como zero recusaria todo pagamento e pareceria
    // decisão de política, em vez do problema de dado que é.
    for (const bad of [undefined, null, "10", Number.NaN, -1]) {
      const r = poolFromRegistrations([
        { status: "registered", entryFeeSnapshot: bad },
      ]);
      assert.deepEqual(
        r,
        { ok: false, reason: "unusable-registration" },
        `deveria falhar em ${String(bad)}`
      );
    }
  });

  it("inscrição gratuita conta como zero, sem quebrar", () => {
    const r = poolFromRegistrations([
      { status: "registered", entryFeeSnapshot: 0 },
    ]);
    assert.deepEqual(r, { ok: true, centavos: 0, counted: 1 });
  });
});
