import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

/**
 * Security-rules matrix for the public identity map and its reverse index.
 *
 * These two collections are the ONE bridge between a real account and its
 * public pseudonym, so the posture is total denial in BOTH directions, for
 * EVERY client — signed out, the owner, another player, and an `admin: true`
 * client alike:
 *
 *  - no client may READ either collection, so a pseudonym can never be resolved
 *    back to an account and the id space can never be enumerated. Denying the
 *    admin claim too is deliberate: a single admin-facing screen paging these
 *    documents would defeat the pseudonymity of every player at once;
 *  - no client may WRITE either collection, so an identity can never be forged,
 *    reassigned, released or reused. They exist only through the Admin SDK in
 *    Cloud Functions, which bypasses these rules.
 *
 * NEVER touches production: project id `demo-*`, local emulator only.
 */

const PROJECT_ID = "demo-sparta-battle-public-id-rules";

const OWNER = "public-id-owner";
const OTHER = "public-id-other";
const ADMIN = "public-id-admin";

const OWNER_PUBLIC_ID = "A7fQ2_kB9xLm3NpQr5TzUw";
const OTHER_PUBLIC_ID = "Zq8Wv2_tR4mYbN7xJc-K1L";

const MAP_COLLECTION = "public_player_ids";
const INDEX_COLLECTION = "public_player_id_index";

const MAP_DOC = `${MAP_COLLECTION}/${OWNER}`;
const INDEX_DOC = `${INDEX_COLLECTION}/${OWNER_PUBLIC_ID}`;

const DAY = "2026-07-28";

let testEnv: RulesTestEnvironment;

/** Every client shape that must be denied, labelled for failure messages. */
function everyClientContext(): ReadonlyArray<readonly [string, any]> {
  return [
    ["deslogado", testEnv.unauthenticatedContext().firestore()],
    ["dono", testEnv.authenticatedContext(OWNER).firestore()],
    ["terceiro", testEnv.authenticatedContext(OTHER).firestore()],
    ["admin", testEnv.authenticatedContext(ADMIN, { admin: true }).firestore()],
  ];
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(process.cwd(), "..", "firestore.rules"), "utf8"),
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    // A complete, valid reservation pair for the owner, plus one for another
    // player, so "read someone else's" is a real question and not a missing doc.
    await db.doc(MAP_DOC).set({
      publicPlayerId: OWNER_PUBLIC_ID,
      createdAt: new Date("2026-07-01T12:00:00Z"),
    });
    await db.doc(INDEX_DOC).set({
      uid: OWNER,
      createdAt: new Date("2026-07-01T12:00:00Z"),
    });
    await db.doc(`${MAP_COLLECTION}/${OTHER}`).set({
      publicPlayerId: OTHER_PUBLIC_ID,
      createdAt: new Date("2026-07-02T12:00:00Z"),
    });
    await db.doc(`${INDEX_COLLECTION}/${OTHER_PUBLIC_ID}`).set({
      uid: OTHER,
      createdAt: new Date("2026-07-02T12:00:00Z"),
    });

    // Fixtures for the collections whose posture must stay exactly as it was.
    for (const uid of [OWNER, OTHER]) {
      await db.doc(`users/${uid}`).set({ email: `${uid}@example.com` });
      await db.doc(`wallets/${uid}`).set({
        balance: 0,
        beta_balance: 0,
        user_ref: db.doc(`users/${uid}`),
      });
      await db.doc(`player_activity/${uid}_${DAY}`).set({
        uid,
        user_ref: db.doc(`users/${uid}`),
        activity_day: DAY,
      });
    }
    await db.doc("tournaments/t-1").set({ name: "Torneio", status: "open" });
    await db.doc("tournament_rooms/t-1").set({ room_id: "X", password: "Y" });
  });
});

describe("preparação de fixtures — equivalente ao Admin SDK", () => {
  it("o contexto SEM Rules consegue criar os dois documentos de identidade", async () => {
    // Prova que a negação total não impede o backend: o Admin SDK ignora Rules,
    // e é assim que a reserva realmente acontece em produção.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const map = await db.doc(MAP_DOC).get();
      const index = await db.doc(INDEX_DOC).get();

      if (!map.exists || !index.exists) {
        throw new Error("os fixtures de identidade deveriam existir");
      }
      if (map.data()?.publicPlayerId !== OWNER_PUBLIC_ID) {
        throw new Error("o fixture do mapa não bate com o índice");
      }
      if (index.data()?.uid !== OWNER) {
        throw new Error("o fixture do índice não bate com o mapa");
      }

      // E também consegue escrever um par novo.
      await db.doc(`${MAP_COLLECTION}/fixture-uid`).set({
        publicPlayerId: "BBBBBBBBBBBBBBBBBBBBBB",
        createdAt: new Date(),
      });
      await db.doc(`${INDEX_COLLECTION}/BBBBBBBBBBBBBBBBBBBBBB`).set({
        uid: "fixture-uid",
        createdAt: new Date(),
      });
    });
  });
});

