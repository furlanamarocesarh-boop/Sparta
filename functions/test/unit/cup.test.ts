import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bracketSizeFor,
  buildBracket,
  champion,
  checkEntrants,
  cupMessage,
  cupStandings,
  declareWinner,
  drawBracket,
  isComplete,
  MAX_CUP_ENTRANTS,
  nextMatchNumber,
  seedOrder,
  type Bracket,
} from "../../src/domain/cup.js";

/**
 * A COPA — mata-mata com chaveamento único.
 *
 * O que este arquivo defende: que o chaveamento é uma FUNÇÃO dos inscritos,
 * conferível por qualquer um; que o bye cai da semeadura em vez de ser uma
 * segunda regra; e que a classificação final tem ordem TOTAL, porque a divisão
 * da premiação paga por posição.
 */

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => `p${i + 1}`);

/** Joga a Copa inteira com o cabeça de chave melhor sempre vencendo. */
function playSeedsWin(start: Bracket): Bracket {
  let bracket = start;
  const seedOf = new Map(bracket.entrants.map((uid, i) => [uid, i]));
  let guard = 0;
  while (!isComplete(bracket) && guard < 500) {
    guard += 1;
    const ready = bracket.matches.find(
      (m) => m.winner === null && m.home !== null && m.away !== null
    );
    if (ready === undefined) break;
    const winner =
      (seedOf.get(ready.home!) ?? 0) <= (seedOf.get(ready.away!) ?? 0)
        ? ready.home!
        : ready.away!;
    const out = declareWinner(bracket, ready.matchNumber, winner);
    assert.equal(out.ok, true, `recusou o confronto ${ready.matchNumber}`);
    if (out.ok) bracket = out.bracket;
  }
  return bracket;
}

describe("o tamanho do chaveamento", () => {
  it("é a menor potência de dois que comporta os inscritos", () => {
    assert.equal(bracketSizeFor(2), 2);
    assert.equal(bracketSizeFor(3), 4);
    assert.equal(bracketSizeFor(4), 4);
    assert.equal(bracketSizeFor(5), 8);
    assert.equal(bracketSizeFor(12), 16);
    assert.equal(bracketSizeFor(16), 16);
    assert.equal(bracketSizeFor(33), 64);
  });
});

