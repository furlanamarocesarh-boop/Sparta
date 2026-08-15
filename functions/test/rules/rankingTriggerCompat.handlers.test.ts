import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";

import { ECONOMY_CASH } from "../../src/domain/economy.js";
import {
  CASH_PRIZE_CATEGORY,
  RANKING_EVENTS_COLLECTION,
  SEASON_ENTRIES_SUBCOLLECTION,
  SEASON_RANKINGS_COLLECTION,
  seasonDocumentId,
} from "../../src/domain/seasonRanking.js";

/**
 * THE decisive proof for the emulator-compatibility fix: the REAL ranking
 * trigger handler executing end-to-end, against the REAL Firestore emulator,
 * with the admin namespace mutilated EXACTLY as `firebase-tools` mutilates it.
 *
 * The unit suite (test/unit/emulatorAdminCompat.test.ts) proves the module can
 * be LOADED under the lossy namespace. Loading is necessary but not sufficient:
 * the write path builds `FieldValue.serverTimestamp()` and
 * `Timestamp.fromDate(...)` while handling an event, so only actually running it
 * shows the first prize no longer crashes. That is why a lazy-initialization fix
 * would have been insufficient and this test would still have failed.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 */

type Handler = (
  snapshot: any,
  options?: { firstActiveSeasonId?: string | null }
) => Promise<{ applied: boolean; reason?: string }>;

const PROJECT_ID = "demo-sparta-battle-ranking-compat";
const SEASON = "2026-08";
const ACTIVE = { firstActiveSeasonId: SEASON };
const PRIZE_AT = new Date("2026-08-03T18:22:11.000Z");
const PLAYER = "compat-player-1";

let onPrizeTransactionCreatedHandler: Handler;
let db: admin.firestore.Firestore;

/** Reproduces exactly what firebase-tools does to the admin namespace. */
function installEmulatorStub(): void {
  const original = admin.firestore;
  Object.defineProperty(admin, "firestore", {
    value: original.bind(admin),
    configurable: true,
    writable: true,
  });
}

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = PROJECT_ID;

  // The stub goes in BEFORE the module is imported — the emulator's ordering.
  installEmulatorStub();
  assert.equal(
    (admin.firestore as unknown as { Timestamp?: unknown }).Timestamp,
    undefined,
    "a simulação do stub falhou"
  );

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
      for (const sub of await doc.ref.listCollections()) {
        const subSnap = await sub.get();
        await Promise.all(subSnap.docs.map((d) => d.ref.delete()));
      }
      await doc.ref.delete();
    })
  );
}

beforeEach(async () => {
  for (const col of [
    SEASON_RANKINGS_COLLECTION,
    RANKING_EVENTS_COLLECTION,
    "public_player_ids",
    "public_player_id_index",
    "transactions",
  ]) {
    await clearCollection(col);
  }
});

/** Writes a prize ledger row and returns its real snapshot. */
async function seedPrize(id = "prize_compat"): Promise<any> {
  const ref = db.collection("transactions").doc(id);
  await ref.set({
    amount: 500,
    category: CASH_PRIZE_CATEGORY,
    user_ref: db.collection("users").doc(PLAYER),
    display_name: "",
    tournament_ref: db.collection("tournaments").doc("compat-t1"),
    previous_balance: 0,
    balance_after: 500,
    // Modular Timestamp: the suite itself must not depend on the statics either.
    timestamp: Timestamp.fromDate(PRIZE_AT),
    status: "completed",
    external_id: id,
  });
  return ref.get();
}

describe("o trigger de ranking EXECUTA sob o namespace mutilado", () => {
  it("aplica um prêmio: entry, parent e guard escritos numa transação", async () => {
    const outcome = await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);

    assert.equal(outcome.applied, true, `não aplicou: ${outcome.reason}`);

    const parentPath = `${SEASON_RANKINGS_COLLECTION}/${seasonDocumentId(
      ECONOMY_CASH as any,
      SEASON
    )}`;

    const parent = await db.doc(parentPath).get();
    assert.equal(parent.exists, true, "o parent da temporada deve existir");

    const entries = await db
      .doc(parentPath)
      .collection(SEASON_ENTRIES_SUBCOLLECTION)
      .get();
    assert.equal(entries.size, 1, "exatamente uma entry");

    const guard = await db
      .collection(RANKING_EVENTS_COLLECTION)
      .doc("prize_compat")
      .get();
    assert.equal(guard.exists, true, "o guard de idempotência deve existir");
  });

  it("os Timestamps gravados são Timestamps reais, não sentinelas quebrados", async () => {
    await onPrizeTransactionCreatedHandler(await seedPrize(), ACTIVE);

    const parentPath = `${SEASON_RANKINGS_COLLECTION}/${seasonDocumentId(
      ECONOMY_CASH as any,
      SEASON
    )}`;
    const entry =
      (
        await db.doc(parentPath).collection(SEASON_ENTRIES_SUBCOLLECTION).get()
      ).docs[0].data() ?? {};

    // firstPrizeAt/lastPrizeAt vêm de Timestamp.fromDate no handler.
    assert.ok(entry.firstPrizeAt instanceof Timestamp, "firstPrizeAt deve ser Timestamp");
    assert.ok(entry.lastPrizeAt instanceof Timestamp, "lastPrizeAt deve ser Timestamp");
    assert.equal(
      (entry.firstPrizeAt as Timestamp).toMillis(),
      PRIZE_AT.getTime(),
      "o instante do prêmio foi preservado exatamente"
    );

    // updatedAt vem de FieldValue.serverTimestamp() e é resolvido pelo servidor.
    assert.ok(entry.updatedAt instanceof Timestamp, "updatedAt deve resolver");

    // A tupla de ordenação continua sendo Timestamps tipados.
    assert.ok(entry.scoreOrder instanceof Timestamp, "scoreOrder deve ser Timestamp");
    assert.ok(entry.winsOrder instanceof Timestamp, "winsOrder deve ser Timestamp");
  });

  it("o replay continua idempotente sob o namespace mutilado", async () => {
    const snap = await seedPrize();
    const first = await onPrizeTransactionCreatedHandler(snap, ACTIVE);
    assert.equal(first.applied, true);

    const parentPath = `${SEASON_RANKINGS_COLLECTION}/${seasonDocumentId(
      ECONOMY_CASH as any,
      SEASON
    )}`;
    const readState = async () => ({
      parent: (await db.doc(parentPath).get()).data(),
      entry: (
        await db.doc(parentPath).collection(SEASON_ENTRIES_SUBCOLLECTION).get()
      ).docs[0].data(),
      guard: (
        await db.collection(RANKING_EVENTS_COLLECTION).doc("prize_compat").get()
      ).data(),
    });

    const before = await readState();

    // O contrato do guard é CONVERGÊNCIA, não recusa: uma reentrega repetida
    // ainda responde `applied: true`, mas não pode escrever nada de novo.
    const replay = await onPrizeTransactionCreatedHandler(snap, ACTIVE);
    assert.equal(replay.applied, true);

    assert.deepEqual(await readState(), before, "o replay deve ser byte-idêntico");
  });
});
