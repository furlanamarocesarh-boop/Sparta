import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkPointsConfig,
  checkPrizeDistribution,
  checkPrizeSlices,
  computeStandings,
  MAX_MATCHES,
  placementPointsFor,
  splitPrize,
  totalDistributed,
  type MatchResult,
  type PointsConfig,
  type PrizeSlice,
} from "../../src/domain/matchPoints.js";

/** Formato comum de Battle Royale: 1 ponto por abate, top 5 pontuam. */
const CONFIG: PointsConfig = {
  killPoints: 1,
  placementPoints: [12, 9, 8, 7, 6],
};

/** A recusa de uma checagem, ou null quando ela passou. */
const refusal = (check: { ok: boolean } & { reason?: string }) =>
  check.ok ? null : (check as { reason: string }).reason;

const match = (n: number, entries: [string, number, number][]): MatchResult => ({
  matchNumber: n,
  entries: entries.map(([uid, kills, placement]) => ({ uid, kills, placement })),
});

describe("quanto vale uma colocação", () => {
  it("a tabela é lida pela posição, 1-based", () => {
    assert.equal(placementPointsFor(CONFIG, 1), 12);
    assert.equal(placementPointsFor(CONFIG, 5), 6);
  });

  it("posição fora da tabela vale ZERO, não erro", () => {
    // Toda tabela real é mais curta que o lobby: só os primeiros pontuam.
    assert.equal(placementPointsFor(CONFIG, 6), 0);
    assert.equal(placementPointsFor(CONFIG, 50), 0);
  });

  it("colocação inutilizável vale zero", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.equal(placementPointsFor(CONFIG, bad), 0, String(bad));
    }
  });
});

describe("somando as partidas", () => {
  it("pontos de abate e de colocação somam entre partidas", () => {
    const standings = computeStandings(CONFIG, [
      match(1, [["ana", 3, 1]]), // 3 + 12 = 15
      match(2, [["ana", 1, 4]]), // 1 + 7  = 8
    ]);
    assert.equal(standings[0].points, 23);
    assert.equal(standings[0].kills, 4);
    assert.equal(standings[0].matchesPlayed, 2);
    assert.equal(standings[0].bestPlacement, 1);
  });

  it("quem venceu a última NÃO vence o campeonato", () => {
    // A razão de o sistema existir: o campeão é quem somou mais, não quem
    // ganhou por último.
    const standings = computeStandings(CONFIG, [
      match(1, [["ana", 8, 2], ["bruno", 0, 30]]), // ana 8+9=17
      match(2, [["ana", 0, 20], ["bruno", 2, 1]]), // bruno 2+12=14
    ]);
    assert.equal(standings[0].uid, "ana");
  });

  it("faltar a uma partida é resultado, não ausência", () => {
    // Comparecer a quatro de seis partidas rende o que rendeu.
    const standings = computeStandings(CONFIG, [
      match(1, [["ana", 1, 1], ["bruno", 0, 2]]),
      match(2, [["ana", 1, 1]]),
    ]);
    const bruno = standings.find((s) => s.uid === "bruno")!;
    assert.equal(bruno.matchesPlayed, 1);
    assert.equal(bruno.points, 9);
  });

  it("uma correção do operador SOMA, não substitui", () => {
    // O mesmo uid duas vezes na mesma partida é alguém corrigindo; recusar
    // aqui deixaria o operador sem jeito de consertar um erro de digitação.
    const standings = computeStandings(CONFIG, [
      match(1, [["ana", 1, 3], ["ana", 2, 0]]),
    ]);
    assert.equal(standings[0].kills, 3);
  });

  it("um campeonato de UMA partida é um campeonato normal", () => {
    const standings = computeStandings(CONFIG, [match(1, [["ana", 5, 1]])]);
    assert.equal(standings[0].points, 17);
  });
});

