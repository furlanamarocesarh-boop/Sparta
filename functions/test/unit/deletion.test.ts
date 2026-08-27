import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideDeletion,
  deletionMessage,
  economyLabel,
  KNOWN_ECONOMIES,
  MAX_DELETABLE_REGISTRATIONS,
  type DeletionRefusal,
} from "../../src/domain/deletion.js";

/**
 * APAGAR UM CAMPEONATO.
 *
 * A regra que manda: apagar NUNCA pode ser um jeito de ficar com o dinheiro de
 * quem se inscreveu. Se ainda há entrada retida, o reembolso vem primeiro; se
 * o campeonato já liquidou, não há o que devolver e devolver criaria dinheiro
 * do nada. Estes testes travam as duas metades.
 */

const base = {
  status: "open",
  activeRegistrations: 0,
  isCreator: true,
  hasSettlement: false,
};

describe("quem pode apagar", () => {
  it("só quem criou", () => {
    // Em toda a base, creator_uid nunca foi consultado como autorização —
    // qualquer admin age sobre o campeonato de qualquer outro. Passa numa ação
    // reversível como cancelar; numa irreversível, não.
    const d = decideDeletion({ ...base, isCreator: false });
    assert.equal(d.kind, "refuse");
    assert.equal(d.kind === "refuse" && d.reason, "not-creator");
  });

  it("não ser o dono é recusado ANTES de qualquer estado", () => {
    // As outras mensagens descrevem o estado do campeonato. Respondê-las a
    // quem não pode mexer nele é responder uma pergunta não autorizada.
    const d = decideDeletion({
      status: "in_progress",
      activeRegistrations: 999,
      isCreator: false,
      hasSettlement: false,
    });
    assert.equal(d.kind === "refuse" && d.reason, "not-creator");
  });
});

describe("o dinheiro volta antes de o campeonato sumir", () => {
  it("aberto COM inscritos reembolsa primeiro", () => {
    const d = decideDeletion({ ...base, activeRegistrations: 3 });
    assert.equal(d.kind, "refund-then-delete");
  });

  it("aberto SEM inscritos apaga direto", () => {
    // Não há entrada retida: não há o que devolver.
    assert.equal(decideDeletion(base).kind, "delete");
  });

  it("LIQUIDADO não reembolsa, mesmo com inscritos", () => {
    // As entradas já viraram prêmio pago. Devolvê-las agora daria ao jogador o
    // prêmio E a entrada de volta — dinheiro criado do nada.
    const d = decideDeletion({
      ...base,
      status: "completed",
      activeRegistrations: 8,
      hasSettlement: true,
    });
    assert.equal(d.kind, "delete");
  });

  it("liquidação vale mesmo com o status mexido de volta para aberto", () => {
    // O status é um campo; a liquidação é um fato. Se houver prova de que o
    // prêmio saiu, ela ganha do rótulo.
    const d = decideDeletion({
      ...base,
      status: "open",
      activeRegistrations: 4,
      hasSettlement: true,
    });
    assert.equal(d.kind, "delete");
  });

  it("cancelado apaga direto — já foi reembolsado", () => {
    // Depois do cancelamento as inscrições ficam "refunded", então nenhuma
    // conta como ativa e não há segundo reembolso.
    const d = decideDeletion({ ...base, status: "cancelled" });
    assert.equal(d.kind, "delete");
  });
});

describe("em andamento", () => {
  it("COM jogadores é recusado", () => {
    // O dinheiro deles está no bolo e o prêmio não saiu. Apagar sem devolver
    // é ficar com o dinheiro; devolver no meio da partida é o que o contrato
    // do cancelamento recusa de propósito, porque o jogo está acontecendo.
    const d = decideDeletion({
      ...base,
      status: "in_progress",
      activeRegistrations: 1,
    });
    assert.equal(d.kind, "refuse");
    assert.equal(d.kind === "refuse" && d.reason, "running-with-players");
  });

  it("SEM ninguém inscrito pode ser apagado", () => {
    // Não há dinheiro de terceiro em jogo, então a recusa não protege nada.
    const d = decideDeletion({ ...base, status: "in_progress" });
    assert.equal(d.kind, "delete");
  });
});

describe("teto de inscrições", () => {
  it("aceita exatamente no teto", () => {
    const d = decideDeletion({
      ...base,
      activeRegistrations: MAX_DELETABLE_REGISTRATIONS,
    });
    assert.equal(d.kind, "refund-then-delete");
  });

  it("recusa acima do teto — reembolso parcial não existe", () => {
    const d = decideDeletion({
      ...base,
      activeRegistrations: MAX_DELETABLE_REGISTRATIONS + 1,
    });
    assert.equal(d.kind === "refuse" && d.reason, "too-many-registrations");
  });
});

describe("mensagens", () => {
  it("toda recusa tem mensagem em pt-BR, sem detalhe interno", () => {
    const reasons: DeletionRefusal[] = [
      "not-creator",
      "running-with-players",
      "too-many-registrations",
    ];
    for (const reason of reasons) {
      const message = deletionMessage(reason);
      assert.notEqual(message.trim(), "", reason);
      // Nada de nome de coleção, campo ou código vazando para quem lê.
      for (const interno of [
        "uid",
        "firestore",
        "registration",
        "undefined",
        "_ref",
      ]) {
        assert.equal(
          message.toLowerCase().includes(interno),
          false,
          `${reason} vazou "${interno}"`
        );
      }
    }
  });

  it("cada economia tem rótulo próprio e eles não se confundem", () => {
    // O rótulo sobrevive ao campeonato: depois que ele some não há de onde
    // derivar a economia, e uma linha de extrato sem economia é ilegível,
    // porque as duas nunca podem ser somadas.
    const rotulos = KNOWN_ECONOMIES.map(economyLabel);
    assert.equal(new Set(rotulos).size, rotulos.length);
    for (const r of rotulos) assert.notEqual(r.trim(), "");
  });
});
