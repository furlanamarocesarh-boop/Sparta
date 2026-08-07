import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { ECONOMY_BETA_CREDIT, ECONOMY_CASH } from "../../src/domain/economy.js";
import { isPublicPlayerId } from "../../src/domain/publicPlayerId.js";
import {
  PUBLIC_PLAYER_ID_COLLECTION,
  PUBLIC_PLAYER_ID_INDEX_COLLECTION,
} from "../../src/domain/publicPlayerId.js";
import {
  RANKING_EVENTS_COLLECTION,
  SEASON_ENTRIES_SUBCOLLECTION,
  SEASON_RANKINGS_COLLECTION,
  seasonDocumentId,
} from "../../src/domain/seasonRanking.js";
import { buildRankKey } from "../../src/domain/seasonLeaderboard.js";

/**
 * Behavioral tests for `getSeasonLeaderboard` and `getMySeasonRanking`, run
 * against the LOCAL Firestore emulator via the Admin SDK.
 *
 * Proves the read side end to end: canonical order, exact ordinals across
 * pages, cursor binding and rejection, economy and season isolation, the
 * unranked answer, and the branch's core promise — NO uid ever leaves the
 * server, in any field, and no identity is minted by a read.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 */

type Handler = (
  data: any,
  context: any,
  options?: any
) => Promise<Record<string, unknown>>;

let getSeasonLeaderboardHandler: Handler;
let getMySeasonRankingHandler: Handler;
let db: admin.firestore.Firestore;

const SEASON = "2026-08";

/**
 * Cursor signing key for the emulator run.
 *
 * A TEST value: it is not, and does not derive from, any production secret —
 * the real key exists only in Secret Manager and is injected into
 * `RANKING_CURSOR_HMAC_SECRET` for the deployed callable. Setting the same
 * environment variable here exercises the exact production resolution path.
 */
const TEST_CURSOR_SECRET = "emulator-cursor-signing-key-0123456789ab";

/**
 * Deterministic clock: EVERY test in this suite runs "at" 2026-08-15 12:00 in
 * São Paulo — inside the fixed SEASON's month — injected through the internal
 * `now` seam, so nothing here depends on the real wall clock and the suite
 * stays green after August 2027 when 2026-08 leaves the retention window. A
 * test that needs a different instant (the retention boundaries) passes its
 * own `now`, which wins via the spread. Production keeps the REAL clock: the
 * seam exists only in the handlers' internal options, never in the payload.
 */
const FIXED_NOW = new Date("2026-08-15T15:00:00Z");

/** Deterministic pseudonyms, ascending so tie-break order is predictable. */
const IDS = [
  "Aaaaaaaaaaaaaaaaaaaaaa",
  "Bbbbbbbbbbbbbbbbbbbbbb",
  "Cccccccccccccccccccccc",
  "Dddddddddddddddddddddd",
  "Eeeeeeeeeeeeeeeeeeeeee",
];

const ctxOf = (uid: string) => ({ auth: { uid, token: {} } });

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-leaderboard-handlers";
  process.env.RANKING_CURSOR_HMAC_SECRET = TEST_CURSOR_SECRET;
  const mod = (await import("../../src/index.js")) as unknown as {
    getSeasonLeaderboardHandler: Handler;
    getMySeasonRankingHandler: Handler;
  };
  getSeasonLeaderboardHandler = (data, context, options = {}) =>
    mod.getSeasonLeaderboardHandler(data, context, {
      now: FIXED_NOW,
      ...options,
    });
  getMySeasonRankingHandler = (data, context, options = {}) =>
    mod.getMySeasonRankingHandler(data, context, {
      now: FIXED_NOW,
      ...options,
    });
  db = admin.firestore();
});

async function clearCollection(path: string): Promise<void> {
  const snap = await db.collection(path).get();
  await Promise.all(
    snap.docs.map(async (doc) => {
      for (const sub of await doc.ref.listCollections()) {
        const subSnap = await sub.get();
        await Promise.all(subSnap.docs.map((d) => d.ref.delete()));
      }
      await doc.ref.delete();
    })
  );
}

async function clearAll(): Promise<void> {
  for (const col of [
    SEASON_RANKINGS_COLLECTION,
    RANKING_EVENTS_COLLECTION,
    PUBLIC_PLAYER_ID_COLLECTION,
    PUBLIC_PLAYER_ID_INDEX_COLLECTION,
  ]) {
    await clearCollection(col);
  }
}

beforeEach(clearAll);

const parentRef = (economy: string, seasonId = SEASON) =>
  db
    .collection(SEASON_RANKINGS_COLLECTION)
    .doc(seasonDocumentId(economy as any, seasonId));

/** Writes one entry directly — the trigger is exercised by its own suite. */
async function seedEntry(
  economy: string,
  publicPlayerId: string,
  scoreCentavos: number,
  winsCount: number,
  seasonId = SEASON
): Promise<void> {
  await parentRef(economy, seasonId)
    .collection(SEASON_ENTRIES_SUBCOLLECTION)
    .doc(publicPlayerId)
    .set({
      publicPlayerId,
      economy,
      seasonId,
      // Exactly what the write path mints: the canonical key, built from the
      // normalised values and the document id.
      rankKey: buildRankKey(scoreCentavos, winsCount, publicPlayerId),
      scoreCentavos,
      winsCount,
      firstPrizeAt: admin.firestore.Timestamp.fromDate(new Date("2026-08-01")),
      lastPrizeAt: admin.firestore.Timestamp.fromDate(new Date("2026-08-15")),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

async function seedParent(
  economy: string,
  playerCount: number,
  totalScoreCentavos: number,
  seasonId = SEASON
): Promise<void> {
  await parentRef(economy, seasonId).set({
    economy,
    seasonId,
    timezone: "America/Sao_Paulo",
    playerCount,
    totalScoreCentavos,
    windowStart: admin.firestore.Timestamp.fromDate(new Date("2026-08-01T03:00:00Z")),
    windowEnd: admin.firestore.Timestamp.fromDate(new Date("2026-09-01T03:00:00Z")),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** Binds a uid to a pseudonym, the way the reservation primitive would. */
async function bindIdentity(uid: string, publicPlayerId: string): Promise<void> {
  await db.collection(PUBLIC_PLAYER_ID_COLLECTION).doc(uid).set({
    publicPlayerId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db
    .collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION)
    .doc(publicPlayerId)
    .set({ uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
}

async function expectFailure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "NO_CODE";
  }
  return assert.fail("esperava uma falha, mas resolveu");
}

/** Five players, deliberately including a full three-way tie-break chain. */
async function seedStandardSeason(): Promise<void> {
  // scores/wins chosen so every comparator level is exercised:
  //   A: 300/2  B: 200/3  C: 200/2  D: 200/2  E: 100/1
  // canonical order -> A, B, C, D, E
  await seedEntry(ECONOMY_CASH, IDS[0], 300, 2);
  await seedEntry(ECONOMY_CASH, IDS[1], 200, 3);
  await seedEntry(ECONOMY_CASH, IDS[2], 200, 2);
  await seedEntry(ECONOMY_CASH, IDS[3], 200, 2);
  await seedEntry(ECONOMY_CASH, IDS[4], 100, 1);
  await seedParent(ECONOMY_CASH, 5, 1100);
}

// ---------------------------------------------------------------------------
// getSeasonLeaderboard
// ---------------------------------------------------------------------------

describe("getSeasonLeaderboard — autenticação e payload", () => {
  it("não autenticado é rejeitado", async () => {
    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler({ economy: ECONOMY_CASH, seasonId: SEASON }, {})
      ),
      "unauthenticated"
    );
  });

  it("chave inesperada é invalid-argument", async () => {
    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: SEASON, uid: "x" },
          ctxOf("u1")
        )
      ),
      "invalid-argument"
    );
  });

  it("economia e temporada inválidas são rejeitadas", async () => {
    for (const payload of [
      { economy: "gold", seasonId: SEASON },
      { economy: ECONOMY_CASH, seasonId: "2026-13" },
      { economy: ECONOMY_CASH, seasonId: "2026" },
    ]) {
      assert.equal(
        await expectFailure(() =>
          getSeasonLeaderboardHandler(payload, ctxOf("u1"))
        ),
        "invalid-argument",
        JSON.stringify(payload)
      );
    }
  });

  it("limite acima do teto é rejeitado, não truncado em silêncio", async () => {
    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: SEASON, limit: 1000 },
          ctxOf("u1")
        )
      ),
      "invalid-argument"
    );
  });
});

