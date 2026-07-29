import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activityDaysInMonth,
  aggregateLedger,
  classifyCategory,
  dailyNetArray,
  daysInMonth,
  isKnownCategory,
  isSameWeek,
  monthOfDayKey,
  normalizeMonth,
  normalizeStatsUid,
  STATS_TIMEZONE,
  weekStartOf,
  type LedgerRow,
} from "../../src/domain/engagementStats.js";

/** A ledger row. `reais` mirrors exactly how Firestore stores `amount`. */
function row(
  category: string,
  reais: number,
  at: Date | null,
  overrides: Partial<LedgerRow> = {}
): LedgerRow {
  return {
    id: `${category}-${reais}`,
    category,
    status: "completed",
    amount: reais,
    at,
    ...overrides,
  };
}

/** An instant unambiguously mid-afternoon in São Paulo on that day. */
const sp = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 18));

const JULY = normalizeMonth("2026-07");
const TODAY = "2026-07-15"; // a Wednesday

function assertDomainCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

describe("unidade monetária congelada", () => {
  it("todo valor devolvido é centavo INTEIRO, nunca reais nem float", () => {
    const result = aggregateLedger({
      rows: [row("entry_fee", 5, sp(2026, 7, 15))],
      requestedMonth: JULY,
      today: TODAY,
    });
    // R$ 5,00 de entrada => -500 centavos.
    assert.equal(result.cash.lifetimeNet, -500);
    assert.equal(Number.isInteger(result.cash.lifetimeNet), true);
  });

  it("centavos fracionários de reais são exatos (R$ 10,03 => 1003)", () => {
    const result = aggregateLedger({
      rows: [row("prize", 10.03, sp(2026, 7, 15))],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(result.cash.lifetimeNet, 1003);
  });

  it("somas repetidas não acumulam desvio de ponto flutuante", () => {
    const rows = Array.from({ length: 3 }, () =>
      row("prize", 0.1, sp(2026, 7, 15))
    );
    const result = aggregateLedger({ rows, requestedMonth: JULY, today: TODAY });
    // 0.1 + 0.1 + 0.1 em float seria 0.30000000000000004. Em centavos: 30.
    assert.equal(result.cash.lifetimeNet, 30);
  });

  it("o fuso do módulo é o mesmo do calendário de negócio", () => {
    assert.equal(STATS_TIMEZONE, "America/Sao_Paulo");
  });
});

describe("mapeamento canônico de categorias", () => {
  it("taxa de entrada é NEGATIVA, na economia certa", () => {
    assert.deepEqual(classifyCategory("entry_fee"), {
      role: "entry",
      economy: "cash",
      sign: -1,
    });
    assert.deepEqual(classifyCategory("beta_entry_fee"), {
      role: "entry",
      economy: "beta_credit",
      sign: -1,
    });
  });

  it("prêmio é POSITIVO", () => {
    assert.equal(classifyCategory("prize").sign, 1);
    assert.equal(classifyCategory("prize").economy, "cash");
    assert.equal(classifyCategory("beta_prize").sign, 1);
    assert.equal(classifyCategory("beta_prize").economy, "beta_credit");
  });

  it("reembolso é POSITIVO — efeito real, categoria inequívoca", () => {
    assert.equal(classifyCategory("entry_refund").sign, 1);
    assert.equal(classifyCategory("entry_refund").role, "refund");
    assert.equal(classifyCategory("beta_refund").sign, 1);
    assert.equal(classifyCategory("beta_refund").economy, "beta_credit");
  });

  it("depósito, saque e grant beta são EXCLUÍDOS", () => {
    for (const c of ["deposit", "withdrawal", "beta_grant"]) {
      assert.equal(classifyCategory(c).sign, 0, `${c} não pode contar`);
      assert.equal(classifyCategory(c).economy, null);
      assert.equal(isKnownCategory(c), true, `${c} é conhecida e excluída`);
    }
  });

  it("categoria desconhecida/legada é excluída, nunca adivinhada", () => {
    for (const c of ["admin_correction", "categoria_futura", "", 42, null]) {
      assert.equal(classifyCategory(c).sign, 0);
      assert.equal(isKnownCategory(c), false);
    }
  });
});

describe("entrada e reembolso se anulam", () => {
  it("entrada + seu reembolso resultam em zero", () => {
    const result = aggregateLedger({
      rows: [
        row("entry_fee", 5, sp(2026, 7, 10)),
        row("entry_refund", 5, sp(2026, 7, 11)),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(result.cash.lifetimeNet, 0);
  });

  it("o mesmo vale na economia beta", () => {
    const result = aggregateLedger({
      rows: [
        row("beta_entry_fee", 5, sp(2026, 7, 10)),
        row("beta_refund", 5, sp(2026, 7, 11)),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(result.beta.lifetimeNet, 0);
  });
});

describe("depósitos e saques ficam de fora do resultado", () => {
  it("um extrato só de depósito/saque/grant dá resultado zero", () => {
    const result = aggregateLedger({
      rows: [
        row("deposit", 100, sp(2026, 7, 5)),
        row("withdrawal", 30, sp(2026, 7, 6)),
        row("beta_grant", 50, sp(2026, 7, 7)),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(result.cash.lifetimeNet, 0);
    assert.equal(result.beta.lifetimeNet, 0);
    assert.equal(result.cash.dailyNet.size, 0);
    assert.equal(dailyNetArray(result.cash).length, 0);
  });
});

describe("cash e beta NUNCA são somados", () => {
  it("cada economia mantém seu próprio resultado", () => {
    const result = aggregateLedger({
      rows: [
        row("prize", 100, sp(2026, 7, 15)),
        row("beta_entry_fee", 5, sp(2026, 7, 15)),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(result.cash.lifetimeNet, 10000);
    assert.equal(result.beta.lifetimeNet, -500);
    // A soma ingênua (9500) não existe em campo algum do resultado.
    assert.notEqual(result.cash.lifetimeNet, 9500);
    assert.notEqual(result.beta.lifetimeNet, 9500);
    assert.equal(result.cash.dailyNet.get("2026-07-15"), 10000);
    assert.equal(result.beta.dailyNet.get("2026-07-15"), -500);
  });
});

describe("fronteiras de São Paulo", () => {
  it("logo antes da meia-noite local conta no dia anterior", () => {
    // 02:59:59Z == 23:59:59 do dia 14 em São Paulo.
    const result = aggregateLedger({
      rows: [row("prize", 10, new Date("2026-07-15T02:59:59.000Z"))],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(result.cash.dailyNet.get("2026-07-14"), 1000);
    assert.equal(result.cash.dailyNet.has("2026-07-15"), false);
  });

  it("exatamente na meia-noite local já é o dia novo", () => {
    const result = aggregateLedger({
      rows: [row("prize", 10, new Date("2026-07-15T03:00:00.000Z"))],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(result.cash.dailyNet.get("2026-07-15"), 1000);
  });

  it("a virada de MÊS respeita São Paulo, não UTC", () => {
    // 2026-08-01T02:00:00Z == 23:00 de 31/07 em São Paulo => ainda julho.
    const result = aggregateLedger({
      rows: [row("prize", 10, new Date("2026-08-01T02:00:00.000Z"))],
      requestedMonth: JULY,
      today: "2026-07-31",
    });
    assert.equal(result.cash.dailyNet.get("2026-07-31"), 1000);
    assert.equal(result.cash.currentMonthNet, 1000);
  });
});

describe("semanas começam na segunda-feira", () => {
  it("segunda é o início da própria semana", () => {
    assert.equal(weekStartOf("2026-07-13"), "2026-07-13"); // segunda
  });

  it("domingo pertence à semana que começou na segunda anterior", () => {
    assert.equal(weekStartOf("2026-07-19"), "2026-07-13"); // domingo
    assert.equal(weekStartOf("2026-07-20"), "2026-07-20"); // segunda seguinte
  });

  it("segunda..domingo é a mesma semana; a segunda seguinte não é", () => {
    for (const d of ["2026-07-13", "2026-07-15", "2026-07-19"]) {
      assert.equal(isSameWeek(d, "2026-07-15"), true, d);
    }
    assert.equal(isSameWeek("2026-07-12", "2026-07-15"), false); // domingo anterior
    assert.equal(isSameWeek("2026-07-20", "2026-07-15"), false);
  });

  it("a semana atravessa a virada de mês corretamente", () => {
    // 2026-08-01 é sábado; sua semana começa em 2026-07-27 (segunda).
    assert.equal(weekStartOf("2026-08-01"), "2026-07-27");
    assert.equal(isSameWeek("2026-07-31", "2026-08-01"), true);
  });
});

describe("janelas: dia, semana, mês e vida toda", () => {
  const rows = [
    row("prize", 20, sp(2026, 7, 15)), // hoje
    row("entry_fee", 5, sp(2026, 7, 15)), // hoje
    row("entry_fee", 5, sp(2026, 7, 13)), // mesma semana (segunda)
    row("entry_fee", 5, sp(2026, 7, 2)), // mesmo mês, outra semana
    row("entry_fee", 5, sp(2026, 6, 30)), // mês anterior
  ];

  it("dia: soma as linhas do mesmo dia", () => {
    const r = aggregateLedger({ rows, requestedMonth: JULY, today: TODAY });
    // +2000 -500 = +1500
    assert.equal(r.cash.dailyNet.get("2026-07-15"), 1500);
  });

  it("semana atual (segunda-based)", () => {
    const r = aggregateLedger({ rows, requestedMonth: JULY, today: TODAY });
    // +2000 -500 -500 = +1000
    assert.equal(r.cash.currentWeekNet, 1000);
  });

  it("mês atual", () => {
    const r = aggregateLedger({ rows, requestedMonth: JULY, today: TODAY });
    // +2000 -500 -500 -500 = +500
    assert.equal(r.cash.currentMonthNet, 500);
  });

  it("vida toda inclui meses anteriores", () => {
    const r = aggregateLedger({ rows, requestedMonth: JULY, today: TODAY });
    // 500 - 500 = 0
    assert.equal(r.cash.lifetimeNet, 0);
  });

  it("dailyNet cobre o mês SOLICITADO, não o mês atual", () => {
    const june = normalizeMonth("2026-06");
    const r = aggregateLedger({ rows, requestedMonth: june, today: TODAY });
    assert.deepEqual(dailyNetArray(r.cash), [
      { date: "2026-06-30", amount: -500 },
    ]);
    // As janelas "atual" continuam ancoradas em `today`, não no mês pedido.
    assert.equal(r.cash.currentMonthNet, 500);
  });
});

describe("ordenação e forma de dailyNet", () => {
  it("é ascendente por data e omite dias zerados", () => {
    const r = aggregateLedger({
      rows: [
        row("prize", 10, sp(2026, 7, 20)),
        row("entry_fee", 5, sp(2026, 7, 3)),
        // Dia que se anula: não deve aparecer.
        row("entry_fee", 5, sp(2026, 7, 10)),
        row("entry_refund", 5, sp(2026, 7, 10)),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.deepEqual(dailyNetArray(r.cash), [
      { date: "2026-07-03", amount: -500 },
      { date: "2026-07-20", amount: 1000 },
    ]);
  });
});

describe("política explícita para linhas inutilizáveis", () => {
  it("status diferente de completed é excluído e contado", () => {
    const r = aggregateLedger({
      rows: [
        row("prize", 10, sp(2026, 7, 15), { status: "pending" }),
        row("prize", 10, sp(2026, 7, 15), { status: "failed" }),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(r.cash.lifetimeNet, 0);
    assert.equal(r.excludedNotCompleted, 2);
  });

  it("valor malformado é excluído e contado, nunca adivinhado", () => {
    const r = aggregateLedger({
      rows: [
        row("prize", "10" as unknown as number, sp(2026, 7, 15)),
        row("prize", Number.NaN, sp(2026, 7, 15)),
        row("prize", -10, sp(2026, 7, 15)),
        row("prize", 10.001, sp(2026, 7, 15)),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(r.cash.lifetimeNet, 0);
    assert.equal(r.excludedMalformedAmount, 4);
  });

  it("linha sem data é excluída e contada", () => {
    const r = aggregateLedger({
      rows: [row("prize", 10, null)],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(r.cash.lifetimeNet, 0);
    assert.equal(r.excludedUndated, 1);
  });

  it("categoria desconhecida é excluída e contada", () => {
    const r = aggregateLedger({
      rows: [
        row("admin_correction", 10, sp(2026, 7, 15)),
        row("categoria_nova", 10, sp(2026, 7, 15)),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(r.cash.lifetimeNet, 0);
    assert.equal(r.excludedUnknownCategory, 2);
  });

  it("uma linha ruim não contamina as boas", () => {
    const r = aggregateLedger({
      rows: [
        row("prize", 10, sp(2026, 7, 15)),
        row("prize", Number.NaN, sp(2026, 7, 15)),
      ],
      requestedMonth: JULY,
      today: TODAY,
    });
    assert.equal(r.cash.lifetimeNet, 1000);
    assert.equal(r.excludedMalformedAmount, 1);
  });
});

describe("extrato vazio", () => {
  it("devolve zeros e nenhum dia", () => {
    const r = aggregateLedger({ rows: [], requestedMonth: JULY, today: TODAY });
    assert.equal(r.cash.lifetimeNet, 0);
    assert.equal(r.cash.currentWeekNet, 0);
    assert.equal(r.cash.currentMonthNet, 0);
    assert.equal(r.beta.lifetimeNet, 0);
    assert.deepEqual(dailyNetArray(r.cash), []);
    assert.deepEqual(dailyNetArray(r.beta), []);
  });
});

describe("normalizeMonth", () => {
  it("aceita AAAA-MM válido", () => {
    assert.deepEqual(normalizeMonth("2026-07"), {
      year: 2026,
      month: 7,
      key: "2026-07",
    });
    assert.equal(normalizeMonth("  2026-01  ").key, "2026-01");
  });

  it("rejeita formato malformado", () => {
    for (const bad of ["2026-7", "07-2026", "2026/07", "2026", "", "julho"]) {
      assertDomainCode(() => normalizeMonth(bad), "invalid-argument");
    }
  });

  it("rejeita não-string", () => {
    for (const bad of [undefined, null, 202607, {}, []]) {
      assertDomainCode(() => normalizeMonth(bad), "invalid-argument");
    }
  });

  it("rejeita mês fora de 01..12 e ano implausível", () => {
    assertDomainCode(() => normalizeMonth("2026-00"), "invalid-argument");
    assertDomainCode(() => normalizeMonth("2026-13"), "invalid-argument");
    assertDomainCode(() => normalizeMonth("1900-05"), "invalid-argument");
    assertDomainCode(() => normalizeMonth("9999-05"), "invalid-argument");
  });
});

describe("daysInMonth e monthOfDayKey", () => {
  it("conta os dias corretos, inclusive fevereiro", () => {
    assert.equal(daysInMonth(normalizeMonth("2026-07")).length, 31);
    assert.equal(daysInMonth(normalizeMonth("2026-02")).length, 28);
    assert.equal(daysInMonth(normalizeMonth("2024-02")).length, 29);
    assert.equal(daysInMonth(normalizeMonth("2026-04")).length, 30);
    assert.equal(daysInMonth(JULY)[0], "2026-07-01");
    assert.equal(daysInMonth(JULY)[30], "2026-07-31");
  });

  it("extrai o mês de uma chave de dia", () => {
    assert.equal(monthOfDayKey("2026-07-15"), "2026-07");
  });
});

describe("activityDaysInMonth", () => {
  it("filtra pelo mês, deduplica e ordena", () => {
    assert.deepEqual(
      activityDaysInMonth(
        ["2026-07-15", "2026-07-01", "2026-07-15", "2026-06-30"],
        JULY
      ),
      ["2026-07-01", "2026-07-15"]
    );
  });

  it("descarta valores malformados sem quebrar", () => {
    assert.deepEqual(
      activityDaysInMonth(
        [null, 42, "", "2026-7-1", "2026-07-32", "2026-02-30", "2026-07-09"],
        JULY
      ),
      ["2026-07-09"]
    );
  });

  it("mês sem acesso devolve lista vazia", () => {
    assert.deepEqual(activityDaysInMonth([], JULY), []);
  });
});

describe("normalizeStatsUid", () => {
  it("aceita e apara um uid válido", () => {
    assert.equal(normalizeStatsUid("  abc123  "), "abc123");
  });

  it("rejeita vazio e uid que escaparia do caminho", () => {
    assertDomainCode(() => normalizeStatsUid(""), "invalid-argument");
    assertDomainCode(() => normalizeStatsUid(null), "invalid-argument");
    assertDomainCode(() => normalizeStatsUid("a/../b"), "invalid-argument");
    assertDomainCode(() => normalizeStatsUid("x".repeat(201)), "invalid-argument");
  });
});
