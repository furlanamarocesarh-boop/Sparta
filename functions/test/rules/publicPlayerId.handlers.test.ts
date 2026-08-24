import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

import {
  encodePublicPlayerId,
  isPublicPlayerId,
  PUBLIC_PLAYER_ID_COLLECTION,
  PUBLIC_PLAYER_ID_ENTROPY_BYTES,
  PUBLIC_PLAYER_ID_INDEX_COLLECTION,
  PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS,
} from "../../src/domain/publicPlayerId.js";

/**
 * Behavioral (execution) tests for `ensurePublicPlayerIdHandler`, run against
 * the LOCAL Firestore emulator via the Admin SDK — proving the real side
 * effects the pure decision cannot: atomicity of the create-only pair, exact
 * stored key-sets, same-id idempotency with an untouched `createdAt`, collision
 * retry with fresh entropy, a bounded budget that fails closed, fail-closed
 * behaviour on structural corruption, convergence under concurrency, and the
 * promise that NO financial document is ever read or written.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 */

type EnsureHandler = (
  uid: unknown,
  options?: { generateEntropy?: () => Uint8Array }
) => Promise<{ publicPlayerId: string; created: boolean }>;

let ensurePublicPlayerIdHandler: EnsureHandler;
let db: admin.firestore.Firestore;

const PLAYER = "public-id-player-1";
const OTHER = "public-id-player-2";

const FINANCIAL_COLLECTIONS = [
  "wallets",
  "transactions",
  "registrations",
  "tournaments",
  "withdrawals",
];

/** 16 deterministic bytes derived from a seed — never used in production. */
function seedBytes(seed: number): Uint8Array {
  const out = new Uint8Array(PUBLIC_PLAYER_ID_ENTROPY_BYTES);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (seed * 31 + i * 7 + 1) % 256;
  }
  return out;
}

/** The id a given seed produces, computed with the real encoder. */
function idForSeed(seed: number): string {
  return encodePublicPlayerId(seedBytes(seed));
}

/** An entropy source that yields the given seeds in order, then repeats the last. */
function entropyFromSeeds(seeds: readonly number[]): {
  generateEntropy: () => Uint8Array;
  calls: () => number;
} {
  let call = 0;
  return {
    generateEntropy: () => {
      const seed = seeds[Math.min(call, seeds.length - 1)];
      call += 1;
      return seedBytes(seed);
    },
    calls: () => call,
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
    // Chaves ordenadas para que a serialização seja comparável byte a byte.
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = normalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Serialização estável: chaves de topo ordenadas, aninhadas já ordenadas. */
function stableStringify(map: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  return JSON.stringify(sorted);
}

async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(path).get();
  return snap.exists ? normalize(snap.data()) : null;
}

async function mapDoc(uid: string): Promise<Record<string, unknown> | null> {
  return readDoc(`${PUBLIC_PLAYER_ID_COLLECTION}/${uid}`);
}

async function indexDoc(id: string): Promise<Record<string, unknown> | null> {
  return readDoc(`${PUBLIC_PLAYER_ID_INDEX_COLLECTION}/${id}`);
}

async function countIn(collection: string): Promise<number> {
  return (await db.collection(collection).get()).size;
}

/** Snapshot of both identity collections, for byte-comparison across a call. */
async function identitySnapshot(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const col of [
    PUBLIC_PLAYER_ID_COLLECTION,
    PUBLIC_PLAYER_ID_INDEX_COLLECTION,
  ]) {
    const snap = await db.collection(col).get();
    for (const doc of snap.docs) {
      out[`${col}/${doc.id}`] = normalize(doc.data());
    }
  }
  return stableStringify(out);
}

async function financialSnapshot(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const col of FINANCIAL_COLLECTIONS) {
    const snap = await db.collection(col).get();
    for (const doc of snap.docs) {
      out[`${col}/${doc.id}`] = normalize(doc.data());
    }
  }
  return stableStringify(out);
}

/** Writes a complete, valid reservation pair directly (Admin SDK). */
async function seedReservation(uid: string, publicPlayerId: string): Promise<void> {
  const createdAt = admin.firestore.Timestamp.fromDate(
    new Date("2026-07-01T12:00:00Z")
  );
  await db
    .doc(`${PUBLIC_PLAYER_ID_COLLECTION}/${uid}`)
    .set({ publicPlayerId, createdAt });
  await db
    .doc(`${PUBLIC_PLAYER_ID_INDEX_COLLECTION}/${publicPlayerId}`)
    .set({ uid, createdAt });
}

