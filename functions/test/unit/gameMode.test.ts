import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BATTLE_ROYALE_LOBBY,
  CUP_TEAM_SIZES,
  cupSpec,
  MAX_CUP_TEAMS,
  resolveGameMode,
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
  it("são exatamente seis, com as chaves que o cliente manda", () => {
    assert.deepEqual(GAME_MODES.map((m) => m.key), [
      "solo",
      "duo",
      "squad",
      "2v2",
      "4v4",
      "copa",
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

describe("Copa — o criador escolhe o tamanho da equipe", () => {
  it("aceita 1, 2 e 4, e nada mais", () => {
    for (const size of CUP_TEAM_SIZES) {
      assert.equal(cupSpec(size)!.teamSize, size);
    }
    for (const bad of [0, 3, 5, 8, -1, 1.5]) {
      assert.equal(cupSpec(bad), null, String(bad));
    }
  });

  it("o rótulo diz o formato do confronto", () => {
    assert.equal(cupSpec(1)!.label, "Copa");
    assert.equal(cupSpec(2)!.label, "Copa 2v2");
    assert.equal(cupSpec(4)!.label, "Copa 4v4");
  });

  it("NÃO é um lobby: o teto é o chaveamento, não a sala", () => {
    // Os confrontos são jogados separadamente, então 48 não tem nada a ver.
    assert.equal(cupSpec(1)!.maxPlayers, MAX_CUP_TEAMS);
    assert.equal(cupSpec(4)!.maxPlayers, MAX_CUP_TEAMS * 4);
    assert.equal(checkPlayerCount(cupSpec(4)!, 256).ok, true);
    assert.equal(
      refusal(checkPlayerCount(cupSpec(4)!, 260)),
      "above-maximum"
    );
  });

  it("equipe pela metade continua recusada", () => {
    assert.equal(refusal(checkPlayerCount(cupSpec(2)!, 7)), "partial-team");
    assert.equal(checkPlayerCount(cupSpec(2)!, 8).ok, true);
  });

  it("duas equipes é o mínimo", () => {
    assert.equal(refusal(checkPlayerCount(cupSpec(4)!, 4)), "below-minimum");
    assert.equal(checkPlayerCount(cupSpec(4)!, 8).ok, true);
  });

  it("qualquer número de equipes serve — o bye resolve o resto", () => {
    // É a diferença para o lobby: 12, 20, 33 equipes são chaveamentos legítimos.
    for (const teams of [2, 3, 5, 12, 20, 33, 64]) {
      assert.equal(
        checkPlayerCount(cupSpec(2)!, teams * 2).ok,
        true,
        `${teams} equipes`
      );
    }
  });
});

describe("o tamanho da equipe vindo do cliente", () => {
  it("só a Copa lê — nos outros ele é consequência do modo", () => {
    assert.equal(resolveGameMode("squad", undefined)!.teamSize, 4);
    assert.equal(resolveGameMode("squad", 4)!.teamSize, 4);
    assert.equal(resolveGameMode("copa", 4)!.teamSize, 4);
    assert.equal(resolveGameMode("copa", undefined)!.teamSize, 1);
  });

  it("um tamanho que CONTRADIZ o modo é recusado, não ignorado", () => {
    // Aceitar em silêncio gravaria um torneio cujo team_size discorda do modo.
    assert.equal(resolveGameMode("squad", 2), null);
    assert.equal(resolveGameMode("2v2", 4), null);
  });

  it("um tamanho impossível de Copa é recusado", () => {
    assert.equal(resolveGameMode("copa", 3), null);
    assert.equal(resolveGameMode("copa", 0), null);
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
