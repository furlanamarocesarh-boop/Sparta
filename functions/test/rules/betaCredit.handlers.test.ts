import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

/**
 * Behavioral (execution) tests for `grantBetaCredit`, run against the LOCAL
 * Firestore emulator via the Admin SDK — proving the real Firestore side
 * effects: exactly-once credit, idempotent replay, same-grant_id conflict,
 * concurrency, overflow atomicity, and — the branch's core promise — that ONLY
 * `beta_balance` ever changes and `requestwithdrawal` remains 100% cash.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 */

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let grantBetaCreditHandler: Handler;
let requestwithdrawalRun: (data: any, context: any) => Promise<any>;
let onUserCreatedRun: (user: any, context: any) => Promise<any>;
let db: admin.firestore.Firestore;

const ADMIN_UID = "admin-1";
const adminCtx = { auth: { uid: ADMIN_UID, token: { admin: true } } };
const nonAdminCtx = { auth: { uid: "user-1", token: {} } };

const PLAYER = "player-1";
const OTHER = "player-2";

/** A complete, valid grant payload (fresh grant_id per test via suffix). */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: PLAYER,
    amount: 50,
    grant_id: "g-default",
    campaign_id: "beta-wave-1",
    reason: "Boas-vindas ao beta",
    ...overrides,
  };
}

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
  for (const col of ["wallets", "transactions", "users", "withdrawals"]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }
}

/** Seeds a full cash wallet; `beta` is added ONLY when provided (old-doc case). */
async function seedWallet(
  uid: string,
  opts: { balance?: number; beta?: number } = {}
): Promise<void> {
  const data: Record<string, unknown> = {
    balance: opts.balance ?? 0,
    total_deposited: 1,
    total_won: 2,
    total_spent: 3,
    total_withdrawn: 4,
    user_ref: db.collection("users").doc(uid),
  };
  if (opts.beta !== undefined) data.beta_balance = opts.beta;
  await db.collection("wallets").doc(uid).set(data);
}

/** Doc data in a stable, deeply-comparable shape (refs→path, ts→millis). */
function normalize(value: unknown): any {
  if (value instanceof admin.firestore.DocumentReference) {
    return { __ref: value.path };
  }
  if (value instanceof admin.firestore.Timestamp) {
    return { __ts: value.toMillis() };
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(path).get();
  return snap.exists ? normalize(snap.data()) : null;
}

async function countBetaGrantTx(): Promise<number> {
  const snap = await db
    .collection("transactions")
    .where("category", "==", "beta_grant")
    .get();
  return snap.size;
}

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-beta-handlers";
  const mod = (await import("../../src/index.js")) as unknown as {
    grantBetaCreditHandler: Handler;
    requestwithdrawal: { run: (data: any, context: any) => Promise<any> };
    onUserCreated: { run: (user: any, context: any) => Promise<any> };
  };
  grantBetaCreditHandler = mod.grantBetaCreditHandler;
  requestwithdrawalRun = (data, context) =>
    mod.requestwithdrawal.run(data, context);
  onUserCreatedRun = (user, context) => mod.onUserCreated.run(user, context);
  db = admin.firestore();
});

beforeEach(clearAll);

describe("onUserCreated — beta_balance seeding", () => {
  it("(1) uma carteira nova nasce com beta_balance: 0 e os cinco campos cash zerados", async () => {
    await onUserCreatedRun({ uid: "new-user", email: "n@e2e.test" }, {});
    const wallet = await readDoc("wallets/new-user");
    assert.deepEqual(wallet, {
      balance: 0,
      total_deposited: 0,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
      beta_balance: 0,
      user_ref: { __ref: "users/new-user" },
    });
  });
});

