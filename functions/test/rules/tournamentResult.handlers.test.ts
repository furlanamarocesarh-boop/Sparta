import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

/**
 * Behavioral (execution) tests for `startTournament` and
 * `declareTournamentResult`/`payprize`, run against the LOCAL Firestore emulator
 * via the Admin SDK — proving the real Firestore side effects, the atomic
 * settlement, the idempotency/concurrency semantics, and the EXACT response
 * shapes.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 */

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let startTournamentHandler: Handler;
let declareTournamentResultHandler: Handler;
let db: admin.firestore.Firestore;

const adminCtx = { auth: { uid: "admin-1", token: { admin: true } } };

async function expectFailure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "NO_CODE";
  }
  return assert.fail("expected the handler to throw, but it resolved");
}

async function clearAll(): Promise<void> {
  for (const col of [
    "tournaments",
    "tournament_rooms",
    "registrations",
    "wallets",
    "transactions",
    "users",
  ]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }

  // O caixa da plataforma, reposto a cada teste.
  //
  // A liquidação passou a exigir que a plataforma consiga cobrir a premiação:
  // um prêmio fixo acima do arrecadado sai do caixa, e o caixa começa vazio.
  // Estas suítes premiam generosamente contra pools pequenos, então cada uma
  // aporta antes — exatamente o que o operador terá de fazer em produção.
  await Promise.all([
    db
      .collection("house")
      .doc("cash")
      .set({ balance_centavos: 100_000_00, economy_type: "cash" }),
    db
      .collection("house")
      .doc("beta_credit")
      .set({ balance_centavos: 100_000_00, economy_type: "beta_credit" }),
  ]);
}

// ── seed helpers ─────────────────────────────────────────────────────────────

async function seedTournament(
  id: string,
  fields: Record<string, unknown>
): Promise<void> {
  await db
    .collection("tournaments")
    .doc(id)
    .set({
      name: "Copa Teste",
      created_at: admin.firestore.Timestamp.fromMillis(1_000_000),
      starts_at: null,
      ...fields,
    });
}

async function seedRoom(
  id: string,
  opts: { roomId?: string; roomPassword?: string; tournamentRefId?: string } = {}
): Promise<void> {
  await db
    .collection("tournament_rooms")
    .doc(id)
    .set({
      tournament_ref: db
        .collection("tournaments")
        .doc(opts.tournamentRefId ?? id),
      room_id: opts.roomId ?? "ROOM-1",
      room_password: opts.roomPassword ?? "pw-1",
      created_at: admin.firestore.Timestamp.fromMillis(1_000_000),
      updated_at: admin.firestore.Timestamp.fromMillis(1_000_000),
    });
}

async function seedRegistration(
  uid: string,
  tid: string,
  opts: { status?: string; userUid?: string; tournamentId?: string } = {}
): Promise<void> {
  await db
    .collection("registrations")
    .doc(`${uid}_${tid}`)
    .set({
      user_ref: db.collection("users").doc(opts.userUid ?? uid),
      tournament_ref: db.collection("tournaments").doc(opts.tournamentId ?? tid),
      status: opts.status ?? "registered",
      entry_fee: 10,
    });
}

async function seedWallet(
  uid: string,
  opts: { balance?: number; totalWon?: number } = {}
): Promise<void> {
  await db
    .collection("wallets")
    .doc(uid)
    .set({
      balance: opts.balance ?? 10,
      total_won: opts.totalWon ?? 5,
      user_ref: db.collection("users").doc(uid),
    });
}

/** A fully settle-ready tournament: in_progress, prize>0, room, registration, wallet. */
async function seedReadyToSettle(
  tid: string,
  uid: string,
  prize = 40
): Promise<void> {
  await seedTournament(tid, { status: "in_progress", prize });
  await seedRoom(tid);
  await seedRegistration(uid, tid);
  await seedWallet(uid, { balance: 10, totalWon: 5 });
}

