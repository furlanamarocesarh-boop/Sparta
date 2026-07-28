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
 * Security-rules matrix for `player_activity`.
 *
 * The collection is NOT financial, but it is personal: it says which days a
 * specific player opened the app. This suite locks the two properties that
 * matter:
 *
 *  - ISOLATION: a player reads only their own history. Neither a direct `get`
 *    on someone else's document nor a `list` filtered to someone else's
 *    `user_ref` is allowed;
 *  - SERVER-AUTHORITATIVE: no client — owner, other player, or admin claim —
 *    may create, update or delete an activity document. They exist only via the
 *    `recordDailyAppOpen` callable (Admin SDK, which bypasses these rules), so
 *    a player can neither forge days they never opened the app nor erase days
 *    they did.
 *
 * NEVER touches production: project id `demo-*`, local emulator only.
 */

const PROJECT_ID = "demo-sparta-battle-activity-rules";

const OWNER = "activity-owner";
const OTHER = "activity-other";
const ADMIN = "activity-admin";

const DAY = "2026-07-28";
const OWNER_DOC = `player_activity/${OWNER}_${DAY}`;
const OTHER_DOC = `player_activity/${OTHER}_${DAY}`;

let testEnv: RulesTestEnvironment;

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
    for (const uid of [OWNER, OTHER]) {
      await db.doc(`users/${uid}`).set({ email: `${uid}@example.com` });
      await db.doc(`player_activity/${uid}_${DAY}`).set({
        uid,
        user_ref: db.doc(`users/${uid}`),
        activity_day: DAY,
        timezone: "America/Sao_Paulo",
        first_opened_at: new Date("2026-07-28T12:00:00Z"),
      });
    }
  });
});

describe("player_activity — leitura isolada por dono", () => {
  it("o dono lê o próprio registro", async () => {
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertSucceeds(db.doc(OWNER_DOC).get());
  });

  it("o dono lista o próprio histórico filtrando por user_ref", async () => {
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertSucceeds(
      db
        .collection("player_activity")
        .where("user_ref", "==", db.doc(`users/${OWNER}`))
        .get()
    );
  });

  it("um jogador NÃO lê o registro de outro jogador", async () => {
    const db = testEnv.authenticatedContext(OTHER).firestore();
    await assertFails(db.doc(OWNER_DOC).get());
  });

  it("um jogador NÃO lista o histórico de outro jogador", async () => {
    const db = testEnv.authenticatedContext(OTHER).firestore();
    await assertFails(
      db
        .collection("player_activity")
        .where("user_ref", "==", db.doc(`users/${OWNER}`))
        .get()
    );
  });

  it("uma listagem SEM filtro de dono é negada (não vaza a coleção inteira)", async () => {
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(db.collection("player_activity").get());
  });

  it("um usuário não autenticado não lê nada", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.doc(OWNER_DOC).get());
    await assertFails(db.doc(OTHER_DOC).get());
  });

  it("o admin pode ler para suporte e auditoria", async () => {
    const db = testEnv
      .authenticatedContext(ADMIN, { admin: true })
      .firestore();
    await assertSucceeds(db.doc(OWNER_DOC).get());
  });
});

describe("player_activity — nenhuma escrita direta de cliente", () => {
  it("o DONO não pode criar um dia que nunca aconteceu", async () => {
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(
      db.doc(`player_activity/${OWNER}_2026-07-01`).set({
        uid: OWNER,
        user_ref: db.doc(`users/${OWNER}`),
        activity_day: "2026-07-01",
      })
    );
  });

  it("o DONO não pode atualizar nem apagar o próprio registro", async () => {
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(db.doc(OWNER_DOC).update({ activity_day: "2026-01-01" }));
    await assertFails(db.doc(OWNER_DOC).delete());
  });

  it("um jogador não pode escrever no registro de outro", async () => {
    const db = testEnv.authenticatedContext(OTHER).firestore();
    await assertFails(db.doc(OWNER_DOC).update({ uid: OTHER }));
    await assertFails(db.doc(OWNER_DOC).delete());
  });

  it("nem o ADMIN escreve direto — só a callable (Admin SDK) cria registros", async () => {
    const db = testEnv
      .authenticatedContext(ADMIN, { admin: true })
      .firestore();
    await assertFails(
      db.doc(`player_activity/${ADMIN}_${DAY}`).set({
        uid: ADMIN,
        user_ref: db.doc(`users/${ADMIN}`),
        activity_day: DAY,
      })
    );
    await assertFails(db.doc(OWNER_DOC).update({ activity_day: "2026-01-01" }));
    await assertFails(db.doc(OWNER_DOC).delete());
  });

  it("um usuário não autenticado não escreve nada", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      db.doc(`player_activity/anon_${DAY}`).set({ uid: "anon" })
    );
    await assertFails(db.doc(OWNER_DOC).delete());
  });
});

describe("player_activity — não abre brecha nas coleções financeiras", () => {
  it("a nova regra não torna wallets/transactions graváveis", async () => {
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(db.doc(`wallets/${OWNER}`).set({ balance: 999 }));
    await assertFails(
      db.doc("transactions/forged").set({
        amount: 999,
        category: "prize",
        user_ref: db.doc(`users/${OWNER}`),
      })
    );
  });
});
