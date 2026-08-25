import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BADGES,
  acknowledgeableIds,
  badgeById,
  isKnownBadgeId,
  badgesToAward,
  pendingCelebrations,
  MAX_ACKNOWLEDGED_BADGES,
  highestEarned,
  nextTier,
  qualifiedBadges,
  referredPlayerCounts,
  PLAYER_COUNTS_AFTER_TOURNAMENTS,
  type BadgeCounts,
} from "../../src/domain/badges.js";

const none: BadgeCounts = {
  tournamentsCreated: 0,
  playersBrought: 0,
  tournamentsPlayed: 0,
  isPartner: false,
};

const ids = (list: readonly { id: string }[]) => list.map((b) => b.id);

describe("a tabela de selos", () => {
  it("tem os quinze, e nenhum id repetido", () => {
    assert.equal(BADGES.length, 15);
    assert.equal(new Set(ids(BADGES)).size, 15);
  });

  it("cada trilha sobe: os limiares estão em ordem crescente", () => {
    // `highestEarned` e `nextTier` dependem disso.
    for (const track of ["creator", "partner", "player"] as const) {
      const tiers = BADGES.filter((b) => b.track === track);
      const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
      assert.deepEqual(ids(tiers), ids(sorted), track);
    }
  });

  it("os limiares são os combinados", () => {
    const t = (id: string) => badgeById(id)!.threshold;
    assert.deepEqual(
      [
        t("creator_verified"),
        t("creator_junior"),
        t("creator_semi_pro"),
        t("creator_pro"),
        t("creator_legend"),
      ],
      [10, 100, 500, 1_000, 2_000]
    );
    assert.deepEqual(
      [
        t("partner_junior"),
        t("partner_semi_pro"),
        t("partner_pro"),
        t("partner_legend"),
      ],
      [100, 1_000, 5_000, 10_000]
    );
    assert.deepEqual(
      [
        t("spartan_noobie"),
        t("spartan_junior"),
        t("spartan_semi_pro"),
        t("spartan_pro"),
        t("spartan_legend"),
      ],
      [50, 500, 1_500, 3_000, 5_000]
    );
  });
});

describe("quem qualifica", () => {
  it("conta zerada não ganha nada", () => {
    assert.deepEqual(qualifiedBadges(none), []);
  });

  it("uma conta abaixo do primeiro limiar não ganha nada", () => {
    assert.deepEqual(qualifiedBadges({ ...none, tournamentsCreated: 9 }), []);
  });

  it("exatamente no limiar JÁ ganha", () => {
    assert.deepEqual(ids(qualifiedBadges({ ...none, tournamentsCreated: 10 })), [
      "creator_verified",
    ]);
  });

  it("passar de um limiar ganha TODOS os anteriores junto", () => {
    // Quem chega a 600 campeonatos sem nunca ter sido avaliado merece os três.
    assert.deepEqual(
      ids(qualifiedBadges({ ...none, tournamentsCreated: 600 })),
      ["creator_verified", "creator_junior", "creator_semi_pro"]
    );
  });

  it("virar colaborador basta para o noobie", () => {
    assert.deepEqual(ids(qualifiedBadges({ ...none, isPartner: true })), [
      "partner_noobie",
    ]);
  });

  it("as trilhas são independentes", () => {
    const both = qualifiedBadges({
      tournamentsCreated: 10,
      playersBrought: 0,
      tournamentsPlayed: 50,
      isPartner: false,
    });
    assert.deepEqual(ids(both), ["creator_verified", "spartan_noobie"]);
  });
});

describe("marca d'água alta: ganhou, ficou", () => {
  it("só concede o que ainda não é possuído", () => {
    const award = badgesToAward({ ...none, tournamentsCreated: 100 }, [
      "creator_verified",
    ]);
    assert.deepEqual(ids(award), ["creator_junior"]);
  });

  it("rodar de novo sem mudança concede NADA", () => {
    // É o que torna a concessão idempotente: um dia sem novidade não escreve.
    const owned = ["creator_verified", "creator_junior"];
    assert.deepEqual(
      badgesToAward({ ...none, tournamentsCreated: 100 }, owned),
      []
    );
  });

  it("a contagem CAIR não tira o selo", () => {
    // Um indicado apaga a conta, um torneio é cancelado. Punir alguém por algo
    // que outra pessoa fez é o que a marca d'água alta existe para evitar.
    const owned = ["partner_junior", "partner_noobie"];
    assert.deepEqual(badgesToAward({ ...none, playersBrought: 0 }, owned), []);
    assert.equal(highestEarned("partner", owned)?.id, "partner_junior");
  });

  it("o selo exibido vem do POSSUÍDO, nunca da contagem de agora", () => {
    assert.equal(
      highestEarned("creator", ["creator_verified", "creator_pro"])?.id,
      "creator_pro"
    );
  });

  it("sem nada possuído, não há selo a exibir", () => {
    assert.equal(highestEarned("player", []), null);
  });
});

