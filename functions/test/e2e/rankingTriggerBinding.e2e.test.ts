import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

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
import { assertEmulatorOnly } from "../support/emulatorGuard.js";
import { fetchWithTimeout } from "../support/httpTimeout.js";

/**
 * THE BINDING PROOF — and deliberately nothing else.
 *
 * Every existing ranking test invokes `onPrizeTransactionCreatedHandler`
 * DIRECTLY with a hand-built snapshot. That proves the handler's logic, but it
 * cannot prove the one thing only a running emulator can show: that creating a
 * document at `transactions/{transactionId}` actually causes the Firestore
 * emulator to DELIVER the event to the deployed trigger. The declaration at
 * `src/index.ts` (`central.firestore.document(...).onCreate(...)`) had no test
 * of any kind — a wrong path or `.onWrite` instead of `.onCreate` would have
 * passed the whole suite.
 *
 * So this file NEVER imports the handler. It writes ONE prize row with the
 * Admin SDK and then only observes Firestore, waiting for documents that can
 * exist only if the trigger fired on its own.
 *
 * TEMPORAL CARE — the reason the timestamp is explicit. Today is August 2026 and
 * `FIRST_ACTIVE_SEASON_ID` is `2026-09`, so a prize stamped with
 * `serverTimestamp()` would land in August, be classified
 * `before-first-active-season`, and write NOTHING. A test built that way would
 * pass while proving nothing at all. The fixture therefore carries an explicit
 * September 2026 instant — inside the first active season — which is the only
 * way an active-path write can be observed without touching the activation
 * constant or adding any emulator/production bypass.
 */

const PROJECT_ID = "demo-sparta-battle";

/** Unique to this suite so no sibling E2E file can collide with it. */
const TOURNAMENT_ID = "e2e-ranking-binding";
const TX_ID = `prize_${TOURNAMENT_ID}`;
const PLAYER_UID = "e2e-ranking-binding-player";

/** Inside the first active season. São Paulo local date: 2026-09-04. */
const PRIZE_AT = new Date("2026-09-04T18:22:11.000Z");
const SEASON = "2026-09";
const DAY_KEY = "2026-09-04";

/** Canonical prize amount, in reais as the ledger stores it. */
const PRIZE_REAIS = 500;
const PRIZE_CENTAVOS = 50_000;

/** Finite budgets — this suite may never be the reason a run hangs. */
const TRIGGER_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";

let db: admin.firestore.Firestore;

const parentPath = `${SEASON_RANKINGS_COLLECTION}/${seasonDocumentId(
  ECONOMY_CASH as never,
  SEASON
)}`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a document to appear, bounded. Returns its data, or throws naming
 * the path — a silent `undefined` would turn a missing delivery into a
 * confusing downstream assertion instead of a clear "the trigger never fired".
 */
async function awaitDoc(
  path: string,
  timeoutMs = TRIGGER_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await db.doc(path).get();
    if (snap.exists) return snap.data() ?? {};
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `o trigger não entregou em ${timeoutMs}ms: "${path}" nunca apareceu — ` +
      `o binding onCreate de transactions/{transactionId} não disparou`
  );
}

