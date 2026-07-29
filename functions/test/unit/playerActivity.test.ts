import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTIVITY_COLLECTION,
  ACTIVITY_TIMEZONE,
  activityDocumentId,
  businessDayKey,
  checkActivityReplay,
  normalizeActivityUid,
  validateClientDay,
  validateClientOffsetMinutes,
} from "../../src/domain/playerActivity.js";

const UID = "7N4hobJBzhOaWmWTidTduhlf7Wj1";

/** Asserts the thrown value is a DomainError with the expected code. */
function assertDomainCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

describe("constantes do calendário de negócio", () => {
  it("fixa America/Sao_Paulo e a coleção dedicada", () => {
    assert.equal(ACTIVITY_TIMEZONE, "America/Sao_Paulo");
    assert.equal(ACTIVITY_COLLECTION, "player_activity");
  });
});

describe("businessDayKey — fronteiras de meia-noite em São Paulo", () => {
  it("um instante logo ANTES da meia-noite local ainda é o dia anterior", () => {
    // 02:59:59Z == 23:59:59 do dia 27 em São Paulo (UTC-3).
    const instant = new Date("2026-07-28T02:59:59.000Z");
    assert.equal(businessDayKey(instant), "2026-07-27");
  });

  it("um instante EXATAMENTE na meia-noite local já é o dia novo", () => {
    // 03:00:00Z == 00:00:00 do dia 28 em São Paulo.
    const instant = new Date("2026-07-28T03:00:00.000Z");
    assert.equal(businessDayKey(instant), "2026-07-28");
  });

  it("o dia de negócio difere do dia UTC na janela 00:00–03:00Z", () => {
    const instant = new Date("2026-07-28T01:30:00.000Z");
    assert.equal(instant.toISOString().slice(0, 10), "2026-07-28");
    // Mesmo instante, calendário de negócio: ainda dia 27.
    assert.equal(businessDayKey(instant), "2026-07-27");
  });

  it("meio-dia local é trivialmente o mesmo dia", () => {
    assert.equal(
      businessDayKey(new Date("2026-07-28T15:00:00.000Z")),
      "2026-07-28"
    );
  });

  it("vira o ano corretamente na virada local", () => {
    assert.equal(
      businessDayKey(new Date("2027-01-01T02:59:59.000Z")),
      "2026-12-31"
    );
    assert.equal(
      businessDayKey(new Date("2027-01-01T03:00:00.000Z")),
      "2027-01-01"
    );
  });

  it("rejeita um instante inválido em vez de inventar um dia", () => {
    assertDomainCode(
      () => businessDayKey(new Date("not a date")),
      "invalid-argument"
    );
    assertDomainCode(
      () => businessDayKey(undefined as unknown as Date),
      "invalid-argument"
    );
  });
});

describe("activityDocumentId", () => {
  it("é determinístico por uid e dia", () => {
    assert.equal(
      activityDocumentId(UID, "2026-07-28"),
      `${UID}_2026-07-28`
    );
    assert.equal(
      activityDocumentId(UID, "2026-07-28"),
      activityDocumentId(UID, "2026-07-28")
    );
  });

  it("dias diferentes produzem documentos diferentes", () => {
    assert.notEqual(
      activityDocumentId(UID, "2026-07-28"),
      activityDocumentId(UID, "2026-07-29")
    );
  });

  it("jogadores diferentes produzem documentos diferentes no mesmo dia", () => {
    assert.notEqual(
      activityDocumentId("player-a", "2026-07-28"),
      activityDocumentId("player-b", "2026-07-28")
    );
  });
});

describe("normalizeActivityUid", () => {
  it("aceita e apara um uid válido", () => {
    assert.equal(normalizeActivityUid(`  ${UID}  `), UID);
  });

  it("rejeita vazio, nulo e não-string", () => {
    assertDomainCode(() => normalizeActivityUid(""), "invalid-argument");
    assertDomainCode(() => normalizeActivityUid("   "), "invalid-argument");
    assertDomainCode(() => normalizeActivityUid(null), "invalid-argument");
    assertDomainCode(() => normalizeActivityUid(undefined), "invalid-argument");
  });

  it("rejeita uid que escaparia do caminho do documento", () => {
    assertDomainCode(
      () => normalizeActivityUid("a/../../wallets/victim"),
      "invalid-argument"
    );
    assertDomainCode(
      () => normalizeActivityUid("x".repeat(201)),
      "invalid-argument"
    );
  });
});