describe("o próximo degrau", () => {
  it("aponta o primeiro que falta", () => {
    assert.equal(nextTier("player", [])?.id, "spartan_noobie");
    assert.equal(nextTier("player", ["spartan_noobie"])?.id, "spartan_junior");
  });

  it("no topo da trilha, não há próximo", () => {
    const all = BADGES.filter((b) => b.track === "creator").map((b) => b.id);
    assert.equal(nextTier("creator", all), null);
  });
});

describe("contagem corrompida não concede nada", () => {
  it("negativo, fracionário ou não numérico qualifica para NADA", () => {
    // Conceder um selo permanente a partir de um número corrompido é algo que
    // correção nenhuma desfaz depois. Não é aparado para zero: aparar
    // esconderia a falha parecendo um "ainda não".
    for (const bad of [-1, 1.5, Number.NaN, "10" as unknown as number]) {
      assert.deepEqual(
        qualifiedBadges({ ...none, tournamentsCreated: bad }),
        [],
        String(bad)
      );
    }
  });
});

describe("recompensa é dado, não código", () => {
  it("todo selo carrega o campo, mesmo indeciso", () => {
    // Duas faixas devem pagar algo ainda não decidido. O campo existe para a
    // decisão chegar como dado depois, sem tocar no motor.
    for (const badge of BADGES) {
      assert.ok("reward" in badge, badge.id);
    }
  });
});

describe("quem conta como 'usuário trazido'", () => {
  const played = (n: number, complete = true) =>
    referredPlayerCounts({
      tournamentsPlayed: n,
      registrationComplete: complete,
    });

  it("cadastrar-se NÃO basta", () => {
    // Um cadastro custa zero, e as faixas de colaborador pagam prêmio: contar
    // cadastro seria pagar por criar conta.
    assert.equal(played(0), false);
  });

  it("abaixo do piso não conta", () => {
    assert.equal(played(PLAYER_COUNTS_AFTER_TOURNAMENTS - 1), false);
  });

  it("exatamente no piso já conta", () => {
    assert.equal(played(PLAYER_COUNTS_AFTER_TOURNAMENTS), true);
  });

  it("o piso é cinco campeonatos", () => {
    // Cinco inscrições pagas: forjar custa exatamente o dinheiro que a
    // forjação está tentando ganhar.
    assert.equal(PLAYER_COUNTS_AFTER_TOURNAMENTS, 5);
  });

  it("cadastro incompleto não conta, por mais que jogue", () => {
    assert.equal(played(500, false), false);
  });

  it("contagem corrompida não conta", () => {
    for (const bad of [-1, 1.5, Number.NaN, "9" as unknown as number]) {
      assert.equal(
        referredPlayerCounts({
          tournamentsPlayed: bad,
          registrationComplete: true,
        }),
        false,
        String(bad)
      );
    }
  });
});

