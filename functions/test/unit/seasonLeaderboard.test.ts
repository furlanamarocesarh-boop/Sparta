import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
} from "../../src/domain/economy.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  buildRankKey,
  compareEntries,
  decodeCursor,
  decodeRankKey,
  encodeCursor,
  LEADERBOARD_CURSOR_VERSION,
  LEADERBOARD_DEFAULT_LIMIT,
  LEADERBOARD_MAX_LIMIT,
  MAX_CURSOR_CHARS,
  MIN_CURSOR_SECRET_BYTES,
  normalizeEconomy,
  normalizeLimit,
  publicEntry,
  RANK_KEY_MAX,
  RANK_KEY_MIN,
  RANKING_CURSOR_SECRET_ENV,
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
  rankKey: buildRankKey(scoreCentavos, winsCount, publicPlayerId),
  scoreCentavos,
  winsCount,
  ...extra,
});

// ---------------------------------------------------------------------------
// Chave canônica
// ---------------------------------------------------------------------------

describe("chave canônica — a ordenação É a chave", () => {
  it("um sort ASCENDENTE da chave reproduz a ordem canônica exata", () => {
    // Mesmas linhas do teste do comparador, ordenadas pelos DOIS caminhos.
    const rows: OrderKey[] = [
      key(100, 2, P2),
      key(100, 2, P1),
      key(200, 1, P3),
      key(100, 3, P3),
      key(0, 1, P1),
    ];

    const byComparator = [...rows].sort(compareEntries);
    const byRankKey = [...rows].sort((a, b) => {
      const ka = buildRankKey(a.scoreCentavos, a.winsCount, a.publicPlayerId);
      const kb = buildRankKey(b.scoreCentavos, b.winsCount, b.publicPlayerId);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    assert.deepEqual(byRankKey, byComparator, "a chave precisa ser a ordenação");
  });

  it("é uma ordem total sobre um conjunto gerado — chave e comparador concordam", () => {
    const rows: OrderKey[] = [];
    for (const s of [0, 100, 200]) {
      for (const w of [0, 1, 2]) {
        for (const p of [P1, P2, P3]) rows.push(key(s, w, p));
      }
    }
    for (const a of rows) {
      for (const b of rows) {
        const ka = buildRankKey(a.scoreCentavos, a.winsCount, a.publicPlayerId);
        const kb = buildRankKey(b.scoreCentavos, b.winsCount, b.publicPlayerId);
        const viaKey = ka < kb ? -1 : ka > kb ? 1 : 0;
        assert.equal(
          viaKey,
          Math.sign(compareEntries(a, b)),
          `divergência em ${JSON.stringify([a, b])}`
        );
      }
    }
  });

  it("é ÚNICA: entries distintas nunca compartilham chave", () => {
    const seen = new Set<string>();
    for (const s of [0, 1, 100]) {
      for (const w of [0, 1, 9]) {
        for (const p of [P1, P2, P3]) {
          const k = buildRankKey(s, w, p);
          assert.equal(seen.has(k), false, `chave repetida: ${k}`);
          seen.add(k);
        }
      }
    }
    // O último componente é o id, que é o document id — logo duas entries só
    // colidiriam se compartilhassem o document id, o que é impossível.
    assert.ok(buildRankKey(100, 1, P1) !== buildRankKey(100, 1, P2));
  });

  it("cai SEMPRE dentro da faixa consultável da versão", () => {
    for (const [s, w, p] of [
      [0, 0, P1],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, P3],
      [123_456, 7, P2],
    ] as const) {
      const k = buildRankKey(s, w, p);
      assert.ok(k >= RANK_KEY_MIN, `${k} abaixo do piso`);
      assert.ok(k < RANK_KEY_MAX, `${k} acima do teto`);
    }
  });

  it("faz round-trip: decodeRankKey devolve exatamente os valores originais", () => {
    for (const [s, w, p] of [
      [0, 0, P1],
      [125_000, 3, P2],
      [Number.MAX_SAFE_INTEGER, 1, P3],
    ] as const) {
      assert.deepEqual(decodeRankKey(buildRankKey(s, w, p)), {
        scoreCentavos: s,
        winsCount: w,
        publicPlayerId: p,
      });
    }
  });

  it("RECUSA construir a chave de uma entry estruturalmente inválida", () => {
    for (const bad of [null, undefined, "100", true, -1, 1.5, NaN, Infinity]) {
      assertDomain(
        () => buildRankKey(bad, 1, P1),
        "failed-precondition",
        `score ${String(bad)}`
      );
      assertDomain(
        () => buildRankKey(100, bad, P1),
        "failed-precondition",
        `wins ${String(bad)}`
      );
    }
    for (const bad of [null, undefined, 42, "", "PLR-1", P1 + "x"]) {
      assertDomain(
        () => buildRankKey(100, 1, bad),
        "failed-precondition",
        `id ${String(bad)}`
      );
    }
  });

  it("RECUSA decodificar uma chave ausente, de outro tipo ou malformada", () => {
    for (const bad of [
      undefined,
      null,
      42,
      true,
      {},
      [],
      "",
      "v1|",
      "v0|" + "0".repeat(16) + "|" + "0".repeat(16) + "|" + P1, // versão errada
      "v2|" + "0".repeat(16) + "|" + "0".repeat(16) + "|" + P1, // versão futura
      "v1|abc|def|" + P1, // componentes não numéricos
      "v1|" + "0".repeat(15) + "|" + "0".repeat(16) + "|" + P1, // largura errada
      "v1|" + "0".repeat(16) + "|" + "0".repeat(16) + "|PLR-1", // id malformado
      "v1|" + "9".repeat(16) + "|" + "0".repeat(16) + "|" + P1, // complemento fora da faixa
    ]) {
      assertDomain(
        () => decodeRankKey(bad),
        "failed-precondition",
        JSON.stringify(bad)
      );
    }
  });
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

  it("CLAMPA um inteiro positivo acima do teto (contrato 9.1 / 16.4)", () => {
    // O contrato congelado manda servir o teto, não recusar: "limit 1000 ->
    // Clamped to 100". Recusar era desvio da matriz 16.4.
    assert.equal(normalizeLimit(101), LEADERBOARD_MAX_LIMIT);
    assert.equal(normalizeLimit(1000), LEADERBOARD_MAX_LIMIT);
    assert.equal(normalizeLimit(Number.MAX_SAFE_INTEGER), LEADERBOARD_MAX_LIMIT);
    // E o teto exato continua sendo ele mesmo.
    assert.equal(normalizeLimit(LEADERBOARD_MAX_LIMIT), LEADERBOARD_MAX_LIMIT);
  });

  it("recusa zero, negativo, fracionário e não numérico — nunca clampa esses", () => {
    // Clampar um tipo inválido inventaria um valor que o cliente não pediu.
    for (const bad of [0, -1, -1000, 1.5, 99.9, "50", "100", true, {}, [], NaN, Infinity, -Infinity]) {
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

describe("cursor — autenticado, opaco e vinculado", () => {
  // Chaves de teste. Nenhuma delas é, ou deriva de, um segredo de produção:
  // o valor real vive apenas no Secret Manager, injetado em
  // process.env[RANKING_CURSOR_SECRET_ENV] na callable.
  const SECRET = "unit-test-cursor-signing-key-0123456789ab";
  const OTHER_SECRET = "a-completely-different-key-0123456789abcd";

  const base = {
    economy: ECONOMY_CASH,
    seasonId: "2026-08",
    afterRankKey: buildRankKey(50_000, 2, P1),
    offset: 50,
  };
  const expected = { economy: ECONOMY_CASH, seasonId: "2026-08" };

  /** O texto interno de um cursor válido, antes do envelope base64url. */
  const innerOf = (cursor: string): string =>
    Buffer.from(cursor, "base64url").toString("utf8");

  const envelope = (inner: string): string =>
    Buffer.from(inner, "utf8").toString("base64url");

  /** Reassina um payload arbitrário com a chave indicada. */
  const sign = (payload: string, secret = SECRET): string =>
    envelope(
      `${payload}.${createHmac("sha256", Buffer.from(secret, "utf8"))
        .update(payload, "utf8")
        .digest("base64url")}`
    );

  /** O checksum FNV-1a público que o cursor usava antes desta correção. */
  const fnv1a = (input: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  };

  it("nomeia o segredo por variável de ambiente, sem valor no repositório", () => {
    assert.equal(RANKING_CURSOR_SECRET_ENV, "RANKING_CURSOR_HMAC_SECRET");
    assert.equal(MIN_CURSOR_SECRET_BYTES, 32);
  });

  it("faz round-trip preservando a tupla e o offset", () => {
    const decoded = decodeCursor(encodeCursor(base, SECRET), expected, SECRET);
    assert.equal(decoded.afterRankKey, base.afterRankKey);
    assert.equal(decoded.offset, 50);
    assert.equal(decoded.economy, ECONOMY_CASH);
    assert.equal(decoded.seasonId, "2026-08");
  });

  it("é determinístico para a mesma entrada e a mesma chave", () => {
    assert.equal(encodeCursor(base, SECRET), encodeCursor({ ...base }, SECRET));
  });

  it("muda inteiramente quando a chave muda", () => {
    assert.notEqual(encodeCursor(base, SECRET), encodeCursor(base, OTHER_SECRET));
  });

  it("é opaco: não vaza os campos em texto claro no envelope", () => {
    const cursor = encodeCursor(base, SECRET);
    assert.ok(!cursor.includes("2026-08"));
    assert.ok(!cursor.includes(P1));
    assert.ok(!cursor.includes("scoreCentavos"));
  });

  it("nunca carrega uid — não há uid para carregar, nem o segredo", () => {
    const inner = innerOf(encodeCursor(base, SECRET));
    assert.ok(!inner.includes("uid"));
    assert.ok(!inner.includes(SECRET), "o segredo nunca entra no cursor");
    assert.ok(inner.includes(P1), "carrega o pseudônimo, não a conta");
  });

  // ── Falha fechada quando não há chave utilizável ──────────────────────────

  it("FALHA FECHADO sem segredo — não existe cursor não assinado", () => {
    for (const missing of [undefined, null, "", 0, {}, []]) {
      assertDomain(
        () => encodeCursor(base, missing),
        "failed-precondition",
        `encode ${String(missing)}`
      );
      assertDomain(
        () => decodeCursor(encodeCursor(base, SECRET), expected, missing),
        "failed-precondition",
        `decode ${String(missing)}`
      );
    }
  });

  it("FALHA FECHADO com segredo curto demais (< 32 bytes)", () => {
    const short = "x".repeat(MIN_CURSOR_SECRET_BYTES - 1);
    assertDomain(() => encodeCursor(base, short), "failed-precondition", "encode");
    assertDomain(
      () => decodeCursor(encodeCursor(base, SECRET), expected, short),
      "failed-precondition",
      "decode"
    );
    // Exatamente 32 bytes já serve.
    const exact = "x".repeat(MIN_CURSOR_SECRET_BYTES);
    assert.equal(decodeCursor(encodeCursor(base, exact), expected, exact).offset, 50);
  });

  // ── O MAC é a barreira ────────────────────────────────────────────────────

  it("REJEITA um cursor assinado com OUTRA chave", () => {
    assertDomain(
      () => decodeCursor(encodeCursor(base, OTHER_SECRET), expected, SECRET),
      "invalid-argument",
      "chave errada"
    );
  });

  it("REJEITA adulteração de QUALQUER campo coberto pelo MAC", () => {
    const inner = innerOf(encodeCursor(base, SECRET));
    const mutations: Array<[string, string, string]> = [
      ["offset", ",50]", ",999999]"],
      ["rankKey score", "9007199254690991", "9007199254690891"],
      ["rankKey wins", "9007199254740989", "9007199254740889"],
      ["publicPlayerId", P1, P2],
      ["economy", "cash", "beta_credit"],
      ["seasonId", "2026-08", "2026-09"],
      ["version", "[2,", "[3,"],
    ];

    for (const [label, from, to] of mutations) {
      const tampered = inner.replace(from, to);
      assert.notEqual(tampered, inner, `${label}: a mutação precisa mudar o texto`);
      assertDomain(
        () => decodeCursor(envelope(tampered), expected, SECRET),
        "invalid-argument",
        `adulterado: ${label}`
      );
    }
  });

  it("REJEITA mesmo que o atacante recalcule o checksum FNV-1a antigo", () => {
    // Exatamente o ataque do achado de auditoria: o FNV-1a é público e
    // recomputável, então antes desta correção este cursor era ACEITO.
    const payload = JSON.stringify([
      LEADERBOARD_CURSOR_VERSION,
      ECONOMY_CASH,
      "2026-08",
      buildRankKey(50_000, 2, P1),
      999_999,
    ]);
    const forged = envelope(`${payload}.${fnv1a(payload)}`);

    assertDomain(
      () => decodeCursor(forged, expected, SECRET),
      "invalid-argument",
      "FNV recomputado"
    );
  });

  it("REJEITA um MAC arbitrário do comprimento correto", () => {
    const inner = innerOf(encodeCursor(base, SECRET));
    const payload = inner.slice(0, inner.lastIndexOf("."));
    const realTag = Buffer.from(inner.slice(inner.lastIndexOf(".") + 1), "base64url");
    assert.equal(realTag.length, 32, "HMAC-SHA256 tem 32 bytes");

    for (const filler of [0x00, 0xab, 0xff]) {
      const bogus = Buffer.alloc(32, filler).toString("base64url");
      assertDomain(
        () => decodeCursor(envelope(`${payload}.${bogus}`), expected, SECRET),
        "invalid-argument",
        `MAC arbitrário 0x${filler.toString(16)}`
      );
    }
  });

  it("REJEITA um MAC truncado, estendido ou ausente", () => {
    const inner = innerOf(encodeCursor(base, SECRET));
    const split = inner.lastIndexOf(".");
    const payload = inner.slice(0, split);
    const tag = Buffer.from(inner.slice(split + 1), "base64url");

    const variants: Array<[string, string]> = [
      ["truncado", tag.subarray(0, 16).toString("base64url")],
      ["1 byte a menos", tag.subarray(0, 31).toString("base64url")],
      ["estendido", Buffer.concat([tag, Buffer.alloc(1)]).toString("base64url")],
      ["vazio", ""],
    ];

    for (const [label, bogus] of variants) {
      assertDomain(
        () => decodeCursor(envelope(`${payload}.${bogus}`), expected, SECRET),
        "invalid-argument",
        label
      );
    }
    // Sem separador não há MAC nenhum.
    assertDomain(
      () => decodeCursor(envelope(payload), expected, SECRET),
      "invalid-argument",
      "sem separador"
    );
  });

  it("REJEITA um MAC válido colado em outro payload", () => {
    const a = innerOf(encodeCursor(base, SECRET));
    const b = innerOf(encodeCursor({ ...base, offset: 999 }, SECRET));
    const payloadA = a.slice(0, a.lastIndexOf("."));
    const tagB = b.slice(b.lastIndexOf(".") + 1);

    assertDomain(
      () => decodeCursor(envelope(`${payloadA}.${tagB}`), expected, SECRET),
      "invalid-argument",
      "MAC trocado"
    );
  });

  // ── Vínculo com a requisição, verificado DEPOIS do MAC ────────────────────

  it("REJEITA um cursor legitimamente assinado de OUTRA temporada", () => {
    const other = encodeCursor({ ...base, seasonId: "2026-09" }, SECRET);
    assertDomain(
      () => decodeCursor(other, expected, SECRET),
      "invalid-argument",
      "outra temporada"
    );
  });

  it("REJEITA um cursor legitimamente assinado de OUTRA economia", () => {
    const other = encodeCursor({ ...base, economy: ECONOMY_BETA_CREDIT }, SECRET);
    assertDomain(
      () => decodeCursor(other, expected, SECRET),
      "invalid-argument",
      "outra economia"
    );
  });

  // ── Validação de campos, que roda mesmo com MAC genuíno ───────────────────

  it("REJEITA lixo, vazio, não texto e cursor gigante", () => {
    for (const bad of ["", "not-a-cursor", "!!!!", undefined, null, 42, {}]) {
      assertDomain(
        () => decodeCursor(bad, expected, SECRET),
        "invalid-argument",
        String(bad)
      );
    }
    assertDomain(
      () => decodeCursor("A".repeat(MAX_CURSOR_CHARS + 1), expected, SECRET),
      "invalid-argument",
      "cursor gigante"
    );
  });

  it("REJEITA payloads implausíveis AINDA QUE assinados com a chave correta", () => {
    // Prova que a validação de campos não depende do MAC: mesmo quem detém a
    // chave não consegue injetar uma tupla impossível.
    for (const payload of [
      [2, "cash", "2026-08", "nao-e-uma-chave", 0], // chave não canônica
      [2, "cash", "2026-08", "v1|abc|def|" + P1, 0], // componentes não numéricos
      [2, "cash", "2026-08", "v0|" + "0".repeat(16) + "|" + "0".repeat(16) + "|" + P1, 0], // versão de chave errada
      [2, "cash", "2026-08", buildRankKey(100, 1, P1), -5], // offset negativo
      [2, "cash", "2026-08", buildRankKey(100, 1, P1), 1.5], // offset fracionário
      [2, "cash", "2026-08", 42, 0], // chave não textual
      [99, "cash", "2026-08", buildRankKey(100, 1, P1), 0], // versão de cursor desconhecida
      [2, "cash", "2026-08", buildRankKey(100, 1, P1)], // aridade errada
      [2, "cash", "2026-08", buildRankKey(100, 1, P1), 0, "extra"],
    ]) {
      assertDomain(
        () => decodeCursor(sign(JSON.stringify(payload)), expected, SECRET),
        "invalid-argument",
        JSON.stringify(payload)
      );
    }
  });

  // ── Discrição das mensagens de erro ───────────────────────────────────────

  it("nenhuma mensagem de erro revela segredo, MAC ou payload decodificado", () => {
    const valid = encodeCursor(base, SECRET);
    const inner = innerOf(valid);
    const payload = inner.slice(0, inner.lastIndexOf("."));
    const tag = inner.slice(inner.lastIndexOf(".") + 1);

    const attempts: Array<() => unknown> = [
      () => decodeCursor(envelope(inner.replace(",50]", ",999999]")), expected, SECRET),
      () => decodeCursor(encodeCursor(base, OTHER_SECRET), expected, SECRET),
      () => decodeCursor(encodeCursor({ ...base, seasonId: "2026-09" }, SECRET), expected, SECRET),
      () => decodeCursor(sign(JSON.stringify([1, "cash", "2026-08", 100, 1, "PLR-1", 0])), expected, SECRET),
      () => decodeCursor("not-a-cursor", expected, SECRET),
      () => decodeCursor(valid, expected, "short"),
    ];

    for (const attempt of attempts) {
      let message = "";
      try {
        attempt();
        assert.fail("deveria ter sido rejeitado");
      } catch (error) {
        assert.ok(error instanceof DomainError, "erro tipado");
        message = `${error.message} ${JSON.stringify((error as { details?: unknown }).details ?? null)}`;
      }

      for (const forbidden of [SECRET, OTHER_SECRET, tag, payload, P1, "50000", "999999"]) {
        assert.ok(
          !message.includes(forbidden),
          `mensagem vazou "${forbidden.slice(0, 12)}…": ${message}`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Projeção pública
// ---------------------------------------------------------------------------

describe("projeção pública — allowlist estrita", () => {
  it("publica exatamente os campos aprovados", () => {
    const row = publicEntry(1, P1, stored(125_000, 3, P1), ECONOMY_CASH, "2026-08");

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
      P1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stored(100, 1, P1, {
        uid: "conta-secreta",
        user_ref: "users/conta-secreta",
        player_id: "PLR-123456",
        firstPrizeAt: new Date(),
        lastPrizeAt: new Date(),
        updatedAt: new Date(),
      }),
      ECONOMY_CASH,
      "2026-08"
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
    const row = publicEntry(1, P1, stored(100, 1, P1), ECONOMY_CASH, "2026-08");
    assert.notEqual(row.label, row.publicPlayerId);
    assert.ok(!row.label.includes(P1));
  });

  it("recusa uma posição inválida", () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      assertDomain(
        () => publicEntry(bad, P1, stored(100, 1, P1), ECONOMY_CASH, "2026-08"),
        "failed-precondition",
        String(bad)
      );
    }
  });

  it("recusa uma entry estruturalmente inválida", () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["chave ausente", { rankKey: undefined }],
      ["chave de outro tipo", { rankKey: 42 }],
      ["chave nula", { rankKey: null }],
      ["chave malformada", { rankKey: "v1|abc|def|" + P1 }],
      [
        "chave de outra versão",
        { rankKey: "v0|" + "0".repeat(16) + "|" + "0".repeat(16) + "|" + P1 },
      ],
    ];

    for (const [label, patch] of cases) {
      assertDomain(
        () => publicEntry(1, P1, { ...stored(100, 1, P1), ...patch }, ECONOMY_CASH, "2026-08"),
        "failed-precondition",
        label
      );
    }
  });

  it("recusa um document id malformado, mesmo com chave válida", () => {
    for (const bad of ["", "PLR-1", P1 + "x", "  "]) {
      assertDomain(
        () => publicEntry(1, bad, stored(100, 1, P1), ECONOMY_CASH, "2026-08"),
        "failed-precondition",
        bad
      );
    }
  });

  it("RECUSA quando a chave aponta para outra identidade que o document id", () => {
    // O ataque de identidade: doc `P1` carregando a chave de `P2`.
    assertDomain(
      () => publicEntry(1, P1, stored(100, 1, P2), ECONOMY_CASH, "2026-08"),
      "failed-precondition",
      "identidade divergente"
    );
  });

  it("economy e seasonId vêm da REQUISIÇÃO, nunca do documento", () => {
    // Ambas são propriedades estruturais do PATH
    // (season_rankings/{economy}_{seasonId}/entries/{id}): uma linha alcançada
    // pelo caminho cash/2026-08 É cash/2026-08, digam o que disserem os campos.
    for (const hostile of [
      { economy: ECONOMY_BETA_CREDIT },
      { economy: "gold" },
      { economy: undefined },
      { economy: null },
      { seasonId: "2026-07" },
      { seasonId: undefined },
      { seasonId: null },
      { seasonId: "" },
      { economy: 42, seasonId: {} },
    ]) {
      const row = publicEntry(
        1,
        P1,
        { ...stored(125_000, 3, P1), ...hostile },
        ECONOMY_CASH,
        "2026-08"
      );
      assert.equal(row.economy, ECONOMY_CASH, JSON.stringify(hostile));
      assert.equal(row.seasonId, "2026-08", JSON.stringify(hostile));
      // E nada disso derruba a projeção.
      assert.equal(row.scoreCentavos, 125_000);
      assert.equal(row.publicPlayerId, P1);
    }
  });

  it("os campos redundantes NÃO são fonte de verdade: não movem nada", () => {
    // Esta é a invariante nova. `scoreCentavos`, `winsCount` e
    // `publicPlayerId` guardados são cópias de auditoria; a resposta vem da
    // chave canônica e do document id. Corrompê-los não pode mudar a resposta
    // — era exatamente por lê-los que as duas superfícies divergiam.
    const honest = publicEntry(1, P1, stored(125_000, 3, P1), ECONOMY_CASH, "2026-08");

    const tampered = publicEntry(
      1,
      P1,
      {
        ...stored(125_000, 3, P1),
        scoreCentavos: 999_999_999,
        winsCount: -7,
        publicPlayerId: P2,
        economy: "gold",
        seasonId: "1999-01",
      },
      ECONOMY_CASH,
      "2026-08"
    );

    assert.deepEqual(tampered, honest, "a resposta veio da chave canônica");
    assert.equal(tampered.scoreCentavos, 125_000);
    assert.equal(tampered.winsCount, 3);
    assert.equal(tampered.publicPlayerId, P1);
  });
});