describe("getSeasonLeaderboard — ordem e posição", () => {
  it("devolve a ordem canônica com ordinais exatos", async () => {
    await seedStandardSeason();

    const res = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1")
    );

    const entries = res.entries as any[];
    assert.deepEqual(
      entries.map((e) => [e.position, e.publicPlayerId]),
      [
        [1, IDS[0]],
        [2, IDS[1]],
        [3, IDS[2]],
        [4, IDS[3]],
        [5, IDS[4]],
      ]
    );
    assert.equal(res.playerCount, 5);
    assert.equal(res.nextCursor, null);
    assert.equal(res.timezone, "America/Sao_Paulo");
    assert.equal(res.amountUnit, "centavos");
  });

  it("empates de score E vitórias são desempatados pelo pseudônimo", async () => {
    await seedStandardSeason();
    const res = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1")
    );
    const entries = res.entries as any[];
    // C e D empatam em 200/2; C vem antes por id.
    assert.equal(entries[2].publicPlayerId, IDS[2]);
    assert.equal(entries[3].publicPlayerId, IDS[3]);
    assert.equal(entries[2].position + 1, entries[3].position);
  });

  it("as posições nunca se repetem", async () => {
    await seedStandardSeason();
    const res = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1")
    );
    const positions = (res.entries as any[]).map((e) => e.position);
    assert.equal(new Set(positions).size, positions.length);
  });

  it("uma temporada vazia devolve lista vazia, sem erro", async () => {
    const res = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1")
    );
    assert.deepEqual(res.entries, []);
    assert.equal(res.playerCount, 0);
    assert.equal(res.nextCursor, null);
  });
});

describe("getSeasonLeaderboard — paginação por cursor", () => {
  it("a numeração CONTINUA entre páginas", async () => {
    await seedStandardSeason();

    const page1 = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2 },
      ctxOf("u1")
    );
    assert.deepEqual(
      (page1.entries as any[]).map((e) => e.position),
      [1, 2]
    );
    assert.ok(page1.nextCursor, "deve haver próxima página");

    const page2 = await getSeasonLeaderboardHandler(
      {
        economy: ECONOMY_CASH,
        seasonId: SEASON,
        limit: 2,
        cursor: page1.nextCursor,
      },
      ctxOf("u1")
    );
    assert.deepEqual(
      (page2.entries as any[]).map((e) => e.position),
      [3, 4]
    );

    const page3 = await getSeasonLeaderboardHandler(
      {
        economy: ECONOMY_CASH,
        seasonId: SEASON,
        limit: 2,
        cursor: page2.nextCursor,
      },
      ctxOf("u1")
    );
    assert.deepEqual(
      (page3.entries as any[]).map((e) => e.position),
      [5]
    );
    assert.equal(page3.nextCursor, null, "a última página não tem cursor");
  });

  it("paginar cobre exatamente o conjunto, sem lacuna nem repetição", async () => {
    await seedStandardSeason();

    const seen: string[] = [];
    let cursor: unknown = undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const res: Record<string, unknown> = await getSeasonLeaderboardHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2, cursor },
        ctxOf("u1")
      );
      for (const e of res.entries as any[]) seen.push(e.publicPlayerId);
      cursor = res.nextCursor;
      if (cursor === null) break;
    }

    assert.deepEqual(seen, [IDS[0], IDS[1], IDS[2], IDS[3], IDS[4]]);
    assert.equal(new Set(seen).size, seen.length);
  });

  it("REJEITA um cursor de outra temporada", async () => {
    await seedStandardSeason();
    const page1 = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2 },
      ctxOf("u1")
    );

    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          {
            economy: ECONOMY_CASH,
            seasonId: "2026-09",
            limit: 2,
            cursor: page1.nextCursor,
          },
          ctxOf("u1")
        )
      ),
      "invalid-argument"
    );
  });

  it("REJEITA um cursor de outra economia", async () => {
    await seedStandardSeason();
    const page1 = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2 },
      ctxOf("u1")
    );

    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          {
            economy: ECONOMY_BETA_CREDIT,
            seasonId: SEASON,
            limit: 2,
            cursor: page1.nextCursor,
          },
          ctxOf("u1")
        )
      ),
      "invalid-argument"
    );
  });

  it("REJEITA um cursor adulterado ou inventado", async () => {
    await seedStandardSeason();
    for (const cursor of ["", "not-a-cursor", "AAAA", "eyJhIjoxfQ"]) {
      assert.equal(
        await expectFailure(() =>
          getSeasonLeaderboardHandler(
            { economy: ECONOMY_CASH, seasonId: SEASON, cursor },
            ctxOf("u1")
          )
        ),
        "invalid-argument",
        cursor
      );
    }
  });
});

describe("getSeasonLeaderboard — isolamento", () => {
  it("cash e beta são rankings independentes", async () => {
    await seedEntry(ECONOMY_CASH, IDS[0], 300, 2);
    await seedParent(ECONOMY_CASH, 1, 300);
    await seedEntry(ECONOMY_BETA_CREDIT, IDS[1], 999, 9);
    await seedParent(ECONOMY_BETA_CREDIT, 1, 999);

    const cash = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1")
    );
    const beta = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_BETA_CREDIT, seasonId: SEASON },
      ctxOf("u1")
    );

    assert.deepEqual(
      (cash.entries as any[]).map((e) => e.publicPlayerId),
      [IDS[0]]
    );
    assert.deepEqual(
      (beta.entries as any[]).map((e) => e.publicPlayerId),
      [IDS[1]]
    );
  });

  it("temporadas diferentes não se misturam", async () => {
    await seedEntry(ECONOMY_CASH, IDS[0], 300, 2, "2026-08");
    await seedParent(ECONOMY_CASH, 1, 300, "2026-08");
    await seedEntry(ECONOMY_CASH, IDS[1], 400, 4, "2026-09");
    await seedParent(ECONOMY_CASH, 1, 400, "2026-09");

    const august = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: "2026-08" },
      ctxOf("u1")
    );
    assert.deepEqual(
      (august.entries as any[]).map((e) => e.publicPlayerId),
      [IDS[0]]
    );
  });
});