describe("a semeadura clássica", () => {
  it("o cabeça 1 e o cabeça 2 só se encontram na final", () => {
    assert.deepEqual(seedOrder(2), [1, 2]);
    assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("todo par soma o mesmo — é isso que a torna balanceada", () => {
    for (const size of [4, 8, 16, 32]) {
      const order = seedOrder(size);
      assert.equal(order.length, size, `tamanho ${size}`);
      assert.deepEqual([...order].sort((a, b) => a - b), players(size).map((_, i) => i + 1));
      for (let i = 0; i < size; i += 2) {
        assert.equal(order[i] + order[i + 1], size + 1, `par ${i} de ${size}`);
      }
    }
  });
});

describe("o sorteio", () => {
  it("um chaveamento cheio não tem bye nenhum", () => {
    const bracket = drawBracket(players(8));
    assert.equal(bracket.size, 8);
    assert.equal(bracket.rounds, 3);
    assert.equal(bracket.matches.filter((m) => m.bye).length, 0);
    // 4 + 2 + 1 confrontos.
    assert.equal(bracket.matches.length, 7);
  });

  it("O BYE VAI PARA OS PRIMEIROS INSCRITOS, e cai sozinho da semeadura", () => {
    // Doze equipes num chaveamento de dezesseis: quatro passam direto, e são
    // justamente as quatro primeiras a se inscrever.
    const bracket = drawBracket(players(12));
    assert.equal(bracket.size, 16);

    const byes = bracket.matches.filter((m) => m.bye);
    assert.equal(byes.length, 4);
    assert.deepEqual(
      byes.map((m) => m.winner).sort(),
      ["p1", "p2", "p3", "p4"].sort()
    );
  });

  it("quem ganhou bye JÁ ESTÁ na segunda rodada", () => {
    // Sem isto, o operador teria que lançar o resultado de um jogo que não
    // aconteceu para o chaveamento andar.
    const bracket = drawBracket(players(12));
    const second = bracket.matches.filter((m) => m.round === 2);
    const placed = second.flatMap((m) => [m.home, m.away]).filter(Boolean);
    for (const seed of ["p1", "p2", "p3", "p4"]) {
      assert.equal(placed.includes(seed), true, seed);
    }
  });

  it("NENHUM confronto nasce sem ninguém, em tamanho nenhum", () => {
    // É a propriedade que garante que um bye nunca promove para outro bye.
    for (let n = 2; n <= MAX_CUP_ENTRANTS; n += 1) {
      const bracket = drawBracket(players(n));
      const first = bracket.matches.filter((m) => m.round === 1);
      for (const match of first) {
        assert.equal(
          match.home !== null || match.away !== null,
          true,
          `${n} inscritos, confronto ${match.matchNumber}`
        );
      }
    }
  });

  it("todo inscrito aparece EXATAMENTE uma vez na primeira rodada", () => {
    for (const n of [2, 3, 5, 7, 12, 13, 31, 64]) {
      const bracket = drawBracket(players(n));
      const sides = bracket.matches
        .filter((m) => m.round === 1)
        .flatMap((m) => [m.home, m.away])
        .filter((s): s is string => s !== null);
      assert.deepEqual(sides.sort(), players(n).sort(), `${n} inscritos`);
    }
  });

  it("as rodadas seguintes existem desde o sorteio", () => {
    // O jogador precisa ver o caminho inteiro no dia do sorteio, não descobrir
    // a semifinal quando ela aparecer.
    const bracket = drawBracket(players(8));
    assert.deepEqual(
      [1, 2, 3].map((r) => bracket.matches.filter((m) => m.round === r).length),
      [4, 2, 1]
    );
  });

  it("uma lista impossível não vira chaveamento", () => {
    assert.equal(buildBracket([]).matches.length, 0);
    assert.equal(buildBracket(["so-um"]).matches.length, 0);
    assert.equal(buildBracket(players(MAX_CUP_ENTRANTS + 1)).matches.length, 0);
    assert.equal(buildBracket(["a", "a"]).matches.length, 0);
  });
});

describe("a lista de inscritos", () => {
  it("recusa pouca gente, gente demais, repetido e vazio", () => {
    assert.equal((checkEntrants([]) as any).reason, "too-few");
    assert.equal((checkEntrants(["a"]) as any).reason, "too-few");
    assert.equal(
      (checkEntrants(players(MAX_CUP_ENTRANTS + 1)) as any).reason,
      "too-many"
    );
    assert.equal((checkEntrants(["a", "a"]) as any).reason, "duplicate-entrant");
    assert.equal((checkEntrants(["a", ""]) as any).reason, "bad-entrant");
    assert.equal((checkEntrants(["a", 7 as unknown]) as any).reason, "bad-entrant");
  });
});

describe("lançando um resultado", () => {
  it("o vencedor sobe para o confronto certo", () => {
    const bracket = drawBracket(players(4));
    // seedOrder(4) = [1,4,2,3] -> confronto 1: p1 x p4, confronto 2: p2 x p3.
    const out = declareWinner(bracket, 1, "p4");
    assert.equal(out.ok, true);
    if (!out.ok) return;

    const final = out.bracket.matches.find((m) => m.round === 2)!;
    assert.equal(final.home, "p4");
    assert.equal(final.away, null);
  });

  it("o lado ímpar entra em casa e o par entra fora", () => {
    // É o que mantém a chave legível de cima para baixo.
    let bracket = drawBracket(players(4));
    bracket = (declareWinner(bracket, 1, "p1") as any).bracket;
    bracket = (declareWinner(bracket, 2, "p3") as any).bracket;
    const final = bracket.matches.find((m) => m.round === 2)!;
    assert.equal(final.home, "p1");
    assert.equal(final.away, "p3");
  });

  it("NADA é mutado — o chaveamento anterior continua o que era", () => {
    // Um resultado aplicado pela metade é um estado que ninguém conserta.
    const before = drawBracket(players(4));
    const snapshot = JSON.stringify(before);
    declareWinner(before, 1, "p1");
    assert.equal(JSON.stringify(before), snapshot);
  });

  it("recusa quem não está no confronto", () => {
    const bracket = drawBracket(players(4));
    assert.equal((declareWinner(bracket, 1, "p2") as any).reason, "not-a-side");
    assert.equal(
      (declareWinner(bracket, 1, "estranho") as any).reason,
      "not-a-side"
    );
  });

  it("recusa confronto inexistente, bye, e rodada ainda sem os dois lados", () => {
    const bracket = drawBracket(players(12));
    assert.equal(
      (declareWinner(bracket, 999, "p1") as any).reason,
      "match-not-found"
    );
    const bye = bracket.matches.find((m) => m.bye)!;
    assert.equal(
      (declareWinner(bracket, bye.matchNumber, bye.winner!) as any).reason,
      "bye-match"
    );
    const pending = bracket.matches.find(
      (m) => m.round === 2 && (m.home === null || m.away === null)
    )!;
    assert.equal(
      (declareWinner(bracket, pending.matchNumber, "p1") as any).reason,
      "match-not-ready"
    );
  });

  it("RELANÇAR é recusado", () => {
    // Corrigir depois que o vencedor já jogou a rodada seguinte não é
    // corrigir: é reescrever o torneio a partir dali.
    const bracket = drawBracket(players(4));
    const first = (declareWinner(bracket, 1, "p1") as any).bracket;
    assert.equal(
      (declareWinner(first, 1, "p4") as any).reason,
      "already-decided"
    );
  });
});

describe("a Copa inteira", () => {
  it("acaba com um campeão, em todo tamanho de 2 a 64", () => {
    for (let n = 2; n <= MAX_CUP_ENTRANTS; n += 1) {
      const played = playSeedsWin(drawBracket(players(n)));
      assert.equal(isComplete(played), true, `${n} inscritos ficou pela metade`);
      assert.equal(champion(played), "p1", `${n} inscritos`);
    }
  });

  it("a classificação lista TODO MUNDO, uma vez só", () => {
    // A divisão da premiação paga por posição: uma lista com buraco pagaria
    // errado, e uma com repetido pagaria duas vezes.
    for (const n of [2, 3, 5, 12, 16, 33]) {
      const played = playSeedsWin(drawBracket(players(n)));
      const table = cupStandings(played);
      assert.equal(table.length, n, `${n} inscritos`);
      assert.equal(new Set(table).size, n, `${n} inscritos tem repetido`);
    }
  });

  it("quem perdeu MAIS TARDE fica na frente", () => {
    const played = playSeedsWin(drawBracket(players(8)));
    const table = cupStandings(played);
    // Cabeças vencendo sempre: 1 campeão, 2 vice, 3 e 4 semifinalistas.
    assert.equal(table[0], "p1");
    assert.equal(table[1], "p2");
    assert.deepEqual(table.slice(2, 4).sort(), ["p3", "p4"]);
    assert.deepEqual(table.slice(4).sort(), ["p5", "p6", "p7", "p8"]);
  });

  it("o azarão que ganha a final é o primeiro da lista", () => {
    // A classificação sai do que ACONTECEU, não da semeadura.
    let bracket = drawBracket(players(4));
    bracket = (declareWinner(bracket, 1, "p4") as any).bracket;
    bracket = (declareWinner(bracket, 2, "p3") as any).bracket;
    const final = bracket.matches.find((m) => m.round === 2)!;
    bracket = (declareWinner(bracket, final.matchNumber, "p4") as any).bracket;

    const table = cupStandings(bracket);
    assert.equal(table[0], "p4");
    assert.equal(table[1], "p3");
    assert.deepEqual(table.slice(2).sort(), ["p1", "p2"]);
  });

  it("empate de verdade desempata pela ORDEM DE INSCRIÇÃO", () => {
    // Dois semifinalistas empatam num mata-mata. Se a divisão paga 3º e 4º
    // diferente, alguém tem que ser o 3º — e a régua é a mesma que semeou.
    const played = playSeedsWin(drawBracket(players(8)));
    const table = cupStandings(played);
    assert.equal(table[2], "p3");
    assert.equal(table[3], "p4");
  });

  it("no meio da Copa, quem ainda está vivo fica à frente de quem caiu", () => {
    const bracket = drawBracket(players(4));
    const after = (declareWinner(bracket, 1, "p1") as any).bracket;
    const table = cupStandings(after);
    assert.equal(table.includes("p4"), true);
    // p4 caiu na rodada 1; p2 e p3 ainda vão jogar a rodada 1 e p1 já está na 2.
    assert.equal(table[0], "p1");
    assert.equal(table[table.length - 1], "p4");
  });

  it("antes de qualquer resultado não há campeão", () => {
    assert.equal(champion(drawBracket(players(8))), null);
    assert.equal(isComplete(drawBracket(players(8))), false);
  });
});

describe("por onde o vencedor sobe", () => {
  it("dois confrontos alimentam um", () => {
    const bracket = drawBracket(players(8));
    const [m1, m2] = bracket.matches.filter((m) => m.round === 1);
    assert.equal(nextMatchNumber(bracket, m1), nextMatchNumber(bracket, m2));
  });

  it("a final não sobe para lugar nenhum", () => {
    const bracket = drawBracket(players(8));
    const final = bracket.matches.find((m) => m.round === bracket.rounds)!;
    assert.equal(nextMatchNumber(bracket, final), null);
  });
});

describe("as mensagens", () => {
  it("toda recusa tem frase própria", () => {
    const generic = cupMessage("__inexistente__");
    for (const reason of [
      "too-few",
      "too-many",
      "duplicate-entrant",
      "bad-entrant",
      "match-not-found",
      "not-a-side",
      "match-not-ready",
      "bye-match",
      "already-decided",
    ]) {
      assert.notEqual(cupMessage(reason), generic, reason);
    }
  });
});