describe("grantBetaCredit — autorização e payload", () => {
  it("(4) não autenticado é rejeitado", async () => {
    assert.equal(
      await expectFailure(() => grantBetaCreditHandler(payload(), {})),
      "unauthenticated"
    );
    assert.equal(
      await expectFailure(() => grantBetaCreditHandler(payload(), { auth: null })),
      "unauthenticated"
    );
  });

  it("(5) usuário sem admin:true é rejeitado (inclusive claim truthy não-boolean)", async () => {
    assert.equal(
      await expectFailure(() => grantBetaCreditHandler(payload(), nonAdminCtx)),
      "permission-denied"
    );
    assert.equal(
      await expectFailure(() =>
        grantBetaCreditHandler(payload(), {
          auth: { uid: "u", token: { admin: "true" } },
        })
      ),
      "permission-denied"
    );
  });

  it("(6) payload com campo extra é rejeitado", async () => {
    assert.equal(
      await expectFailure(() =>
        grantBetaCreditHandler(payload({ foo: 1 }), adminCtx)
      ),
      "invalid-argument"
    );
  });

  it("(7) granted_by NUNCA vem do payload: a chave é rejeitada e a proveniência é o token", async () => {
    // A chave granted_by no payload é um campo não permitido.
    assert.equal(
      await expectFailure(() =>
        grantBetaCreditHandler(payload({ granted_by: "attacker" }), adminCtx)
      ),
      "invalid-argument"
    );

    // E numa concessão válida, granted_by é exatamente context.auth.uid.
    await seedWallet(PLAYER);
    await grantBetaCreditHandler(payload({ grant_id: "g-prov" }), adminCtx);
    const tx = await readDoc("transactions/beta_grant_g-prov");
    assert.equal(tx?.granted_by, ADMIN_UID);
  });

  it("(8) amount inválido é rejeitado sem escrita: zero, negativo, NaN, Infinity, 3 casas, acima do limite, string", async () => {
    await seedWallet(PLAYER, { beta: 10 });
    const before = await readDoc(`wallets/${PLAYER}`);

    for (const amount of [0, -5, NaN, Infinity, 1.234, 1_000_000.01, "10"]) {
      assert.equal(
        await expectFailure(() =>
          grantBetaCreditHandler(payload({ amount, grant_id: "g-bad" }), adminCtx)
        ),
        "invalid-argument",
        `amount=${String(amount)}`
      );
    }

    assert.deepEqual(await readDoc(`wallets/${PLAYER}`), before);
    assert.equal(await readDoc("transactions/beta_grant_g-bad"), null);
    assert.equal(await countBetaGrantTx(), 0);
  });

  it("carteira inexistente → not-found e NENHUMA escrita parcial (17)", async () => {
    assert.equal(
      await expectFailure(() =>
        grantBetaCreditHandler(payload({ uid: "ghost", grant_id: "g-ghost" }), adminCtx)
      ),
      "not-found"
    );
    assert.equal(await readDoc("transactions/beta_grant_g-ghost"), null);
  });
});