describe("public_player_ids — nenhum cliente lê", () => {
  it("get é negado para deslogado, dono, terceiro e admin", async () => {
    for (const [, db] of everyClientContext()) {
      await assertFails(db.doc(MAP_DOC).get());
      await assertFails(db.doc(`${MAP_COLLECTION}/${OTHER}`).get());
      // Um documento INEXISTENTE também é negado: nem a existência vaza.
      await assertFails(db.doc(`${MAP_COLLECTION}/ninguem`).get());
    }
  });

  it("list é negado para todos, inclusive filtrado", async () => {
    for (const [, db] of everyClientContext()) {
      await assertFails(db.collection(MAP_COLLECTION).get());
      await assertFails(
        db.collection(MAP_COLLECTION).where("publicPlayerId", "==", OWNER_PUBLIC_ID).get()
      );
    }
  });
});

describe("public_player_ids — nenhum cliente escreve", () => {
  it("create é negado para todos", async () => {
    for (const [label, db] of everyClientContext()) {
      await assertFails(
        db.doc(`${MAP_COLLECTION}/forged-${label}`).set({
          publicPlayerId: "CCCCCCCCCCCCCCCCCCCCCC",
          createdAt: new Date(),
        })
      );
    }
  });

  it("update e delete são negados para todos", async () => {
    for (const [, db] of everyClientContext()) {
      await assertFails(db.doc(MAP_DOC).update({ publicPlayerId: OTHER_PUBLIC_ID }));
      await assertFails(db.doc(MAP_DOC).delete());
      await assertFails(db.doc(`${MAP_COLLECTION}/${OTHER}`).delete());
    }
  });
});

describe("public_player_id_index — nenhum cliente lê", () => {
  it("get é negado para todos — o pseudônimo nunca volta a ser um uid", async () => {
    for (const [, db] of everyClientContext()) {
      await assertFails(db.doc(INDEX_DOC).get());
      await assertFails(db.doc(`${INDEX_COLLECTION}/${OTHER_PUBLIC_ID}`).get());
    }
  });

  it("list é negado para todos — o espaço de ids não é enumerável", async () => {
    for (const [, db] of everyClientContext()) {
      await assertFails(db.collection(INDEX_COLLECTION).get());
      await assertFails(
        db.collection(INDEX_COLLECTION).where("uid", "==", OWNER).get()
      );
    }
  });
});

describe("public_player_id_index — nenhum cliente escreve", () => {
  it("create é negado para todos — uma identidade não pode ser forjada", async () => {
    for (const [label, db] of everyClientContext()) {
      await assertFails(
        db.doc(`${INDEX_COLLECTION}/DDDDDDDDDDDDDDDDDDDDDD`).set({
          uid: label,
          createdAt: new Date(),
        })
      );
    }
  });

  it("update e delete são negados — nem reatribuir, nem liberar para reuso", async () => {
    for (const [, db] of everyClientContext()) {
      await assertFails(db.doc(INDEX_DOC).update({ uid: OTHER }));
      await assertFails(db.doc(INDEX_DOC).delete());
    }
  });
});

describe("as coleções existentes mantêm exatamente a postura anterior", () => {
  it("users e wallets continuam legíveis só pelo dono ou admin", async () => {
    const owner = testEnv.authenticatedContext(OWNER).firestore();
    const other = testEnv.authenticatedContext(OTHER).firestore();
    const adminDb = testEnv
      .authenticatedContext(ADMIN, { admin: true })
      .firestore();

    await assertSucceeds(owner.doc(`users/${OWNER}`).get());
    await assertSucceeds(owner.doc(`wallets/${OWNER}`).get());
    await assertSucceeds(adminDb.doc(`wallets/${OWNER}`).get());
    await assertFails(other.doc(`wallets/${OWNER}`).get());
    await assertFails(owner.doc(`wallets/${OWNER}`).update({ balance: 999 }));
  });

  it("tournaments continua legível a qualquer logado e não gravável", async () => {
    const owner = testEnv.authenticatedContext(OWNER).firestore();
    const anon = testEnv.unauthenticatedContext().firestore();

    await assertSucceeds(owner.doc("tournaments/t-1").get());
    await assertFails(anon.doc("tournaments/t-1").get());
    await assertFails(owner.doc("tournaments/t-1").update({ status: "closed" }));
  });

  it("player_activity continua isolado por dono", async () => {
    const owner = testEnv.authenticatedContext(OWNER).firestore();
    const other = testEnv.authenticatedContext(OTHER).firestore();

    await assertSucceeds(owner.doc(`player_activity/${OWNER}_${DAY}`).get());
    await assertFails(other.doc(`player_activity/${OWNER}_${DAY}`).get());
  });

  it("tournament_rooms continua totalmente fechado", async () => {
    const owner = testEnv.authenticatedContext(OWNER).firestore();
    const adminDb = testEnv
      .authenticatedContext(ADMIN, { admin: true })
      .firestore();

    await assertFails(owner.doc("tournament_rooms/t-1").get());
    await assertFails(adminDb.doc("tournament_rooms/t-1").get());
  });

  it("a coleção não prevista continua negada pelo catch-all", async () => {
    const owner = testEnv.authenticatedContext(OWNER).firestore();

    await assertFails(owner.doc("colecao_inexistente/x").get());
    await assertFails(owner.doc("colecao_inexistente/x").set({ a: 1 }));
  });
});
