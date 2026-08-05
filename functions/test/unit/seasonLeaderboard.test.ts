import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
} from "../../src/domain/economy.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  compareEntries,
  decodeCursor,
  encodeCursor,
  LEADERBOARD_DEFAULT_LIMIT,
  LEADERBOARD_MAX_LIMIT,
  normalizeEconomy,
  normalizeLimit,
  publicEntry,
  rankFromAhead,
  type OrderKey,
} from "../../src/domain/seasonLeaderboard.js";

const P1 = "A7fQ2_kB9xLm3NpQr5TzUw";
const P2 = "B8gR3_lC0yMn4OqRs6UaVx";
const P3 = "C9hS4_mD1zNo5PrSt7VbWy";

function assertDomain(fn: () => unknown, code: string, label: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof DomainError, `${label}: not a DomainError`);
      assert.equal(error.code, code, `${label}: wrong code`);
      return true;
    },
    label
  );
}

const key = (
  scoreCentavos: number,
  winsCount: number,
  publicPlayerId: string
): OrderKey => ({ scoreCentavos, winsCount, publicPlayerId });

const stored = (
  scoreCentavos: number,
  winsCount: number,
  publicPlayerId: string,
  extra: Record<string, unknown> = {}
) => ({
  publicPlayerId,
  economy: ECONOMY_CASH,
  seasonId: "2026-08",
  scoreCentavos,
  winsCount,
  ...extra,
});

// ---------------------------------------------------------------------------
// Ordem canônica
// ---------------------------------------------------------------------------

describe("ordem canônica — três níveis, nada mais", () => {
  it("ordena por pontuação DESCENDENTE primeiro", () => {
    assert.ok(compareEntries(key(200, 1, P1), key(100, 9, P2)) < 0);
    assert.ok(compareEntries(key(100, 9, P1), key(200, 1, P2)) > 0);
  });

  it("desempata por vitórias DESCENDENTE", () => {
    assert.ok(compareEntries(key(100, 3, P2), key(100, 2, P1)) < 0);
    assert.ok(compareEntries(key(100, 2, P1), key(100, 3, P2)) > 0);
  });

  it("desempata enfim por publicPlayerId ASCENDENTE", () => {
    assert.ok(compareEntries(key(100, 2, P1), key(100, 2, P2)) < 0);
    assert.ok(compareEntries(key(100, 2, P2), key(100, 2, P1)) > 0);
  });

  it("é uma ordem TOTAL: nada empata de fato", () => {
    const rows = [
      key(100, 2, P2),
      key(100, 2, P1),
      key(200, 1, P3),
      key(100, 3, P3),
      key(0, 1, P1),
    ];
    const sorted = [...rows].sort(compareEntries);

    for (let i = 1; i < sorted.length; i += 1) {
      assert.notEqual(
        compareEntries(sorted[i - 1], sorted[i]),
        0,
        "duas linhas não podem comparar iguais"
      );
    }
    assert.deepEqual(
      sorted.map((r) => [r.scoreCentavos, r.winsCount, r.publicPlayerId]),
      [
        [200, 1, P3],
        [100, 3, P3],
        [100, 2, P1],
        [100, 2, P2],
        [0, 1, P1],
      ]
    );
  });

  it("o comparador é antissimétrico e reflexivo em zero", () => {
    const a = key(100, 2, P1);
    const b = key(100, 2, P2);
    assert.equal(Math.sign(compareEntries(a, b)), -Math.sign(compareEntries(b, a)));
    assert.equal(compareEntries(a, { ...a }), 0);
  });

  it("é transitivo sobre um conjunto gerado", () => {
    const rows: OrderKey[] = [];
    for (const s of [0, 100, 200]) {
      for (const w of [1, 2]) {
        for (const p of [P1, P2, P3]) rows.push(key(s, w, p));
      }
    }
    for (const a of rows) {
      for (const b of rows) {
        for (const c of rows) {
          if (compareEntries(a, b) < 0 && compareEntries(b, c) < 0) {
            assert.ok(compareEntries(a, c) < 0, "transitividade quebrada");
          }
        }
      }
    }
  });

  it("NÃO usa lastPrizeAt nem qualquer timestamp como nível", () => {
    // Duas linhas idênticas nos três níveis comparam igual mesmo com
    // timestamps diferentes — um trigger atrasado nunca move ninguém.
    const a = { ...key(100, 2, P1), lastPrizeAt: new Date("2026-08-01") };
    const b = { ...key(100, 2, P1), lastPrizeAt: new Date("2026-08-31") };
    assert.equal(compareEntries(a, b), 0);
  });

  it("NÃO usa uid: o comparador nem aceita esse campo", () => {
    const a = { ...key(100, 2, P1), uid: "zzz" };
    const b = { ...key(100, 2, P1), uid: "aaa" };
    assert.equal(compareEntries(a, b), 0);
  });
});