describe("grantBetaCredit — concessão", () => {
  it("(3)(9)(10) admin concede; SOMENTE beta_balance muda; os cinco campos cash ficam byte-idênticos", async () => {
    await seedWallet(PLAYER, { balance: 77, beta: 10 });
    const before = await readDoc(`wallets/${PLAYER}`);

    const res = await grantBetaCreditHandler(
      payload({ grant_id: "g-only-beta" }),
      adminCtx
    );
    assert.equal(res.success, true);
    assert.equal(res.idempotent, false);
    assert.equal(res.grant_id, "g-only-beta");
    assert.equal(res.beta_balance, 60); // 10 + 50

    const after = await readDoc(`wallets/${PLAYER}`);
    assert.equal(after?.beta_balance, 60);
    // Tudo, exceto beta_balance, permanece exatamente igual.
    const { beta_balance: b0, ...restBefore } = before as any;
    const { beta_balance: b1, ...restAfter } = after as any;
    assert.equal(b0, 10);
    assert.equal(b1, 60);
    assert.deepEqual(restAfter, restBefore);
  });

  it("(2) carteira ANTIGA sem beta_balance é lida como zero (sem migração)", async () => {
    await seedWallet(PLAYER); // sem o campo
    assert.equal((await readDoc(`wallets/${PLAYER}`))?.beta_balance, undefined);

    const res = await grantBetaCreditHandler(
      payload({ grant_id: "g-old-wallet" }),
      adminCtx
    );
    assert.equal(res.beta_balance, 50); // 0 (ausente) + 50
    assert.equal((await readDoc(`wallets/${PLAYER}`))?.beta_balance, 50);
  });

  it("(11) a transação beta tem categoria, economy_type e proveniência corretas", async () => {
    await seedWallet(PLAYER, { beta: 10 });
    await grantBetaCreditHandler(payload({ grant_id: "g-schema" }), adminCtx);

    const tx = await readDoc("transactions/beta_grant_g-schema");
    assert.ok(tx, "the deterministic beta_grant transaction must exist");
    assert.equal(tx.category, "beta_grant");
    assert.equal(tx.economy_type, "beta_credit");
    assert.equal(tx.grant_id, "g-schema");
    assert.equal(tx.campaign_id, "beta-wave-1");
    assert.equal(tx.reason, "Boas-vindas ao beta");
    assert.equal(tx.granted_by, ADMIN_UID);
    assert.equal(tx.amount, 50);
    assert.equal(tx.beta_previous_balance, 10);
    assert.equal(tx.beta_balance_after, 60);
    assert.deepEqual(tx.user_ref, { __ref: `users/${PLAYER}` });
    assert.equal(tx.status, "completed");
    assert.equal(tx.external_id, "beta_grant_g-schema");
    assert.ok((tx.created_at as any).__ts > 0, "created_at is a server timestamp");
    assert.ok((tx.timestamp as any).__ts > 0, "timestamp is a server timestamp");
    // Nunca os carimbos CASH: este documento não toca `balance`.
    assert.equal(tx.previous_balance, undefined);
    assert.equal(tx.balance_after, undefined);
  });

  it("(12) replay idêntico: sucesso idempotente, carteira e transação byte-idênticas", async () => {
    await seedWallet(PLAYER, { beta: 10 });
    await grantBetaCreditHandler(payload({ grant_id: "g-replay" }), adminCtx);

    const walletBefore = await readDoc(`wallets/${PLAYER}`);
    const txBefore = await readDoc("transactions/beta_grant_g-replay");

    const replay = await grantBetaCreditHandler(
      payload({ grant_id: "g-replay" }),
      adminCtx
    );
    assert.equal(replay.success, true);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.beta_balance, 60);

    assert.deepEqual(await readDoc(`wallets/${PLAYER}`), walletBefore);
    assert.deepEqual(await readDoc("transactions/beta_grant_g-replay"), txBefore);
    assert.equal(await countBetaGrantTx(), 1);
  });

  it("(12b) replay idêntico por OUTRO admin também é idempotente (granted_by não diverge)", async () => {
    await seedWallet(PLAYER);
    await grantBetaCreditHandler(payload({ grant_id: "g-other-admin" }), adminCtx);
    const txBefore = await readDoc("transactions/beta_grant_g-other-admin");

    const otherAdmin = { auth: { uid: "admin-2", token: { admin: true } } };
    const replay = await grantBetaCreditHandler(
      payload({ grant_id: "g-other-admin" }),
      otherAdmin
    );
    assert.equal(replay.idempotent, true);
    const txAfter = await readDoc("transactions/beta_grant_g-other-admin");
    assert.deepEqual(txAfter, txBefore); // granted_by original preservado
    assert.equal(txAfter?.granted_by, ADMIN_UID);
  });

  it("(13) mesmo grant_id com dados diferentes → failed-precondition e ZERO escrita", async () => {
    await seedWallet(PLAYER, { beta: 0 });
    await seedWallet(OTHER, { beta: 0 });
    await grantBetaCreditHandler(payload({ grant_id: "g-conflict" }), adminCtx);

    const walletBefore = await readDoc(`wallets/${PLAYER}`);
    const otherBefore = await readDoc(`wallets/${OTHER}`);
    const txBefore = await readDoc("transactions/beta_grant_g-conflict");

    const divergents = [
      payload({ grant_id: "g-conflict", amount: 51 }),
      payload({ grant_id: "g-conflict", uid: OTHER }),
      payload({ grant_id: "g-conflict", campaign_id: "outra" }),
      payload({ grant_id: "g-conflict", reason: "Outro motivo" }),
    ];
    for (const data of divergents) {
      assert.equal(
        await expectFailure(() => grantBetaCreditHandler(data, adminCtx)),
        "failed-precondition",
        JSON.stringify(data)
      );
    }

    assert.deepEqual(await readDoc(`wallets/${PLAYER}`), walletBefore);
    assert.deepEqual(await readDoc(`wallets/${OTHER}`), otherBefore);
    assert.deepEqual(await readDoc("transactions/beta_grant_g-conflict"), txBefore);
    assert.equal(await countBetaGrantTx(), 1);
  });

  it("(14) concorrência com o MESMO grant_id credita exatamente uma vez", async () => {
    await seedWallet(PLAYER, { beta: 0 });

    const results = await Promise.all([
      grantBetaCreditHandler(payload({ grant_id: "g-race" }), adminCtx),
      grantBetaCreditHandler(payload({ grant_id: "g-race" }), adminCtx),
    ]);

    for (const res of results) assert.equal(res.success, true);
    assert.equal(
      results.filter((r) => r.idempotent === false).length,
      1,
      "exactly one call performs the credit; the other replays"
    );
    assert.equal((await readDoc(`wallets/${PLAYER}`))?.beta_balance, 50);
    assert.equal(await countBetaGrantTx(), 1);
  });

  it("(15) grants DIFERENTES concorrentes preservam a soma exata", async () => {
    await seedWallet(PLAYER, { beta: 0 });

    const results = await Promise.all([
      grantBetaCreditHandler(
        payload({ grant_id: "g-sum-a", amount: 10 }),
        adminCtx
      ),
      grantBetaCreditHandler(
        payload({ grant_id: "g-sum-b", amount: 25.5 }),
        adminCtx
      ),
    ]);

    for (const res of results) {
      assert.equal(res.success, true);
      assert.equal(res.idempotent, false);
    }
    assert.equal((await readDoc(`wallets/${PLAYER}`))?.beta_balance, 35.5);
    assert.equal(await countBetaGrantTx(), 2);
  });

  it("(16)(17) overflow é rejeitado ATOMICAMENTE: sem crédito e sem transação", async () => {
    // beta_balance exatamente no teto (R$-like 10.000.000,00).
    await seedWallet(PLAYER, { beta: 10_000_000 });
    const before = await readDoc(`wallets/${PLAYER}`);

    assert.equal(
      await expectFailure(() =>
        grantBetaCreditHandler(
          payload({ grant_id: "g-overflow", amount: 0.01 }),
          adminCtx
        )
      ),
      "failed-precondition"
    );

    assert.deepEqual(await readDoc(`wallets/${PLAYER}`), before);
    assert.equal(await readDoc("transactions/beta_grant_g-overflow"), null);
    assert.equal(await countBetaGrantTx(), 0);
  });
});