describe("o desempate é total e determinístico", () => {
  it("mais pontos primeiro", () => {
    const s = computeStandings(CONFIG, [
      match(1, [["a", 0, 2], ["b", 0, 1]]),
    ]);
    assert.deepEqual(s.map((x) => x.uid), ["b", "a"]);
  });

  it("empatou em pontos: mais abates", () => {
    const config: PointsConfig = { killPoints: 0, placementPoints: [10, 10] };
    const s = computeStandings(config, [
      match(1, [["a", 1, 1], ["b", 5, 2]]),
    ]);
    assert.deepEqual(s.map((x) => x.uid), ["b", "a"]);
  });

  it("empatou nos dois: melhor colocação de uma partida", () => {
    const config: PointsConfig = { killPoints: 1, placementPoints: [] };
    const s = computeStandings(config, [
      match(1, [["a", 2, 9], ["b", 2, 2]]),
    ]);
    assert.deepEqual(s.map((x) => x.uid), ["b", "a"]);
  });

  it("idênticos em tudo: a ordem AINDA é estável", () => {
    // Sem ordem total, os mesmos resultados poderiam classificar de dois
    // jeitos em duas leituras — e um deles seria pago.
    const config: PointsConfig = { killPoints: 1, placementPoints: [] };
    const once = computeStandings(config, [match(1, [["zeta", 1, 1], ["alfa", 1, 1]])]);
    const twice = computeStandings(config, [match(1, [["alfa", 1, 1], ["zeta", 1, 1]])]);
    assert.deepEqual(once.map((s) => s.uid), ["alfa", "zeta"]);
    assert.deepEqual(once.map((s) => s.uid), twice.map((s) => s.uid));
  });

  it("quem nunca se colocou perde para quem se colocou", () => {
    const config: PointsConfig = { killPoints: 1, placementPoints: [] };
    const s = computeStandings(config, [
      match(1, [["a", 1, 0], ["b", 1, 40]]),
    ]);
    assert.deepEqual(s.map((x) => x.uid), ["b", "a"]);
  });
});

describe("a configuração é recusada quando não fecha", () => {
  it("aceita o comum", () => {
    assert.deepEqual(checkPointsConfig(6, CONFIG), { ok: true });
    assert.deepEqual(checkPointsConfig(1, CONFIG), { ok: true });
  });

  it("zero partidas não é campeonato", () => {
    for (const bad of [0, -1, 1.5, "6", null, MAX_MATCHES + 1]) {
      assert.equal(checkPointsConfig(bad, CONFIG).ok, false, String(bad));
    }
  });

  it("pontuação só por colocação é legítima", () => {
    assert.deepEqual(
      checkPointsConfig(3, { killPoints: 0, placementPoints: [10] }),
      { ok: true }
    );
  });

  it("ponto quebrado ou negativo é recusado", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.equal(
        checkPointsConfig(3, { killPoints: bad, placementPoints: [] }).ok,
        false,
        String(bad)
      );
      assert.equal(
        checkPointsConfig(3, { killPoints: 1, placementPoints: [bad] }).ok,
        false,
        String(bad)
      );
    }
  });
});

describe("a divisão do prêmio é do criador, e tem que fechar", () => {
  // R$ 1.000,00 repartidos em 500 / 300 / 200.
  const split3: PrizeSlice[] = [
    { position: 1, centavos: 50_000 },
    { position: 2, centavos: 30_000 },
    { position: 3, centavos: 20_000 },
  ];

  it("aceita uma divisão que soma exatamente a premiação", () => {
    assert.deepEqual(checkPrizeDistribution(split3, 100_000), { ok: true });
  });

  it("vencedor único é uma divisão de uma fatia", () => {
    assert.deepEqual(
      checkPrizeDistribution([{ position: 1, centavos: 100_000 }], 100_000),
      { ok: true }
    );
  });

  it("RECUSA se a soma não bater com a premiação, para menos ou para mais", () => {
    // Para menos deixaria dinheiro parado sem regra nenhuma dizendo para onde
    // ele vai; para mais prometeria dinheiro que o campeonato não arrecadou.
    assert.equal(refusal(checkPrizeDistribution(split3, 100_001)), "must-total-prize");
    assert.equal(refusal(checkPrizeDistribution(split3, 99_999)), "must-total-prize");
    assert.equal(refusal(checkPrizeDistribution(split3, 0)), "must-total-prize");
  });

  it("UM CENTAVO de diferença já recusa", () => {
    // É o ponto de guardar valor em vez de percentual: não existe "quase".
    const off: PrizeSlice[] = [
      { position: 1, centavos: 3_333 },
      { position: 2, centavos: 3_333 },
      { position: 3, centavos: 3_333 },
    ];
    assert.equal(refusal(checkPrizeDistribution(off, 10_000)), "must-total-prize");
    assert.deepEqual(
      checkPrizeDistribution(
        [
          { position: 1, centavos: 3_334 },
          { position: 2, centavos: 3_333 },
          { position: 3, centavos: 3_333 },
        ],
        10_000
      ),
      { ok: true }
    );
  });

  it("A FORMA é checada antes da soma", () => {
    // "esta linha é impossível" é mais útil do que "o total não fecha" quando
    // o erro está numa linha só.
    assert.equal(
      refusal(checkPrizeDistribution([{ position: 1, centavos: 0 }], 0)),
      "bad-slice"
    );
    assert.equal(
      refusal(
        checkPrizeDistribution([{ position: 1, centavos: 1.5 }], 100)
      ),
      "bad-slice"
    );
  });

  it("RECUSA posições com buraco", () => {
    // Pagar 1º e 3º sem 2º não é divisão que alguém configura de propósito —
    // é erro de digitação, e o jogador descobriria não sendo pago.
    assert.equal(
      refusal(
        checkPrizeDistribution(
          [
            { position: 1, centavos: 50_000 },
            { position: 3, centavos: 50_000 },
          ],
          100_000
        )
      ),
      "non-consecutive-positions"
    );
  });

  it("recusa posição repetida, fatia zerada e lista vazia", () => {
    assert.equal(
      refusal(
        checkPrizeDistribution(
          [
            { position: 1, centavos: 50_000 },
            { position: 1, centavos: 50_000 },
          ],
          100_000
        )
      ),
      "duplicate-position"
    );
    assert.equal(
      refusal(checkPrizeDistribution([{ position: 1, centavos: 0 }], 0)),
      "bad-slice"
    );
    assert.equal(refusal(checkPrizeDistribution([], 0)), "empty-distribution");
  });

  it("a FORMA sozinha não exige premiação — é o que um preset consegue conferir", () => {
    // Um formato salvo carrega valores e nenhum campeonato; exigir a soma aqui
    // impediria de salvar qualquer divisão.
    assert.deepEqual(checkPrizeSlices(split3), { ok: true });
    assert.equal(refusal(checkPrizeSlices([])), "empty-distribution");
    assert.equal(totalDistributed(split3), 100_000);
  });
});

