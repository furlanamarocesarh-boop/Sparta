import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkPreset,
  checkPresetId,
  checkPresetName,
  MAX_PRESET_ID_LENGTH,
  MAX_PRESET_NAME_LENGTH,
  presetIdFor,
  presetMessage,
} from "../../src/domain/scoringPreset.js";

/**
 * CONFIGURAÇÕES SALVAS — o que este arquivo defende.
 *
 * A regra de valor: uma configuração que SALVA tem que CRIAR o campeonato. Se
 * as duas validações puderem divergir, o criador guarda uma tabela que só falha
 * semanas depois, na hora de usar. Por isso os testes de pontuação e divisão
 * aqui não repetem as regras — eles provam que a recusa é a MESMA.
 */

describe("id derivado do nome", () => {
  it("tira acento, caixa e pontuação", () => {
    assert.equal(presetIdFor("Squad 6 Partidas"), "squad-6-partidas");
    assert.equal(presetIdFor("Ápice — Solo!"), "apice-solo");
    assert.equal(presetIdFor("  liga   ção  "), "liga-cao");
  });

  it("o mesmo nome dá o mesmo id — é o que faz salvar SUBSTITUIR", () => {
    // Sem isto, salvar duas vezes deixa duas linhas idênticas para o criador
    // distinguir, e um toque duplo vira uma configuração duplicada.
    assert.equal(presetIdFor("Squad 6"), presetIdFor("squad 6"));
    assert.equal(presetIdFor("Squad-6"), presetIdFor("Squad 6"));
  });

  it("nome sem nada aproveitável não vira id", () => {
    // "." e ".." são ids que o Firestore recusa, e "" não endereça nada.
    for (const bad of ["", "   ", "!!!", "...", "---", "?!"]) {
      assert.equal(presetIdFor(bad), null, bad);
    }
  });

  it("nunca produz um id perigoso de caminho", () => {
    for (const hostile of [
      "../../users/admin",
      "__proto__",
      "a/b/c",
      ".",
      "..",
    ]) {
      const id = presetIdFor(hostile);
      if (id === null) continue;
      assert.equal(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id), true, hostile);
      assert.equal(id.includes("/"), false, hostile);
      assert.equal(id.startsWith("__"), false, hostile);
    }
  });

  it("corta no limite sem deixar hífen sobrando", () => {
    const id = presetIdFor("a".repeat(30) + " " + "b".repeat(30))!;
    assert.equal(id.length <= MAX_PRESET_ID_LENGTH, true);
    assert.equal(id.endsWith("-"), false);
  });
});

describe("nome", () => {
  it("aceita um nome comum", () => {
    assert.deepEqual(checkPresetName("Squad 6 partidas"), { ok: true });
  });

  it("recusa curto demais, longo demais e sem letras", () => {
    assert.equal((checkPresetName("a") as any).reason, "name-too-short");
    assert.equal(
      (checkPresetName("x".repeat(MAX_PRESET_NAME_LENGTH + 1)) as any).reason,
      "name-too-long"
    );
    assert.equal((checkPresetName("!!!") as any).reason, "name-has-no-letters");
  });

  it("recusa o que não é texto", () => {
    for (const bad of [null, undefined, 7, {}, []]) {
      assert.equal((checkPresetName(bad as unknown) as any).reason, "bad-name");
    }
  });
});

describe("id recebido do cliente", () => {
  it("aceita exatamente o alfabeto que este módulo produz", () => {
    for (const good of ["squad-6", "solo", "a1", "liga-de-verao-2026"]) {
      assert.deepEqual(checkPresetId(good), { ok: true }, good);
    }
  });

  it("recusa qualquer coisa que possa mirar outro caminho", () => {
    // Apagar recebe um id, e um id é um caminho de documento.
    for (const bad of [
      "",
      "/",
      "../users",
      "Squad-6",
      "squad_6",
      "-squad",
      "squad-",
      "squad--6",
      "a".repeat(MAX_PRESET_ID_LENGTH + 1),
      null,
      7,
    ]) {
      assert.equal((checkPresetId(bad as unknown) as any).reason, "bad-preset-id", String(bad));
    }
  });
});

