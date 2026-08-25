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

describe("o resultado: o que ficou, e para quem", () => {
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

  it("a margem é o lucro, e ela tem dono", () => {
    // O único lucro com razão por trás. A taxa de 7,5% é POLÍTICA de produto:
    // a liquidação credita o prêmio cheio e não retém nada, então nenhuma
    // linha registra uma taxa sendo tirada. Reportá-la seria inventar dinheiro
    // que nunca foi separado.
    const split = cashOf(
      splitProfit([t("house_margin", 3, 10_000), t("commission_accrued", 2, 300)])
    );
    assert.equal(split.marginCentavos, 10_000);
    assert.equal(split.commissionCentavos, 300);
    assert.equal(split.ownerCentavos, 9_700);
  });

  it("MARGEM NEGATIVA é um prejuízo, não um zero", () => {
    // O bug que isto conserta: a casa subsidiando o prêmio grava valor
    // negativo, e um painel que o pisasse em zero esconderia exatamente o
    // número que o operador precisa ver.
    const split = cashOf(splitProfit([t("house_margin", 1, -5_000)]));
    assert.equal(split.marginCentavos, -5_000);
    assert.equal(split.ownerCentavos, -5_000);
  });

  it("o dono pode ficar negativo, e isso não é aparado", () => {
    const split = cashOf(
      splitProfit([t("house_margin", 1, 100), t("commission_accrued", 1, 900)])
    );
    assert.equal(split.ownerCentavos, -800);
  });

  it("a comissão nunca entra negativa no cálculo", () => {
    // Ela é passivo: só existe devendo. Um valor negativo gravado seria dado
    // corrompido, e somá-lo aumentaria a parte do dono.
    const split = cashOf(splitProfit([t("commission_accrued", 1, -500)]));
    assert.equal(split.commissionCentavos, 500);
    assert.equal(split.ownerCentavos, -500);
  });

  it("as duas economias têm resultados separados", () => {
    const rows = splitProfit([
      t("house_margin", 1, 10_000),
      t("beta_house_margin", 1, 777),
    ]);
    assert.equal(cashOf(rows).marginCentavos, 10_000);
    assert.equal(
      (rows.find((r) => r.economy === "beta_credit") as any).marginCentavos,
      777
    );
  });

  it("sem movimento, resultado zero — mas as duas linhas existem", () => {
    const rows = splitProfit([]);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.ownerCentavos === 0));
  });

  it("nenhuma outra categoria conta como lucro", () => {
    // Aporte no caixa é dinheiro COLOCADO, não ganho. Contá-lo como lucro
    // faria um depósito seu parecer receita.
    const split = cashOf(
      splitProfit([t("house_funding", 1, 100_000), t("deposit", 1, 50_000)])
    );
    assert.equal(split.marginCentavos, 0);
    assert.equal(split.ownerCentavos, 0);
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