describe("dividindo o prêmio", () => {
  const split3: PrizeSlice[] = [
    { position: 1, centavos: 50_000 },
    { position: 2, centavos: 30_000 },
    { position: 3, centavos: 20_000 },
  ];
  const podium = computeStandings(CONFIG, [
    match(1, [["ouro", 10, 1], ["prata", 5, 2], ["bronze", 1, 3]]),
  ]);

  it("cada posição recebe EXATAMENTE o que foi configurado", () => {
    const out = splitPrize(100_000, split3, podium);
    assert.deepEqual(
      out.awards.map((a) => [a.uid, a.centavos]),
      [["ouro", 50_000], ["prata", 30_000], ["bronze", 20_000]]
    );
  });

  it("O TOTAL PAGO É EXATAMENTE O PRÊMIO, sempre", () => {
    assert.equal(
      splitPrize(100_000, split3, podium).paidCentavos +
        splitPrize(100_000, split3, podium).unclaimedCentavos,
      100_000
    );
  });

  it("uma divisão igual em três é paga igual — sem sobra para ninguém", () => {
    // O caso que motivou trocar percentual por valor: em pontos-base, R$ 1,00
    // três vezes virava 3333 bps três vezes, que dá 9999, e o centavo que
    // faltava ia para o primeiro lugar. Quem digitou três valores iguais via o
    // campeão receber mais.
    const equal: PrizeSlice[] = [
      { position: 1, centavos: 100 },
      { position: 2, centavos: 100 },
      { position: 3, centavos: 100 },
    ];
    const out = splitPrize(300, equal, podium);
    assert.deepEqual(out.awards.map((a) => a.centavos), [100, 100, 100]);
    assert.equal(out.paidCentavos, 300);
  });

  it("posição sem jogador NÃO é redistribuída", () => {
    // Menos jogadores do que posições pagantes é situação do operador. Mover
    // em silêncio o dinheiro do terceiro para o primeiro pagaria a alguém um
    // valor que ninguém configurou.
    const soloOnly = computeStandings(CONFIG, [match(1, [["ouro", 1, 1]])]);
    const out = splitPrize(100_000, split3, soloOnly);
    assert.equal(out.awards.length, 1);
    assert.equal(out.paidCentavos, 50_000);
    assert.equal(out.unclaimedCentavos, 50_000);
  });

  it("ninguém jogou: nada é pago, e o prêmio inteiro fica sem dono", () => {
    const out = splitPrize(100_000, split3, []);
    assert.equal(out.paidCentavos, 0);
    assert.equal(out.unclaimedCentavos, 100_000);
  });

  it("uma divisão que não fecha com o prêmio não paga NADA", () => {
    // Falha fechada: dividir com regra quebrada é a forma de pagar errado.
    const out = splitPrize(100_000, [{ position: 1, centavos: 90_000 }], podium);
    assert.deepEqual(out.awards, []);
    assert.equal(out.paidCentavos, 0);
  });

  it("prêmio inutilizável não paga NADA", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      assert.equal(splitPrize(bad as number, split3, podium).paidCentavos, 0);
    }
  });
});
