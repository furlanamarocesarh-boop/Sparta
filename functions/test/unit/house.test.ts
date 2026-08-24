import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideHouseFunding,
  houseDocId,
  houseFundingMessage,
  houseMarginCategoryFor,
  HOUSE_BALANCE_FIELD,
  HOUSE_BETA_MARGIN_CATEGORY,
  HOUSE_MARGIN_CATEGORY,
} from "../../src/domain/house.js";
import { MAX_BALANCE_CENTAVOS } from "../../src/domain/money.js";

const reais = (c: number) => `R$ ${(c / 100).toFixed(2)}`;

/** Narrows to the insolvency branch, failing loudly on any other outcome. */
function insolvent(
  d: ReturnType<typeof decideHouseFunding>
): Extract<typeof d, { reason: "house-insolvent" }> {
  assert.equal(d.ok, false);
  assert.equal((d as { reason?: string }).reason, "house-insolvent");
  return d as Extract<typeof d, { reason: "house-insolvent" }>;
}

describe("caixa da plataforma — a regra inteira", () => {
  it("um torneio que paga menos do que arrecadou CREDITA o caixa", () => {
    const d = decideHouseFunding({
      poolCentavos: 20_000,
      paidCentavos: 15_000,
      houseCentavos: 0,
    });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.marginCentavos, 5_000);
    assert.equal(d.houseAfterCentavos, 5_000);
    assert.equal(d.subsidised, false);
  });

  it("um torneio que paga MAIS do que arrecadou debita o caixa", () => {
    // O que o produto queria e a trava antiga proibia: prêmio garantido.
    const d = decideHouseFunding({
      poolCentavos: 8_000,
      paidCentavos: 15_000,
      houseCentavos: 10_000,
    });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.marginCentavos, -7_000);
    assert.equal(d.houseAfterCentavos, 3_000);
    assert.equal(d.subsidised, true);
  });

  it("RECUSA quando deixaria o caixa negativo", () => {
    const d = decideHouseFunding({
      poolCentavos: 0,
      paidCentavos: 50_000,
      houseCentavos: 10_000,
    });
    assert.equal(insolvent(d).shortfallCentavos, 40_000);
  });

  it("gastar o caixa ATÉ ZERO é permitido — zero não é negativo", () => {
    const d = decideHouseFunding({
      poolCentavos: 0,
      paidCentavos: 10_000,
      houseCentavos: 10_000,
    });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.houseAfterCentavos, 0);
  });

  it("um centavo além do caixa já recusa", () => {
    const d = decideHouseFunding({
      poolCentavos: 0,
      paidCentavos: 10_001,
      houseCentavos: 10_000,
    });
    assert.equal(insolvent(d).shortfallCentavos, 1);
  });

  it("com caixa zerado, ninguém paga acima do arrecadado", () => {
    // O estado inicial da plataforma. Um prêmio garantido precisa de margem
    // acumulada antes — que é exatamente o que o torna sustentável.
    const d = decideHouseFunding({
      poolCentavos: 5_000,
      paidCentavos: 5_001,
      houseCentavos: 0,
    });
    assert.equal(d.ok, false);
  });

  it("pagar exatamente o arrecadado não move o caixa", () => {
    const d = decideHouseFunding({
      poolCentavos: 5_000,
      paidCentavos: 5_000,
      houseCentavos: 700,
    });
    assert.equal(d.ok, true);
    if (!d.ok) return;
    assert.equal(d.marginCentavos, 0);
    assert.equal(d.houseAfterCentavos, 700);
    assert.equal(d.subsidised, false);
  });

  it("a falta é o número ACIONÁVEL, não o pagamento", () => {
    // É quanto o operador precisa aportar, ou cortar do prêmio.
    const d = decideHouseFunding({
      poolCentavos: 1_000,
      paidCentavos: 9_000,
      houseCentavos: 3_000,
    });
    const refusal = insolvent(d);
    assert.equal(refusal.shortfallCentavos, 5_000);
    assert.match(houseFundingMessage(refusal, reais), /Faltam R\$ 50\.00/);
    assert.match(houseFundingMessage(refusal, reais), /caixa da plataforma/i);
  });
});

describe("caixa — entradas impossíveis falham FECHADO", () => {
  it("recusa números não inteiros, negativos ou não numéricos", () => {
    const bad = [1.5, -1, Number.NaN, Infinity, "10" as unknown as number];
    for (const value of bad) {
      assert.equal(
        decideHouseFunding({
          poolCentavos: value,
          paidCentavos: 0,
          houseCentavos: 0,
        }).ok,
        false,
        `pool ${String(value)}`
      );
      assert.equal(
        decideHouseFunding({
          poolCentavos: 0,
          paidCentavos: 0,
          houseCentavos: value,
        }).ok,
        false,
        `caixa ${String(value)}`
      );
    }
  });

  it("um caixa acima do teto de dinheiro é corrupção, não fortuna", () => {
    const d = decideHouseFunding({
      poolCentavos: MAX_BALANCE_CENTAVOS,
      paidCentavos: 0,
      houseCentavos: MAX_BALANCE_CENTAVOS,
    });
    assert.equal(d.ok, false);
  });
});

describe("as duas economias têm caixas SEPARADOS", () => {
  it("cada economia resolve para o seu próprio documento", () => {
    assert.equal(houseDocId("cash"), "cash");
    assert.equal(houseDocId("beta_credit"), "beta_credit");
  });

  it("uma economia desconhecida cai em cash, nunca em beta", () => {
    // Falhar para o lado do dinheiro real significa que o pior caso é uma
    // recusa por caixa insuficiente, não Créditos Beta financiando reais.
    assert.equal(houseDocId(""), "cash");
    assert.equal(houseDocId("outra"), "cash");
  });

  it("a categoria de razão distingue as duas", () => {
    assert.equal(houseMarginCategoryFor("cash"), HOUSE_MARGIN_CATEGORY);
    assert.equal(
      houseMarginCategoryFor("beta_credit"),
      HOUSE_BETA_MARGIN_CATEGORY
    );
    assert.notEqual(HOUSE_MARGIN_CATEGORY, HOUSE_BETA_MARGIN_CATEGORY);
  });

  it("o campo de saldo NÃO se chama balance", () => {
    // O reconciliador percorre wallets/ e deriva a identidade do jogador a
    // partir de balance. Um documento de caixa com o mesmo formato acabaria
    // varrido para dentro dessa conta.
    assert.equal(HOUSE_BALANCE_FIELD, "balance_centavos");
    assert.notEqual(HOUSE_BALANCE_FIELD, "balance");
  });
});