/** Deletes everything this suite could have created, including subcollections. */
async function cleanup(): Promise<void> {
  await db.collection("transactions").doc(TX_ID).delete();
  await db.collection(RANKING_EVENTS_COLLECTION).doc(TX_ID).delete();

  const parentRef = db.doc(parentPath);
  for (const sub of await parentRef.listCollections()) {
    const snap = await sub.get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await parentRef.delete();

  const identity = await db.collection("public_player_ids").doc(PLAYER_UID).get();
  const publicPlayerId = identity.exists
    ? (identity.data()?.publicPlayerId as string | undefined)
    : undefined;
  if (publicPlayerId) {
    await db.collection("public_player_id_index").doc(publicPlayerId).delete();
  }
  await db.collection("public_player_ids").doc(PLAYER_UID).delete();
}

let guard: Record<string, unknown>;
let entry: Record<string, unknown>;
let publicPlayerId: string;

describe("E2E — o trigger de ranking dispara SOZINHO (binding onCreate)", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID); // fail-closed ANTES de qualquer uso de SDK

    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    // O emulador de Functions precisa estar de pé: é ele quem entrega o evento.
    // Sem esta checagem, uma ausência viraria "o trigger não disparou".
    try {
      await fetchWithTimeout(`http://${FUNCTIONS_HOST}/`, {}, 10_000);
    } catch (error) {
      throw new Error(
        `FAIL-CLOSED (E2E aborted): emulador de Functions inacessível em ` +
          `${FUNCTIONS_HOST} — ${(error as Error).message}`
      );
    }

    await cleanup();

    // A ÚNICA escrita desta suíte. Forma canônica copiada de
    // test/rules/seasonRanking.handlers.test.ts (seedPrize): nenhum campo inventado.
    await db
      .collection("transactions")
      .doc(TX_ID)
      .set({
        amount: PRIZE_REAIS,
        category: CASH_PRIZE_CATEGORY,
        user_ref: db.collection("users").doc(PLAYER_UID),
        display_name: "",
        tournament_ref: db.collection("tournaments").doc(TOURNAMENT_ID),
        previous_balance: 0,
        balance_after: PRIZE_REAIS,
        // Explícito, não serverTimestamp(): ver a nota temporal no topo.
        timestamp: Timestamp.fromDate(PRIZE_AT),
        status: "completed",
        external_id: TX_ID,
      });

    // Daqui em diante, apenas observação.
    guard = await awaitDoc(`${RANKING_EVENTS_COLLECTION}/${TX_ID}`);
    publicPlayerId = guard.publicPlayerId as string;
    assert.ok(publicPlayerId, "o guard deve nomear o publicPlayerId cunhado");
    entry = await awaitDoc(
      `${parentPath}/${SEASON_ENTRIES_SUBCOLLECTION}/${publicPlayerId}`
    );
  });

  after(async () => {
    await cleanup();
  });

  it("o guard ranking_events/{transactionId} foi criado pelo trigger", () => {
    assert.ok(guard, "ranking_events deve existir");
    assert.equal(
      (guard.transactionRef as { path?: string })?.path,
      `transactions/${TX_ID}`,
      "o guard aponta para a transação que o originou"
    );
  });

  it("a entry season_rankings/cash_2026-09/entries/{publicPlayerId} foi criada", () => {
    assert.ok(entry, "a entry da temporada deve existir");
    assert.equal(parentPath, `${SEASON_RANKINGS_COLLECTION}/cash_${SEASON}`);
  });

  it("o parent da temporada foi criado junto", async () => {
    const parent = await db.doc(parentPath).get();
    assert.equal(parent.exists, true);
    assert.equal(parent.data()?.playerCount, 1);
    assert.equal(parent.data()?.totalScoreCentavos, PRIZE_CENTAVOS);
  });

  it("os campos do guard correspondem à transação", () => {
    assert.equal(guard.economy, ECONOMY_CASH);
    assert.equal(guard.seasonId, SEASON);
    assert.equal(guard.dayKey, DAY_KEY);
    assert.equal(guard.amountCentavos, PRIZE_CENTAVOS);
  });

  it("os campos da entry correspondem à transação", () => {
    assert.equal(entry.economy, ECONOMY_CASH);
    assert.equal(entry.seasonId, SEASON);
    assert.equal(entry.publicPlayerId, publicPlayerId);
    assert.equal(entry.scoreCentavos, PRIZE_CENTAVOS);
    assert.equal(entry.winsCount, 1);
    assert.equal(
      (entry.firstPrizeAt as Timestamp).toMillis(),
      PRIZE_AT.getTime(),
      "o instante do prêmio foi preservado exatamente"
    );
    assert.equal((entry.lastPrizeAt as Timestamp).toMillis(), PRIZE_AT.getTime());
  });

  it("a entry não guarda uid — o pseudônimo é a única identidade", () => {
    const serialized = JSON.stringify(entry);
    assert.ok(
      !serialized.includes(PLAYER_UID),
      "o uid do jogador nunca pode aparecer na entry"
    );
  });
});
