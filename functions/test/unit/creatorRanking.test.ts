import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CREATOR_LEADERBOARD_PAGE_SIZE,
  decideCreatorAccrual,
  economyOfEntryFee,
  projectCreatorRow,
} from "../../src/domain/creatorRanking.js";

/** Uma inscrição paga por outra pessoa num campeonato em Créditos Beta. */
function fee(overrides: Record<string, unknown> = {}) {
  return {
    category: "beta_entry_fee",
    amount: -10,
    creatorUid: "criador-1",
    tournamentEconomy: "beta_credit",
    payerUid: "jogador-1",
    ...overrides,
  };
}

describe("o que conta como volume de criador", () => {
  it("uma inscrição paga soma o valor cheio", () => {
    // "Movimentado" é o que os jogadores pagaram para entrar — o volume que o
    // criador GEROU, e que já conta enquanto o campeonato ainda enche.
    const d = decideCreatorAccrual(fee());
    assert.deepEqual(d, {
      accrue: true,
      economy: "beta_credit",
      creatorUid: "criador-1",
      centavos: 1000,
    });
  });

  it("o valor é a magnitude: a linha é um débito e vem negativa", () => {
    assert.equal(
      (decideCreatorAccrual(fee({ amount: -25.5 })) as any).centavos,
      2550
    );
    assert.equal(
      (decideCreatorAccrual(fee({ amount: 25.5 })) as any).centavos,
      2550
    );
  });

  it("as duas economias, cada uma no seu quadro", () => {
    assert.equal(economyOfEntryFee("entry_fee"), "cash");
    assert.equal(economyOfEntryFee("beta_entry_fee"), "beta_credit");
    const cash = decideCreatorAccrual(
      fee({ category: "entry_fee", tournamentEconomy: "cash" })
    );
    assert.equal((cash as any).economy, "cash");
  });
});

describe("o que NÃO conta", () => {
  it("nenhuma outra categoria do livro-razão", () => {
    // Lista fechada: tratar uma categoria futura como volume inflaria o rank
    // de alguém em silêncio.
    for (const c of [
      "prize",
      "beta_prize",
      "kill_prize",
      "beta_kill_prize",
      "deposit",
      "withdrawal",
      "entry_refund",
      "house_funding",
      "categoria_do_futuro",
      "",
      null,
      42,
    ]) {
      assert.deepEqual(
        decideCreatorAccrual(fee({ category: c })),
        { accrue: false, reason: "not-an-entry-fee" },
        String(c)
      );
      assert.equal(economyOfEntryFee(c), null, String(c));
    }
  });

  it("RECUSA quando categoria e torneio discordam de economia", () => {
    // Uma das duas fontes está errada, e escolher qualquer uma publicaria
    // dinheiro real no quadro errado.
    assert.deepEqual(
      decideCreatorAccrual(fee({ tournamentEconomy: "cash" })),
      { accrue: false, reason: "economy-mismatch" }
    );
    assert.deepEqual(
      decideCreatorAccrual(
        fee({ category: "entry_fee", tournamentEconomy: "beta_credit" })
      ),
      { accrue: false, reason: "economy-mismatch" }
    );
  });

  it("a economia é checada ANTES do valor", () => {
    // Nenhum valor significa coisa alguma enquanto os dois lados discordam
    // sobre que tipo de dinheiro é aquele.
    assert.deepEqual(
      decideCreatorAccrual(
        fee({ tournamentEconomy: "cash", amount: "lixo" })
      ),
      { accrue: false, reason: "economy-mismatch" }
    );
  });

  it("o criador entrando no próprio campeonato NÃO conta", () => {
    // A taxa é real e o livro-razão a guarda; rankear como volume gerado
    // deixaria qualquer um subir pagando a si mesmo em looping.
    assert.deepEqual(
      decideCreatorAccrual(fee({ payerUid: "criador-1" })),
      { accrue: false, reason: "self-entry" }
    );
  });

  it("campeonato grátis não movimenta nada", () => {
    // Linha legítima, não dado corrompido — recusada em silêncio em vez de
    // virar um incremento de zero.
    assert.deepEqual(decideCreatorAccrual(fee({ amount: 0 })), {
      accrue: false,
      reason: "zero-amount",
    });
  });

  it("valor inutilizável é recusado, nunca coagido", () => {
    for (const bad of ["10", null, undefined, {}, [], Number.NaN, Infinity]) {
      assert.deepEqual(
        decideCreatorAccrual(fee({ amount: bad })),
        { accrue: false, reason: "bad-amount" },
        String(bad)
      );
    }
  });

  it("sem criador utilizável não há a quem creditar", () => {
    for (const bad of [null, undefined, "", "  ", 42, "com/barra", "a".repeat(201)]) {
      assert.deepEqual(
        decideCreatorAccrual(fee({ creatorUid: bad })),
        { accrue: false, reason: "no-creator" },
        String(bad)
      );
    }
  });
});

describe("o que a linha MOSTRA", () => {
  const source = {
    position: 1,
    nickname: "RDKILL",
    publicPlayerId: "AbCdEfGhIjKlMnOpQrStUv",
    volumeCentavos: 125_000,
    tournamentsCreated: 42,
  };

  it("posição, nick, pseudônimo, volume e campeonatos", () => {
    assert.deepEqual(projectCreatorRow(source), source);
  });

  it("o uid do criador NUNCA atravessa", () => {
    // A entrada é chaveada por uid porque é o único identificador estável do
    // servidor; ele fica deste lado, igual ao perfil público.
    const row = projectCreatorRow({
      ...source,
      creator_uid: "criador-1",
      email: "dono@sparta.gg",
    } as never) as unknown as Record<string, unknown>;

    for (const leaked of ["creator_uid", "email", "uid", "entries_count"]) {
      assert.equal(leaked in row, false, leaked);
    }
  });

  it("a saída tem EXATAMENTE cinco chaves", () => {
    assert.deepEqual(Object.keys(projectCreatorRow(source)).sort(), [
      "nickname",
      "position",
      "publicPlayerId",
      "tournamentsCreated",
      "volumeCentavos",
    ]);
  });

  it("sem pseudônimo a linha existe, só não é clicável", () => {
    for (const bad of [null, undefined, "", 42]) {
      assert.equal(
        projectCreatorRow({ ...source, publicPlayerId: bad }).publicPlayerId,
        null,
        String(bad)
      );
    }
  });

  it("sem nick, string vazia — a linha não some", () => {
    assert.equal(projectCreatorRow({ ...source, nickname: null }).nickname, "");
  });

  it("número inutilizável vira zero em vez de derrubar o quadro", () => {
    for (const bad of [-1, 1.5, "42", null, Number.NaN]) {
      assert.equal(
        projectCreatorRow({ ...source, volumeCentavos: bad }).volumeCentavos,
        0,
        String(bad)
      );
    }
  });
});

describe("a página é limitada, e isso é parte do contrato", () => {
  it("o tamanho é conhecido de antemão", () => {
    // Cada linha custa uma consulta agregada de campeonatos do criador. Uma
    // página sem teto transformaria uma chamada num número indeterminado delas.
    assert.equal(CREATOR_LEADERBOARD_PAGE_SIZE, 25);
    assert.ok(CREATOR_LEADERBOARD_PAGE_SIZE > 0);
  });
});
