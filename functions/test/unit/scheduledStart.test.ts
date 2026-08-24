import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseScheduledStart } from "../../src/domain/settlement.js";

describe("horário de início do campeonato", () => {
  it("ausente continua sendo ausente — a forma de todo torneio existente", () => {
    // Este campo foi gravado como null literal desde sempre, e nada nunca o
    // atualizou. Omitir tem que seguir se comportando exatamente como antes.
    for (const absent of [undefined, null, ""]) {
      assert.equal(parseScheduledStart(absent), null, String(absent));
    }
  });

  it("aceita milissegundos de época — o que um cliente Dart manda", () => {
    const d = parseScheduledStart(Date.UTC(2026, 7, 30, 23, 0));
    assert.equal(d?.toISOString(), "2026-08-30T23:00:00.000Z");
  });

  it("aceita ISO-8601 — o que um console ou script manda", () => {
    const d = parseScheduledStart("2026-08-30T23:00:00.000Z");
    assert.equal(d?.toISOString(), "2026-08-30T23:00:00.000Z");
  });

  it("um valor ilegível RECUSA, nunca vira null em silêncio", () => {
    // Quem digitou um horário e não recebeu horário nenhum merece saber.
    for (const bad of ["amanhã", "30/08/2026 23:00", {}, [], true, Number.NaN]) {
      assert.throws(
        () => parseScheduledStart(bad),
        /data de início/i,
        `deveria recusar ${JSON.stringify(bad)}`
      );
    }
  });

  it("recusa ano absurdo — é erro de digitação, não agenda", () => {
    assert.throws(() => parseScheduledStart("1974-01-01T00:00:00Z"));
    assert.throws(() => parseScheduledStart("2999-01-01T00:00:00Z"));
  });

  it("a janela é generosa: recusa disparate, não planejamento", () => {
    assert.ok(parseScheduledStart("2020-01-01T00:00:00Z"));
    assert.ok(parseScheduledStart("2100-12-31T00:00:00Z"));
  });

  it("uma data no PASSADO é aceita", () => {
    // Registrar um torneio que já aconteceu é legítimo; recusar seria a tela
    // decidindo o que o operador pode declarar.
    assert.ok(parseScheduledStart("2024-05-01T12:00:00Z"));
  });
});