describe("requestwithdrawal — o saque ignora beta_balance", () => {
  it("(18)(19) balance=0 e beta_balance>0 → 'Saldo insuficiente.', beta intacto", async () => {
    await seedWallet(PLAYER, { balance: 0, beta: 100 });
    const before = await readDoc(`wallets/${PLAYER}`);

    const code = await expectFailure(() =>
      requestwithdrawalRun(
        { amount: 10, pixkey: "chave-pix-de-teste" },
        { auth: { uid: PLAYER, token: {} } }
      )
    );
    assert.equal(code, "failed-precondition");

    // Nada mudou: nem o cash (0), nem o beta (100).
    assert.deepEqual(await readDoc(`wallets/${PLAYER}`), before);
    assert.equal((await readDoc(`wallets/${PLAYER}`))?.beta_balance, 100);
  });

  it("(20) com cash suficiente o saque debita SÓ o balance; beta_balance intocado", async () => {
    await seedWallet(PLAYER, { balance: 20, beta: 100 });

    const res = await requestwithdrawalRun(
      { amount: 10, pixkey: "chave-pix-de-teste" },
      { auth: { uid: PLAYER, token: {} } }
    );
    assert.equal(res.success, true);

    const wallet = await readDoc(`wallets/${PLAYER}`);
    assert.equal(wallet?.balance, 10); // 20 - 10
    assert.equal(wallet?.beta_balance, 100); // completamente ignorado
  });
});