describe("o momento da conquista", () => {
  // GANHAR UM SELO ACONTECE UMA VEZ SÓ. Se a comemoração vivesse apenas na
  // resposta que concedeu, um app fechado entre a concessão e o diálogo
  // perderia o momento para sempre: a chamada seguinte não tem nada de novo a
  // relatar porque não HÁ nada de novo — o selo já é da pessoa.

  describe("pendingCelebrations", () => {
    it("junta o que acabou de ser concedido com o que ficou devendo", () => {
      assert.deepEqual(
        pendingCelebrations(["creator_verified"], ["spartan_noobie"]),
        ["creator_verified", "spartan_noobie"]
      );
    });

    it("não repete um id que já estava pendente", () => {
      // Conceder é idempotente, então a mesma chamada pode ver as duas coisas.
      assert.deepEqual(
        pendingCelebrations(["creator_verified"], ["creator_verified"]),
        ["creator_verified"]
      );
    });

    it("descarta o que está gravado e não é selo", () => {
      assert.deepEqual(
        pendingCelebrations(
          ["creator_verified", "selo_inventado", 42, null, ""],
          []
        ),
        ["creator_verified"]
      );
    });

    it("um campo ausente ou de tipo errado vira lista vazia", () => {
      for (const bad of [undefined, null, "creator_verified", 42, {}]) {
        assert.deepEqual(pendingCelebrations(bad, []), [], String(bad));
      }
    });

    it("sem nada pendente e sem nada novo, não há o que comemorar", () => {
      assert.deepEqual(pendingCelebrations([], []), []);
    });
  });

  describe("acknowledgeableIds", () => {
    const unseen = ["creator_verified", "spartan_noobie"];

    it("limpa o que foi realmente mostrado", () => {
      assert.deepEqual(acknowledgeableIds(["creator_verified"], unseen), [
        "creator_verified",
      ]);
    });

    it("IGNORA um id que não estava pendente", () => {
      // O cliente diz "mostrei estes"; o servidor decide o que isso pode
      // significar. Aceitar qualquer id deixaria alguém descobrir, observando
      // o que muda, quais selos a conta tem.
      assert.deepEqual(acknowledgeableIds(["creator_legend"], unseen), []);
    });

    it("IGNORA o que não é selo, mesmo se estiver gravado", () => {
      assert.deepEqual(
        acknowledgeableIds(["selo_inventado"], ["selo_inventado"]),
        []
      );
    });

    it("ignora tipos errados sem estourar", () => {
      assert.deepEqual(acknowledgeableIds([42, null, {}, ""], unseen), []);
    });

    it("não repete um id pedido duas vezes", () => {
      // Os ids vão para um arrayRemove; duplicar só engorda a escrita.
      assert.deepEqual(
        acknowledgeableIds(["creator_verified", "creator_verified"], unseen),
        ["creator_verified"]
      );
    });

    it("limita quantos ids uma chamada pode nomear", () => {
      const flood = Array.from(
        { length: MAX_ACKNOWLEDGED_BADGES + 50 },
        () => "creator_verified"
      );
      assert.equal(acknowledgeableIds(flood, unseen).length, 1);
    });

    it("nada a limpar é resultado normal, não erro", () => {
      // Dois aparelhos comemorando a mesma coisa é o caso comum, e o segundo
      // legitimamente não tem o que fazer.
      assert.deepEqual(acknowledgeableIds(["creator_verified"], []), []);
      assert.deepEqual(acknowledgeableIds([], unseen), []);
    });
  });
});

describe("o motor reconhece as DUAS famílias de id", () => {
  // Os quinze fixos vivem numa tabela e são PROCURADOS. Um selo de colocação
  // não está em tabela nenhuma — o espaço de ids dele é infinito, um por mês —
  // então é INTERPRETADO. Toda checagem que perguntava "existe na tabela?"
  // passou a perguntar as duas coisas; sem isso, um troféu de temporada vira
  // um id que o motor recusa confirmar, e a comemoração se repete para sempre.
  const SEASON = "season_player_top1_2026-09";

  it("um selo fixo é conhecido", () => {
    assert.equal(isKnownBadgeId("creator_verified"), true);
  });

  it("um selo de temporada é conhecido", () => {
    assert.equal(isKnownBadgeId(SEASON), true);
    assert.equal(isKnownBadgeId("season_creator_top100_2027-01"), true);
  });

  it("lixo não é conhecido", () => {
    for (const bad of [
      "selo_inventado",
      "season_player_top7_2026-09",
      "",
      null,
      42,
      {},
    ]) {
      assert.equal(isKnownBadgeId(bad), false, String(bad));
    }
  });

  it("a comemoração de um troféu de temporada pode ser CONFIRMADA", () => {
    // Este é o bug que a mudança evita: sem reconhecer o id, `arrayRemove`
    // nunca limparia a dívida e o diálogo voltaria em toda leitura.
    assert.deepEqual(acknowledgeableIds([SEASON], [SEASON]), [SEASON]);
  });

  it("um troféu de temporada sobrevive na fila de comemoração", () => {
    assert.deepEqual(pendingCelebrations([SEASON], []), [SEASON]);
  });

  it("um id de temporada MALFORMADO continua sendo descartado", () => {
    const fake = "season_player_top7_2026-09";
    assert.deepEqual(acknowledgeableIds([fake], [fake]), []);
    assert.deepEqual(pendingCelebrations([fake], []), []);
  });
});
