import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { MAX_AGGREGATE_CENTAVOS } from "../../src/domain/aggregateMoney.js";
import { encodeRankScalar } from "../../src/domain/seasonLeaderboard.js";
import {
  BETA_PRIZE_CATEGORY,
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
} from "../../src/domain/economy.js";
import {
  CASH_PRIZE_CATEGORY,
  RANKING_EVENTS_COLLECTION,
  RANKING_TIMEZONE,
  SEASON_ENTRIES_SUBCOLLECTION,
  SEASON_RANKINGS_COLLECTION,
  seasonDocumentId,
  seasonWindow,
} from "../../src/domain/seasonRanking.js";
import {
  PUBLIC_PLAYER_ID_COLLECTION,
  PUBLIC_PLAYER_ID_INDEX_COLLECTION,
  isPublicPlayerId,
} from "../../src/domain/publicPlayerId.js";

/**
 * Behavioral (execution) tests for `onPrizeTransactionCreated`, run against the
 * LOCAL Firestore emulator via the Admin SDK — proving the real side effects:
 * eligibility filtering, the activation gate, identity minting, the idempotent
 * guard, atomic entry+parent+guard commits, replay convergence and the branch's
 * core promise: NO financial document is ever modified.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 *
 * The trigger's automatic firing is NOT exercised here — that needs the
 * Functions emulator and belongs to the later E2E step. These tests invoke the
 * exported handler directly with a real snapshot, which is what the repository's
 * other `*.handlers.test.ts` files do.
 */

type Handler = (
  snapshot: any,
  options?: {
    firstActiveSeasonId?: string | null;
    ensureIdentity?: (
      uid: string
    ) => Promise<{ publicPlayerId: string; created: boolean }>;
  }
) => Promise<{ applied: boolean; reason?: string }>;

let onPrizeTransactionCreatedHandler: Handler;
let db: admin.firestore.Firestore;

const PLAYER = "ranking-player-1";
const OTHER = "ranking-player-2";

/** The season every fixture lands in, and the gate value the tests authorize. */
const SEASON = "2026-08";
const PRIZE_AT = new Date("2026-08-03T18:22:11.000Z");
const NEXT_SEASON_PRIZE_AT = new Date("2026-09-04T18:22:11.000Z");

/**
 * The gate these tests authorize EXPLICITLY, so the suite exercises the active
 * path without depending on what production currently ships.
 *
 * Production ships `FIRST_ACTIVE_SEASON_ID = "2026-09"` (seasonRanking.ts), so
 * the August fixtures above are deliberately BEFORE the production milestone:
 * the "produção" tests below assert exactly that, and the "active" tests pass
 * this option to reach the write path. Neither reading is implicit.
 */
const ACTIVE = { firstActiveSeasonId: SEASON };

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-ranking-handlers";
  const mod = (await import("../../src/index.js")) as unknown as {
    onPrizeTransactionCreatedHandler: Handler;
  };
  onPrizeTransactionCreatedHandler = mod.onPrizeTransactionCreatedHandler;
  db = admin.firestore();
});

