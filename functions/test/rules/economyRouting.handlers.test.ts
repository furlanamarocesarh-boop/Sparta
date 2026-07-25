import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import * as admin from "firebase-admin";

/**
 * Behavioral (execution) tests for the tournament ECONOMY ROUTING —
 * createTournament + jointournament + startTournament +
 * declareTournamentResult/payprize — against the LOCAL Firestore emulator.
 *
 * These prove, with real Firestore side effects and full before/after
 * snapshots, the non-mixing contract: a cash tournament only ever touches the
 * cash pool, a beta tournament only ever touches `beta_balance`, there is no
 * fallback or conversion in either direction, the economy is immutable after
 * creation (type + durable lock + registration provenance), and every failure
 * is atomic.
 *
 * NEVER touches production: runs only under `npm run test:rules` (the `before`
 * hook asserts FIRESTORE_EMULATOR_HOST) and uses a DISTINCT emulator project id.
 */

type Handler = (data: any, context: any) => Promise<Record<string, unknown>>;

let createTournamentHandler: Handler;
let declareTournamentResultHandler: Handler;
let startTournamentHandler: Handler;
let jointournamentRun: (data: any, context: any) => Promise<any>;
let payprizeRun: (data: any, context: any) => Promise<any>;
let db: admin.firestore.Firestore;

const ADMIN_UID = "admin-1";
const adminCtx = { auth: { uid: ADMIN_UID, token: { admin: true } } };

const A = "player-a";
const B = "player-b";
const ctxOf = (uid: string) => ({ auth: { uid, token: {} } });

const ENTRY = 10;
const PRIZE = 100;

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
    "withdrawals",
  ]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((doc) => doc.ref.delete()));
  }
}

async function seedUser(uid: string): Promise<void> {
  await db.collection("users").doc(uid).set({
    email: `${uid}@e2e.test`,
    username: uid,
    player_id: `PLR-${uid}`,
    pix_key: "",
    whatsapp: "",
  });
}

/** Full five-field cash wallet; `beta` only when provided (old-doc case). */
async function seedWallet(
  uid: string,
  opts: { balance?: number; beta?: number; totalWon?: number } = {}
): Promise<void> {
  const data: Record<string, unknown> = {
    balance: opts.balance ?? 0,
    total_deposited: 1,
    total_won: opts.totalWon ?? 2,
    total_spent: 3,
    total_withdrawn: 4,
    user_ref: db.collection("users").doc(uid),
  };
  if (opts.beta !== undefined) data.beta_balance = opts.beta;
  await db.collection("wallets").doc(uid).set(data);
}

/** Seeds a tournament doc DIRECTLY (legacy / flip scenarios). */
async function seedTournament(
  id: string,
  fields: Record<string, unknown>
): Promise<void> {
  await db
    .collection("tournaments")
    .doc(id)
    .set({
      name: "Economy Routing",
      entry_fee: ENTRY,
      prize: PRIZE,
      status: "open",
      current_participants: 0,
      max_participants: 8,
      current_players: 0,
      max_players: 8,
      created_at: admin.firestore.Timestamp.fromMillis(1_000_000),
      starts_at: null,
      ...fields,
    });
}

async function seedRegistration(
  uid: string,
  tid: string,
  opts: { economy?: string } = {}
): Promise<void> {
  const data: Record<string, unknown> = {
    user_ref: db.collection("users").doc(uid),
    tournament_ref: db.collection("tournaments").doc(tid),
    entry_fee: ENTRY,
    status: "registered",
  };
  if (opts.economy !== undefined) data.economy_type = opts.economy;
  await db.collection("registrations").doc(`${uid}_${tid}`).set(data);
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
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
    return out;
  }
  return value;
}

async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(path).get();
  return snap.exists ? normalize(snap.data()) : null;
}

async function countTxWhere(category: string): Promise<number> {
  const snap = await db
    .collection("transactions")
    .where("category", "==", category)
    .get();
  return snap.size;
}

/** The wallet snapshot minus the named field — for only-X-changed proofs. */
function omit(
  doc: Record<string, unknown> | null,
  field: string
): Record<string, unknown> {
  const { [field]: _dropped, ...rest } = (doc ?? {}) as Record<string, unknown>;
  return rest;
}

