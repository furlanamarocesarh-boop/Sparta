import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BATTLE_ROYALE_LOBBY,
  capacityMessage,
  capacitySummary,
  checkPlayerCount,
  GAME_MODES,
  gameModeSpec,
  teamsFor,
  type CapacityRefusal,
} from "../../src/domain/gameMode.js";

/**
 * QUANTA GENTE CABE EM CADA MODO.
 *
 * O modo não é rótulo: ele decide como o lobby é jogado. Produção tem torneios
 * criados como 2v2 com cinquenta vagas — não são 2v2 grandes, são torneios que
 * não têm como ser jogados. Este arquivo é o que passa a impedir isso.
 */

const spec = (key: string) => gameModeSpec(key)!;
const refusal = (check: ReturnType<typeof checkPlayerCount>): CapacityRefusal =>
  check.ok ? ("nenhuma" as CapacityRefusal) : check.reason;

describe("os modos que existem", () => {
  it("são exatamente cinco, com as chaves que o cliente manda", () => {
    assert.deepEqual(GAME_MODES.map((m) => m.key), [
      "solo",
      "duo",
      "squad",
      "2v2",
      "4v4",
    ]);
  });

  it("aceita a chave como o formulário a normaliza", () => {
    assert.equal(spec("SQUAD").key, "squad");
    assert.equal(spec(" 2v2 ").key, "2v2");
    assert.equal(spec("2 v 2").key, "2v2");
  });

  it("o que não é modo não vira modo", () => {
    for (const bad of ["", "trio", "5v5", "battle", null, 7, {}]) {
      assert.equal(gameModeSpec(bad as unknown), null, String(bad));
    }
  });
});

describe("battle royale — o lobby de 48", () => {
  it("squad são 12 equipes de 4", () => {
    const squad = spec("squad");
    const check = checkPlayerCount(squad, 48);
    assert.equal(check.ok, true);
    if (check.ok) assert.equal(check.teams, 12);
    assert.equal(capacitySummary(squad, 48), "12 equipes de 4");
  });

  it("duo são 24 equipes de 2", () => {
    const duo = spec("duo");
    const check = checkPlayerCount(duo, 48);
    assert.equal(check.ok, true);
    if (check.ok) assert.equal(check.teams, 24);
    assert.equal(capacitySummary(duo, 48), "24 equipes de 2");
  });

  it("solo são 48 jogadores", () => {
    assert.equal(checkPlayerCount(spec("solo"), 48).ok, true);
    assert.equal(capacitySummary(spec("solo"), 48), "48 jogadores");
  });

  it("os três compartilham o MESMO teto — é o que o jogo senta", () => {
    for (const key of ["solo", "duo", "squad"]) {
      assert.equal(spec(key).maxPlayers, BATTLE_ROYALE_LOBBY, key);
      assert.equal(refusal(checkPlayerCount(spec(key), 49)), "above-maximum", key);
    }
  });

  it("menos que o lobby cheio é normal", () => {
    // Um campeonato de 12 squads é o formato; um de 4 também.
    assert.equal(checkPlayerCount(spec("squad"), 16).ok, true);
    assert.equal(checkPlayerCount(spec("duo"), 10).ok, true);
    assert.equal(checkPlayerCount(spec("solo"), 2).ok, true);
  });

  it("EQUIPE PELA METADE é recusada", () => {
    // 23 num lobby de duo são onze duplas e uma pessoa sem parceiro. Quem
    // descobre isso é o jogador que ficou de fora.
    assert.equal(refusal(checkPlayerCount(spec("duo"), 23)), "partial-team");
    assert.equal(refusal(checkPlayerCount(spec("squad"), 10)), "partial-team");
    assert.equal(refusal(checkPlayerCount(spec("squad"), 47)), "partial-team");
    // Em solo toda contagem é inteira: a equipe é uma pessoa.
    assert.equal(checkPlayerCount(spec("solo"), 23).ok, true);
  });

  it("menos de DUAS equipes não é disputa", () => {
    assert.equal(refusal(checkPlayerCount(spec("squad"), 4)), "below-minimum");
    assert.equal(refusal(checkPlayerCount(spec("duo"), 2)), "below-minimum");
    assert.equal(refusal(checkPlayerCount(spec("solo"), 1)), "below-minimum");
    // E duas equipes exatas passam.
    assert.equal(checkPlayerCount(spec("squad"), 8).ok, true);
  });
});

describe("versus — dois times, e só", () => {
  it("2v2 são exatamente 4 jogadores", () => {
    const mode = spec("2v2");
    assert.equal(mode.minPlayers, 4);
    assert.equal(mode.maxPlayers, 4);
    assert.equal(checkPlayerCount(mode, 4).ok, true);
    assert.equal(capacitySummary(mode, 4), "2 equipes de 2");
  });

  it("4v4 são exatamente 8 jogadores", () => {
    const mode = spec("4v4");
    assert.equal(checkPlayerCount(mode, 8).ok, true);
    assert.equal(capacitySummary(mode, 8), "2 equipes de 4");
  });

  it("QUALQUER outro número é recusado — para mais e para menos", () => {
    for (const n of [1, 2, 3, 5, 6, 8, 16, 48, 50]) {
      assert.equal(refusal(checkPlayerCount(spec("2v2"), n)), "fixed-count", `2v2 com ${n}`);
    }
    for (const n of [4, 6, 7, 9, 12, 50]) {
      assert.equal(refusal(checkPlayerCount(spec("4v4"), n)), "fixed-count", `4v4 com ${n}`);
    }
  });

  it("a recusa da contagem fixa tem razão PRÓPRIA", () => {
    // Dizer "acima do máximo" para um 2v2 com cinco sugere que quatro é um
    // teto que dava para escolher abaixo, quando quatro é o único número.
    assert.notEqual(refusal(checkPlayerCount(spec("2v2"), 5)), "above-maximum");
    assert.notEqual(refusal(checkPlayerCount(spec("2v2"), 3)), "below-minimum");
  });
});

describe("números impossíveis", () => {
  it("nada que não seja inteiro positivo passa", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "8", null, undefined]) {
      assert.equal(
        refusal(checkPlayerCount(spec("solo"), bad as unknown)),
        "bad-number",
        String(bad)
      );
    }
  });
});

describe("as mensagens", () => {
  it("cada recusa diz o NÚMERO que resolve", () => {
    assert.match(capacityMessage(spec("2v2"), "fixed-count"), /4 jogadores/);
    assert.match(capacityMessage(spec("squad"), "above-maximum"), /48/);
    assert.match(capacityMessage(spec("squad"), "above-maximum"), /12 equipes de 4/);
    assert.match(capacityMessage(spec("duo"), "partial-team"), /múltiplo de 2/);
    assert.match(capacityMessage(spec("squad"), "below-minimum"), /8 jogadores/);
  });

  it("nenhuma mensagem sai vazia ou genérica por acidente", () => {
    const generic = capacityMessage(spec("solo"), "bad-number");
    for (const mode of GAME_MODES) {
      for (const reason of [
        "below-minimum",
        "above-maximum",
        "partial-team",
        "fixed-count",
      ] as CapacityRefusal[]) {
        const message = capacityMessage(mode, reason);
        assert.equal(message.length > 0, true);
        assert.notEqual(message, generic, `${mode.key}/${reason}`);
      }
    }
  });
});

describe("contagem de equipes", () => {
  it("conta só equipes CHEIAS", () => {
    assert.equal(teamsFor(spec("squad"), 48), 12);
    assert.equal(teamsFor(spec("squad"), 10), 2);
    assert.equal(teamsFor(spec("solo"), 7), 7);
  });
});