describe("configuração inteira", () => {
  const base = {
    name: "Squad 6 partidas",
    matchesCount: 6,
    killPoints: 1,
    placementPoints: [12, 9, 8, 7, 6],
    prizeDistribution: [
      { position: 1, amount_centavos: 5000 },
      { position: 2, amount_centavos: 3000 },
      { position: 3, amount_centavos: 2000 },
    ],
  };

  it("normaliza e devolve exatamente o que a criação aceita", () => {
    const result = checkPreset(base);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.preset, {
      presetId: "squad-6-partidas",
      name: "Squad 6 partidas",
      matchesCount: 6,
      killPoints: 1,
      placementPoints: [12, 9, 8, 7, 6],
      prizeDistribution: [
        { position: 1, centavos: 5000 },
        { position: 2, centavos: 3000 },
        { position: 3, centavos: 2000 },
      ],
    });
  });

  it("a ausência é o formato de sempre: uma partida, sem pontos, campeão leva tudo", () => {
    const result = checkPreset({
      name: "Padrão",
      matchesCount: undefined,
      killPoints: undefined,
      placementPoints: undefined,
      prizeDistribution: undefined,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.preset.matchesCount, 1);
    assert.equal(result.preset.killPoints, 0);
    assert.deepEqual(result.preset.placementPoints, []);
    assert.equal(result.preset.prizeDistribution, null);
  });

  it("null na divisão é 'só o campeão', não uma divisão vazia", () => {
    const result = checkPreset({ ...base, prizeDistribution: null });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.preset.prizeDistribution, null);
  });

  it("recusa a pontuação com a MESMA razão da criação de campeonato", () => {
    // O ponto do teste não são os limites — é que a razão vem das funções
    // compartilhadas, então salvar e criar nunca podem discordar.
    assert.equal(
      (checkPreset({ ...base, matchesCount: 51 }) as any).reason,
      "bad-matches-count"
    );
    assert.equal(
      (checkPreset({ ...base, killPoints: -1 }) as any).reason,
      "bad-kill-points"
    );
    assert.equal(
      (checkPreset({ ...base, placementPoints: [12, 1.5] }) as any).reason,
      "bad-placement-points"
    );
  });

  it("recusa a divisão com a MESMA razão da criação de campeonato", () => {
    assert.equal(
      (
        checkPreset({
          ...base,
          prizeDistribution: [{ position: 1, amount_centavos: 0 }],
        }) as any
      ).reason,
      "bad-slice"
    );
    assert.equal(
      (
        checkPreset({
          ...base,
          prizeDistribution: [
            { position: 1, amount_centavos: 5000 },
            { position: 3, amount_centavos: 5000 },
          ],
        }) as any
      ).reason,
      "non-consecutive-positions"
    );
    assert.equal(
      (checkPreset({ ...base, prizeDistribution: [] }) as any).reason,
      "empty-distribution"
    );
    assert.equal(
      (checkPreset({ ...base, prizeDistribution: "tudo" }) as any).reason,
      "bad-slice"
    );
  });

  it("um preset NÃO exige que a soma feche — ele não tem premiação", () => {
    // A soma é conferida na criação, onde os dois números existem. Exigir aqui
    // impediria de salvar qualquer divisão, já que o campeonato ainda não
    // existe. O app fecha a brecha do outro lado: aplicar um preset põe a soma
    // das posições como premiação.
    const result = checkPreset(base);
    assert.equal(result.ok, true);
  });

  it("recusa o nome antes de olhar a pontuação", () => {
    // Ordem importa para a mensagem: quem esqueceu o nome tem que ouvir sobre
    // o nome, não sobre pontos por abate.
    assert.equal(
      (checkPreset({ ...base, name: "", matchesCount: 999 }) as any).reason,
      "name-too-short"
    );
  });
});

describe("mensagens", () => {
  it("toda recusa própria tem frase própria", () => {
    const generic = presetMessage("__inexistente__");
    for (const reason of [
      "bad-name",
      "name-too-short",
      "name-too-long",
      "name-has-no-letters",
      "bad-preset-id",
      "too-many-presets",
    ]) {
      const message = presetMessage(reason);
      assert.notEqual(message, generic, reason);
      assert.equal(message.length > 0, true, reason);
    }
  });
});
