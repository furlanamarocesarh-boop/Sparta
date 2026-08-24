import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isRegistrationComplete,
  normalizeNickname,
  parseNickname,
  NICKNAME_MAX,
  NICKNAME_MIN,
  RESERVED_NICKNAMES,
} from "../../src/domain/nickname.js";

describe("o nick Sparta", () => {
  it("guarda o que o jogador digitou, e reserva a forma dobrada", () => {
    const n = parseNickname("Spartano");
    assert.equal(n.display, "Spartano", "tirou a maiúscula do jogador");
    assert.equal(n.normalized, "spartano");
  });

  it("maiúsculas, minúsculas e acentos são UM nick só", () => {
    // Deixá-los coexistir é como começa a personificação: numa lista de
    // inscritos ninguém distingue "Spártano" de "spartano".
    for (const variant of ["Spartano", "SPARTANO", "spártano", "Spártano"]) {
      assert.equal(normalizeNickname(variant), "spartano", variant);
    }
  });

  it("aceita letras, números e _", () => {
    for (const good of ["ana_123", "Zeca", "player1", "ÉricaGG"]) {
      assert.ok(parseNickname(good), good);
    }
  });

  it("recusa espaço, pontuação e emoji", () => {
    // Lista de inscritos, ranking e link de compartilhamento renderizam isto.
    for (const bad of ["dois nomes", "a.b", "nick!", "jogador🎮", "a-b"]) {
      assert.throws(() => parseNickname(bad), `deveria recusar ${bad}`);
    }
  });

  it("respeita o tamanho mínimo e o máximo", () => {
    assert.throws(() => parseNickname("ab"));
    assert.ok(parseNickname("a".repeat(NICKNAME_MIN)));
    assert.ok(parseNickname("a".repeat(NICKNAME_MAX)));
    assert.throws(() => parseNickname("a".repeat(NICKNAME_MAX + 1)));
  });

  it("recusa vazio e espaço em branco", () => {
    for (const bad of ["", "   ", null, undefined]) {
      assert.throws(() => parseNickname(bad));
    }
  });
});

describe("nicks que ninguém pode ter", () => {
  it("recusa os nomes que soam como a plataforma", () => {
    // Uma mensagem de "sparta" ou "suporte" numa lista é a personificação
    // mais barata que existe.
    for (const reserved of ["sparta", "suporte", "admin", "staff"]) {
      assert.throws(
        () => parseNickname(reserved),
        /não está disponível/i,
        reserved
      );
    }
  });

  it("a reserva vale em qualquer caixa ou acento", () => {
    assert.throws(() => parseNickname("SPARTA"));
    assert.throws(() => parseNickname("Suporté"));
  });

  it("todo nick reservado tem tamanho válido — a lista é autoritativa", () => {
    // Os códigos de indicação já ensinaram isso: um reservado curto passava
    // por uma checagem de tamanho mínimo que rodava antes da lista.
    for (const reserved of RESERVED_NICKNAMES) {
      assert.throws(() => parseNickname(reserved), reserved);
    }
  });
});

describe("cadastro completo: os três passos", () => {
  it("nick sem KYC NÃO completa", () => {
    assert.equal(
      isRegistrationComplete({ nickname: "spartano", kycVerified: false }),
      false
    );
  });

  it("KYC sem nick NÃO completa", () => {
    assert.equal(
      isRegistrationComplete({ nickname: "", kycVerified: true }),
      false
    );
  });

  it("os dois juntos completam", () => {
    assert.equal(
      isRegistrationComplete({ nickname: "spartano", kycVerified: true }),
      true
    );
  });

  it("nick só de espaço não vale como nick", () => {
    assert.equal(
      isRegistrationComplete({ nickname: "   ", kycVerified: true }),
      false
    );
  });

  it("o KYC é PARÂMETRO, não padrão — 'em breve' não vira 'opcional'", () => {
    // Se o campo tivesse default true, cada chamador que esquecesse de passá-lo
    // estaria declarando KYC feito. Aqui esquecer não compila.
    assert.equal(
      isRegistrationComplete({ nickname: "spartano", kycVerified: false }),
      false
    );
  });
});
