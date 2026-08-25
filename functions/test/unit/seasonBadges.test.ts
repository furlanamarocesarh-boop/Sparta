import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  badgeForPlacement,
  isSeasonBadgeId,
  isSeasonClosed,
  MAX_SEASONS_PER_SETTLEMENT,
  nextSeasonId,
  parseSeasonBadgeId,
  placementTier,
  previousSeasonId,
  SEASON_BADGE_ECONOMY,
  SEASON_BADGE_TIERS,
  seasonBadgeId,
  seasonsToSettle,
} from "../../src/domain/seasonBadges.js";
import { FIRST_ACTIVE_SEASON_ID } from "../../src/domain/seasonRanking.js";

describe("a identidade de um selo de temporada", () => {
  it("carrega trilha, grau e MÊS", () => {
    // "Top 1" sozinho é troféu sem data. O mês é o que faz uma segunda vitória
    // em outubro ser um segundo troféu, e não um no-op.
    assert.equal(
      seasonBadgeId({ track: "player", tier: 1, seasonId: "2026-09" }),
      "season_player_top1_2026-09"
    );
    assert.equal(
      seasonBadgeId({ track: "creator", tier: 100, seasonId: "2027-01" }),
      "season_creator_top100_2027-01"
    );
  });

  it("volta inteira ao ser lida", () => {
    for (const track of ["player", "creator"] as const) {
      for (const tier of SEASON_BADGE_TIERS) {
        const id = seasonBadgeId({ track, tier, seasonId: "2026-09" });
        assert.deepEqual(parseSeasonBadgeId(id), {
          track,
          tier,
          seasonId: "2026-09",
        });
      }
    }
  });

  it("recusa construir o que não poderia ser conquistado", () => {
    assert.throws(() =>
      seasonBadgeId({ track: "player", tier: 7, seasonId: "2026-09" })
    );
    assert.throws(() =>
      seasonBadgeId({ track: "player", tier: 1, seasonId: "2026-13" })
    );
  });
});

describe("o que NÃO é selo de temporada", () => {
  it("os quinze selos fixos não são", () => {
    // A leitura é o que diz ao resto do sistema que um id FORA da tabela fixa
    // mesmo assim é real. Se ela aceitasse demais, viraria escrita na lista de
    // selos de alguém.
    for (const id of [
      "creator_verified",
      "spartan_legend",
      "partner_noobie",
    ]) {
      assert.equal(parseSeasonBadgeId(id), null, id);
      assert.equal(isSeasonBadgeId(id), false, id);
    }
  });

  it("grau que ninguém poderia ter conquistado", () => {
    for (const bad of [
      "season_player_top7_2026-09",
      "season_player_top0_2026-09",
      "season_player_top50_2026-09",
      "season_player_top1000_2026-09",
    ]) {
      assert.equal(parseSeasonBadgeId(bad), null, bad);
    }
  });

  it("uma segunda grafia do mesmo grau é recusada", () => {
    // `Number` aceitaria " 1", "1e0" e "01" — e duas grafias seriam dois ids
    // para um troféu só.
    for (const bad of [
      "season_player_top01_2026-09",
      "season_player_top1e0_2026-09",
      "season_player_top+1_2026-09",
    ]) {
      assert.equal(parseSeasonBadgeId(bad), null, bad);
    }
  });

  it("mês impossível", () => {
    for (const bad of [
      "season_player_top1_2026-13",
      "season_player_top1_2026-00",
      "season_player_top1_2026-9",
      "season_player_top1_26-09",
    ]) {
      assert.equal(parseSeasonBadgeId(bad), null, bad);
    }
  });

  it("forma errada, prefixo errado, trilha errada, lixo", () => {
    for (const bad of [
      "season_player_top1",
      "season_player_top1_2026-09_extra",
      "temporada_player_top1_2026-09",
      "season_admin_top1_2026-09",
      "season_player_first_2026-09",
      "",
      null,
      42,
      {},
    ]) {
      assert.equal(parseSeasonBadgeId(bad), null, String(bad));
    }
  });
});