describe("validateClientDay — data do cliente conferida contra o servidor", () => {
  const SERVER_DAY = "2026-07-28";

  it("ausente é válido: o cliente não é obrigado a mandar nada", () => {
    assert.equal(validateClientDay(undefined, SERVER_DAY), null);
    assert.equal(validateClientDay(null, SERVER_DAY), null);
  });

  it("aceita exatamente o dia do servidor", () => {
    assert.equal(validateClientDay(SERVER_DAY, SERVER_DAY), SERVER_DAY);
  });

  it("tolera um dia de diferença (relógio perto da meia-noite)", () => {
    assert.equal(validateClientDay("2026-07-27", SERVER_DAY), "2026-07-27");
    assert.equal(validateClientDay("2026-07-29", SERVER_DAY), "2026-07-29");
  });

  it("rejeita formato malformado", () => {
    for (const bad of ["28/07/2026", "2026-7-28", "2026-07-28T00:00:00Z", "hoje"]) {
      assertDomainCode(
        () => validateClientDay(bad, SERVER_DAY),
        "invalid-argument"
      );
    }
  });

  it("rejeita não-string", () => {
    assertDomainCode(() => validateClientDay(20260728, SERVER_DAY), "invalid-argument");
    assertDomainCode(() => validateClientDay({}, SERVER_DAY), "invalid-argument");
    assertDomainCode(() => validateClientDay(true, SERVER_DAY), "invalid-argument");
  });

  it("rejeita datas bem formadas que não existem no calendário", () => {
    assertDomainCode(
      () => validateClientDay("2026-02-30", "2026-02-28"),
      "invalid-argument"
    );
    assertDomainCode(
      () => validateClientDay("2026-13-01", "2026-12-31"),
      "invalid-argument"
    );
    assertDomainCode(
      () => validateClientDay("2026-00-10", SERVER_DAY),
      "invalid-argument"
    );
  });

  it("rejeita datas anteriores ao beta como implausíveis", () => {
    assertDomainCode(
      () => validateClientDay("1999-01-01", SERVER_DAY),
      "invalid-argument"
    );
  });

  it("rejeita relógio muito distante do servidor", () => {
    assertDomainCode(
      () => validateClientDay("2026-08-15", SERVER_DAY),
      "failed-precondition"
    );
    assertDomainCode(
      () => validateClientDay("2026-07-01", SERVER_DAY),
      "failed-precondition"
    );
  });
});

describe("validateClientOffsetMinutes", () => {
  it("ausente é válido", () => {
    assert.equal(validateClientOffsetMinutes(undefined), null);
    assert.equal(validateClientOffsetMinutes(null), null);
  });

  it("aceita o offset real de São Paulo e os extremos do mundo", () => {
    assert.equal(validateClientOffsetMinutes(-180), -180);
    assert.equal(validateClientOffsetMinutes(-720), -720);
    assert.equal(validateClientOffsetMinutes(840), 840);
    assert.equal(validateClientOffsetMinutes(0), 0);
  });

  it("rejeita não-inteiro e fora do intervalo", () => {
    assertDomainCode(() => validateClientOffsetMinutes(-180.5), "invalid-argument");
    assertDomainCode(() => validateClientOffsetMinutes("-180"), "invalid-argument");
    assertDomainCode(() => validateClientOffsetMinutes(NaN), "invalid-argument");
    assertDomainCode(() => validateClientOffsetMinutes(-721), "invalid-argument");
    assertDomainCode(() => validateClientOffsetMinutes(841), "invalid-argument");
  });
});

describe("checkActivityReplay", () => {
  const consistent = {
    uid: UID,
    activityDay: "2026-07-28",
    userRefPath: `users/${UID}`,
  };

  it("aceita um documento totalmente consistente como replay", () => {
    const result = checkActivityReplay({
      uid: UID,
      dayKey: "2026-07-28",
      stored: consistent,
    });
    assert.equal(result.ok, true);
  });

  it("rejeita um documento cujo uid não bate com o id determinístico", () => {
    const result = checkActivityReplay({
      uid: UID,
      dayKey: "2026-07-28",
      stored: { ...consistent, uid: "outro-jogador" },
    });
    assert.equal(result.ok, false);
  });

  it("rejeita um documento cujo dia não bate", () => {
    const result = checkActivityReplay({
      uid: UID,
      dayKey: "2026-07-28",
      stored: { ...consistent, activityDay: "2026-07-27" },
    });
    assert.equal(result.ok, false);
  });

  it("rejeita um documento cujo user_ref aponta para outro usuário", () => {
    const result = checkActivityReplay({
      uid: UID,
      dayKey: "2026-07-28",
      stored: { ...consistent, userRefPath: "users/victim" },
    });
    assert.equal(result.ok, false);
  });

  it("rejeita um documento sem os campos esperados", () => {
    const result = checkActivityReplay({
      uid: UID,
      dayKey: "2026-07-28",
      stored: {},
    });
    assert.equal(result.ok, false);
  });
});
