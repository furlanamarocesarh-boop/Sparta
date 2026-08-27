import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectPublicProfile } from "../../src/domain/publicProfile.js";

/** Um documento de usuário com TUDO que a conta guarda, inclusive o privado. */
function source(overrides: Record<string, unknown> = {}) {
  return {
    publicPlayerId: "aaaaaaaaaaaaaaaaaaaaaa",
    username: "RDKILL",
    badges: ["creator_verified", "spartan_noobie"],
    tournamentsPlayed: 42,
    tournamentsCreated: 7,
    tournamentsWon: 5,
    createdAt: new Date(Date.UTC(2026, 7, 3, 14, 32, 9)),
    // FECHADO É O PADRÃO do fixture porque é o padrão do produto: quem nunca
    // mexeu em configuração nenhuma não mostra número nenhum.
    earningsPublic: undefined,
    lifetimeWonCentavos: 245_000,
    ...overrides,
  };
}

describe("o que o perfil público MOSTRA", () => {
  it("nick, selos e contagens", () => {
    const p = projectPublicProfile(source());
    assert.equal(p.nickname, "RDKILL");
    assert.deepEqual(p.badges, ["creator_verified", "spartan_noobie"]);
    assert.equal(p.tournamentsPlayed, 42);
    assert.equal(p.tournamentsCreated, 7);
  });

  it("o pseudônimo, nunca o uid", () => {
    const p = projectPublicProfile(source());
    assert.equal(p.publicPlayerId, "aaaaaaaaaaaaaaaaaaaaaa");
    assert.equal("uid" in p, false);
  });

  it("mês e ano de entrada, nunca o instante exato", () => {
    // Um carimbo preciso é alça de correlação: prende a conta a um momento
    // que dá para casar com um cadastro em outro lugar.
    const p = projectPublicProfile(source());
    assert.equal(p.memberSince, "agosto de 2026");
    assert.equal(p.memberSince!.includes("14"), false, "vazou a hora");
    assert.equal(p.memberSince!.includes("3"), false, "vazou o dia");
  });
});

describe("o que o perfil público NÃO mostra", () => {
  it("NENHUM campo privado atravessa, mesmo estando no documento", () => {
    // Este é o teste que a feature existe para ter. Todo outro caminho de
    // leitura deste backend recusa mostrar um jogador a outro; o perfil abre
    // um buraco nisso de propósito, e o buraco é recortado por lista de
    // permissão — não projetando o documento e removendo o que alguém lembrou.
    const p = projectPublicProfile(
      source({
        email: "dono@sparta.gg",
        cpf: "000.000.000-00",
        partner_ref: "parceiro-1",
        kyc_verified: true,
      } as never) as never
    ) as unknown as Record<string, unknown>;

    for (const leaked of [
      "email",
      "cpf",
      "partner_ref",
      "kyc_verified",
      "uid",
      "balance",
      "total_won",
      "total_spent",
      "beta_balance",
    ]) {
      assert.equal(leaked in p, false, `vazou "${leaked}"`);
    }
  });

  it("a saída tem EXATAMENTE nove chaves", () => {
    // Fixa o tamanho: um campo novo em users/{uid} não aparece aqui sozinho,
    // e um campo novo NESTA projeção quebra o teste até ser decidido.
    //
    // ERAM SEIS. As três que entraram foram decididas, não escorregaram:
    // `tournamentsWon` é uma contagem, da mesma natureza das duas que já
    // estavam; `earningsVisible` e `lifetimeWonCentavos` abrem — só com o dono
    // tendo pedido, e fechado por padrão — o total de prêmios. Saldo continua
    // fora, e é o teste acima que garante isso.
    assert.deepEqual(Object.keys(projectPublicProfile(source())).sort(), [
      "badges",
      "earningsVisible",
      "lifetimeWonCentavos",
      "memberSince",
      "nickname",
      "publicPlayerId",
      "tournamentsCreated",
      "tournamentsPlayed",
      "tournamentsWon",
    ]);
  });

  it("dinheiro nunca entra, nem por engano", () => {
    const p = JSON.stringify(projectPublicProfile(source()));
    for (const money of ["balance", "centavos", "total_won", "R$"]) {
      assert.equal(p.includes(money), false, money);
    }
  });
});