describe("qual grau uma colocação ganha", () => {
  it("o MELHOR grau, e só ele", () => {
    // Segundo lugar satisfaz literalmente "top 3", "top 10" e "top 100"
    // também. Entregar quatro troféus por um resultado enterraria a conquista
    // nos próprios prêmios de consolação.
    assert.equal(placementTier(1), 1);
    assert.equal(placementTier(2), 2);
    assert.equal(placementTier(3), 3);
  });

  it("as faixas caem no teto delas", () => {
    for (const rank of [4, 7, 10]) assert.equal(placementTier(rank), 10, `${rank}`);
    for (const rank of [11, 50, 100]) assert.equal(placementTier(rank), 100, `${rank}`);
  });

  it("fora do top 100 não ganha nada", () => {
    for (const rank of [101, 500, 10_000]) {
      assert.equal(placementTier(rank), null, `${rank}`);
    }
  });

  it("colocação inutilizável não vira troféu por arredondamento", () => {
    for (const bad of [0, -1, 1.5, "1", null, undefined, Number.NaN, Infinity]) {
      assert.equal(placementTier(bad), null, String(bad));
    }
  });

  it("badgeForPlacement junta as duas pontas", () => {
    assert.equal(
      badgeForPlacement("player", "2026-09", 2),
      "season_player_top2_2026-09"
    );
    assert.equal(
      badgeForPlacement("creator", "2026-09", 42),
      "season_creator_top100_2026-09"
    );
    assert.equal(badgeForPlacement("player", "2026-09", 101), null);
    assert.equal(badgeForPlacement("player", "2026-13", 1), null);
  });
});

describe("a economia é constante, não parâmetro", () => {
  it("só dinheiro", () => {
    // Um selo de colocação é permanente e público. Conceder por liderar um
    // quadro de dinheiro de mentira gastaria o significado do troféu antes de
    // a economia real existir.
    assert.equal(SEASON_BADGE_ECONOMY, "cash");
  });
});

describe("quando uma temporada é final", () => {
  const during = new Date(Date.UTC(2026, 8, 15, 12));
  const after = new Date(Date.UTC(2026, 9, 5, 12));

  it("durante o mês NÃO é final", () => {
    // "Você é terceiro" não é fato enquanto o mês corre — é um retrato que
    // amanhã contradiz.
    assert.equal(isSeasonClosed("2026-09", during), false);
  });

  it("depois do mês é final", () => {
    assert.equal(isSeasonClosed("2026-09", after), true);
  });

  it("mês inválido nunca é final", () => {
    assert.equal(isSeasonClosed("2026-13", after), false);
  });
});

describe("vizinhança de meses", () => {
  it("atravessa a virada do ano nos dois sentidos", () => {
    assert.equal(nextSeasonId("2026-12"), "2027-01");
    assert.equal(previousSeasonId("2027-01"), "2026-12");
    assert.equal(nextSeasonId("2026-09"), "2026-10");
    assert.equal(previousSeasonId("2026-10"), "2026-09");
  });
});

describe("quais temporadas ainda devem conferência", () => {
  const first = FIRST_ACTIVE_SEASON_ID!;

  it("conta vazia começa na PRIMEIRA temporada ativa", () => {
    // Meses anteriores ao ranking não têm entradas: perguntar por eles seria
    // uma leitura que só pode responder "não", e conceder troféu por um mês
    // que nunca foi ranqueado seria inventar resultado.
    const out = seasonsToSettle({
      settledThrough: undefined,
      now: new Date(Date.UTC(2026, 10, 5)),
    });
    assert.equal(out[0], first);
  });

  it("NUNCA inclui o mês corrente", () => {
    const out = seasonsToSettle({
      settledThrough: undefined,
      now: new Date(Date.UTC(2026, 9, 15)), // meio de outubro
    });
    assert.deepEqual(out, ["2026-09"]);
  });

  it("continua de onde parou", () => {
    const out = seasonsToSettle({
      settledThrough: "2026-09",
      now: new Date(Date.UTC(2026, 11, 5)),
    });
    assert.deepEqual(out, ["2026-10", "2026-11"]);
  });

  it("em dia, não devolve nada", () => {
    assert.deepEqual(
      seasonsToSettle({
        settledThrough: "2026-10",
        now: new Date(Date.UTC(2026, 10, 15)),
      }),
      []
    );
  });

  it("um cursor corrompido cai para a primeira temporada, sem estourar", () => {
    for (const bad of [null, 42, "lixo", "2026-13", {}]) {
      const out = seasonsToSettle({
        settledThrough: bad,
        now: new Date(Date.UTC(2026, 10, 5)),
      });
      assert.equal(out[0], first, String(bad));
    }
  });

  it("um cursor ANTERIOR à primeira temporada não reabre o passado", () => {
    const out = seasonsToSettle({
      settledThrough: "2020-01",
      now: new Date(Date.UTC(2026, 10, 5)),
    });
    assert.equal(out[0], first);
  });

  it("quem sumiu por um ano não faz a chamada explodir", () => {
    // O cursor faz o resto ser liquidado na chamada seguinte, em vez de
    // perdido.
    const out = seasonsToSettle({
      settledThrough: undefined,
      now: new Date(Date.UTC(2030, 0, 5)),
    });
    assert.equal(out.length, MAX_SEASONS_PER_SETTLEMENT);
  });
});