describe("getSeasonLeaderboard — privacidade", () => {
  it("nenhuma resposta contém uid, nem no cursor", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-secreto", IDS[0]);

    const res = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2 },
      ctxOf("uid-secreto")
    );

    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes("uid-secreto"), false);
    assert.equal(serialized.includes('"uid"'), false);

    // E o cursor, decodificado, também não carrega uid.
    const decoded = Buffer.from(
      String(res.nextCursor),
      "base64url"
    ).toString("utf8");
    assert.equal(decoded.includes("uid-secreto"), false);
  });

  it("cada linha publica somente os campos aprovados", async () => {
    await seedStandardSeason();
    const res = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON, limit: 1 },
      ctxOf("u1")
    );

    assert.deepEqual(Object.keys((res.entries as any[])[0]).sort(), [
      "economy",
      "label",
      "position",
      "publicPlayerId",
      "scoreCentavos",
      "seasonId",
      "winsCount",
    ]);
  });

  it("uma leitura NUNCA cria identidade", async () => {
    await seedStandardSeason();
    await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("jogador-sem-identidade")
    );

    assert.equal(
      (await db.collection(PUBLIC_PLAYER_ID_COLLECTION).get()).size,
      0
    );
  });
});

// ---------------------------------------------------------------------------
// getMySeasonRanking
// ---------------------------------------------------------------------------

describe("getMySeasonRanking — autenticação e payload", () => {
  it("não autenticado é rejeitado", async () => {
    assert.equal(
      await expectFailure(() =>
        getMySeasonRankingHandler({ economy: ECONOMY_CASH, seasonId: SEASON }, {})
      ),
      "unauthenticated"
    );
  });

  it("uid no payload é invalid-argument", async () => {
    assert.equal(
      await expectFailure(() =>
        getMySeasonRankingHandler(
          { economy: ECONOMY_CASH, seasonId: SEASON, uid: "outro" },
          ctxOf("u1")
        )
      ),
      "invalid-argument"
    );
  });
});

describe("getMySeasonRanking — posição exata", () => {
  it("devolve a MESMA posição que o leaderboard paginado", async () => {
    await seedStandardSeason();
    for (let i = 0; i < IDS.length; i += 1) {
      await bindIdentity(`uid-${i}`, IDS[i]);
    }

    const board = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-0")
    );
    const expected = new Map(
      (board.entries as any[]).map((e) => [e.publicPlayerId, e.position])
    );

    for (let i = 0; i < IDS.length; i += 1) {
      const mine = await getMySeasonRankingHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON },
        ctxOf(`uid-${i}`)
      );
      assert.equal(mine.isRanked, true, IDS[i]);
      assert.equal(mine.rank, expected.get(IDS[i]), `posição de ${IDS[i]}`);
    }
  });

  it("resolve os três desempates: score, vitórias e pseudônimo", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-c", IDS[2]);
    await bindIdentity("uid-d", IDS[3]);

    const c = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-c")
    );
    const d = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-d")
    );

    // C e D empatam em 200/2 — B (200/3) está à frente de ambos.
    assert.equal(c.rank, 3);
    assert.equal(d.rank, 4);
  });

  it("o líder é a posição 1", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a")
    );
    assert.equal(res.rank, 1);
    assert.equal((res.entry as any).scoreCentavos, 300);
  });
});

describe("getMySeasonRanking — não ranqueado", () => {
  it("sem identidade: isRanked false e rank null", async () => {
    await seedStandardSeason();

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("jogador-novo")
    );

    assert.equal(res.isRanked, false);
    assert.equal(res.rank, null);
    assert.equal(res.entry, null);
    assert.equal(res.playerCount, 5);
  });

  it("com identidade mas sem prêmio: isRanked false", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-sem-premio", IDS[4].replace(/E/g, "F"));

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-sem-premio")
    );

    assert.equal(res.isRanked, false);
    assert.equal(res.rank, null);
    assert.equal(res.entry, null);
  });

  it("NÃO cria entry fictícia nem identidade", async () => {
    await seedStandardSeason();
    const before = (
      await parentRef(ECONOMY_CASH)
        .collection(SEASON_ENTRIES_SUBCOLLECTION)
        .get()
    ).size;

    await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("jogador-novo")
    );

    assert.equal(
      (
        await parentRef(ECONOMY_CASH)
          .collection(SEASON_ENTRIES_SUBCOLLECTION)
          .get()
      ).size,
      before,
      "nenhuma entry pode ser criada por uma leitura"
    );
    assert.equal(
      (await db.collection(PUBLIC_PLAYER_ID_COLLECTION).get()).size,
      0,
      "nenhuma identidade pode ser criada por uma leitura"
    );
  });
});

describe("getMySeasonRanking — privacidade e isolamento", () => {
  it("nunca devolve o uid", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-secreto", IDS[0]);

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-secreto")
    );

    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes("uid-secreto"), false);
    assert.equal(serialized.includes('"uid"'), false);
    assert.equal(isPublicPlayerId((res.entry as any).publicPlayerId), true);
  });

  it("a entry devolvida traz somente os campos aprovados", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a")
    );

    assert.deepEqual(Object.keys(res.entry as any).sort(), [
      "label",
      "publicPlayerId",
      "scoreCentavos",
      "winsCount",
    ]);
  });

  it("a posição em cash não vaza para beta", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);

    const beta = await getMySeasonRankingHandler(
      { economy: ECONOMY_BETA_CREDIT, seasonId: SEASON },
      ctxOf("uid-a")
    );

    assert.equal(beta.isRanked, false, "o jogador não pontuou em beta");
    assert.equal(beta.rank, null);
  });
});

// ---------------------------------------------------------------------------
// Correção 1 — cursor autenticado, na callable real
// ---------------------------------------------------------------------------

describe("getSeasonLeaderboard — cursor autenticado ponta a ponta", () => {
  /** Um cursor legítimo da página 1, emitido pela própria callable. */
  async function mintCursor(): Promise<string> {
    await seedStandardSeason();
    const page1 = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2 },
      ctxOf("uid-1")
    );
    const cursor = page1.nextCursor;
    assert.equal(typeof cursor, "string", "a página 1 precisa emitir um cursor");
    return cursor as string;
  }

  it("o cursor emitido é aceito de volta e continua a numeração", async () => {
    const cursor = await mintCursor();
    const page2 = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2, cursor },
      ctxOf("uid-1")
    );
    assert.deepEqual(
      (page2.entries as any[]).map((e) => e.position),
      [3, 4]
    );
  });

  it("REJEITA um cursor forjado com o checksum FNV-1a público", async () => {
    await seedStandardSeason();
    // O ataque exato do achado: o FNV-1a é recomputável por qualquer cliente.
    const payload = JSON.stringify([1, ECONOMY_CASH, SEASON, 300, 2, IDS[0], 0]);
    let hash = 0x811c9dc5;
    for (let i = 0; i < payload.length; i += 1) {
      hash ^= payload.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const forged = Buffer.from(
      `${payload}.${hash.toString(36)}`,
      "utf8"
    ).toString("base64url");

    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: SEASON, cursor: forged },
          ctxOf("uid-1")
        )
      ),
      "invalid-argument"
    );
  });

  it("REJEITA um cursor válido com o offset adulterado", async () => {
    const cursor = await mintCursor();
    const inner = Buffer.from(cursor, "base64url").toString("utf8");
    const split = inner.lastIndexOf(".");
    const tampered = `${inner.slice(0, split).replace(/,2\]$/, ",999999]")}.${inner.slice(split + 1)}`;
    assert.notEqual(tampered, inner, "a mutação precisa mudar o payload");

    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          {
            economy: ECONOMY_CASH,
            seasonId: SEASON,
            cursor: Buffer.from(tampered, "utf8").toString("base64url"),
          },
          ctxOf("uid-1")
        )
      ),
      "invalid-argument"
    );
  });

  it("FALHA FECHADO quando o segredo não está no ambiente", async () => {
    await seedStandardSeason();
    const saved = process.env.RANKING_CURSOR_HMAC_SECRET;
    try {
      delete process.env.RANKING_CURSOR_HMAC_SECRET;
      // Sem chave não se emite cursor...
      assert.equal(
        await expectFailure(() =>
          getSeasonLeaderboardHandler(
            { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2 },
            ctxOf("uid-1")
          )
        ),
        "failed-precondition"
      );
      // ...nem se aceita um.
      assert.equal(
        await expectFailure(() =>
          getSeasonLeaderboardHandler(
            { economy: ECONOMY_CASH, seasonId: SEASON, cursor: "qualquer" },
            ctxOf("uid-1")
          )
        ),
        "failed-precondition"
      );
    } finally {
      process.env.RANKING_CURSOR_HMAC_SECRET = saved;
    }
  });

  it("REJEITA um cursor assinado com OUTRA chave", async () => {
    const cursor = await mintCursor();
    const saved = process.env.RANKING_CURSOR_HMAC_SECRET;
    try {
      process.env.RANKING_CURSOR_HMAC_SECRET =
        "a-rotated-cursor-signing-key-0123456789ab";
      assert.equal(
        await expectFailure(() =>
          getSeasonLeaderboardHandler(
            { economy: ECONOMY_CASH, seasonId: SEASON, cursor },
            ctxOf("uid-1")
          )
        ),
        "invalid-argument"
      );
    } finally {
      process.env.RANKING_CURSOR_HMAC_SECRET = saved;
    }
  });

  it("o cliente NÃO controla a chave: cursorSecret no payload é rejeitado", async () => {
    await seedStandardSeason();
    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          {
            economy: ECONOMY_CASH,
            seasonId: SEASON,
            cursorSecret: "chave-escolhida-pelo-atacante-0123456789",
          },
          ctxOf("uid-1")
        )
      ),
      "invalid-argument",
      "cursorSecret não está na allowlist do payload"
    );
  });

  it("o segredo nunca aparece na resposta nem no cursor", async () => {
    const cursor = await mintCursor();
    const page = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON, limit: 2, cursor },
      ctxOf("uid-1")
    );
    const blob = JSON.stringify(page) + cursor;
    assert.ok(!blob.includes(TEST_CURSOR_SECRET));
    assert.ok(!blob.includes("RANKING_CURSOR_HMAC_SECRET"));
  });
});