async function clearCollection(path: string): Promise<void> {
  const snap = await db.collection(path).get();
  await Promise.all(
    snap.docs.map(async (doc) => {
      const subs = await doc.ref.listCollections();
      for (const sub of subs) {
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
    "transactions",
    "wallets",
    "users",
    "tournaments",
    "registrations",
    "withdrawals",
  ]) {
    await clearCollection(col);
  }
}

beforeEach(clearAll);

/** Writes a prize ledger row and returns its real snapshot. */
async function seedPrize(
  overrides: Record<string, unknown> = {},
  id = "prize_t1"
): Promise<admin.firestore.DocumentSnapshot> {
  const uid = (overrides.uid as string) ?? PLAYER;
  delete overrides.uid;

  const ref = db.collection("transactions").doc(id);
  await ref.set({
    amount: 500,
    category: CASH_PRIZE_CATEGORY,
    user_ref: db.collection("users").doc(uid),
    display_name: "",
    tournament_ref: db.collection("tournaments").doc(id.replace("prize_", "")),
    previous_balance: 0,
    balance_after: 500,
    timestamp: admin.firestore.Timestamp.fromDate(PRIZE_AT),
    status: "completed",
    external_id: id,
    ...overrides,
  });
  return ref.get();
}

/** Seeds the financial documents this flow must never modify. */
async function seedFinancialWorld(): Promise<Record<string, unknown>> {
  const userRef = db.collection("users").doc(PLAYER);
  await db.collection("users").doc(PLAYER).set({ email: "p@e2e.test" });
  await db.collection("wallets").doc(PLAYER).set({
    balance: 500,
    beta_balance: 0,
    total_deposited: 0,
    total_won: 500,
    total_spent: 0,
    total_withdrawn: 0,
    user_ref: userRef,
  });
  await db.collection("tournaments").doc("t1").set({
    status: "completed",
    prize: 500,
    entry_fee: 5,
  });
  return {
    wallet: (await db.collection("wallets").doc(PLAYER).get()).data(),
    tournament: (await db.collection("tournaments").doc("t1").get()).data(),
  };
}

function parentPath(economy: string, seasonId = SEASON): string {
  return `${SEASON_RANKINGS_COLLECTION}/${seasonDocumentId(
    economy as any,
    seasonId
  )}`;
}

async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(path).get();
  return snap.exists ? (snap.data() ?? {}) : null;
}

async function countAll(): Promise<{
  parents: number;
  entries: number;
  guards: number;
  identities: number;
}> {
  const parents = await db.collection(SEASON_RANKINGS_COLLECTION).get();
  let entries = 0;
  for (const parent of parents.docs) {
    entries += (
      await parent.ref.collection(SEASON_ENTRIES_SUBCOLLECTION).get()
    ).size;
  }
  return {
    parents: parents.size,
    entries,
    guards: (await db.collection(RANKING_EVENTS_COLLECTION).get()).size,
    identities: (await db.collection(PUBLIC_PLAYER_ID_COLLECTION).get()).size,
  };
}

async function onlyEntry(
  economy: string,
  seasonId = SEASON
): Promise<Record<string, unknown>> {
  const snap = await db
    .doc(parentPath(economy, seasonId))
    .collection(SEASON_ENTRIES_SUBCOLLECTION)
    .get();
  assert.equal(snap.size, 1, "esperava exatamente uma entry");
  return snap.docs[0].data() ?? {};
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

// ---------------------------------------------------------------------------
// O portão de ativação
// ---------------------------------------------------------------------------

describe("ativação — agosto/2026 é ANTERIOR ao marco de produção", () => {
  it("sem opções, um prêmio de agosto não cria identidade nem ranking", async () => {
    const snap = await seedPrize();

    // Nenhuma opção: exatamente o que o export implantável faz, lendo a
    // constante real de produção (FIRST_ACTIVE_SEASON_ID = "2026-09").
    const outcome = await onPrizeTransactionCreatedHandler(snap);

    // O prêmio é de 2026-08-03; setembro é o primeiro mês completo autorizado,
    // logo agosto está permanentemente fora de escopo — e NÃO por falta de
    // configuração. A distinção entre os dois motivos é o contrato aqui.
    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, "before-first-active-season");

    const counts = await countAll();
    assert.deepEqual(counts, {
      parents: 0,
      entries: 0,
      guards: 0,
      identities: 0,
    });
  });

  it("sem opções, um prêmio de setembro É processado — produção está ativa", async () => {
    // A contraprova do teste acima: a produção não está inerte, apenas começa
    // em setembro. Sem isto, um retorno a `null` passaria despercebido.
    const snap = await seedPrize({
      timestamp: admin.firestore.Timestamp.fromDate(NEXT_SEASON_PRIZE_AT),
    });

    const outcome = await onPrizeTransactionCreatedHandler(snap);

    assert.equal(outcome.applied, true);
    assert.equal(
      (outcome as unknown as { seasonId: string }).seasonId,
      "2026-09",
      "o marco de produção é setembro/2026"
    );
  });

  it("o contrato de desligamento por null continua disponível", async () => {
    // `null` é o estado fail-closed explícito do contrato congelado
    // (seasonRanking.ts). Ele permanece alcançável mesmo com produção ativa.
    const snap = await seedPrize();

    const outcome = await onPrizeTransactionCreatedHandler(snap, {
      firstActiveSeasonId: null,
    });

    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, "first-active-season-not-configured");
    assert.deepEqual(await countAll(), {
      parents: 0,
      entries: 0,
      guards: 0,
      identities: 0,
    });
  });

  it("uma configuração inválida também deixa tudo inerte", async () => {
    const snap = await seedPrize();

    for (const bad of ["", "2026-13", "abc", "2026"]) {
      const outcome = await onPrizeTransactionCreatedHandler(snap, {
        firstActiveSeasonId: bad,
      });
      assert.equal(outcome.applied, false, bad);
      assert.equal(outcome.reason, "first-active-season-not-configured", bad);
    }

    assert.deepEqual(await countAll(), {
      parents: 0,
      entries: 0,
      guards: 0,
      identities: 0,
    });
  });

  it("a identidade NÃO é chamada no caminho inerte", async () => {
    const snap = await seedPrize();
    let called = 0;

    const outcome = await onPrizeTransactionCreatedHandler(snap, {
      ensureIdentity: async () => {
        called += 1;
        return { publicPlayerId: "A7fQ2_kB9xLm3NpQr5TzUw", created: true };
      },
    });

    assert.equal(outcome.applied, false);
    assert.equal(called, 0, "a identidade não pode ser tocada antes do portão");
  });

  it("um evento anterior ao marco é ignorado — não há backfill", async () => {
    const snap = await seedPrize();

    const outcome = await onPrizeTransactionCreatedHandler(snap, {
      firstActiveSeasonId: "2026-09",
    });

    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, "before-first-active-season");
    assert.deepEqual(await countAll(), {
      parents: 0,
      entries: 0,
      guards: 0,
      identities: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Elegibilidade
// ---------------------------------------------------------------------------

describe("elegibilidade — nada é escrito para linhas fora do contrato", () => {
  const NOTHING = { parents: 0, entries: 0, guards: 0, identities: 0 };

  it("uma transação que não é prêmio não escreve nada", async () => {
    const ref = db.collection("transactions").doc("withdrawal_1_abc");
    await ref.set({
      amount: 50,
      category: "withdrawal",
      user_ref: db.collection("users").doc(PLAYER),
      tournament_ref: null,
      timestamp: admin.firestore.Timestamp.fromDate(PRIZE_AT),
      status: "pending",
    });

    const outcome = await onPrizeTransactionCreatedHandler(
      await ref.get(),
      ACTIVE
    );

    assert.equal(outcome.applied, false);
    assert.equal(outcome.reason, "not-a-prize-id");
    assert.deepEqual(await countAll(), NOTHING);
  });

  it("um id prize_* com categoria não premiada não escreve nada", async () => {
    const snap = await seedPrize({ category: "deposit" });
    const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    assert.equal(outcome.reason, "category-not-ranking-bearing");
    assert.deepEqual(await countAll(), NOTHING);
  });

  it("admin_correction não é premiada", async () => {
    const snap = await seedPrize({ category: "admin_correction" });
    const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    assert.equal(outcome.reason, "category-not-ranking-bearing");
    assert.deepEqual(await countAll(), NOTHING);
  });

  it("um status diferente de completed não escreve nada", async () => {
    for (const status of ["pending", "", "COMPLETED"]) {
      await clearAll();
      const snap = await seedPrize({ status });
      const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);

      assert.equal(outcome.reason, "status-not-completed", status);
      assert.deepEqual(await countAll(), NOTHING, status);
    }
  });

  it("um valor malformado não escreve nada", async () => {
    for (const amount of [-1, 10.005, "500", null]) {
      await clearAll();
      const snap = await seedPrize({ amount });
      const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);

      assert.equal(outcome.applied, false, String(amount));
      assert.ok(
        String(outcome.reason).startsWith("amount-"),
        `${amount} -> ${outcome.reason}`
      );
      assert.deepEqual(await countAll(), NOTHING, String(amount));
    }
  });

  it("um timestamp inutilizável não escreve nada", async () => {
    const snap = await seedPrize({ timestamp: "2026-08-03" });
    const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    assert.equal(outcome.reason, "timestamp-unusable");
    assert.deepEqual(await countAll(), NOTHING);
  });

  it("uma referência de usuário fora de users/ não escreve nada", async () => {
    const snap = await seedPrize({
      user_ref: db.collection("wallets").doc(PLAYER),
    });
    const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    assert.equal(outcome.reason, "user-ref-unusable");
    assert.deepEqual(await countAll(), NOTHING);
  });

  it("uma referência de torneio ausente não escreve nada", async () => {
    const snap = await seedPrize({ tournament_ref: null });
    const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    assert.equal(outcome.reason, "tournament-ref-unusable");
    assert.deepEqual(await countAll(), NOTHING);
  });
});

// ---------------------------------------------------------------------------
// O caminho feliz
// ---------------------------------------------------------------------------

describe("aplicação — um prêmio cash", () => {
  it("cria parent, entry e guard com o schema aprovado", async () => {
    const snap = await seedPrize();
    const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    assert.equal(outcome.applied, true);

    const parent = await readDoc(parentPath(ECONOMY_CASH));
    assert.ok(parent, "o parent deve existir");
    assert.equal(parent.economy, ECONOMY_CASH);
    assert.equal(parent.seasonId, SEASON);
    assert.equal(parent.timezone, RANKING_TIMEZONE);
    assert.equal(parent.playerCount, 1);
    assert.equal(parent.totalScoreCentavos, 50_000);

    const window = seasonWindow(SEASON);
    assert.equal(
      (parent.windowStart as admin.firestore.Timestamp).toMillis(),
      window.start.getTime()
    );
    assert.equal(
      (parent.windowEnd as admin.firestore.Timestamp).toMillis(),
      window.end.getTime()
    );
    assert.ok(parent.updatedAt instanceof admin.firestore.Timestamp);

    const entry = await onlyEntry(ECONOMY_CASH);
    assert.equal(isPublicPlayerId(entry.publicPlayerId), true);
    assert.equal(entry.economy, ECONOMY_CASH);
    assert.equal(entry.seasonId, SEASON);
    assert.equal(entry.scoreCentavos, 50_000);
    assert.equal(entry.winsCount, 1);
    assert.equal(
      (entry.firstPrizeAt as admin.firestore.Timestamp).toMillis(),
      PRIZE_AT.getTime()
    );
    assert.equal(
      (entry.lastPrizeAt as admin.firestore.Timestamp).toMillis(),
      PRIZE_AT.getTime()
    );

    const guard = await readDoc(`${RANKING_EVENTS_COLLECTION}/prize_t1`);
    assert.ok(guard, "o guard deve existir");
    assert.equal(
      (guard.transactionRef as admin.firestore.DocumentReference).path,
      "transactions/prize_t1"
    );
    assert.equal(guard.publicPlayerId, entry.publicPlayerId);
    assert.equal(guard.economy, ECONOMY_CASH);
    assert.equal(guard.amountCentavos, 50_000);
    assert.equal(guard.seasonId, SEASON);
    assert.equal(guard.dayKey, "2026-08-03");
    assert.ok(guard.appliedAt instanceof admin.firestore.Timestamp);
  });

  it("a entry NUNCA guarda uid, user_ref, player_id, posição ou rank", async () => {
    const snap = await seedPrize();
    await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    const entry = await onlyEntry(ECONOMY_CASH);
    for (const forbidden of [
      "uid",
      "user_ref",
      "player_id",
      "display_name",
      "avatar",
      "position",
      "rank",
      "schemaVersion",
      "tournamentsCount",
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(entry, forbidden),
        false,
        `${forbidden} não pode existir na entry`
      );
    }

    // E o id do documento é o pseudônimo, nunca o uid.
    const docs = await db
      .doc(parentPath(ECONOMY_CASH))
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .get();
    assert.equal(isPublicPlayerId(docs.docs[0].id), true);
    assert.notEqual(docs.docs[0].id, PLAYER);
  });

  it("os ids persistidos seguem os formatos aprovados", async () => {
    const snap = await seedPrize();
    await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    const parents = await db.collection(SEASON_RANKINGS_COLLECTION).get();
    assert.deepEqual(
      parents.docs.map((d) => d.id),
      [`${ECONOMY_CASH}_${SEASON}`]
    );

    const guards = await db.collection(RANKING_EVENTS_COLLECTION).get();
    assert.deepEqual(
      guards.docs.map((d) => d.id),
      ["prize_t1"]
    );
  });

  it("cria a identidade no primeiro evento e a reutiliza sem mexer no createdAt", async () => {
    const first = await seedPrize();
    await onPrizeTransactionCreatedHandler(first, ACTIVE);

    const mapPath = `${PUBLIC_PLAYER_ID_COLLECTION}/${PLAYER}`;
    const afterFirst = await readDoc(mapPath);
    assert.ok(afterFirst, "a identidade deve ter sido criada");
    const createdAt = (
      afterFirst.createdAt as admin.firestore.Timestamp
    ).toMillis();

    const second = await seedPrize(
      { timestamp: admin.firestore.Timestamp.fromDate(PRIZE_AT) },
      "prize_t2"
    );
    await onPrizeTransactionCreatedHandler(second, ACTIVE);

    const afterSecond = await readDoc(mapPath);
    assert.equal(
      (afterSecond!.createdAt as admin.firestore.Timestamp).toMillis(),
      createdAt,
      "o createdAt canônico não pode mudar"
    );
    assert.equal(afterSecond!.publicPlayerId, afterFirst.publicPlayerId);
    assert.equal((await countAll()).identities, 1);
  });
});

describe("aplicação — um prêmio beta", () => {
  it("alimenta apenas o ranking beta, nunca o cash", async () => {
    const snap = await seedPrize({
      category: BETA_PRIZE_CATEGORY,
      economy_type: ECONOMY_BETA_CREDIT,
    });

    const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);
    assert.equal(outcome.applied, true);

    assert.ok(await readDoc(parentPath(ECONOMY_BETA_CREDIT)));
    assert.equal(await readDoc(parentPath(ECONOMY_CASH)), null);

    const entry = await onlyEntry(ECONOMY_BETA_CREDIT);
    assert.equal(entry.economy, ECONOMY_BETA_CREDIT);
  });

  it("cash e beta do mesmo jogador ficam isolados", async () => {
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);
    await onPrizeTransactionCreatedHandler(
      await seedPrize(
        { category: BETA_PRIZE_CATEGORY, amount: 300 },
        "prize_t2"
      ),
      ACTIVE
    );

    const cash = await onlyEntry(ECONOMY_CASH);
    const beta = await onlyEntry(ECONOMY_BETA_CREDIT);

    assert.equal(cash.scoreCentavos, 50_000);
    assert.equal(beta.scoreCentavos, 30_000);
    assert.equal(cash.winsCount, 1);
    assert.equal(beta.winsCount, 1);
    // Mesmo jogador, mesmo pseudônimo, documentos separados.
    assert.equal(cash.publicPlayerId, beta.publicPlayerId);
    assert.equal((await countAll()).parents, 2);
  });
});

// ---------------------------------------------------------------------------
// Acumulação
// ---------------------------------------------------------------------------

describe("acumulação", () => {
  it("dois prêmios do mesmo jogador somam numa única entry", async () => {
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);
    await onPrizeTransactionCreatedHandler(
      await seedPrize({ amount: 250 }, "prize_t2"),
      ACTIVE
    );

    const entry = await onlyEntry(ECONOMY_CASH);
    assert.equal(entry.scoreCentavos, 75_000);
    assert.equal(entry.winsCount, 2);

    const parent = await readDoc(parentPath(ECONOMY_CASH));
    assert.equal(parent!.playerCount, 1, "o mesmo jogador não conta duas vezes");
    assert.equal(parent!.totalScoreCentavos, 75_000);
    assert.equal((await countAll()).guards, 2);
  });

  it("um prêmio de outro jogador incrementa playerCount", async () => {
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);
    await onPrizeTransactionCreatedHandler(
      await seedPrize({ uid: OTHER, amount: 100 }, "prize_t2"),
      ACTIVE
    );

    const parent = await readDoc(parentPath(ECONOMY_CASH));
    assert.equal(parent!.playerCount, 2);
    assert.equal(parent!.totalScoreCentavos, 60_000);

    const entries = await db
      .doc(parentPath(ECONOMY_CASH))
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .get();
    assert.equal(entries.size, 2);
    assert.equal((await countAll()).identities, 2);
  });

  it("meses diferentes vão para parents diferentes", async () => {
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);
    await onPrizeTransactionCreatedHandler(
      await seedPrize(
        {
          timestamp: admin.firestore.Timestamp.fromDate(NEXT_SEASON_PRIZE_AT),
          amount: 100,
        },
        "prize_t2"
      ),
      ACTIVE
    );

    assert.equal((await readDoc(parentPath(ECONOMY_CASH)))!.totalScoreCentavos, 50_000);
    assert.equal(
      (await readDoc(parentPath(ECONOMY_CASH, "2026-09")))!.totalScoreCentavos,
      10_000
    );
    assert.equal((await countAll()).parents, 2);
  });

  it("firstPrizeAt é preservado e lastPrizeAt avança", async () => {
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);

    const later = new Date("2026-08-20T09:00:00.000Z");
    await onPrizeTransactionCreatedHandler(
      await seedPrize(
        { timestamp: admin.firestore.Timestamp.fromDate(later) },
        "prize_t2"
      ),
      ACTIVE
    );

    const entry = await onlyEntry(ECONOMY_CASH);
    assert.equal(
      (entry.firstPrizeAt as admin.firestore.Timestamp).toMillis(),
      PRIZE_AT.getTime()
    );
    assert.equal(
      (entry.lastPrizeAt as admin.firestore.Timestamp).toMillis(),
      later.getTime()
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotência
// ---------------------------------------------------------------------------

describe("idempotência", () => {
  it("um replay do mesmo transactionId não incrementa nada", async () => {
    const snap = await seedPrize();
    await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    const before = {
      parent: await readDoc(parentPath(ECONOMY_CASH)),
      entry: await onlyEntry(ECONOMY_CASH),
      guard: await readDoc(`${RANKING_EVENTS_COLLECTION}/prize_t1`),
    };

    const outcome = await onPrizeTransactionCreatedHandler(snap, ACTIVE);
    assert.equal(outcome.applied, true);

    const after = {
      parent: await readDoc(parentPath(ECONOMY_CASH)),
      entry: await onlyEntry(ECONOMY_CASH),
      guard: await readDoc(`${RANKING_EVENTS_COLLECTION}/prize_t1`),
    };

    assert.deepEqual(after, before, "o replay deve ser byte-idêntico");
    assert.deepEqual(await countAll(), {
      parents: 1,
      entries: 1,
      guards: 1,
      identities: 1,
    });
  });

  it("cinco replays continuam byte-idênticos", async () => {
    const snap = await seedPrize();
    await onPrizeTransactionCreatedHandler(snap, ACTIVE);
    const first = await onlyEntry(ECONOMY_CASH);

    for (let i = 0; i < 5; i += 1) {
      await onPrizeTransactionCreatedHandler(snap, ACTIVE);
    }

    assert.deepEqual(await onlyEntry(ECONOMY_CASH), first);
  });

  it("duas execuções concorrentes convergem sem duplicar", async () => {
    const snap = await seedPrize();

    await Promise.all([
      onPrizeTransactionCreatedHandler(snap, ACTIVE),
      onPrizeTransactionCreatedHandler(snap, ACTIVE),
    ]);

    const entry = await onlyEntry(ECONOMY_CASH);
    assert.equal(entry.scoreCentavos, 50_000, "o valor não pode ser somado duas vezes");
    assert.equal(entry.winsCount, 1);

    const parent = await readDoc(parentPath(ECONOMY_CASH));
    assert.equal(parent!.playerCount, 1);
    assert.equal(parent!.totalScoreCentavos, 50_000);
    assert.deepEqual(await countAll(), {
      parents: 1,
      entries: 1,
      guards: 1,
      identities: 1,
    });
  });

  it("um guard conflitante falha fechado, sem escrever", async () => {
    const snap = await seedPrize();
    await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    // Corrompe o guard como se outro evento o tivesse escrito.
    await db
      .collection(RANKING_EVENTS_COLLECTION)
      .doc("prize_t1")
      .update({ amountCentavos: 1 });

    const before = await onlyEntry(ECONOMY_CASH);

    assert.equal(
      await expectFailure(() =>
        onPrizeTransactionCreatedHandler(snap, ACTIVE)
      ),
      "failed-precondition"
    );

    assert.deepEqual(
      await onlyEntry(ECONOMY_CASH),
      before,
      "nada pode ser escrito quando o guard diverge"
    );
  });

  it("parent apagado com entries órfãs falha fechado, sem reconstruir", async () => {
    // Dois vencedores distintos: o parent chega legitimamente a playerCount 2.
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);
    await onPrizeTransactionCreatedHandler(
      await seedPrize({ uid: OTHER, amount: 300 }, "prize_t2"),
      ACTIVE
    );

    const healthy = await readDoc(parentPath(ECONOMY_CASH));
    assert.equal(healthy!.playerCount, 2);
    assert.equal(healthy!.totalScoreCentavos, 80_000);

    // Fora de banda: apaga SÓ o documento pai. O Firestore preserva a
    // subcoleção, então as entries sobrevivem órfãs e intactas.
    await db.doc(parentPath(ECONOMY_CASH)).delete();
    const orphans = await db
      .doc(parentPath(ECONOMY_CASH))
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .get();
    assert.equal(orphans.size, 2, "as entries precisam sobreviver ao pai");

    // O próximo prêmio de um jogador que JÁ tem entry não pode reconstruir o
    // parent: isso republicaria playerCount 1 e um total de um prêmio só.
    const third = await seedPrize({ amount: 100 }, "prize_t3");
    assert.equal(
      await expectFailure(() =>
        onPrizeTransactionCreatedHandler(third, ACTIVE)
      ),
      "failed-precondition"
    );

    // E nada foi escrito: nem parent reconstruído, nem guard do evento.
    assert.equal(await readDoc(parentPath(ECONOMY_CASH)), null);
    assert.equal(
      await readDoc(`${RANKING_EVENTS_COLLECTION}/prize_t3`),
      null
    );
    const stillOrphans = await db
      .doc(parentPath(ECONOMY_CASH))
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .get();
    assert.equal(stillOrphans.size, 2);
    assert.deepEqual(
      stillOrphans.docs.map((d) => d.data().scoreCentavos).sort(),
      orphans.docs.map((d) => d.data().scoreCentavos).sort(),
      "as entries órfãs não podem ser alteradas"
    );
  });

  it("um guard incompleto falha fechado", async () => {
    const snap = await seedPrize();
    await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    await db
      .collection(RANKING_EVENTS_COLLECTION)
      .doc("prize_t1")
      .set({ publicPlayerId: "A7fQ2_kB9xLm3NpQr5TzUw" });

    assert.equal(
      await expectFailure(() =>
        onPrizeTransactionCreatedHandler(snap, ACTIVE)
      ),
      "failed-precondition"
    );
  });
});

// ---------------------------------------------------------------------------
// Overflow e rollback atômico
// ---------------------------------------------------------------------------

describe("overflow aborta tudo", () => {
  /** O escalar canônico exatamente como o write path o persiste. NÃO é uma data. */
  const rankTs = (value: number): admin.firestore.Timestamp => {
    const s = encodeRankScalar(value);
    return new admin.firestore.Timestamp(s.seconds, s.nanoseconds);
  };

  /** A entry desta temporada, para o jogador que os fixtures premiam. */
  const entryRefOf = (publicPlayerId: string) =>
    db
      .doc(parentPath(ECONOMY_CASH))
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .doc(publicPlayerId);

  it("não escreve entry, parent nem guard quando o agregado estoura", async () => {
    // Primeiro prêmio, aplicado normalmente.
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);
    const entryBefore = await onlyEntry(ECONOMY_CASH);

    // Empurra a entry para o teto exato NO CAMPO AUTORITATIVO.
    //
    // A transição lê `scoreOrder` — nunca a cópia de auditoria `scoreCentavos`
    // —, então saturar o escalar tipado é a ÚNICA forma de alcançar o teto.
    // `scoreCentavos` é deixada deliberadamente no valor antigo (50 000) para
    // que a proteção de overflow só possa ter vindo de `scoreOrder`.
    // `winsOrder` permanece válido, como todo campo tipado exigido.
    const entryRef = entryRefOf(entryBefore.publicPlayerId as string);
    await entryRef.update({ scoreOrder: rankTs(MAX_AGGREGATE_CENTAVOS) });
    const saturated = (await entryRef.get()).data() ?? {};
    const parentBefore = await readDoc(parentPath(ECONOMY_CASH));

    assert.equal(
      saturated.scoreCentavos,
      50_000,
      "a cópia de auditoria continua defasada: o teto veio do campo tipado"
    );

    // Qualquer centavo adicional estoura.
    const second = await seedPrize({ amount: 0.01 }, "prize_t2");

    assert.equal(
      await expectFailure(() =>
        onPrizeTransactionCreatedHandler(second, ACTIVE)
      ),
      "failed-precondition"
    );

    assert.deepEqual(
      (await entryRef.get()).data(),
      saturated,
      "a entry não pode mudar"
    );
    assert.deepEqual(
      await readDoc(parentPath(ECONOMY_CASH)),
      parentBefore,
      "o parent não pode mudar"
    );
    assert.equal(
      await readDoc(`${RANKING_EVENTS_COLLECTION}/prize_t2`),
      null,
      "o guard do evento que estourou não pode existir"
    );
    assert.equal((await countAll()).guards, 1);
  });

  it("REAPLICAR o mesmo evento após o overflow continua não escrevendo nada", async () => {
    // Idempotência preservada: o evento que estourou não deixou guard, então a
    // retentativa reexecuta o mesmo caminho e falha de novo — nunca aplica
    // parcialmente nem converge para um estado gravado.
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);
    const entryBefore = await onlyEntry(ECONOMY_CASH);
    const entryRef = entryRefOf(entryBefore.publicPlayerId as string);
    await entryRef.update({ scoreOrder: rankTs(MAX_AGGREGATE_CENTAVOS) });

    const saturated = (await entryRef.get()).data() ?? {};
    const parentBefore = await readDoc(parentPath(ECONOMY_CASH));
    const second = await seedPrize({ amount: 0.01 }, "prize_t2");

    for (const attempt of [1, 2, 3]) {
      assert.equal(
        await expectFailure(() =>
          onPrizeTransactionCreatedHandler(second, ACTIVE)
        ),
        "failed-precondition",
        `tentativa ${attempt}`
      );
      assert.deepEqual(
        (await entryRef.get()).data(),
        saturated,
        `tentativa ${attempt}: a entry não pode mudar`
      );
      assert.deepEqual(
        await readDoc(parentPath(ECONOMY_CASH)),
        parentBefore,
        `tentativa ${attempt}: o parent não pode mudar`
      );
      assert.equal(
        await readDoc(`${RANKING_EVENTS_COLLECTION}/prize_t2`),
        null,
        `tentativa ${attempt}: o guard não pode existir`
      );
      assert.equal((await countAll()).guards, 1, `tentativa ${attempt}`);
    }
  });

  it("saturar SOMENTE a cópia de auditoria scoreCentavos não decide nada", async () => {
    // O contra-teste do anterior, e a prova direta de que `scoreCentavos` é
    // não-decisória: com a cópia no teto e `scoreOrder` intacto, o mesmo prêmio
    // que estouraria APLICA normalmente. A cópia não provoca overflow, não o
    // suprime, não altera a transição e não muda a decisão de erro.
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);
    const entryBefore = await onlyEntry(ECONOMY_CASH);
    const entryRef = entryRefOf(entryBefore.publicPlayerId as string);

    const orderBefore = (await entryRef.get()).get("scoreOrder");
    await entryRef.update({ scoreCentavos: MAX_AGGREGATE_CENTAVOS });

    const second = await seedPrize({ amount: 0.01 }, "prize_t2");
    const result = await onPrizeTransactionCreatedHandler(second, ACTIVE);
    assert.equal(result.applied, true, "a cópia adulterada não bloqueia nada");

    // A transição partiu de scoreOrder (50 000), não da cópia saturada.
    const after = (await entryRef.get()).data() ?? {};
    assert.equal(after.scoreCentavos, 50_001, "50 000 + 1 centavo");
    assert.equal(after.winsCount, 2);
    assert.equal(
      (after.scoreOrder as admin.firestore.Timestamp).isEqual(
        rankTs(50_001)
      ),
      true,
      "o escalar canônico avançou exatamente um centavo"
    );
    assert.equal(
      (orderBefore as admin.firestore.Timestamp).isEqual(rankTs(50_000)),
      true,
      "o escalar de origem era 50 000, não o teto"
    );

    // O parent acompanha a transição real, não a cópia.
    const parent = await readDoc(parentPath(ECONOMY_CASH));
    assert.equal(parent!.totalScoreCentavos, 50_001);
    assert.equal(parent!.playerCount, 1);
    assert.equal((await countAll()).guards, 2, "o evento foi aplicado uma vez");
  });
});

