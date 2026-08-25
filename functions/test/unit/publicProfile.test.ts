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
    createdAt: new Date(Date.UTC(2026, 7, 3, 14, 32, 9)),
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

  it("a saída tem EXATAMENTE seis chaves", () => {
    // Fixa o tamanho: um campo novo em users/{uid} não aparece aqui sozinho,
    // e um campo novo NESTA projeção quebra o teste até ser decidido.
    assert.deepEqual(Object.keys(projectPublicProfile(source())).sort(), [
      "badges",
      "memberSince",
      "nickname",
      "publicPlayerId",
      "tournamentsCreated",
      "tournamentsPlayed",
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