// ---------------------------------------------------------------------------
// Correção 2 — ordinal a partir de UM snapshot consistente
// ---------------------------------------------------------------------------

describe("getMySeasonRanking — snapshot único e consistente", () => {
  it("as contagens NÃO enxergam uma escrita concorrente iniciada após a 1ª leitura", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-c", IDS[2]); // C: 200/2 -> posição 3

    let fired = 0;
    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-c"),
      {
        // A transação já fixou seu snapshot; esta escrita é posterior a ele.
        afterFirstRead: async () => {
          fired += 1;
          // E (100/1) salta para 999/9, o que colocaria C em 4º
          // se as contagens fossem lidas fora da transação.
          await seedEntry(ECONOMY_CASH, IDS[4], 999, 9);
        },
      }
    );

    assert.equal(fired, 1, "o ponto de sincronização precisa ter rodado");
    assert.equal(res.isRanked, true);
    assert.equal(
      res.rank,
      3,
      "a posição vem do snapshot da transação, não de leituras intercaladas"
    );

    // E a escrita realmente aconteceu: a leitura seguinte já a enxerga.
    const depois = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-c")
    );
    assert.equal(depois.rank, 4, "a escrita concorrente era real e efetiva");
  });

  it("rank e playerCount vêm do MESMO snapshot", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a"),
      {
        afterFirstRead: async () => {
          await seedParent(ECONOMY_CASH, 99, 999_999);
          await seedEntry(ECONOMY_CASH, "Zzzzzzzzzzzzzzzzzzzzzz", 500, 5);
        },
      }
    );

    assert.equal(res.rank, 1, "A continua líder no snapshot");
    assert.equal(res.playerCount, 5, "playerCount é do mesmo snapshot do rank");
  });

  it("o não-ranqueado também responde a partir de um snapshot", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-x", "Xxxxxxxxxxxxxxxxxxxxxx"); // sem entry

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-x"),
      {
        afterFirstRead: async () => {
          await seedParent(ECONOMY_CASH, 42, 4200);
        },
      }
    );

    assert.equal(res.isRanked, false);
    assert.equal(res.rank, null);
    assert.equal(res.playerCount, 5, "o parent lido é o do snapshot");
  });

  it("os três desempates continuam exatos dentro da transação", async () => {
    await seedStandardSeason();
    for (let i = 0; i < IDS.length; i += 1) await bindIdentity(`uid-${i}`, IDS[i]);

    const ranks: number[] = [];
    for (let i = 0; i < IDS.length; i += 1) {
      const res = await getMySeasonRankingHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON },
        ctxOf(`uid-${i}`)
      );
      ranks.push(res.rank as number);
    }
    // A:300/2  B:200/3  C:200/2  D:200/2  E:100/1 — inclui empate triplo em 200.
    assert.deepEqual(ranks, [1, 2, 3, 4, 5]);
    assert.equal(new Set(ranks).size, 5, "nenhuma posição se repete");
  });

  it("a transação é somente leitura: nada é persistido pela consulta", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);

    const antes = await parentRef(ECONOMY_CASH)
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .doc(IDS[0])
      .get();

    await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a")
    );

    const depois = await parentRef(ECONOMY_CASH)
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .doc(IDS[0])
      .get();

    assert.deepEqual(depois.data(), antes.data(), "a entry não foi tocada");
    assert.equal(
      depois.updateTime!.isEqual(antes.updateTime!),
      true,
      "nem o updateTime mudou — nenhuma escrita, nem de posição"
    );
  });
});

// ---------------------------------------------------------------------------
// Reauditoria — cenários que isolam CADA aggregate individualmente
// ---------------------------------------------------------------------------

describe("getMySeasonRanking — isolamento por aggregate", () => {
  // O teste original de concorrência só discrimina o 1º count (score maior).
  // Estes dois cenários movem um concorrente para dentro de EXATAMENTE um dos
  // outros dois conjuntos, então cada um falha se — e somente se — o SEU
  // aggregate escapar da transação.

  it("Cenário A — SÓ o segundo count muda: wins de um empatado em score", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-c", IDS[2]); // C: 200/2 -> posição 3

    let fired = 0;
    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-c"),
      {
        afterFirstRead: async () => {
          fired += 1;
          // E: 100/1 -> 200/3. Para C isso altera EXCLUSIVAMENTE o 2º conjunto:
          //   1º (score > 200): E chega EM 200, não acima — inalterado {A};
          //   2º (==200, wins > 2): E entra — {B} vira {B, E};
          //   3º (==200, ==2, id < C): E tem id posterior a C — inalterado {};
          //   elegível: E já existia — count total inalterado (5).
          await seedEntry(ECONOMY_CASH, IDS[4], 200, 3);
        },
      }
    );

    assert.equal(fired, 1, "a seam precisa disparar exatamente uma vez");
    assert.equal(res.isRanked, true);
    assert.equal(
      res.rank,
      3,
      "o 2º count veio do snapshot — um vazamento SÓ dele já daria 4"
    );
    assert.equal(res.playerCount, 5, "playerCount do mesmo snapshot");

    // A escrita era real: fora da transação o estado novo vale.
    const depois = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-c")
    );
    assert.equal(depois.rank, 4, "a escrita concorrente foi efetiva");
    assert.equal(depois.playerCount, 5);
  });

  it("Cenário B — SÓ o terceiro count muda: empate total com id anterior", async () => {
    // X: id lexicograficamente ANTERIOR a C, seed inicial fora dos três
    // conjuntos à frente de C (100/1 não supera nem empata os 200 de C).
    const X = "Baaaaaaaaaaaaaaaaaaaaa";
    await seedStandardSeason();
    await seedEntry(ECONOMY_CASH, X, 100, 1);
    await seedParent(ECONOMY_CASH, 6, 1200);
    await bindIdentity("uid-c", IDS[2]); // C: 200/2

    let fired = 0;
    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-c"),
      {
        afterFirstRead: async () => {
          fired += 1;
          // X: 100/1 -> 200/2. Para C isso altera EXCLUSIVAMENTE o 3º conjunto:
          //   1º (score > 200): X chega EM 200 — inalterado {A};
          //   2º (==200, wins > 2): X empata em 2, não supera — inalterado {B};
          //   3º (==200, ==2, id < C): "Baaa…" < "Cccc…" — {} vira {X};
          //   elegível: X já existia — count total inalterado (6).
          await seedEntry(ECONOMY_CASH, X, 200, 2);
        },
      }
    );

    assert.equal(fired, 1, "a seam precisa disparar exatamente uma vez");
    assert.equal(res.isRanked, true);
    assert.equal(
      res.rank,
      3,
      "o 3º count veio do snapshot — um vazamento SÓ dele já daria 4"
    );
    assert.equal(res.playerCount, 6, "playerCount do mesmo snapshot");

    const depois = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-c")
    );
    assert.equal(depois.rank, 4, "a escrita concorrente foi efetiva");
    assert.equal(depois.playerCount, 6);
  });
});

