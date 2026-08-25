import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  aggregateToCentavos,
  CATEGORY_SPECS,
  KNOWN_CATEGORIES,
  rollUpByEconomy,
  specFor,
  splitProfit,
  WINDOW_KEYS,
  windowStart,
  type CategoryTotal,
} from "../../src/domain/adminOverview.js";

describe("a tabela de categorias é fechada e verdadeira", () => {
  it("TODA categoria que o backend escreve está na tabela", () => {
    // ESTE É O TESTE QUE IMPORTA. `house_funding` guarda `amount_centavos` e
    // não `amount`; um painel que somasse `amount` reportaria o caixa como
    // R$ 0, em silêncio, e alguém tomaria decisão em cima disso. A tabela é a
    // defesa, e ela só vale se ninguém puder acrescentar uma categoria sem
    // passar por aqui.
    //
    // A VARREDURA COBRE `src/` INTEIRO porque a maioria das categorias não é
    // escrita como literal em `index.ts`: elas vivem em constantes dos módulos
    // de domínio. Procurar só o literal achava seis de doze — foi assim que
    // este teste falhou da primeira vez, e é exatamente o buraco que ele
    // precisa não ter.
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(`src/${f}`, "utf8"));

    const written = new Set<string>();
    for (const source of files) {
      for (const m of source.matchAll(/category:\s*"([a-z_]+)"/g)) {
        written.add(m[1]);
      }
      for (const m of source.matchAll(
        /_CATEGORY(?:\s*:\s*[\w<>." ]+)?\s*=\s*"([a-z_]+)"/g
      )) {
        written.add(m[1]);
      }
    }

    assert.ok(
      written.size >= 15,
      `a varredura achou poucas categorias (${written.size}): ${[...written].sort()}`
    );

    const missing = [...written].filter((c) => specFor(c) === null).sort();
    assert.deepEqual(
      missing,
      [],
      `categorias escritas pelo backend e ausentes da tabela: ${missing}`
    );
  });

  it("a categoria legada aparece na tabela mesmo sem quem a escreva", () => {
    // `admin_correction` existe em dados de produção e NADA no backend atual a
    // escreve — veio de uma correção manual. Deixá-la fora da tabela faria o
    // painel recusar linhas que existem de verdade.
    assert.notEqual(specFor("admin_correction"), null);
    const files = readdirSync("src", { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(`src/${f}`, "utf8"));
    assert.ok(
      !files.some((f) => f.includes('"admin_correction"')),
      "alguém passou a escrever admin_correction: mova o comentário"
    );
  });

  it("a tabela cobre as dezessete, em ordem estável", () => {
    assert.equal(KNOWN_CATEGORIES.length, 17);
    assert.deepEqual([...KNOWN_CATEGORIES].sort(), [...KNOWN_CATEGORIES]);
  });

  it("a forma do valor segue a família, não o capricho", () => {
    // Duas famílias: quem MOVE CARTEIRA guarda reais; quem é da PLATAFORMA
    // (caixa, margem, comissão) guarda centavos e não tem `user_ref`. Somar
    // `amount` nas duas devolveria zero para a segunda inteira, em silêncio.
    const platform = [
      "house_funding",
      "house_margin",
      "beta_house_funding",
      "beta_house_margin",
      "commission_accrued",
    ];
    for (const [id, spec] of Object.entries(CATEGORY_SPECS)) {
      assert.equal(
        spec.shape,
        platform.includes(id) ? "centavos" : "reais",
        id
      );
      if (platform.includes(id)) {
        assert.equal(spec.direction, "internal", id);
      }
    }
  });

  it("cada categoria pertence a uma economia só", () => {
    for (const [id, spec] of Object.entries(CATEGORY_SPECS)) {
      const beta = id.startsWith("beta_");
      assert.equal(
        spec.economy,
        beta ? "beta_credit" : "cash",
        `${id} está na economia errada`
      );
    }
  });

  it("uma categoria desconhecida é RECUSADA, nunca assumida", () => {
    for (const bad of ["categoria_do_futuro", "", null, 42, {}]) {
      assert.equal(specFor(bad), null, String(bad));
    }
  });
});

describe("convertendo um agregado em centavos", () => {
  it("reais viram centavos", () => {
    assert.equal(aggregateToCentavos("reais", 10.03), 1003);
    assert.equal(aggregateToCentavos("reais", 0), 0);
  });

  it("centavos passam inteiros", () => {
    assert.equal(aggregateToCentavos("centavos", 10_000), 10_000);
  });

  it("o erro de ponto flutuante morre no arredondamento", () => {
    // Reais são guardados como ponto flutuante, então uma soma de milhares
    // deles carrega fração de centavo. Arredondar UMA vez, na borda, é o que
    // impede isso de virar um número que não fecha.
    const soma = 0.1 + 0.2; // 0.30000000000000004
    assert.equal(aggregateToCentavos("reais", soma), 30);
    assert.equal(aggregateToCentavos("reais", 10.03 * 3), 3009);
  });

  it("um agregado inutilizável vira zero, nunca NaN na tela", () => {
    for (const bad of [null, undefined, "10", Number.NaN, Infinity, {}]) {
      assert.equal(aggregateToCentavos("reais", bad), 0, String(bad));
    }
  });
});

describe("as janelas", () => {
  const now = new Date(Date.UTC(2026, 7, 25, 10, 0, 0));

  it("são móveis, não de calendário", () => {
    // "Últimas 24 horas" é as últimas 24 horas, não "hoje": quem olha às 10h
    // quer o dia e a noite anteriores, não as dez horas desde a meia-noite.
    const day = windowStart("day", now)!;
    assert.equal(day.toISOString(), "2026-08-24T10:00:00.000Z");
  });

  it("uma semana, um mês e um ano contam dias", () => {
    assert.equal(windowStart("week", now)!.toISOString(), "2026-08-18T10:00:00.000Z");
    assert.equal(windowStart("month", now)!.toISOString(), "2026-07-26T10:00:00.000Z");
    assert.equal(windowStart("year", now)!.toISOString(), "2025-08-25T10:00:00.000Z");
  });

  it("o total não tem começo", () => {
    assert.equal(windowStart("all", now), null);
  });

  it("as janelas vêm da mais curta para a mais longa", () => {
    assert.deepEqual(WINDOW_KEYS, ["day", "week", "month", "year", "all"]);
  });
});

describe("somando por economia", () => {
  const t = (
    category: string,
    count: number,
    centavos: number
  ): CategoryTotal => {
    const spec = specFor(category)!;
    return {
      category,
      label: spec.label,
      economy: spec.economy,
      direction: spec.direction,
      count,
      centavos,
    };
  };

  it("AS DUAS ECONOMIAS NUNCA SE SOMAM", () => {
    // A mesma regra da carteira, do ranking e do quadro de criadores. Um
    // "total" único cobrindo as duas seria mentira nas duas.
    const rows = rollUpByEconomy([
      t("deposit", 2, 5_000),
      t("beta_prize", 3, 9_900),
    ]);
    const cash = rows.find((r) => r.economy === "cash")!;
    const beta = rows.find((r) => r.economy === "beta_credit")!;
    assert.equal(cash.volumeCentavos, 5_000);
    assert.equal(beta.volumeCentavos, 9_900);
  });

  it("entrada e saída ficam ao lado do volume, não subtraídas", () => {
    // Um líquido zero pode significar "nada aconteceu" ou "mil reais entraram
    // e mil saíram", e esses dois dias são muito diferentes.
    const cash = rollUpByEconomy([
      t("deposit", 1, 10_000),
      t("withdrawal", 1, 10_000),
    ]).find((r) => r.economy === "cash")!;

    assert.equal(cash.volumeCentavos, 20_000);
    assert.equal(cash.inCentavos, 10_000);
    assert.equal(cash.outCentavos, 10_000);
  });

  it("um movimento interno entra no volume e em nenhum lado", () => {
    const cash = rollUpByEconomy([t("house_funding", 1, 10_000)]).find(
      (r) => r.economy === "cash"
    )!;
    assert.equal(cash.volumeCentavos, 10_000);
    assert.equal(cash.inCentavos, 0);
    assert.equal(cash.outCentavos, 0);
  });

  it("as duas economias sempre aparecem, mesmo zeradas", () => {
    // Uma linha ausente lê como "sem dados" quando a verdade é "nada
    // aconteceu", e as duas coisas são diferentes.
    const rows = rollUpByEconomy([]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.economy).sort(),
      ["beta_credit", "cash"]
    );
    assert.ok(rows.every((r) => r.count === 0 && r.volumeCentavos === 0));
  });
});

describe("o lucro vem do razão, não da margem", () => {
  const t = (
    category: string,
    count: number,
    centavos: number
  ): CategoryTotal => {
    const spec = specFor(category)!;
    return {
      category,
      label: spec.label,
      economy: spec.economy,
      direction: spec.direction,
      count,
      centavos,
    };
  };

  const cashOf = (rows: readonly { economy: string }[]) =>
    rows.find((r) => r.economy === "cash") as any;

  it("arrecadado menos pago é o resultado", () => {
    const split = cashOf(
      splitProfit([t("entry_fee", 10, 100_000), t("prize", 1, 70_000)])
    );
    assert.equal(split.collectedCentavos, 100_000);
    assert.equal(split.paidCentavos, 70_000);
    assert.equal(split.grossCentavos, 30_000);
    assert.equal(split.ownerCentavos, 30_000);
  });

  it("PAGAR MAIS DO QUE ENTROU É PREJUÍZO, não zero", () => {
    // É exatamente o caso de produção: R$ 10,03 entraram e R$ 30,30 saíram.
    // Prêmio é CREDITADO sem debitar fonte, então isso sai do nada — e um
    // painel que pisasse em zero esconderia justamente esse buraco.
    const split = cashOf(
      splitProfit([t("entry_fee", 1, 1003), t("prize", 1, 3030)])
    );
    assert.equal(split.grossCentavos, -2027);
    assert.equal(split.ownerCentavos, -2027);
  });

  it("estorno reduz o arrecadado", () => {
    const split = cashOf(
      splitProfit([t("entry_fee", 2, 2000), t("entry_refund", 1, 1000)])
    );
    assert.equal(split.collectedCentavos, 1000);
  });

  it("prêmio por abate também é pagamento", () => {
    const split = cashOf(
      splitProfit([t("entry_fee", 1, 5000), t("kill_prize", 3, 1500)])
    );
    assert.equal(split.paidCentavos, 1500);
    assert.equal(split.grossCentavos, 3500);
  });

  it("A MARGEM NÃO ENTRA — senão o mesmo dinheiro conta duas vezes", () => {
    // `house_margin` é o registro derivado da MESMA diferença. Somá-la por
    // cima dobraria o resultado das liquidações que a têm.
    const split = cashOf(
      splitProfit([
        t("entry_fee", 1, 10_000),
        t("prize", 1, 6_000),
        t("house_margin", 1, 4_000),
      ])
    );
    assert.equal(split.grossCentavos, 4_000);
  });

  it("depósito, saque e aporte não são receita", () => {
    // Dinheiro entrando numa carteira ou no caixa é o operador trocando de
    // bolso. Só inscrição é alguém pagando à plataforma.
    const split = cashOf(
      splitProfit([
        t("deposit", 1, 50_000),
        t("withdrawal", 1, 20_000),
        t("house_funding", 1, 100_000),
        t("admin_correction", 1, 1_000),
      ])
    );
    assert.equal(split.collectedCentavos, 0);
    assert.equal(split.paidCentavos, 0);
    assert.equal(split.ownerCentavos, 0);
  });

  it("a comissão sai do resultado do dono", () => {
    const split = cashOf(
      splitProfit([
        t("entry_fee", 1, 10_000),
        t("prize", 1, 6_000),
        t("commission_accrued", 1, 300),
      ])
    );
    assert.equal(split.grossCentavos, 4_000);
    assert.equal(split.commissionCentavos, 300);
    assert.equal(split.ownerCentavos, 3_700);
  });

  it("as duas economias têm resultados separados", () => {
    const rows = splitProfit([
      t("entry_fee", 1, 10_000),
      t("beta_entry_fee", 1, 500),
    ]);
    assert.equal(cashOf(rows).collectedCentavos, 10_000);
    assert.equal(
      (rows.find((r) => r.economy === "beta_credit") as any).collectedCentavos,
      500
    );
  });

  it("sem movimento, tudo zero — mas as duas linhas existem", () => {
    const rows = splitProfit([]);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.ownerCentavos === 0));
  });

  it("todo papel de lucro está declarado, e só onde faz sentido", () => {
    const roles: Record<string, string> = {};
    for (const [id, spec] of Object.entries(CATEGORY_SPECS)) {
      if (spec.profitRole) roles[id] = spec.profitRole;
    }
    assert.deepEqual(roles, {
      entry_fee: "collected",
      beta_entry_fee: "collected",
      entry_refund: "refunded",
      beta_refund: "refunded",
      prize: "paid",
      beta_prize: "paid",
      kill_prize: "paid",
      beta_kill_prize: "paid",
      commission_accrued: "commission",
    });
  });
});

describe("volume com valor negativo", () => {
  it("um subsídio MOVEU dinheiro, então engorda o volume", () => {
    // Somar -5000 deixaria um prejuízo encolher o volume e faria um mês
    // movimentado parecer parado.
    const spec = specFor("house_margin")!;
    const rows = rollUpByEconomy([
      {
        category: "house_margin",
        label: spec.label,
        economy: spec.economy,
        direction: spec.direction,
        count: 1,
        centavos: -5_000,
      },
    ]);
    assert.equal(
      rows.find((r) => r.economy === "cash")!.volumeCentavos,
      5_000
    );
  });
});