/** Seeds the financial documents this primitive must never touch. */
async function seedFinancialWorld(): Promise<void> {
  const userRef = db.collection("users").doc(PLAYER);
  await db.doc(`users/${PLAYER}`).set({ email: "p@e2e.test" });
  await db.doc(`wallets/${PLAYER}`).set({
    balance: 12345,
    beta_balance: 50,
    total_deposited: 12345,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
    user_ref: userRef,
  });
  await db.doc("transactions/seed_tx").set({
    amount: 12345,
    category: "deposit",
    economy_type: "cash",
    status: "completed",
    user_ref: userRef,
  });
  await db.doc("tournaments/t-1").set({
    name: "Torneio",
    status: "open",
    economy_type: "cash",
    entry_fee: 500,
    prize: 2000,
    current_participants: 0,
    max_participants: 8,
  });
}

async function clearAll(): Promise<void> {
  for (const col of [
    PUBLIC_PLAYER_ID_COLLECTION,
    PUBLIC_PLAYER_ID_INDEX_COLLECTION,
    "users",
    ...FINANCIAL_COLLECTIONS,
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

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-public-id-handlers";
  const mod = (await import("../../src/index.js")) as unknown as {
    ensurePublicPlayerIdHandler: EnsureHandler;
  };
  ensurePublicPlayerIdHandler = mod.ensurePublicPlayerIdHandler;
  db = admin.firestore();
});

beforeEach(clearAll);

describe("ensurePublicPlayerId — primeira reserva", () => {
  it("cria os DOIS documentos, com o key-set exato de cada um", async () => {
    const result = await ensurePublicPlayerIdHandler(PLAYER);

    assert.equal(result.created, true);
    assert.ok(isPublicPlayerId(result.publicPlayerId));

    const map = await mapDoc(PLAYER);
    const index = await indexDoc(result.publicPlayerId);

    assert.ok(map, "o mapa precisa existir");
    assert.ok(index, "o índice reverso precisa existir");

    assert.deepEqual(Object.keys(map).sort(), ["createdAt", "publicPlayerId"]);
    assert.deepEqual(Object.keys(index).sort(), ["createdAt", "uid"]);

    assert.equal(map.publicPlayerId, result.publicPlayerId);
    assert.equal(index.uid, PLAYER);
  });

  it("o identificador persistido satisfaz o formato ratificado", async () => {
    const { publicPlayerId } = await ensurePublicPlayerIdHandler(PLAYER);

    const snap = await db.collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION).get();
    assert.equal(snap.size, 1);
    // O id do documento de índice É o identificador — precisa ser válido.
    assert.ok(isPublicPlayerId(snap.docs[0].id));
    assert.equal(snap.docs[0].id, publicPlayerId);

    const mapSnap = await db.collection(PUBLIC_PLAYER_ID_COLLECTION).get();
    assert.equal(mapSnap.docs[0].id, PLAYER);
    assert.ok(isPublicPlayerId(mapSnap.docs[0].data().publicPlayerId));
  });

  it("nunca há criação parcial: ou os dois documentos, ou nenhum", async () => {
    await ensurePublicPlayerIdHandler(PLAYER);

    assert.equal(await countIn(PUBLIC_PLAYER_ID_COLLECTION), 1);
    assert.equal(await countIn(PUBLIC_PLAYER_ID_INDEX_COLLECTION), 1);
  });

  it("dois jogadores recebem identidades distintas", async () => {
    const a = await ensurePublicPlayerIdHandler(PLAYER);
    const b = await ensurePublicPlayerIdHandler(OTHER);

    assert.notEqual(a.publicPlayerId, b.publicPlayerId);
    assert.equal(await countIn(PUBLIC_PLAYER_ID_COLLECTION), 2);
    assert.equal(await countIn(PUBLIC_PLAYER_ID_INDEX_COLLECTION), 2);
  });

  it("rejeita UID inválido sem escrever nada", async () => {
    for (const bad of ["", "   ", null, undefined, "uid/../wallets", "x".repeat(201)]) {
      assert.equal(
        await expectFailure(() => ensurePublicPlayerIdHandler(bad)),
        "invalid-argument"
      );
    }
    assert.equal(await countIn(PUBLIC_PLAYER_ID_COLLECTION), 0);
    assert.equal(await countIn(PUBLIC_PLAYER_ID_INDEX_COLLECTION), 0);
  });
});