// ---------------------------------------------------------------------------
// Reauditoria — conjunto elegível: paridade estrutural com o leaderboard
// ---------------------------------------------------------------------------

describe("conjunto canônico — corrupção falha fechada nas DUAS callables", () => {
  /**
   * Escreve uma entry fora de banda. As fixtures partem SEMPRE de uma entry
   * completa, idêntica à que o write path produz, e corrompem exatamente um
   * campo — nunca um documento artificialmente ilegível.
   */
  async function corruptEntry(
    id: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const base = {
      publicPlayerId: id,
      economy: ECONOMY_CASH,
      seasonId: SEASON,
      rankKey: buildRankKey(500, 9, id),
      scoreCentavos: 500,
      winsCount: 9,
      firstPrizeAt: admin.firestore.Timestamp.fromDate(new Date("2026-08-01")),
      lastPrizeAt: admin.firestore.Timestamp.fromDate(new Date("2026-08-15")),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await parentRef(ECONOMY_CASH)
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .doc(id)
      .set({ ...base, ...patch });
  }

  /** Both surfaces must reach the SAME public decision on the same season. */
  async function bothFailClosed(label: string): Promise<void> {
    const board = await expectFailure(() =>
      getSeasonLeaderboardHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON },
        ctxOf("uid-any")
      )
    );
    const mine = await expectFailure(() =>
      getMySeasonRankingHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON },
        ctxOf("uid-c")
      )
    );
    assert.equal(board, "failed-precondition", `${label}: leaderboard`);
    assert.equal(mine, "failed-precondition", `${label}: posição individual`);
  }

  const Z = "Zzzzzzzzzzzzzzzzzzzzzz";

  // O caso original da auditoria, agora com o veredito novo.
  it("A/C válidos + Z com winsCount inválido + parent 3: AMBAS falham fechadas", async () => {
    await seedEntry(ECONOMY_CASH, IDS[0], 300, 2);
    await seedEntry(ECONOMY_CASH, IDS[2], 200, 2);
    await seedParent(ECONOMY_CASH, 3, 1000);
    await corruptEntry(Z, { winsCount: null, rankKey: 42 });
    await bindIdentity("uid-c", IDS[2]);

    await bothFailClosed("winsCount inválido");
  });

  // A chave canônica é a ÚNICA fonte de ordenação: corromper as cópias de
  // auditoria não pode mudar resposta nenhuma, nem derrubar o ranking.
  for (const [label, patch] of [
    ["scoreCentavos ausente", { scoreCentavos: admin.firestore.FieldValue.delete() }],
    ["scoreCentavos null", { scoreCentavos: null }],
    ["scoreCentavos boolean", { scoreCentavos: true }],
    ["scoreCentavos string", { scoreCentavos: "500" }],
    ["scoreCentavos negativo", { scoreCentavos: -1 }],
    ["scoreCentavos fracionário", { scoreCentavos: 1.5 }],
    ["scoreCentavos NaN", { scoreCentavos: NaN }],
    ["winsCount ausente", { winsCount: admin.firestore.FieldValue.delete() }],
    ["winsCount null", { winsCount: null }],
    ["winsCount boolean", { winsCount: false }],
    ["winsCount string", { winsCount: "9" }],
    ["winsCount negativo", { winsCount: -1 }],
    ["winsCount fracionário", { winsCount: 2.5 }],
    ["winsCount NaN", { winsCount: NaN }],
    ["publicPlayerId ausente", { publicPlayerId: admin.firestore.FieldValue.delete() }],
    ["publicPlayerId null", { publicPlayerId: null }],
    ["publicPlayerId número", { publicPlayerId: 42 }],
    ["publicPlayerId vazio", { publicPlayerId: "" }],
    ["publicPlayerId malformado", { publicPlayerId: "PLR-1" }],
    ["publicPlayerId != document id", { publicPlayerId: IDS[0] }],
  ] as const) {
    it(`cópia de auditoria corrompida (${label}) NÃO move nada`, async () => {
      await seedStandardSeason();
      await bindIdentity("uid-c", IDS[2]);
      // A entry de E continua com a chave canônica correta; só a cópia muda.
      await parentRef(ECONOMY_CASH)
        .collection(SEASON_ENTRIES_SUBCOLLECTION)
        .doc(IDS[4])
        .update(patch as Record<string, unknown>);

      const board = await getSeasonLeaderboardHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON },
        ctxOf("uid-any")
      );
      assert.equal((board.entries as any[]).length, 5, label);
      assert.equal(board.playerCount, 5, label);
      assert.deepEqual(
        (board.entries as any[]).map((e) => e.publicPlayerId),
        IDS,
        `${label}: a ordem vem da chave canônica`
      );

      const mine = await getMySeasonRankingHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON },
        ctxOf("uid-c")
      );
      assert.equal(mine.rank, 3, label);
      assert.equal(mine.playerCount, 5, label);
    });
  }

  // Corromper a CHAVE, por outro lado, torna a entry não consultável — e isso
  // as duas callables detectam pelo count físico, sem varredura.
  for (const [label, patch] of [
    ["chave ausente", { rankKey: admin.firestore.FieldValue.delete() }],
    ["chave null", { rankKey: null }],
    ["chave numérica", { rankKey: 42 }],
    ["chave boolean", { rankKey: true }],
    ["chave array", { rankKey: ["v1|x"] }],
    ["chave mapa", { rankKey: { a: 1 } }],
    ["chave de outra versão", { rankKey: "v0|" + "0".repeat(16) + "|" + "0".repeat(16) + "|" + "Zzzzzzzzzzzzzzzzzzzzzz" }],
    ["chave de versão futura", { rankKey: "v2|" + "0".repeat(16) + "|" + "0".repeat(16) + "|" + "Zzzzzzzzzzzzzzzzzzzzzz" }],
    ["chave estruturalmente inválida", { rankKey: "v1|abc|def|xyz" }],
  ] as const) {
    it(`chave canônica corrompida (${label}): AMBAS falham fechadas`, async () => {
      await seedStandardSeason();
      await bindIdentity("uid-c", IDS[2]);
      await parentRef(ECONOMY_CASH)
        .collection(SEASON_ENTRIES_SUBCOLLECTION)
        .doc(IDS[4])
        .update(patch as Record<string, unknown>);

      await bothFailClosed(label);
    });
  }

  it("chave apontando para OUTRA identidade que o document id: falha fechada", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-c", IDS[2]);
    // O documento de E passa a carregar a chave de A: mesma faixa canônica,
    // então o count não muda — quem barra é a reconciliação id ↔ chave.
    await parentRef(ECONOMY_CASH)
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .doc(IDS[4])
      .update({ rankKey: buildRankKey(100, 1, IDS[0]) });

    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: SEASON },
          ctxOf("uid-any")
        )
      ),
      "failed-precondition",
      "o leaderboard renderiza a linha e detecta a divergência"
    );
  });

  it("dois jogadores com MESMO score e wins continuam totalmente ordenados", async () => {
    // C e D empatam em 200/2; o desempate final é o document id, que é único.
    await seedStandardSeason();
    for (let i = 0; i < IDS.length; i += 1) await bindIdentity(`uid-${i}`, IDS[i]);

    const board = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-0")
    );
    assert.deepEqual(
      (board.entries as any[]).map((e) => e.position),
      [1, 2, 3, 4, 5],
      "nenhuma posição compartilhada"
    );

    const ranks: number[] = [];
    for (let i = 0; i < IDS.length; i += 1) {
      const mine = await getMySeasonRankingHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON },
        ctxOf(`uid-${i}`)
      );
      ranks.push(mine.rank as number);
    }
    assert.deepEqual(ranks, [1, 2, 3, 4, 5], "rank concorda com o leaderboard");
  });

  it("um pseudônimo NÃO pode ocupar dois documentos: a chave é única", async () => {
    // Uma segunda entry tentando representar C. O document id difere, então a
    // chave difere — e a chave carrega o id, que não bate com o documento.
    await seedStandardSeason();
    await bindIdentity("uid-c", IDS[2]);
    const impostor = "Zzzzzzzzzzzzzzzzzzzzzz";
    await parentRef(ECONOMY_CASH)
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .doc(impostor)
      .set({
        publicPlayerId: IDS[2],
        economy: ECONOMY_CASH,
        seasonId: SEASON,
        rankKey: buildRankKey(200, 2, IDS[2]),
        scoreCentavos: 200,
        winsCount: 2,
      });

    // O count físico subiu para 6 enquanto o parent declara 5.
    await bothFailClosed("pseudônimo duplicado");
  });
});