const read = (col: string, id: string) => db.collection(col).doc(id).get();

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-result-handlers";
  const mod = (await import("../../src/index.js")) as unknown as {
    startTournamentHandler: Handler;
    declareTournamentResultHandler: Handler;
  };
  startTournamentHandler = mod.startTournamentHandler;
  declareTournamentResultHandler = mod.declareTournamentResultHandler;
  db = admin.firestore();
});

beforeEach(clearAll);
after(clearAll);

// ══════════════════════════ startTournament ═════════════════════════════════

describe("startTournament handler (emulator)", () => {
  it("fails not-found for a non-existent tournament", async () => {
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "ghost" }, adminCtx)
      ),
      "not-found"
    );
  });

  it("moves open -> in_progress and stamps updated_at, leaving created_at/starts_at", async () => {
    await seedTournament("t1", { status: "open", prize: 40 });
    await seedRoom("t1");

    const res = await startTournamentHandler({ tournamentid: "t1" }, adminCtx);
    assert.deepEqual(res, { success: true });

    const snap = await read("tournaments", "t1");
    const data = snap.data() ?? {};
    assert.equal(data.status, "in_progress");
    assert.ok(data.updated_at instanceof admin.firestore.Timestamp);
    // created_at is untouched; starts_at keeps its original null.
    assert.equal(
      (data.created_at as admin.firestore.Timestamp).toMillis(),
      1_000_000
    );
    assert.equal(data.starts_at, null);
  });

  it("fails failed-precondition when the room is missing", async () => {
    await seedTournament("t1", { status: "open", prize: 40 });
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t1" }, adminCtx)
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition on invalid room credentials", async () => {
    await seedTournament("t1", { status: "open", prize: 40 });
    await seedRoom("t1", { roomId: "" });
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t1" }, adminCtx)
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition when the room points at another tournament", async () => {
    await seedTournament("t1", { status: "open", prize: 40 });
    await seedRoom("t1", { tournamentRefId: "other" });
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t1" }, adminCtx)
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition on an invalid prize (zero)", async () => {
    await seedTournament("t1", { status: "open", prize: 0 });
    await seedRoom("t1");
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t1" }, adminCtx)
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition for completed or unknown status", async () => {
    await seedTournament("t1", { status: "completed", prize: 40 });
    await seedRoom("t1");
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t1" }, adminCtx)
      ),
      "failed-precondition"
    );
    await seedTournament("t2", { status: "weird", prize: 40 });
    await seedRoom("t2");
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t2" }, adminCtx)
      ),
      "failed-precondition"
    );
  });

  it("is idempotent on replay and does NOT rewrite updated_at", async () => {
    await seedTournament("t1", {
      status: "in_progress",
      prize: 40,
      updated_at: admin.firestore.Timestamp.fromMillis(2_000_000),
    });
    await seedRoom("t1");

    const res = await startTournamentHandler({ tournamentid: "t1" }, adminCtx);
    assert.deepEqual(res, { success: true });

    const data = (await read("tournaments", "t1")).data() ?? {};
    assert.equal(data.status, "in_progress");
    // Replay must not churn the timestamp.
    assert.equal(
      (data.updated_at as admin.firestore.Timestamp).toMillis(),
      2_000_000
    );
  });

  it("fails a replay whose structure is no longer valid (room gone)", async () => {
    await seedTournament("t1", { status: "in_progress", prize: 40 });
    // No room seeded.
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t1" }, adminCtx)
      ),
      "failed-precondition"
    );
  });
});

// ═══════════════════ declareTournamentResult / payprize ═════════════════════

