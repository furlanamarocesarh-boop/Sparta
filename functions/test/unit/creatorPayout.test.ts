import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideCreatorPayout,
  PLATFORM_FEE_BPS,
} from "../../src/domain/creatorPayout.js";

/**
 * O REPASSE AO CRIADOR.
 *
 * O que estes testes travam, em ordem de importância:
 *
 *  1. que taxa + repasse dão EXATAMENTE a margem. Um centavo criado ou perdido
 *     aqui é dinheiro que não existe ou que sumiu, e não há de onde recontar;
 *  2. que ninguém fica devendo. Margem negativa é subsídio da casa, não dívida
 *     do criador;
 *  3. que Crédito Beta não repassa. Ele é ficha emitida de graça, e repassar
 *     criaria crédito que ninguém emitiu.
 */

const entrada = (over: Partial<Parameters<typeof decideCreatorPayout>[0]> = {}) => ({
  economy: "cash",
  poolCentavos: 100_00,
  paidCentavos: 50_00,
  payeeUid: "dono",
  ...over,
});

describe("a repartição fecha", () => {
  it("taxa + repasse = margem, ao centavo", () => {
    // A invariante que vale mais que todas as outras juntas.
    const d = decideCreatorPayout(entrada());
    assert.equal(d.kind, "pay");
    if (d.kind !== "pay") return;
    assert.equal(d.feeCentavos + d.creatorCentavos, d.marginCentavos);
    assert.equal(d.marginCentavos, 50_00);
  });

  it("a taxa é 7,5% do ARRECADADO, não da sobra", () => {
    // Cobrar sobre a sobra premiaria quem paga pouco de prêmio e puniria quem
    // paga bem — o oposto do que a plataforma quer incentivar.
    const d = decideCreatorPayout(entrada({ poolCentavos: 100_00, paidCentavos: 0 }));
    assert.equal(d.kind === "pay" && d.feeCentavos, 750);

    const outro = decideCreatorPayout(
      entrada({ poolCentavos: 100_00, paidCentavos: 90_00 })
    );
    assert.equal(
      outro.kind === "pay" && outro.feeCentavos,
      750,
      "a taxa não muda com a premiação"
    );
  });

  it("a fração de centavo fica com o CRIADOR", () => {
    // 7,5% de 3333 é 249,975. A plataforma nunca cobra a mais do que a
    // política diz, nem por um centavo.
    const d = decideCreatorPayout(
      entrada({ poolCentavos: 3333, paidCentavos: 0 })
    );
    assert.equal(d.kind === "pay" && d.feeCentavos, 249);
    assert.equal(d.kind === "pay" && d.creatorCentavos, 3333 - 249);
  });

  it("a taxa aprovada é a mesma do parceiro — uma política só", () => {
    assert.equal(PLATFORM_FEE_BPS, 750);
  });
});

describe("ninguém fica devendo", () => {
  it("premiação ACIMA do arrecadado não vira dívida do criador", () => {
    // Quem cobriu foi o caixa da plataforma.
    const d = decideCreatorPayout(
      entrada({ poolCentavos: 50_00, paidCentavos: 80_00 })
    );
    assert.equal(d.kind, "none");
    assert.equal(d.kind === "none" && d.reason, "no-margin");
    assert.equal(d.kind === "none" && d.feeCentavos, 0, "a casa não cobra nada");
  });

  it("margem exatamente zero não paga ninguém", () => {
    const d = decideCreatorPayout(
      entrada({ poolCentavos: 50_00, paidCentavos: 50_00 })
    );
    assert.equal(d.kind === "none" && d.reason, "no-margin");
  });

  it("quando a taxa come a margem, a casa fica com o que sobrou", () => {
    // Arrecadou 100, pagou 99,50: sobram 50 centavos e a taxa seria 750.
    // Cobrar o que não existe viraria saldo negativo.
    const d = decideCreatorPayout(
      entrada({ poolCentavos: 100_00, paidCentavos: 99_50 })
    );
    assert.equal(d.kind === "none" && d.reason, "fee-eats-margin");
    assert.equal(d.kind === "none" && d.feeCentavos, 50);
  });
});

describe("as portas fechadas", () => {
  it("CRÉDITO BETA não repassa nada", () => {
    const d = decideCreatorPayout(entrada({ economy: "beta_credit" }));
    assert.equal(d.kind === "none" && d.reason, "not-cash");
  });

  it("sem organização, ninguém recebe", () => {
    // Inventar um destinatário para dinheiro é a última coisa que este
    // arquivo faria.
    for (const vazio of [null, ""]) {
      const d = decideCreatorPayout(entrada({ payeeUid: vazio }));
      assert.equal(d.kind === "none" && d.reason, "no-payee", String(vazio));
    }
  });

  it("a razão descreve a causa MAIS FUNDAMENTAL", () => {
    // Beta sem dono e sem margem responde "beta": mudar o dono ou a premiação
    // não faria repasse nenhum acontecer.
    const d = decideCreatorPayout(
      entrada({ economy: "beta_credit", payeeUid: null, paidCentavos: 999_00 })
    );
    assert.equal(d.kind === "none" && d.reason, "not-cash");
  });

  it("valor corrompido recusa em vez de repartir", () => {
    for (const lixo of [1.5, -1, NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const d = decideCreatorPayout(entrada({ poolCentavos: lixo }));
      assert.equal(d.kind === "none" && d.reason, "invalid-amount", String(lixo));
    }
  });
});