before(async () => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "these tests MUST run under the Firestore emulator (npm run test:rules)"
  );
  process.env.GCLOUD_PROJECT = "demo-sparta-battle-economy-handlers";
  const mod = (await import("../../src/index.js")) as unknown as {
    createTournamentHandler: Handler;
    declareTournamentResultHandler: Handler;
    startTournamentHandler: Handler;
    jointournament: { run: (data: any, context: any) => Promise<any> };
    payprize: { run: (data: any, context: any) => Promise<any> };
  };
  createTournamentHandler = mod.createTournamentHandler;
  declareTournamentResultHandler = mod.declareTournamentResultHandler;
  startTournamentHandler = mod.startTournamentHandler;
  jointournamentRun = (data, context) => mod.jointournament.run(data, context);
  payprizeRun = (data, context) => mod.payprize.run(data, context);
  db = admin.firestore();
});

beforeEach(clearAll);

// ─────────────────────────────────────────────────────────────────────────────
// createTournament — economy_type obrigatório, tipo + trava persistidos.
// ─────────────────────────────────────────────────────────────────────────────

describe("createTournament — economy_type", () => {
  const basePayload = {
    name: "Copa",
    description: "",
    entry_fee: ENTRY,
    prize: PRIZE,
    max_players: 8,
    game_mode: "solo",
  };

  it("(4) economy_type ausente → invalid-argument", async () => {
    await seedUser(ADMIN_UID);
    assert.equal(
      await expectFailure(() => createTournamentHandler(basePayload, adminCtx)),
      "invalid-argument"
    );
  });

  it("(5) economy_type inválido → invalid-argument (sem alias/case/coerção)", async () => {
    await seedUser(ADMIN_UID);
    for (const bad of ["CASH", "Beta_Credit", "beta", "", null, 1, true]) {
      assert.equal(
        await expectFailure(() =>
          createTournamentHandler(
            { ...basePayload, economy_type: bad },
            adminCtx
          )
        ),
        "invalid-argument",
        `economy_type=${String(bad)}`
      );
    }
  });

  it("(6) persiste economy_type e locked_economy_type IGUAIS, para as duas economias", async () => {
    await seedUser(ADMIN_UID);
    for (const economy of ["cash", "beta_credit"]) {
      const res = await createTournamentHandler(
        { ...basePayload, economy_type: economy },
        adminCtx
      );
      assert.equal(res.success, true);
      // Resposta pública preservada: exatamente as chaves aprovadas.
      assert.deepEqual(Object.keys(res).sort(), [
        "message",
        "success",
        "tournament_id",
        "tournament_ref",
      ]);
      const doc = await readDoc(`tournaments/${res.tournament_id}`);
      assert.equal(doc?.economy_type, economy);
      assert.equal(doc?.locked_economy_type, economy);
      assert.equal(doc?.status, "open");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// jointournament — roteamento do débito.
// ─────────────────────────────────────────────────────────────────────────────

describe("jointournament — roteamento cash", () => {
  it("(9)(10)(15)(16) cash debita SÓ balance/total_spent; beta_balance intocado; snapshot + provenance registrados; trava materializada", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 50, beta: 70 });
    await seedTournament("t-cash", {}); // LEGADO: sem economy fields

    const before = await readDoc(`wallets/${A}`);
    const res = await jointournamentRun({ tournamentid: "t-cash" }, ctxOf(A));
    assert.equal(res.success, true);

    // Carteira: balance 50→40, total_spent 3→13; TODO o resto byte-idêntico.
    const after = await readDoc(`wallets/${A}`);
    assert.equal(after?.balance, 40);
    assert.equal(after?.total_spent, 13);
    assert.equal(after?.beta_balance, 70); // (10) intocado
    assert.deepEqual(
      omit(omit(after, "balance"), "total_spent"),
      omit(omit(before, "balance"), "total_spent")
    );

    // (15) inscrição com proveniência + snapshot server-authoritative.
    const reg = await readDoc(`registrations/${A}_t-cash`);
    assert.equal(reg?.status, "registered");
    assert.equal(reg?.economy_type, "cash");
    assert.equal(reg?.entry_fee_snapshot, ENTRY);
    assert.equal(reg?.entry_fee, ENTRY);
    assert.ok((reg?.transaction_ref as any)?.__ref);

    // (16) transaction cash: categoria/es stamps cash + provenance, SEM beta.
    const txPath = (reg?.transaction_ref as any).__ref as string;
    const tx = await readDoc(txPath);
    assert.equal(tx?.category, "entry_fee");
    assert.equal(tx?.economy_type, "cash");
    assert.equal(tx?.previous_balance, 50);
    assert.equal(tx?.balance_after, 40);
    assert.equal(tx?.beta_previous_balance, undefined);
    assert.equal(tx?.beta_balance_after, undefined);

    // Trava materializada no MESMO update legítimo (doc legado).
    const t = await readDoc("tournaments/t-cash");
    assert.equal(t?.economy_type, "cash");
    assert.equal(t?.locked_economy_type, "cash");
    assert.equal(t?.current_participants, 1);
  });

  it("(13) cash insuficiente NUNCA usa beta: falha sem escrita mesmo com beta alto", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 5, beta: 1000 });
    await seedTournament("t-cash", {});

    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        jointournamentRun({ tournamentid: "t-cash" }, ctxOf(A))
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal(await readDoc(`registrations/${A}_t-cash`), null);
    assert.equal(await countTxWhere("entry_fee"), 0);
  });
});