// ---------------------------------------------------------------------------
// Reauditoria — parent e entry, todas as combinações
// ---------------------------------------------------------------------------

describe("getMySeasonRanking — parent e entry", () => {
  it("parent e entry ausentes: não ranqueado com playerCount 0", async () => {
    await bindIdentity("uid-x", "Xxxxxxxxxxxxxxxxxxxxxx");

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-x")
    );

    assert.equal(res.isRanked, false);
    assert.equal(res.rank, null);
    assert.equal(res.entry, null);
    assert.equal(res.playerCount, 0);
  });

  it("parent AUSENTE com entry EXISTENTE falha fechado — nunca rank com playerCount 0", async () => {
    // O mesmo estado que o write path (decideParent) já trata como corrupção.
    await seedEntry(ECONOMY_CASH, IDS[2], 200, 2); // entry sem parent
    await bindIdentity("uid-c", IDS[2]);

    assert.equal(
      await expectFailure(() =>
        getMySeasonRankingHandler(
          { economy: ECONOMY_CASH, seasonId: SEASON },
          ctxOf("uid-c")
        )
      ),
      "failed-precondition",
      "a leitura responde do mesmo invariante fail-closed do write path"
    );
  });

  it("parent EXISTENTE com entry ausente: não ranqueado com o playerCount elegível", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-x", "Xxxxxxxxxxxxxxxxxxxxxx");

    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-x")
    );

    assert.equal(res.isRanked, false);
    assert.equal(res.rank, null);
    assert.equal(res.playerCount, 5);
  });
});

// ---------------------------------------------------------------------------
// Reauditoria — retenção: a janela de 12 temporadas (§8.4)
// ---------------------------------------------------------------------------