describe("um documento incompleto não quebra a página", () => {
  it("sem nick, o perfil ainda existe", () => {
    assert.equal(projectPublicProfile(source({ username: "" })).nickname, "");
    assert.equal(
      projectPublicProfile(source({ username: null })).nickname,
      ""
    );
  });

  it("sem selos, lista vazia", () => {
    for (const bad of [null, undefined, "creator_verified", 42]) {
      assert.deepEqual(projectPublicProfile(source({ badges: bad })).badges, []);
    }
  });

  it("selo malformado no meio da lista é descartado, os bons ficam", () => {
    const p = projectPublicProfile(
      source({ badges: ["creator_verified", 7, "", null, "spartan_noobie"] })
    );
    assert.deepEqual(p.badges, ["creator_verified", "spartan_noobie"]);
  });

  it("contagem inutilizável vira zero em vez de derrubar a página", () => {
    // É caminho de exibição para um estranho: transformar um dado ruim em
    // página quebrada pune quem não tem como consertar.
    for (const bad of [-1, 1.5, "42", null, Number.NaN]) {
      assert.equal(
        projectPublicProfile(source({ tournamentsPlayed: bad }))
          .tournamentsPlayed,
        0,
        String(bad)
      );
    }
  });

  it("sem data usável, memberSince é nulo — nunca uma data inventada", () => {
    for (const bad of [null, undefined, "2026-08-03", 42, {}]) {
      assert.equal(
        projectPublicProfile(source({ createdAt: bad })).memberSince,
        null,
        String(bad)
      );
    }
  });

  it("aceita Timestamp do Firestore sem importar o Admin SDK", () => {
    const stamp = { toDate: () => new Date(Date.UTC(2026, 0, 15)) };
    assert.equal(
      projectPublicProfile(source({ createdAt: stamp })).memberSince,
      "janeiro de 2026"
    );
  });
});

describe("o total de prêmios, e a porta que o governa", () => {
  it("FECHADO por padrão — quem nunca mexeu não mostra nada", () => {
    // É a regra que já valia para todo mundo, agora escrita como padrão em vez
    // de como ausência de código.
    const p = projectPublicProfile(source());
    assert.equal(p.earningsVisible, false);
    assert.equal(p.lifetimeWonCentavos, null);
  });

  it("ABERTO mostra o total, em centavos inteiros", () => {
    const p = projectPublicProfile(source({ earningsPublic: true }));
    assert.equal(p.earningsVisible, true);
    assert.equal(p.lifetimeWonCentavos, 245_000);
  });

  it("SÓ o booleano verdadeiro abre", () => {
    // Um campo corrompido não pode virar consentimento que ninguém deu.
    for (const lixo of ["true", 1, "sim", {}, [], "TRUE"]) {
      const p = projectPublicProfile(source({ earningsPublic: lixo }));
      assert.equal(p.earningsVisible, false, String(lixo));
      assert.equal(p.lifetimeWonCentavos, null, String(lixo));
    }
  });

  it("com a porta FECHADA o número morre aqui, mesmo se for passado", () => {
    // Defesa em profundidade: o chamador já evita ler a carteira, e ainda
    // assim a projeção não deixa passar.
    const p = projectPublicProfile(
      source({ earningsPublic: false, lifetimeWonCentavos: 999_999 })
    );
    assert.equal(p.lifetimeWonCentavos, null);
  });

  it("um total corrompido vira ausência, não uma página quebrada", () => {
    for (const lixo of ["2450", -1, 12.5, null, undefined, NaN]) {
      const p = projectPublicProfile(
        source({ earningsPublic: true, lifetimeWonCentavos: lixo })
      );
      assert.equal(p.lifetimeWonCentavos, null, String(lixo));
      assert.equal(p.earningsVisible, true, "a porta continua aberta");
    }
  });

  it("SALDO nunca sai, nem com a porta aberta", () => {
    // "Quanto ganhou ao longo do tempo" é conquista; "quanto tem agora" é
    // convite. A projeção não sabe representar saldo.
    const p: any = projectPublicProfile(
      source({ earningsPublic: true, balance: 1_000_000 } as any)
    );
    assert.equal(JSON.stringify(p).includes("1000000"), false);
    assert.equal("balance" in p, false);
    assert.equal("totalSpent" in p, false);
  });
});

describe("vitórias de vida inteira", () => {
  it("saem no perfil", () => {
    assert.equal(projectPublicProfile(source()).tournamentsWon, 5);
  });

  it("uma contagem corrompida vira zero, não uma página quebrada", () => {
    for (const lixo of ["5", -1, 2.5, null, undefined]) {
      assert.equal(
        projectPublicProfile(source({ tournamentsWon: lixo })).tournamentsWon,
        0,
        String(lixo)
      );
    }
  });
});