describe("jointournament — roteamento beta", () => {
  async function seedBetaTournament(id: string): Promise<void> {
    await seedTournament(id, {
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });
  }

  it("(11)(12)(15)(17) beta debita SÓ beta_balance; os cinco campos cash byte-idênticos; ledger beta sem campos cash falsificados", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 55, beta: 30 });
    await seedBetaTournament("t-beta");

    const before = await readDoc(`wallets/${A}`);
    const res = await jointournamentRun({ tournamentid: "t-beta" }, ctxOf(A));
    assert.equal(res.success, true);

    const after = await readDoc(`wallets/${A}`);
    assert.equal(after?.beta_balance, 20); // 30 - 10
    // (12) TODOS os cinco campos cash + user_ref byte-idênticos.
    assert.deepEqual(omit(after, "beta_balance"), omit(before, "beta_balance"));

    const reg = await readDoc(`registrations/${A}_t-beta`);
    assert.equal(reg?.economy_type, "beta_credit");
    assert.equal(reg?.entry_fee_snapshot, ENTRY);

    // (17) transaction beta: categoria beta, stamps beta, NUNCA stamps cash.
    const tx = await readDoc((reg?.transaction_ref as any).__ref);
    assert.equal(tx?.category, "beta_entry_fee");
    assert.equal(tx?.economy_type, "beta_credit");
    assert.equal(tx?.amount, ENTRY);
    assert.equal(tx?.beta_previous_balance, 30);
    assert.equal(tx?.beta_balance_after, 20);
    assert.equal(tx?.previous_balance, undefined);
    assert.equal(tx?.balance_after, undefined);
  });

  it("(14) beta insuficiente NUNCA usa cash: falha sem escrita mesmo com balance alto", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 1000, beta: 5 });
    await seedBetaTournament("t-beta");

    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        jointournamentRun({ tournamentid: "t-beta" }, ctxOf(A))
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal(await readDoc(`registrations/${A}_t-beta`), null);
    assert.equal(await countTxWhere("beta_entry_fee"), 0);
  });

  it("(2-carteira) carteira antiga SEM beta_balance é lida como zero no caminho beta", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 1000 }); // sem beta_balance
    await seedBetaTournament("t-beta");
    assert.equal(
      await expectFailure(() =>
        jointournamentRun({ tournamentid: "t-beta" }, ctxOf(A))
      ),
      "failed-precondition" // beta ausente = 0 < entry fee — nunca usa o cash
    );
  });

  it("(18) replay do join não debita novamente (already-exists, saldos intactos)", async () => {
    await seedUser(A);
    await seedWallet(A, { beta: 30 });
    await seedBetaTournament("t-beta");

    await jointournamentRun({ tournamentid: "t-beta" }, ctxOf(A));
    const wAfterFirst = await readDoc(`wallets/${A}`);

    assert.equal(
      await expectFailure(() =>
        jointournamentRun({ tournamentid: "t-beta" }, ctxOf(A))
      ),
      "already-exists"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wAfterFirst);
    assert.equal(await countTxWhere("beta_entry_fee"), 1);
  });

  it("(19) joins concorrentes: usuários diferentes pagam exatamente uma vez cada; duplo-join concorrente debita uma vez", async () => {
    await seedUser(A);
    await seedUser(B);
    await seedWallet(A, { beta: 30 });
    await seedWallet(B, { beta: 30 });
    await seedBetaTournament("t-beta");

    const results = await Promise.allSettled([
      jointournamentRun({ tournamentid: "t-beta" }, ctxOf(A)),
      jointournamentRun({ tournamentid: "t-beta" }, ctxOf(B)),
      jointournamentRun({ tournamentid: "t-beta" }, ctxOf(A)), // duplicado
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 2, "A once + B once succeed");
    assert.equal(rejected.length, 1, "the duplicate A join fails");

    // Cada carteira debitada EXATAMENTE uma vez; capacidade correta.
    assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 20);
    assert.equal((await readDoc(`wallets/${B}`))?.beta_balance, 20);
    assert.equal(
      (await readDoc("tournaments/t-beta"))?.current_participants,
      2
    );
    assert.equal(await countTxWhere("beta_entry_fee"), 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Imutabilidade — flip administrativo detectado pelos handlers.
// ─────────────────────────────────────────────────────────────────────────────

describe("imutabilidade da economia (type + trava + proveniência)", () => {
  it("(20) flip só do economy_type após inscrição: join, start e declare falham sem escrita", async () => {
    await seedUser(A);
    await seedUser(B);
    await seedWallet(A, { beta: 30 });
    await seedWallet(B, { beta: 30 });
    await seedTournament("t-flip", {
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });
    await jointournamentRun({ tournamentid: "t-flip" }, ctxOf(A));

    // Simula a escrita administrativa direta (Rules ainda não bloqueiam).
    await db
      .collection("tournaments")
      .doc("t-flip")
      .update({ economy_type: "cash" });

    const tBefore = await readDoc("tournaments/t-flip");
    const wB = await readDoc(`wallets/${B}`);

    assert.equal(
      await expectFailure(() =>
        jointournamentRun({ tournamentid: "t-flip" }, ctxOf(B))
      ),
      "failed-precondition"
    );
    assert.equal(
      await expectFailure(() =>
        startTournamentHandler({ tournamentid: "t-flip" }, adminCtx)
      ),
      "failed-precondition"
    );
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t-flip", winneruid: A },
          adminCtx
        )
      ),
      "failed-precondition"
    );

    assert.deepEqual(await readDoc("tournaments/t-flip"), tBefore);
    assert.deepEqual(await readDoc(`wallets/${B}`), wB);
    assert.equal(await readDoc(`registrations/${B}_t-flip`), null);
  });

  it("(25)+(invariante) flip COMPLETO beta→cash após inscrição: a premiação é bloqueada pela proveniência da inscrição", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 7, beta: 30 });
    await seedTournament("t-flip2", {
      status: "in_progress",
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });
    await seedRegistration(A, "t-flip2", { economy: "beta_credit" });

    // Flip completo (type + trava) — a checagem type/trava passa, mas a
    // inscrição beta diverge da economia cash: NUNCA paga em dinheiro.
    await db.collection("tournaments").doc("t-flip2").update({
      economy_type: "cash",
      locked_economy_type: "cash",
    });

    const wBefore = await readDoc(`wallets/${A}`);
    const tBefore = await readDoc("tournaments/t-flip2");
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t-flip2", winneruid: A },
          adminCtx
        )
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.deepEqual(await readDoc("tournaments/t-flip2"), tBefore);
    assert.equal(await countTxWhere("prize"), 0);
    assert.equal(await countTxWhere("beta_prize"), 0);
  });

  it("(invariante) flip COMPLETO cash→beta após inscrição cash: premiação bloqueada (inclusive inscrição legada)", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 7, beta: 30 });
    await seedTournament("t-flip3", { status: "in_progress" }); // legado cash
    await seedRegistration(A, "t-flip3", {}); // legada, sem proveniência

    await db.collection("tournaments").doc("t-flip3").update({
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });

    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t-flip3", winneruid: A },
          adminCtx
        )
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal(await countTxWhere("beta_prize"), 0);
  });

  it("(3) estado econômico persistido inválido falha fechado em join/start/declare", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 100, beta: 100 });
    await seedTournament("t-corrupt", { economy_type: "CASH" });

    for (const attempt of [
      () => jointournamentRun({ tournamentid: "t-corrupt" }, ctxOf(A)),
      () => startTournamentHandler({ tournamentid: "t-corrupt" }, adminCtx),
      () =>
        declareTournamentResultHandler(
          { tournamentid: "t-corrupt", winneruid: A },
          adminCtx
        ),
    ]) {
      assert.equal(await expectFailure(attempt), "failed-precondition");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settlement — roteamento do prêmio.
// ─────────────────────────────────────────────────────────────────────────────

describe("settlement — prêmio cash preservado", () => {
  it("(21)(22)(27) settlement cash intacto (inscrição legada aceita), beta_balance intocado, schema cash SEM economy_type", async () => {
    await seedUser(A);
    await seedWallet(A, { balance: 10, totalWon: 5, beta: 40 });
    await seedTournament("t-cash", { status: "in_progress" });
    await seedRegistration(A, "t-cash", {}); // legada, sem proveniência (27)

    const res = await declareTournamentResultHandler(
      { tournamentid: "t-cash", winneruid: A },
      adminCtx
    );
    assert.equal(res.success, true);

    const w = await readDoc(`wallets/${A}`);
    assert.equal(w?.balance, 110); // 10 + 100
    assert.equal(w?.total_won, 105); // 5 + 100
    assert.equal(w?.beta_balance, 40); // (22) intocado

    // (21) o schema cash canônico é preservado byte-for-byte: as MESMAS 10
    // chaves de sempre, sem economy_type nem stamps beta.
    const tx = await readDoc("transactions/prize_t-cash");
    assert.deepEqual(Object.keys(tx ?? {}).sort(), [
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
    assert.equal(tx?.category, "prize");
    const t = await readDoc("tournaments/t-cash");
    assert.equal(t?.status, "completed");
    assert.equal((t?.result as any)?.economy_type, undefined);
  });
});

describe("settlement — prêmio beta", () => {
  async function seedBetaSettle(): Promise<void> {
    await seedUser(A);
    await seedWallet(A, { balance: 7, totalWon: 3, beta: 10 });
    await seedTournament("t-beta", {
      status: "in_progress",
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });
    await seedRegistration(A, "t-beta", { economy: "beta_credit" });
  }

  it("(23)(24) prêmio beta credita SÓ beta_balance; total_won e os demais campos cash byte-idênticos", async () => {
    await seedBetaSettle();
    const before = await readDoc(`wallets/${A}`);

    const res = await declareTournamentResultHandler(
      { tournamentid: "t-beta", winneruid: A },
      adminCtx
    );
    assert.equal(res.success, true);

    const after = await readDoc(`wallets/${A}`);
    assert.equal(after?.beta_balance, 110); // 10 + 100
    assert.equal(after?.total_won, 3); // (24) NUNCA muda
    assert.deepEqual(omit(after, "beta_balance"), omit(before, "beta_balance"));

    // Ledger inconfundivelmente beta: nunca parece depósito/prêmio cash.
    const tx = await readDoc("transactions/prize_t-beta");
    assert.equal(tx?.category, "beta_prize");
    assert.equal(tx?.economy_type, "beta_credit");
    assert.equal(tx?.amount, PRIZE);
    assert.equal(tx?.beta_previous_balance, 10);
    assert.equal(tx?.beta_balance_after, 110);
    assert.equal(tx?.previous_balance, undefined);
    assert.equal(tx?.balance_after, undefined);

    const t = await readDoc("tournaments/t-beta");
    assert.equal(t?.status, "completed");
    assert.equal((t?.result as any)?.economy_type, "beta_credit");
    assert.equal((t?.result as any)?.prize, PRIZE);
  });

  it("(26) inscrição beta SEM proveniência econômica é rejeitada sem escrita", async () => {
    await seedUser(A);
    await seedWallet(A, { beta: 10 });
    await seedTournament("t-beta", {
      status: "in_progress",
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });
    await seedRegistration(A, "t-beta", {}); // sem economy_type

    const wBefore = await readDoc(`wallets/${A}`);
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t-beta", winneruid: A },
          adminCtx
        )
      ),
      "failed-precondition"
    );
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.equal(await countTxWhere("beta_prize"), 0);
    assert.equal((await readDoc("tournaments/t-beta"))?.status, "in_progress");
  });

  it("(28) replay do settlement beta: sucesso idempotente, sem segundo crédito, docs byte-idênticos", async () => {
    await seedBetaSettle();
    await declareTournamentResultHandler(
      { tournamentid: "t-beta", winneruid: A },
      adminCtx
    );
    const wAfter = await readDoc(`wallets/${A}`);
    const txAfter = await readDoc("transactions/prize_t-beta");
    const tAfter = await readDoc("tournaments/t-beta");

    const replay = await declareTournamentResultHandler(
      { tournamentid: "t-beta", winneruid: A },
      adminCtx
    );
    assert.equal(replay.success, true);

    assert.deepEqual(await readDoc(`wallets/${A}`), wAfter);
    assert.deepEqual(await readDoc("transactions/prize_t-beta"), txAfter);
    assert.deepEqual(await readDoc("tournaments/t-beta"), tAfter);

    // Replay com OUTRO vencedor → failed-precondition.
    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t-beta", winneruid: B },
          adminCtx
        )
      ),
      "failed-precondition"
    );
  });

  it("(29) payprize é o MESMO roteamento: liquida beta em beta_balance e replay cruzado é idempotente", async () => {
    await seedBetaSettle();

    const res = await payprizeRun(
      { tournamentid: "t-beta", winneruid: A },
      adminCtx
    );
    assert.equal(res.success, true);
    assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 110);
    assert.equal(
      (await readDoc("transactions/prize_t-beta"))?.category,
      "beta_prize"
    );

    // Replay cruzado pelo handler canônico: idempotente, sem novo crédito.
    const wBefore = await readDoc(`wallets/${A}`);
    const replay = await declareTournamentResultHandler(
      { tournamentid: "t-beta", winneruid: A },
      adminCtx
    );
    assert.equal(replay.success, true);
    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
  });

  it("(30) settlements beta concorrentes pagam exatamente uma vez", async () => {
    await seedBetaSettle();

    const results = await Promise.allSettled([
      declareTournamentResultHandler(
        { tournamentid: "t-beta", winneruid: A },
        adminCtx
      ),
      declareTournamentResultHandler(
        { tournamentid: "t-beta", winneruid: A },
        adminCtx
      ),
    ]);
    for (const r of results) {
      assert.equal(r.status, "fulfilled", "both identical calls succeed");
    }
    assert.equal((await readDoc(`wallets/${A}`))?.beta_balance, 110);
    assert.equal(await countTxWhere("beta_prize"), 1);
  });

  it("(31)(32) overflow do beta_balance falha ATOMICAMENTE: sem crédito, sem transação, status e result intactos", async () => {
    await seedUser(A);
    await seedWallet(A, { beta: 10_000_000 }); // teto do pool
    await seedTournament("t-beta", {
      status: "in_progress",
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
    });
    await seedRegistration(A, "t-beta", { economy: "beta_credit" });

    const wBefore = await readDoc(`wallets/${A}`);
    const tBefore = await readDoc("tournaments/t-beta");

    assert.equal(
      await expectFailure(() =>
        declareTournamentResultHandler(
          { tournamentid: "t-beta", winneruid: A },
          adminCtx
        )
      ),
      "failed-precondition"
    );

    assert.deepEqual(await readDoc(`wallets/${A}`), wBefore);
    assert.deepEqual(await readDoc("tournaments/t-beta"), tBefore);
    assert.equal(await readDoc("transactions/prize_t-beta"), null);
  });
});