// ---------------------------------------------------------------------------
// Nenhum documento financeiro é tocado
// ---------------------------------------------------------------------------

describe("o dinheiro nunca é tocado", () => {
  it("wallet, tournament e a própria transação ficam intactos", async () => {
    const before = await seedFinancialWorld();
    const snap = await seedPrize();
    const prizeBefore = (await snap.ref.get()).data();

    await onPrizeTransactionCreatedHandler(snap, ACTIVE);

    assert.deepEqual(
      (await db.collection("wallets").doc(PLAYER).get()).data(),
      before.wallet,
      "a carteira não pode mudar"
    );
    assert.deepEqual(
      (await db.collection("tournaments").doc("t1").get()).data(),
      before.tournament,
      "o torneio não pode mudar"
    );
    assert.deepEqual(
      (await snap.ref.get()).data(),
      prizeBefore,
      "a transação de prêmio é imutável"
    );
  });

  it("não cria nenhum documento financeiro novo", async () => {
    await seedFinancialWorld();
    const walletsBefore = (await db.collection("wallets").get()).size;
    const txBefore = (await db.collection("transactions").get()).size;

    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);

    assert.equal((await db.collection("wallets").get()).size, walletsBefore);
    // A única transação nova é a que o próprio teste semeou.
    assert.equal((await db.collection("transactions").get()).size, txBefore + 1);
    assert.equal((await db.collection("withdrawals").get()).size, 0);
    assert.equal((await db.collection("registrations").get()).size, 0);
  });
});