describe("declareTournamentResult handler (emulator)", () => {
  it("fails not-found for a non-existent tournament", async () => {
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "ghost", winneruid: "w1" },
          adminCtx
        )
      ),
      "not-found"
    );
  });

  it("fails failed-precondition when status is open (not in_progress)", async () => {
    await seedTournament("t1", { status: "open", prize: 40 });
    await seedRegistration("w1", "t1");
    await seedWallet("w1");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition for an unknown status", async () => {
    await seedTournament("t1", { status: "weird", prize: 40 });
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition when the registration is missing", async () => {
    await seedTournament("t1", { status: "in_progress", prize: 40 });
    await seedWallet("w1");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition when the registration is not confirmed", async () => {
    await seedTournament("t1", { status: "in_progress", prize: 40 });
    await seedRegistration("w1", "t1", { status: "pending" });
    await seedWallet("w1");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition when registration refs point elsewhere", async () => {
    await seedTournament("t1", { status: "in_progress", prize: 40 });
    await seedRegistration("w1", "t1", { userUid: "other" });
    await seedWallet("w1");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );

    await seedRegistration("w1", "t1", { tournamentId: "other" });
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("fails not-found when the winner wallet is missing", async () => {
    await seedTournament("t1", { status: "in_progress", prize: 40 });
    await seedRegistration("w1", "t1");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "not-found"
    );
  });

  it("fails failed-precondition on an invalid stored prize (zero)", async () => {
    await seedTournament("t1", { status: "in_progress", prize: 0 });
    await seedRegistration("w1", "t1");
    await seedWallet("w1");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("settles a valid tournament: exact credit, canonical transaction, result, completed, equal stamps", async () => {
    await seedReadyToSettle("t1", "w1", 40);

    const res = await declareTournamentResultHandler(
      { tournamentid: "t1", winneruid: "w1" },
      adminCtx
    );
    assert.deepEqual(res, { success: true });

    // Wallet: 10 + 40 = 50; total_won 5 + 40 = 45; updated_at stamped.
    const wallet = (await read("wallets", "w1")).data() ?? {};
    assert.equal(wallet.balance, 50);
    assert.equal(wallet.total_won, 45);
    assert.ok(wallet.updated_at instanceof admin.firestore.Timestamp);

    // Deterministic prize transaction with the canonical schema.
    const tx = (await read("transactions", "prize_t1")).data() ?? {};
    assert.deepEqual(Object.keys(tx).sort(), [
      "amount",
      "balance_after",
      "category",
      "display_name",
      "external_id",
      "previous_balance",
      "status",
      "timestamp",
      "tournament_ref",
      "user_ref",
    ]);
    assert.equal(tx.amount, 40);
    assert.equal(tx.category, "prize");
    assert.equal(tx.display_name, "");
    assert.equal(tx.previous_balance, 10);
    assert.equal(tx.balance_after, 50);
    assert.equal(tx.status, "completed");
    assert.equal(tx.external_id, "prize_t1");
    assert.equal((tx.user_ref as admin.firestore.DocumentReference).path, "users/w1");
    assert.equal(
      (tx.tournament_ref as admin.firestore.DocumentReference).path,
      "tournaments/t1"
    );

    // Tournament: completed + result persisted with canonical refs.
    const tournament = (await read("tournaments", "t1")).data() ?? {};
    assert.equal(tournament.status, "completed");
    const result = tournament.result as Record<string, unknown>;
    assert.equal(result.placement, 1);
    assert.equal(result.winner_uid, "w1");
    assert.equal(result.prize, 40);
    assert.equal((result.winner_ref as admin.firestore.DocumentReference).path, "users/w1");
    assert.equal(
      (result.registration_ref as admin.firestore.DocumentReference).path,
      "registrations/w1_t1"
    );
    assert.equal(
      (result.transaction_ref as admin.firestore.DocumentReference).path,
      "transactions/prize_t1"
    );

    // Every stamp written in the commit is the SAME time.
    const stamps = [
      (tx.timestamp as admin.firestore.Timestamp).toMillis(),
      (result.declared_at as admin.firestore.Timestamp).toMillis(),
      (result.paid_at as admin.firestore.Timestamp).toMillis(),
      (tournament.updated_at as admin.firestore.Timestamp).toMillis(),
      (wallet.updated_at as admin.firestore.Timestamp).toMillis(),
    ];
    assert.equal(new Set(stamps).size, 1, "all commit stamps must be equal");
  });

  it("is idempotent for the same winner: two successes, exactly one credit", async () => {
    await seedReadyToSettle("t1", "w1", 40);

    const a = await declareTournamentResultHandler(
      { tournamentid: "t1", winneruid: "w1" },
      adminCtx
    );
    const b = await declareTournamentResultHandler(
      { tournamentid: "t1", winneruid: "w1" },
      adminCtx
    );
    assert.deepEqual(a, { success: true });
    assert.deepEqual(b, { success: true });

    // Credited once only.
    const wallet = (await read("wallets", "w1")).data() ?? {};
    assert.equal(wallet.balance, 50);
    assert.equal(wallet.total_won, 45);
  });

  it("fails failed-precondition on replay with a different winner", async () => {
    await seedReadyToSettle("t1", "w1", 40);
    await declareTournamentResultHandler(
      { tournamentid: "t1", winneruid: "w1" },
      adminCtx
    );
    // Now completed; declaring a different winner must fail.
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w2" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition on a partial in_progress state (transaction already exists)", async () => {
    await seedTournament("t1", { status: "in_progress", prize: 40 });
    await seedRegistration("w1", "t1");
    await seedWallet("w1");
    // A stray prize transaction exists while still in_progress → inconsistent.
    await db.collection("transactions").doc("prize_t1").set({
      amount: 40,
      category: "prize",
      external_id: "prize_t1",
    });
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("fails failed-precondition on a partial in_progress state (result already exists)", async () => {
    await seedTournament("t1", {
      status: "in_progress",
      prize: 40,
      result: { placement: 1, winner_uid: "w1" },
    });
    await seedRegistration("w1", "t1");
    await seedWallet("w1");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("rolls back completely on a failed settlement (no tx, no result, status intact)", async () => {
    // Wallet missing forces a not-found AFTER the registration passed — no write
    // must survive.
    await seedTournament("t1", { status: "in_progress", prize: 40 });
    await seedRegistration("w1", "t1");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t1", winneruid: "w1" },
          adminCtx
        )
      ),
      "not-found"
    );
    assert.equal((await read("transactions", "prize_t1")).exists, false);
    const tournament = (await read("tournaments", "t1")).data() ?? {};
    assert.equal(tournament.status, "in_progress");
    assert.equal(tournament.result, undefined);
  });
});

// ═══════════════════════════ concurrency ════════════════════════════════════

describe("declareTournamentResult concurrency (emulator)", () => {
  it("two concurrent identical calls: both succeed, exactly one credit", async () => {
    await seedReadyToSettle("t1", "w1", 40);

    const [a, b] = await Promise.all([
      declareTournamentResultHandler(
        { tournamentid: "t1", winneruid: "w1" },
        adminCtx
      ),
      declareTournamentResultHandler(
        { tournamentid: "t1", winneruid: "w1" },
        adminCtx
      ),
    ]);
    assert.deepEqual(a, { success: true });
    assert.deepEqual(b, { success: true });

    const wallet = (await read("wallets", "w1")).data() ?? {};
    assert.equal(wallet.balance, 50, "credited exactly once");
    assert.equal(wallet.total_won, 45);
  });

  it("two concurrent different winners: one success, one failed-precondition", async () => {
    await seedTournament("t1", { status: "in_progress", prize: 40 });
    await seedRoom("t1");
    await seedRegistration("w1", "t1");
    await seedRegistration("w2", "t1");
    await seedWallet("w1", { balance: 10, totalWon: 5 });
    await seedWallet("w2", { balance: 100, totalWon: 0 });

    const results = await Promise.allSettled([
      declareTournamentResultHandler(
        { tournamentid: "t1", winneruid: "w1" },
        adminCtx
      ),
      declareTournamentResultHandler(
        { tournamentid: "t1", winneruid: "w2" },
        adminCtx
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one winner is declared");
    assert.equal(rejected.length, 1, "the other is rejected");
    assert.equal(
      (rejected[0] as PromiseRejectedResult).reason.code,
      "failed-precondition"
    );

    // Exactly one wallet was credited.
    const w1 = (await read("wallets", "w1")).data() ?? {};
    const w2 = (await read("wallets", "w2")).data() ?? {};
    const w1Credited = w1.balance === 50;
    const w2Credited = w2.balance === 140;
    assert.notEqual(w1Credited, w2Credited, "exactly one of the two is credited");
  });
});