// ---------------------------------------------------------------------------
// Posição
// ---------------------------------------------------------------------------

describe("posição — ordinal exato", () => {
  it("a posição é a contagem à frente mais um", () => {
    assert.equal(rankFromAhead(0), 1);
    assert.equal(rankFromAhead(41), 42);
  });

  it("recusa uma contagem impossível", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, "3", null, undefined]) {
      assertDomain(
        () => rankFromAhead(bad),
        "failed-precondition",
        String(bad)
      );
    }
  });

  it("não existem posições compartilhadas — ordenar dá 1,2,3 sem repetição", () => {
    const rows = [key(100, 2, P2), key(100, 2, P1), key(100, 2, P3)];
    const positions = [...rows]
      .sort(compareEntries)
      .map((_, index) => index + 1);
    assert.deepEqual(positions, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Limite e economia
// ---------------------------------------------------------------------------

describe("limite da página", () => {
  it("ausente vira o padrão", () => {
    assert.equal(normalizeLimit(undefined), LEADERBOARD_DEFAULT_LIMIT);
    assert.equal(normalizeLimit(null), LEADERBOARD_DEFAULT_LIMIT);
    assert.equal(LEADERBOARD_DEFAULT_LIMIT, 50);
  });

  it("aceita as bordas válidas", () => {
    assert.equal(normalizeLimit(1), 1);
    assert.equal(normalizeLimit(LEADERBOARD_MAX_LIMIT), 100);
  });

  it("recusa acima do teto em vez de truncar em silêncio", () => {
    assertDomain(() => normalizeLimit(101), "invalid-argument", "101");
    assertDomain(() => normalizeLimit(1000), "invalid-argument", "1000");
  });

  it("recusa zero, negativo, fracionário e não numérico", () => {
    for (const bad of [0, -1, 1.5, "50", true, {}, []]) {
      assertDomain(() => normalizeLimit(bad), "invalid-argument", String(bad));
    }
  });
});

describe("economia", () => {
  it("aceita apenas as duas economias congeladas", () => {
    assert.equal(normalizeEconomy(ECONOMY_CASH), ECONOMY_CASH);
    assert.equal(normalizeEconomy(ECONOMY_BETA_CREDIT), ECONOMY_BETA_CREDIT);
  });

  it("recusa qualquer outra", () => {
    for (const bad of [undefined, null, "", "CASH", "beta", "both", 1, {}]) {
      assertDomain(() => normalizeEconomy(bad), "invalid-argument", String(bad));
    }
  });
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

describe("cursor — opaco, vinculado e verificado", () => {
  const base = {
    economy: ECONOMY_CASH,
    seasonId: "2026-08",
    after: key(50_000, 2, P1),
    offset: 50,
  };
  const expected = { economy: ECONOMY_CASH, seasonId: "2026-08" };

  it("faz round-trip preservando a tupla e o offset", () => {
    const decoded = decodeCursor(encodeCursor(base), expected);
    assert.deepEqual(decoded.after, base.after);
    assert.equal(decoded.offset, 50);
    assert.equal(decoded.economy, ECONOMY_CASH);
    assert.equal(decoded.seasonId, "2026-08");
  });

  it("é opaco: não vaza os campos em texto claro", () => {
    const cursor = encodeCursor(base);
    assert.ok(!cursor.includes("2026-08"));
    assert.ok(!cursor.includes(P1));
    assert.ok(!cursor.includes("scoreCentavos"));
  });

  it("nunca carrega uid — não há uid para carregar", () => {
    const decoded = Buffer.from(encodeCursor(base), "base64url").toString("utf8");
    assert.ok(!decoded.includes("uid"));
    assert.ok(decoded.includes(P1), "carrega o pseudônimo, não a conta");
  });

  it("é determinístico para a mesma entrada", () => {
    assert.equal(encodeCursor(base), encodeCursor({ ...base }));
  });

  it("REJEITA um cursor de outra temporada", () => {
    const other = encodeCursor({ ...base, seasonId: "2026-09" });
    assertDomain(
      () => decodeCursor(other, expected),
      "invalid-argument",
      "outra temporada"
    );
  });

  it("REJEITA um cursor de outra economia", () => {
    const other = encodeCursor({ ...base, economy: ECONOMY_BETA_CREDIT });
    assertDomain(
      () => decodeCursor(other, expected),
      "invalid-argument",
      "outra economia"
    );
  });

  it("REJEITA um cursor adulterado", () => {
    const valid = encodeCursor(base);
    const raw = Buffer.from(valid, "base64url").toString("utf8");
    // Mexe no offset sem recalcular o checksum.
    const tampered = raw.replace(",50]", ",999]");
    assert.notEqual(tampered, raw, "a mutação precisa mudar o texto");
    const forged = Buffer.from(tampered, "utf8").toString("base64url");

    assertDomain(
      () => decodeCursor(forged, expected),
      "invalid-argument",
      "adulterado"
    );
  });

  it("REJEITA lixo, vazio e não texto", () => {
    for (const bad of ["", "not-a-cursor", "!!!!", undefined, null, 42, {}]) {
      assertDomain(
        () => decodeCursor(bad, expected),
        "invalid-argument",
        String(bad)
      );
    }
  });

  it("REJEITA um cursor com pseudônimo malformado", () => {
    const raw = JSON.stringify([1, "cash", "2026-08", 100, 1, "PLR-123", 0]);
    // Recalcula o checksum para provar que a validação NÃO depende só dele.
    let hash = 0x811c9dc5;
    for (let i = 0; i < raw.length; i += 1) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const forged = Buffer.from(
      `${raw}.${hash.toString(36)}`,
      "utf8"
    ).toString("base64url");

    assertDomain(
      () => decodeCursor(forged, expected),
      "invalid-argument",
      "pseudônimo malformado"
    );
  });

  it("REJEITA valores negativos ou fracionários na tupla", () => {
    for (const payload of [
      [1, "cash", "2026-08", -1, 1, P1, 0],
      [1, "cash", "2026-08", 100, -1, P1, 0],
      [1, "cash", "2026-08", 100, 1, P1, -5],
      [1, "cash", "2026-08", 1.5, 1, P1, 0],
    ]) {
      const raw = JSON.stringify(payload);
      let hash = 0x811c9dc5;
      for (let i = 0; i < raw.length; i += 1) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      const forged = Buffer.from(`${raw}.${hash.toString(36)}`, "utf8").toString(
        "base64url"
      );
      assertDomain(
        () => decodeCursor(forged, expected),
        "invalid-argument",
        JSON.stringify(payload)
      );
    }
  });

  it("REJEITA uma versão desconhecida", () => {
    const raw = JSON.stringify([99, "cash", "2026-08", 100, 1, P1, 0]);
    let hash = 0x811c9dc5;
    for (let i = 0; i < raw.length; i += 1) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const forged = Buffer.from(`${raw}.${hash.toString(36)}`, "utf8").toString(
      "base64url"
    );
    assertDomain(
      () => decodeCursor(forged, expected),
      "invalid-argument",
      "versão desconhecida"
    );
  });
});

// ---------------------------------------------------------------------------
// Projeção pública
// ---------------------------------------------------------------------------

describe("projeção pública — allowlist estrita", () => {
  it("publica exatamente os campos aprovados", () => {
    const row = publicEntry(1, stored(125_000, 3, P1));

    assert.deepEqual(Object.keys(row).sort(), [
      "economy",
      "label",
      "position",
      "publicPlayerId",
      "scoreCentavos",
      "seasonId",
      "winsCount",
    ]);
    assert.equal(row.position, 1);
    assert.equal(row.publicPlayerId, P1);
    assert.equal(row.label, "Jogador A7fQ2_kB");
    assert.equal(row.scoreCentavos, 125_000);
    assert.equal(row.winsCount, 3);
  });

  it("um campo extra guardado na entry NÃO vaza", () => {
    const row = publicEntry(
      1,
      stored(100, 1, P1, {
        uid: "conta-secreta",
        user_ref: "users/conta-secreta",
        player_id: "PLR-123456",
        firstPrizeAt: new Date(),
        lastPrizeAt: new Date(),
        updatedAt: new Date(),
      })
    ) as unknown as Record<string, unknown>;

    for (const leaked of [
      "uid",
      "user_ref",
      "player_id",
      "firstPrizeAt",
      "lastPrizeAt",
      "updatedAt",
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(row, leaked),
        false,
        `${leaked} não pode aparecer na resposta pública`
      );
    }
    assert.equal(JSON.stringify(row).includes("conta-secreta"), false);
  });

  it("o rótulo nunca revela o identificador completo", () => {
    const row = publicEntry(1, stored(100, 1, P1));
    assert.notEqual(row.label, row.publicPlayerId);
    assert.ok(!row.label.includes(P1));
  });

  it("recusa uma posição inválida", () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      assertDomain(
        () => publicEntry(bad, stored(100, 1, P1)),
        "failed-precondition",
        String(bad)
      );
    }
  });

  it("recusa uma entry estruturalmente inválida", () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["pseudônimo malformado", { publicPlayerId: "PLR-123456" }],
      ["pontuação negativa", { scoreCentavos: -1 }],
      ["pontuação fracionária", { scoreCentavos: 1.5 }],
      ["vitórias zero", { winsCount: 0 }],
      ["economia inválida", { economy: "gold" }],
      ["temporada ausente", { seasonId: "" }],
    ];

    for (const [label, patch] of cases) {
      assertDomain(
        () => publicEntry(1, { ...stored(100, 1, P1), ...patch }),
        "failed-precondition",
        label
      );
    }
  });
});
