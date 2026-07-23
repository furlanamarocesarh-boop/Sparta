import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

/**
 * Behavioral (execution) tests for the tournament-room callables, run against
 * the LOCAL Firestore emulator via the Admin SDK — proving the real Firestore
 * side effects and the EXACT public response shapes, not just source strings.
 *
 * NEVER touches production:
 *  - it runs only under `npm run test:rules`, which sets FIRESTORE_EMULATOR_HOST
 *    (the `before` hook asserts it is present and aborts otherwise);
 *  - it uses a DISTINCT emulator project id, so it shares no data with the
 *    rules-unit-testing suite (which clears `demo-sparta-battle`) even though
 *    node runs the two test files in parallel.
 */

type Handler = (
  data: any,
  context: any
) => Promise<Record<string, unknown>>;

let setTournamentRoomHandler: Handler;
let getTournamentRoomHandler: Handler;
let db: admin.firestore.Firestore;

const adminCtx = { auth: { uid: "admin-1", token: { admin: true } } };
const playerCtx = (uid: string) => ({ auth: { uid, token: {} } });

interface Failure {
  code: string;
  reason?: string;
}

async function expectFailure(fn: () => Promise<unknown>): Promise<Failure> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: unknown; details?: { reason?: unknown } };
    return {
      code: typeof e.code === "string" ? e.code : "NO_CODE",
      reason:
        e.details && typeof e.details.reason === "string"
          ? e.details.reason
          : undefined,
    };
  }
  return assert.fail("expected the handler to throw, but it resolved");
}

async function clearAll(): Promise<void> {
  for (const col of ["tournaments", "registrations", "tournament_rooms"]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }
}

async function seedTournament(id: string): Promise<void> {
  await db.collection("tournaments").doc(id).set({
    name: "Copa Teste",
    status: "open",
    entry_fee: 10,
    current_participants: 0,
    max_participants: 16,
  });
}

async function seedRegistration(uid: string, tid: string): Promise<void> {
  await db
    .collection("registrations")
    .doc(`${uid}_${tid}`)
    .set({
      user_ref: db.collection("users").doc(uid),
      tournament_ref: db.collection("tournaments").doc(tid),
      status: "registered",
    });
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  // Isolated emulator namespace: never the rules suite's project, never prod.
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-room-handlers";
  // Dynamic import AFTER GCLOUD_PROJECT is set — index.ts calls
  // admin.initializeApp() at module load, and ESM hoists static imports.
  const mod = (await import("../../src/index.js")) as unknown as {
    setTournamentRoomHandler: Handler;
    getTournamentRoomHandler: Handler;
  };
  setTournamentRoomHandler = mod.setTournamentRoomHandler;
  getTournamentRoomHandler = mod.getTournamentRoomHandler;
  db = admin.firestore();
});

beforeEach(clearAll);
after(clearAll);

describe("setTournamentRoom handler — behavior (emulator)", () => {
  it("rejects publishing to a non-existent tournament with not-found", async () => {
    const failure = await expectFailure(() =>
      setTournamentRoomHandler(
        { tournamentid: "ghost", roomid: "R", roompassword: "P" },
        adminCtx
      )
    );
    assert.equal(failure.code, "not-found");
  });

  it("publishes the room and returns EXACTLY { success: true }", async () => {
    await seedTournament("t-set");
    const res = await setTournamentRoomHandler(
      { tournamentid: "t-set", roomid: "ROOM-1", roompassword: "pw-1" },
      adminCtx
    );
    assert.deepEqual(res, { success: true });
    assert.deepEqual(Object.keys(res).sort(), ["success"]);
  });

  it("writes tournament_rooms/{id} with the exact schema and a valid tournament_ref", async () => {
    await seedTournament("t-doc");
    await setTournamentRoomHandler(
      { tournamentid: "t-doc", roomid: "ROOM-2", roompassword: "pw-2" },
      adminCtx
    );

    const roomSnap = await db.collection("tournament_rooms").doc("t-doc").get();
    assert.ok(roomSnap.exists);
    const room = roomSnap.data()!;

    assert.deepEqual(Object.keys(room).sort(), [
      "created_at",
      "room_id",
      "room_password",
      "tournament_ref",
      "updated_at",
    ]);
    assert.equal(room.room_id, "ROOM-2");
    assert.equal(room.room_password, "pw-2");
    assert.equal(room.tournament_ref.path, "tournaments/t-doc");
    assert.ok(room.created_at instanceof admin.firestore.Timestamp);
    assert.ok(room.updated_at instanceof admin.firestore.Timestamp);
  });

  it("never writes credentials into the tournaments document", async () => {
    await seedTournament("t-clean");
    await setTournamentRoomHandler(
      { tournamentid: "t-clean", roomid: "ROOM-3", roompassword: "pw-3" },
      adminCtx
    );
    const tournament = (
      await db.collection("tournaments").doc("t-clean").get()
    ).data()!;
    for (const forbidden of [
      "room_id",
      "room_password",
      "roomid",
      "roompassword",
    ]) {
      assert.ok(
        !(forbidden in tournament),
        `tournaments doc must not contain ${forbidden}`
      );
    }
  });

  it("re-publishing preserves created_at and advances updated_at", async () => {
    await seedTournament("t-rep");
    await setTournamentRoomHandler(
      { tournamentid: "t-rep", roomid: "ROOM-A", roompassword: "pw-A" },
      adminCtx
    );
    const first = (
      await db.collection("tournament_rooms").doc("t-rep").get()
    ).data()!;

    await delay(25);

    await setTournamentRoomHandler(
      { tournamentid: "t-rep", roomid: "ROOM-B", roompassword: "pw-B" },
      adminCtx
    );
    const second = (
      await db.collection("tournament_rooms").doc("t-rep").get()
    ).data()!;

    assert.ok(
      second.created_at.isEqual(first.created_at),
      "created_at must be preserved across re-publish"
    );
    assert.ok(
      second.updated_at.toMillis() > first.updated_at.toMillis(),
      "updated_at must advance on re-publish"
    );
    // The write really happened (new credentials stored).
    assert.equal(second.room_id, "ROOM-B");
    assert.equal(second.room_password, "pw-B");
  });
});