describe("ensurePublicPlayerId — imutabilidade", () => {
  it("a segunda chamada devolve o MESMO identificador, sem criar nada", async () => {
    const first = await ensurePublicPlayerIdHandler(PLAYER);
    const second = await ensurePublicPlayerIdHandler(PLAYER);

    assert.equal(second.publicPlayerId, first.publicPlayerId);
    assert.equal(second.created, false);
    assert.equal(await countIn(PUBLIC_PLAYER_ID_COLLECTION), 1);
    assert.equal(await countIn(PUBLIC_PLAYER_ID_INDEX_COLLECTION), 1);
  });

  it("a segunda chamada NÃO altera createdAt de nenhum dos dois documentos", async () => {
    const first = await ensurePublicPlayerIdHandler(PLAYER);
    const before = await identitySnapshot();

    await ensurePublicPlayerIdHandler(PLAYER);
    await ensurePublicPlayerIdHandler(PLAYER);

    assert.equal(
      await identitySnapshot(),
      before,
      "nenhum byte pode mudar em uma reutilização"
    );
    assert.equal(
      (await mapDoc(PLAYER))?.publicPlayerId,
      first.publicPlayerId
    );
  });
});

describe("ensurePublicPlayerId — colisão", () => {
  it("uma colisão força entropia nova e preserva o índice do dono legítimo", async () => {
    const collided = idForSeed(1);
    const fresh = idForSeed(2);
    await seedReservation(OTHER, collided);
    const otherMapBefore = await mapDoc(OTHER);
    const collidedIndexBefore = await indexDoc(collided);

    const source = entropyFromSeeds([1, 2]);
    const result = await ensurePublicPlayerIdHandler(PLAYER, {
      generateEntropy: source.generateEntropy,
    });

    assert.equal(result.created, true);
    assert.equal(result.publicPlayerId, fresh);
    assert.notEqual(result.publicPlayerId, collided);
    assert.equal(source.calls(), 2, "a colisão precisa sortear entropia nova");

    // O índice colidido e seu dono permanecem exatamente como estavam.
    assert.deepEqual(await mapDoc(OTHER), otherMapBefore);
    assert.deepEqual(await indexDoc(collided), collidedIndexBefore);

    // E o par novo pertence a quem pediu.
    assert.equal((await mapDoc(PLAYER))?.publicPlayerId, fresh);
    assert.equal((await indexDoc(fresh))?.uid, PLAYER);
  });

  it("o candidato colidido nunca é reutilizado pela conta que colidiu", async () => {
    const collided = idForSeed(3);
    await seedReservation(OTHER, collided);

    const result = await ensurePublicPlayerIdHandler(PLAYER, {
      generateEntropy: entropyFromSeeds([3, 4]).generateEntropy,
    });

    assert.notEqual(result.publicPlayerId, collided);
    assert.equal((await indexDoc(collided))?.uid, OTHER);
  });

  it("esgotar o orçamento falha fechado, sem reservar nem reutilizar", async () => {
    const collided = idForSeed(5);
    await seedReservation(OTHER, collided);
    const before = await identitySnapshot();

    // Entropia sempre colidente: toda tentativa encontra o mesmo dono legítimo.
    const source = entropyFromSeeds([5]);
    const code = await expectFailure(() =>
      ensurePublicPlayerIdHandler(PLAYER, {
        generateEntropy: source.generateEntropy,
      })
    );

    assert.equal(code, "internal");
    assert.equal(
      source.calls(),
      PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS,
      "o orçamento precisa ser exatamente o da constante nomeada"
    );
    assert.equal(await mapDoc(PLAYER), null, "nada foi reservado");
    assert.equal(await identitySnapshot(), before, "nada mudou no estado");
  });
});