describe("retenção — somente a temporada corrente e as 11 anteriores", () => {
  // Relógios determinísticos, meio do mês para ficar longe de qualquer borda
  // de fuso. SEASON = 2026-08 em todos os casos; o que muda é o "agora".
  const AGO_2026 = new Date("2026-08-15T12:00:00Z"); // corrente: idade 0
  const JUL_2027 = new Date("2027-07-15T12:00:00Z"); // 11ª anterior (cruza o ano)
  const AGO_2027 = new Date("2027-08-15T12:00:00Z"); // 12ª anterior: expira
  const FUTURA = "2026-09"; // com AGO_2026, um mês no futuro

  it("getSeasonLeaderboard serve a temporada corrente", async () => {
    await seedStandardSeason();
    const res = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1"),
      { now: AGO_2026 }
    );
    assert.equal(res.success, true);
    assert.equal((res.entries as any[]).length, 5);
  });

  it("getSeasonLeaderboard serve a 11ª temporada anterior, cruzando o ano", async () => {
    await seedStandardSeason();
    const res = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1"),
      { now: JUL_2027 }
    );
    assert.equal(res.success, true);
    assert.equal((res.entries as any[]).length, 5);
  });

  it("getSeasonLeaderboard REJEITA a 12ª temporada anterior", async () => {
    await seedStandardSeason();
    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: SEASON },
          ctxOf("u1"),
          { now: AGO_2027 }
        )
      ),
      "invalid-argument"
    );
  });

  it("getSeasonLeaderboard REJEITA uma temporada futura", async () => {
    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: FUTURA },
          ctxOf("u1"),
          { now: AGO_2026 }
        )
      ),
      "invalid-argument"
    );
  });

  it("getMySeasonRanking serve a temporada corrente", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);
    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a"),
      { now: AGO_2026 }
    );
    assert.equal(res.rank, 1);
  });

  it("getMySeasonRanking serve a 11ª temporada anterior, cruzando o ano", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);
    const res = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a"),
      { now: JUL_2027 }
    );
    assert.equal(res.rank, 1);
  });

  it("getMySeasonRanking REJEITA a 12ª temporada anterior", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);
    assert.equal(
      await expectFailure(() =>
        getMySeasonRankingHandler(
          { economy: ECONOMY_CASH, seasonId: SEASON },
          ctxOf("uid-a"),
          { now: AGO_2027 }
        )
      ),
      "invalid-argument"
    );
  });

  it("getMySeasonRanking REJEITA uma temporada futura", async () => {
    assert.equal(
      await expectFailure(() =>
        getMySeasonRankingHandler(
          { economy: ECONOMY_CASH, seasonId: FUTURA },
          ctxOf("u1"),
          { now: AGO_2026 }
        )
      ),
      "invalid-argument"
    );
  });

  it("a mensagem de rejeição é GENÉRICA: igual para expirada e futura", async () => {
    // Distinguir expirada de futura revelaria quais temporadas têm dados.
    const messages: string[] = [];
    for (const [seasonId, now] of [
      [SEASON, AGO_2027],
      [FUTURA, AGO_2026],
    ] as const) {
      try {
        await getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId },
          ctxOf("u1"),
          { now }
        );
        assert.fail("deveria ter sido rejeitada");
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    assert.equal(messages[0], messages[1], "uma única mensagem pública");
  });

  // ── A fronteira REAL de São Paulo, não a de UTC ──────────────────────────
  // São Paulo é UTC-3 o ano inteiro (sem horário de verão desde 2019), então a
  // virada mensal acontece às 03:00Z. Estes casos ficam nos dois lados dessa
  // virada, onde o mês de São Paulo e o de UTC DIFEREM — trocar o cálculo por
  // UTC muda o mês corrente e, com ele, a janela de retenção.
  const SP_AINDA_AGOSTO = new Date("2026-09-01T02:59:00Z"); // 31/08 23:59 -03
  const SP_JA_SETEMBRO = new Date("2026-09-01T03:01:00Z"); // 01/09 00:01 -03

  it("virada mensal de São Paulo: 02:59Z ainda é agosto para AMBAS as callables", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);

    // Agosto/2026 é o mês CORRENTE em São Paulo -> servido.
    const board = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1"),
      { now: SP_AINDA_AGOSTO }
    );
    assert.equal(board.success, true);

    const mine = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a"),
      { now: SP_AINDA_AGOSTO }
    );
    assert.equal(mine.rank, 1);

    // E setembro ainda é FUTURO nesse instante — em UTC já não seria.
    for (const call of [
      () =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: "2026-09" },
          ctxOf("u1"),
          { now: SP_AINDA_AGOSTO }
        ),
      () =>
        getMySeasonRankingHandler(
          { economy: ECONOMY_CASH, seasonId: "2026-09" },
          ctxOf("uid-a"),
          { now: SP_AINDA_AGOSTO }
        ),
    ]) {
      assert.equal(
        await expectFailure(call),
        "invalid-argument",
        "setembro ainda é futuro às 02:59Z em São Paulo"
      );
    }
  });

  it("virada mensal de São Paulo: 03:01Z já é setembro para AMBAS as callables", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);

    // Dois minutos depois, setembro passou a ser o mês corrente.
    const board = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: "2026-09" },
      ctxOf("u1"),
      { now: SP_JA_SETEMBRO }
    );
    assert.equal(board.success, true);
    assert.equal((board.entries as any[]).length, 0, "setembro está vazio");

    const mine = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: "2026-09" },
      ctxOf("uid-a"),
      { now: SP_JA_SETEMBRO }
    );
    assert.equal(mine.isRanked, false);

    // E agosto virou a temporada anterior — continua dentro da janela.
    const agosto = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("u1"),
      { now: SP_JA_SETEMBRO }
    );
    assert.equal((agosto.entries as any[]).length, 5);
  });

  it("virada de ANO em São Paulo: 2027-01-01T02:59Z ainda é dezembro/2026", async () => {
    // Mês corrente em São Paulo = 2026-12. A 11ª anterior é 2026-01 (servida)
    // e a 12ª é 2025-12 (rejeitada). Em UTC o instante já seria janeiro/2027,
    // o que deslocaria a janela inteira em um mês e inverteria os dois casos.
    const virada = new Date("2027-01-01T02:59:00Z"); // 31/12/2026 23:59 -03

    for (const call of [
      () =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: "2026-01" },
          ctxOf("u1"),
          { now: virada }
        ),
      () =>
        getMySeasonRankingHandler(
          { economy: ECONOMY_CASH, seasonId: "2026-01" },
          ctxOf("u1"),
          { now: virada }
        ),
    ]) {
      const res = await call();
      assert.equal(res.success, true, "janeiro/2026 é a 11ª anterior");
    }

    for (const call of [
      () =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: "2025-12" },
          ctxOf("u1"),
          { now: virada }
        ),
      () =>
        getMySeasonRankingHandler(
          { economy: ECONOMY_CASH, seasonId: "2025-12" },
          ctxOf("u1"),
          { now: virada }
        ),
    ]) {
      assert.equal(
        await expectFailure(call),
        "invalid-argument",
        "dezembro/2025 é a 12ª anterior"
      );
    }

    // E o outro lado da virada: 03:01Z já é janeiro/2027, então 2026-01 passa
    // a ser a 12ª anterior e é rejeitada. Sob UTC nada mudaria entre os dois
    // instantes — é isto que torna o teste discriminante.
    const depois = new Date("2027-01-01T03:01:00Z"); // 01/01/2027 00:01 -03
    assert.equal(
      await expectFailure(() =>
        getSeasonLeaderboardHandler(
          { economy: ECONOMY_CASH, seasonId: "2026-01" },
          ctxOf("u1"),
          { now: depois }
        )
      ),
      "invalid-argument",
      "dois minutos depois, 2026-01 saiu da janela"
    );
  });
});

// ---------------------------------------------------------------------------
// Payload endurecido — protótipo, herança, accessors e symbols
// ---------------------------------------------------------------------------