describe("getTournamentRoom handler — behavior (emulator)", () => {
  it("returns not-found for a non-existent tournament, before checking registration", async () => {
    // No tournament AND no registration: the tournament check runs first, so the
    // code is not-found (NOT permission-denied) — proving the contract ordering.
    const failure = await expectFailure(() =>
      getTournamentRoomHandler({ tournamentid: "ghost" }, playerCtx("p1"))
    );
    assert.equal(failure.code, "not-found");
  });

  it("denies a caller with no registration: permission-denied + registration-required", async () => {
    await seedTournament("t-noreg");
    const failure = await expectFailure(() =>
      getTournamentRoomHandler({ tournamentid: "t-noreg" }, playerCtx("p1"))
    );
    assert.equal(failure.code, "permission-denied");
    assert.equal(failure.reason, "registration-required");
  });

  it("denies a registered caller when the room is unpublished: failed-precondition + room-not-published", async () => {
    await seedTournament("t-noroom");
    await seedRegistration("p1", "t-noroom");
    const failure = await expectFailure(() =>
      getTournamentRoomHandler({ tournamentid: "t-noroom" }, playerCtx("p1"))
    );
    assert.equal(failure.code, "failed-precondition");
    assert.equal(failure.reason, "room-not-published");
  });

  it("returns EXACTLY { success, roomid, roompassword } to a registered caller once published", async () => {
    await seedTournament("t-ok");
    await seedRegistration("p1", "t-ok");
    await setTournamentRoomHandler(
      { tournamentid: "t-ok", roomid: "ROOM-X", roompassword: "pw-X" },
      adminCtx
    );

    const res = await getTournamentRoomHandler(
      { tournamentid: "t-ok" },
      playerCtx("p1")
    );

    assert.deepEqual(res, {
      success: true,
      roomid: "ROOM-X",
      roompassword: "pw-X",
    });
    assert.deepEqual(Object.keys(res).sort(), [
      "roomid",
      "roompassword",
      "success",
    ]);
    // No snake_case, no stored-only fields, no extra fields.
    for (const forbidden of [
      "room_id",
      "room_password",
      "tournament_ref",
      "created_at",
      "updated_at",
      "tournamentid",
    ]) {
      assert.ok(!(forbidden in res), `response must not contain ${forbidden}`);
    }
  });

  it("does not honor another UID's registration (deterministic id only)", async () => {
    await seedTournament("t-cross");
    await seedRegistration("player-A", "t-cross");
    await setTournamentRoomHandler(
      { tournamentid: "t-cross", roomid: "ROOM-Y", roompassword: "pw-Y" },
      adminCtx
    );

    // player-B has no `player-B_t-cross` registration and must be refused, even
    // though player-A IS registered and the room IS published.
    const failure = await expectFailure(() =>
      getTournamentRoomHandler(
        { tournamentid: "t-cross" },
        playerCtx("player-B")
      )
    );
    assert.equal(failure.code, "permission-denied");
    assert.equal(failure.reason, "registration-required");
  });

  it("ignores a non-deterministic registration doc (no field/query fallback)", async () => {
    await seedTournament("t-fb");
    // A registration doc that references player-B but is NOT keyed {uid}_{tid}.
    await db.collection("registrations").doc("arbitrary-key-123").set({
      user_ref: db.collection("users").doc("player-B"),
      tournament_ref: db.collection("tournaments").doc("t-fb"),
      status: "registered",
    });
    await setTournamentRoomHandler(
      { tournamentid: "t-fb", roomid: "ROOM-Z", roompassword: "pw-Z" },
      adminCtx
    );

    const failure = await expectFailure(() =>
      getTournamentRoomHandler({ tournamentid: "t-fb" }, playerCtx("player-B"))
    );
    assert.equal(failure.code, "permission-denied");
    assert.equal(failure.reason, "registration-required");
  });
});
