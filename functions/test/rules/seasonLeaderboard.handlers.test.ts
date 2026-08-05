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

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let getSeasonLeaderboardHandler: Handler;
let getMySeasonRankingHandler: Handler;
let db: admin.firestore.Firestore;

const SEASON = "2026-08";

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
  const mod = (await import("../../src/index.js")) as unknown as {
    getSeasonLeaderboardHandler: Handler;
    getMySeasonRankingHandler: Handler;
  };
  getSeasonLeaderboardHandler = mod.getSeasonLeaderboardHandler;
  getMySeasonRankingHandler = mod.getMySeasonRankingHandler;
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