describe("payload endurecido — protótipo e campos herdados", () => {
  // Valores-canário: se qualquer um vazar numa mensagem de erro, o teste de
  // discrição falha. Nenhum deles é, ou deriva de, um segredo real.
  const CANARY_SECRET = "canary-attacker-chosen-key-0123456789abcdef";
  const CANARY_VALUE = "canary-smuggled-value-xyz";

  const VALID = { economy: ECONOMY_CASH, seasonId: SEASON };

  /** Both ranking callables, invoked at runtime through the wrapped handlers. */
  const CALLABLES: ReadonlyArray<
    [string, (data: unknown) => Promise<Record<string, unknown>>]
  > = [
    ["getSeasonLeaderboard", (data) => getSeasonLeaderboardHandler(data, ctxOf("u1"))],
    ["getMySeasonRanking", (data) => getMySeasonRankingHandler(data, ctxOf("u1"))],
  ];

  /** Captures the error an invocation raises, code and message. */
  async function capture(
    fn: () => Promise<unknown>
  ): Promise<{ code: string; message: string }> {
    try {
      await fn();
    } catch (error) {
      return {
        code: String((error as { code?: unknown }).code ?? "NO_CODE"),
        message: String((error as Error).message ?? ""),
      };
    }
    return assert.fail("esperava uma rejeição, mas resolveu");
  }

  it("payload normal continua aceito nas duas callables", async () => {
    await seedStandardSeason();
    await bindIdentity("uid-a", IDS[0]);

    const board = await getSeasonLeaderboardHandler({ ...VALID }, ctxOf("u1"));
    assert.equal(board.success, true);

    const mine = await getMySeasonRankingHandler({ ...VALID }, ctxOf("uid-a"));
    assert.equal(mine.success, true);
    assert.equal(mine.rank, 1);
  });

  it("REJEITA campos válidos que existem SOMENTE no protótipo", async () => {
    // Exatamente o bypass: Object.keys(payload) fica vazio, mas (data ?? {}).x
    // resolveria pela cadeia de protótipos.
    for (const [name, call] of CALLABLES) {
      const smuggled = Object.create({ ...VALID });
      const res = await capture(() => call(smuggled));
      assert.equal(res.code, "invalid-argument", name);
    }
  });

  it("REJEITA cursorSecret herdado — a chave nunca pode vir do payload", async () => {
    const smuggled = Object.create({ ...VALID, cursorSecret: CANARY_SECRET });
    const res = await capture(() =>
      getSeasonLeaderboardHandler(smuggled, ctxOf("u1"))
    );
    assert.equal(res.code, "invalid-argument");
    assert.ok(!res.message.includes(CANARY_SECRET), "canário não pode vazar");
  });

  it("REJEITA now herdado — o relógio nunca pode vir do payload", async () => {
    for (const [name, call] of CALLABLES) {
      const smuggled = Object.create({
        ...VALID,
        now: new Date("2030-01-01T00:00:00Z"),
      });
      const res = await capture(() => call(smuggled));
      assert.equal(res.code, "invalid-argument", name);
    }
  });

  it("REJEITA campo extra herdado", async () => {
    for (const [name, call] of CALLABLES) {
      const smuggled = Object.create({ ...VALID, bogus: CANARY_VALUE });
      const res = await capture(() => call(smuggled));
      assert.equal(res.code, "invalid-argument", name);
      assert.ok(!res.message.includes(CANARY_VALUE), `${name}: canário vazou`);
    }
  });

  it("REJEITA a propriedade PRÓPRIA __proto__ criada por JSON.parse", async () => {
    // JSON.parse não invoca o setter — cria uma própria enumerável "__proto__".
    const parsed = JSON.parse(
      `{"economy":"${ECONOMY_CASH}","seasonId":"${SEASON}","__proto__":{"bogus":1}}`
    );
    for (const [name, call] of CALLABLES) {
      const res = await capture(() => call(parsed));
      assert.equal(res.code, "invalid-argument", name);
    }
  });

  it("REJEITA array e objeto com protótipo personalizado", async () => {
    for (const [name, call] of CALLABLES) {
      // Array continua rejeitado.
      assert.equal((await capture(() => call([]))).code, "invalid-argument", name);

      // Protótipo de terceiros com campos próprios VÁLIDOS: a forma é hostil
      // mesmo quando o conteúdo parece certo.
      const custom = Object.create({ polluted: true });
      custom.economy = ECONOMY_CASH;
      custom.seasonId = SEASON;
      assert.equal(
        (await capture(() => call(custom))).code,
        "invalid-argument",
        `${name}: protótipo personalizado`
      );
    }
  });

  it("REJEITA accessor em campo permitido e symbol key", async () => {
    for (const [name, call] of CALLABLES) {
      // Getter num campo da allowlist: valor computado sob demanda é hostil.
      const withGetter: Record<string, unknown> = { seasonId: SEASON };
      Object.defineProperty(withGetter, "economy", {
        enumerable: true,
        get: () => ECONOMY_CASH,
      });
      assert.equal(
        (await capture(() => call(withGetter))).code,
        "invalid-argument",
        `${name}: accessor`
      );

      // Symbol key nunca pertence a um payload JSON.
      const withSymbol: Record<string | symbol, unknown> = { ...VALID };
      (withSymbol as Record<symbol, unknown>)[Symbol("contrabando")] = 1;
      assert.equal(
        (await capture(() => call(withSymbol))).code,
        "invalid-argument",
        `${name}: symbol`
      );
    }
  });

  it("REJEITA as opções internas como chaves PRÓPRIAS do payload", async () => {
    // O caminho antigo (allowlist) continua fechado para as seams.
    for (const [payload, call] of [
      [{ ...VALID, cursorSecret: CANARY_SECRET }, CALLABLES[0][1]],
      [{ ...VALID, now: "2030-01-01" }, CALLABLES[0][1]],
      [{ ...VALID, now: "2030-01-01" }, CALLABLES[1][1]],
      [{ ...VALID, afterFirstRead: 1 }, CALLABLES[1][1]],
    ] as const) {
      const res = await capture(() => call(payload));
      assert.equal(res.code, "invalid-argument");
      assert.ok(!res.message.includes(CANARY_SECRET));
    }
  });
});

// ---------------------------------------------------------------------------
// Parent malformado — falha fechada nas duas callables
// ---------------------------------------------------------------------------

describe("parent malformado — falha fechada nas duas callables", () => {
  /** Overwrites the season parent with an arbitrary (possibly bad) counter. */
  async function seedParentWithCounter(playerCount: unknown): Promise<void> {
    const base: Record<string, unknown> = {
      economy: ECONOMY_CASH,
      seasonId: SEASON,
      timezone: "America/Sao_Paulo",
      totalScoreCentavos: 1100,
      windowStart: admin.firestore.Timestamp.fromDate(
        new Date("2026-08-01T03:00:00Z")
      ),
      windowEnd: admin.firestore.Timestamp.fromDate(
        new Date("2026-09-01T03:00:00Z")
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (playerCount !== undefined) base.playerCount = playerCount;
    await parentRef(ECONOMY_CASH).set(base);
  }

  for (const [label, bad] of [
    ["ausente", undefined],
    ["com tipo incorreto (string)", "5"],
    ["negativo", -1],
    ["não inteiro", 2.5],
    ["NaN", NaN],
  ] as const) {
    it(`playerCount ${label}: ambas as callables falham fechado`, async () => {
      await seedStandardSeason();
      await seedParentWithCounter(bad);
      await bindIdentity("uid-a", IDS[0]);

      for (const [name, fail] of [
        [
          "getMySeasonRanking",
          () =>
            getMySeasonRankingHandler(
              { economy: ECONOMY_CASH, seasonId: SEASON },
              ctxOf("uid-a")
            ),
        ],
        [
          "getSeasonLeaderboard",
          () =>
            getSeasonLeaderboardHandler(
              { economy: ECONOMY_CASH, seasonId: SEASON },
              ctxOf("uid-a")
            ),
        ],
      ] as const) {
        assert.equal(
          await expectFailure(fail),
          "failed-precondition",
          `${name}: parent malformado deve falhar fechado`
        );
      }
    });
  }

  it("a mensagem pública não revela o valor malformado", async () => {
    await seedStandardSeason();
    await seedParentWithCounter("valor-canario-97531");
    await bindIdentity("uid-a", IDS[0]);

    try {
      await getMySeasonRankingHandler(
        { economy: ECONOMY_CASH, seasonId: SEASON },
        ctxOf("uid-a")
      );
      assert.fail("deveria ter falhado");
    } catch (error) {
      assert.ok(
        !String((error as Error).message).includes("97531"),
        "o valor armazenado não pode aparecer na mensagem"
      );
    }
  });

  it("contador VÁLIDO porém divergente do real: AMBAS falham fechadas", async () => {
    // Supera explicitamente o contrato anterior, que tolerava o mismatch: um
    // parent desatualizado descreve uma temporada que não existe.
    for (const counter of [42, 4, 6, 0]) {
      await clearAll();
      await seedStandardSeason(); // 5 entries canônicas
      await seedParentWithCounter(counter);
      await bindIdentity("uid-a", IDS[0]);

      assert.equal(
        await expectFailure(() =>
          getSeasonLeaderboardHandler(
            { economy: ECONOMY_CASH, seasonId: SEASON },
            ctxOf("uid-a")
          )
        ),
        "failed-precondition",
        `leaderboard com contador ${counter}`
      );
      assert.equal(
        await expectFailure(() =>
          getMySeasonRankingHandler(
            { economy: ECONOMY_CASH, seasonId: SEASON },
            ctxOf("uid-a")
          )
        ),
        "failed-precondition",
        `posição com contador ${counter}`
      );
    }
  });

  it("contador correto: as duas superfícies respondem normalmente", async () => {
    await seedStandardSeason();
    await seedParentWithCounter(5);
    await bindIdentity("uid-a", IDS[0]);

    const board = await getSeasonLeaderboardHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a")
    );
    const mine = await getMySeasonRankingHandler(
      { economy: ECONOMY_CASH, seasonId: SEASON },
      ctxOf("uid-a")
    );

    assert.equal(board.playerCount, 5);
    assert.equal(mine.rank, 1);
    assert.equal(mine.playerCount, 5);
    assert.equal(board.playerCount, mine.playerCount, "os dois concordam");
  });
});