describe("ensurePublicPlayerId — inconsistências falham fechadas", () => {
  it("mapa sem índice reverso falha e não repara nada", async () => {
    const orphanId = idForSeed(6);
    await db
      .doc(`${PUBLIC_PLAYER_ID_COLLECTION}/${PLAYER}`)
      .set({ publicPlayerId: orphanId, createdAt: new Date() });
    const before = await identitySnapshot();

    assert.equal(
      await expectFailure(() => ensurePublicPlayerIdHandler(PLAYER)),
      "failed-precondition"
    );
    assert.equal(await identitySnapshot(), before);
    assert.equal(await indexDoc(orphanId), null);
  });

  it("mapa malformado falha e não é sobrescrito", async () => {
    await db
      .doc(`${PUBLIC_PLAYER_ID_COLLECTION}/${PLAYER}`)
      .set({ publicPlayerId: 42, createdAt: new Date() });
    const before = await identitySnapshot();

    assert.equal(
      await expectFailure(() => ensurePublicPlayerIdHandler(PLAYER)),
      "failed-precondition"
    );
    assert.equal(await identitySnapshot(), before);
  });

  it("índice do identificador mapeado pertencente a outro UID falha", async () => {
    const id = idForSeed(7);
    await db
      .doc(`${PUBLIC_PLAYER_ID_COLLECTION}/${PLAYER}`)
      .set({ publicPlayerId: id, createdAt: new Date() });
    await db
      .doc(`${PUBLIC_PLAYER_ID_INDEX_COLLECTION}/${id}`)
      .set({ uid: OTHER, createdAt: new Date() });
    const before = await identitySnapshot();

    assert.equal(
      await expectFailure(() => ensurePublicPlayerIdHandler(PLAYER)),
      "failed-precondition"
    );
    assert.equal(await identitySnapshot(), before);
  });

  it("índice órfão apontando para o próprio UID falha em vez de adotar a metade solta", async () => {
    const orphanId = idForSeed(8);
    await db
      .doc(`${PUBLIC_PLAYER_ID_INDEX_COLLECTION}/${orphanId}`)
      .set({ uid: PLAYER, createdAt: new Date() });
    const before = await identitySnapshot();

    assert.equal(
      await expectFailure(() =>
        ensurePublicPlayerIdHandler(PLAYER, {
          generateEntropy: entropyFromSeeds([8]).generateEntropy,
        })
      ),
      "failed-precondition"
    );
    assert.equal(await mapDoc(PLAYER), null, "o mapa não pode ser criado");
    assert.equal(await identitySnapshot(), before, "o órfão não é apagado nem alterado");
  });
});

describe("ensurePublicPlayerId — concorrência", () => {
  it("chamadas simultâneas para o mesmo UID convergem para um único par", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensurePublicPlayerIdHandler(PLAYER))
    );

    const ids = new Set(results.map((r) => r.publicPlayerId));
    assert.equal(ids.size, 1, "todas as chamadas precisam ver a mesma identidade");
    assert.equal(
      results.filter((r) => r.created).length,
      1,
      "exatamente uma chamada pode ter criado a reserva"
    );
    assert.equal(await countIn(PUBLIC_PLAYER_ID_COLLECTION), 1);
    assert.equal(await countIn(PUBLIC_PLAYER_ID_INDEX_COLLECTION), 1);

    const id = [...ids][0];
    assert.equal((await mapDoc(PLAYER))?.publicPlayerId, id);
    assert.equal((await indexDoc(id))?.uid, PLAYER);
  });
});

describe("ensurePublicPlayerId — nada financeiro é tocado", () => {
  it("nenhuma coleção financeira é lida ou escrita", async () => {
    await seedFinancialWorld();
    const before = await financialSnapshot();

    await ensurePublicPlayerIdHandler(PLAYER);
    await ensurePublicPlayerIdHandler(PLAYER);

    assert.equal(await financialSnapshot(), before);
    assert.equal(await countIn("wallets"), 1);
    assert.equal(await countIn("transactions"), 1);
    assert.equal(await countIn("tournaments"), 1);
    assert.equal(await countIn("registrations"), 0);
    assert.equal(await countIn("withdrawals"), 0);

    // A identidade também não referencia a carteira nem o usuário.
    const map = await mapDoc(PLAYER);
    assert.deepEqual(Object.keys(map ?? {}).sort(), ["createdAt", "publicPlayerId"]);
  });
});
