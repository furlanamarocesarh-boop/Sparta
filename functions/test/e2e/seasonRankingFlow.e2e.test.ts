import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { seedOrganization } from "../support/orgSeed.js";
import { Timestamp } from "firebase-admin/firestore";

import { ECONOMY_BETA_CREDIT, ECONOMY_CASH } from "../../src/domain/economy.js";
import { assertSeasonServable } from "../../src/domain/seasonLeaderboard.js";
import {
  FIRST_ACTIVE_SEASON_ID,
  RANKING_EVENTS_COLLECTION,
  SEASON_ENTRIES_SUBCOLLECTION,
  SEASON_RANKINGS_COLLECTION,
  decideActivation,
  seasonDocumentId,
  seasonIdFromInstant,
  seasonWindow,
} from "../../src/domain/seasonRanking.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";
import { fetchWithTimeout } from "../support/httpTimeout.js";
import { seedHouse } from "../support/houseFunding.js";

/**
 * FULL SEASON-RANKING CYCLE, end to end, for BOTH economies.
 *
 * Every mutation goes through the REAL onCall HTTP transport of the Functions
 * emulator — no handler is imported or invoked directly. That is newly possible:
 * until the `admin.firestore` static-loss defect was fixed, mutating callables
 * threw through the HTTP layer, which is why the two older E2E suites use a
 * documented hybrid. This suite deliberately does NOT inherit that workaround,
 * so it also proves the transport itself is healthy.
 *
 * The Admin SDK is used for FIXTURES, for the temporal bridge/projection, for
 * cleanup and for READING assertions — never to perform a business mutation.
 * Every business mutation (fund, create, join, room, start, declare, settle)
 * goes through the real callables. Concretely the Admin SDK seeds player wallets
 * (there is no public funding endpoint for a non-admin), publishes the
 * pre-activation bridge event and the read-season projection, removes every
 * document the suite created, and reads documents to assert.
 *
 * ── PONTE TEMPORAL DE PRÉ-ATIVAÇÃO ─────────────────────────────────────────
 * `FIRST_ACTIVE_SEASON_ID` is `2026-09`. A prize settled by the real flow is
 * stamped with `serverTimestamp()`, so while the wall clock is before September
 * 2026 the resulting season is `before-first-active-season` and the trigger
 * correctly writes NOTHING. A suite built on that alone would pass while proving
 * nothing.
 *
 * So: the season is DERIVED from the real prize transaction's own timestamp in
 * America/São_Paulo. If it already falls in the first active season or later,
 * the real transaction is used directly and no bridge exists. Only when it falls
 * BEFORE does the suite publish one additional event — a copy of the real
 * transaction the flow just produced, canonical shape preserved, changing only
 * its document id, its `external_id` and an explicit September timestamp.
 *
 * The bridge is therefore self-dissolving: from 2026-09-01 the condition stops
 * holding, the copy is never created, and the very same assertions run against
 * the transaction the flow itself settled. Nothing in production code is touched
 * and `FIRST_ACTIVE_SEASON_ID` is never overridden.
 *
 * ── PROJEÇÃO DE LEITURA ────────────────────────────────────────────────────
 * `getSeasonLeaderboard` and `getMySeasonRanking` enforce a retention window
 * (`assertSeasonServable`): a season NEWER than the current business month is
 * refused. While the bridge is active the ranked season is in the future, so
 * neither endpoint could execute its SUCCESS path against it — and a suite that
 * only proved the refusal would prove nothing about the winner, the position or
 * the public payload.
 *
 * So the two seasons are named separately and never confused:
 *   • `rankedSeasonId` / `rankedParentPath` — the trigger's TRUE output, which
 *     is asserted as produced and never modified;
 *   • `readSeasonId` / `readParentPath` — the season the callables are asked
 *     about. Identical to the ranked one whenever that is servable; otherwise
 *     the current month, carrying a canonical PROJECTION of the trigger's own
 *     documents (see `publishProjection`).
 *
 * Both endpoints therefore ALWAYS run their success path. The refusal of a
 * future season is additionally asserted, but never as a substitute for it.
 */

const PROJECT_ID = "demo-sparta-battle";
const REGION = "us-central1";
const PW = "E2e-Passw0rd"; // LOCAL emulator password — not a real credential

const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = () => process.env.FIREBASE_AUTH_EMULATOR_HOST!;

/** One operator; DISTINCT players per economy, so no identity is shared. */
const OPERATOR = { uid: "e2e-srf-admin", email: "srf-admin@e2e.test" };
const CASH_WINNER = { uid: "e2e-srf-cash-win", email: "srf-cash-win@e2e.test" };
const CASH_OTHER = { uid: "e2e-srf-cash-oth", email: "srf-cash-oth@e2e.test" };
const BETA_WINNER = { uid: "e2e-srf-beta-win", email: "srf-beta-win@e2e.test" };
const BETA_OTHER = { uid: "e2e-srf-beta-oth", email: "srf-beta-oth@e2e.test" };
const ALL_USERS = [OPERATOR, CASH_WINNER, CASH_OTHER, BETA_WINNER, BETA_OTHER];

const CASH_ENTRY = 10;
const CASH_PRIZE = 100;
const BETA_GRANT = 100;
const BETA_ENTRY = 10;
const BETA_PRIZE = 50;

/**
 * An instant provably inside the FIRST ACTIVE season, derived from
 * `FIRST_ACTIVE_SEASON_ID` itself rather than repeated as a literal — so moving
 * the activation constant moves the bridge with it, and the two can never
 * disagree. Half a day past the window start keeps it clear of the boundary.
 */
const BRIDGE_AT = new Date(
  seasonWindow(String(FIRST_ACTIVE_SEASON_ID)).start.getTime() + 12 * 60 * 60 * 1000
);

const TRIGGER_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

let db: admin.firestore.Firestore;

// ─── HTTP transport (real onCall layer) ──────────────────────────────────────

interface CallResult {
  ok: boolean;
  result?: any;
  code?: string;
  message?: string;
}

async function signIn(email: string): Promise<string> {
  const url = `http://${AUTH_HOST()}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PW, returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`emulator sign-in failed for ${email}: ${res.status}`);
  const body = (await res.json()) as { idToken?: string };
  if (!body.idToken) throw new Error(`no idToken for ${email}`);
  return body.idToken;
}

/** Invokes a deployed callable over the real HTTP/onCall transport. */
async function callAs(
  idToken: string,
  name: string,
  data: Record<string, unknown>
): Promise<CallResult> {
  const res = await fetchWithTimeout(
    `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/${name}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ data }),
    }
  );
  const body = (await res.json().catch(() => ({}))) as any;
  if (res.ok && body && "result" in body) return { ok: true, result: body.result };
  const err = body?.error ?? {};
  return {
    ok: false,
    code: typeof err.status === "string" ? err.status : "UNKNOWN",
    message: typeof err.message === "string" ? err.message : "",
  };
}

/** Calls and fails loudly, naming the endpoint — a broken step is never silent. */
async function mustCall(
  idToken: string,
  name: string,
  data: Record<string, unknown>
): Promise<any> {
  const res = await callAs(idToken, name, data);
  assert.equal(
    res.ok,
    true,
    `endpoint "${name}" falhou pelo transporte HTTP do emulador: ${res.code} ${res.message}`
  );
  return res.result;
}

// ─── Firestore observation ───────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function readDoc(path: string): Promise<Record<string, unknown> | null> {
  const snap = await db.doc(path).get();
  return snap.exists ? (snap.data() ?? {}) : null;
}

async function awaitDoc(
  path: string,
  timeoutMs = TRIGGER_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await readDoc(path);
    if (found) return found;
    await sleep(POLL_MS);
  }
  throw new Error(
    `o trigger não entregou em ${timeoutMs}ms: "${path}" nunca apareceu`
  );
}

/**
 * Prize rows the FLOW produced for a tournament — the arity guard for idempotency.
 *
 * `exclude` carries the pre-activation bridge copy when one exists. That copy is
 * a deliberate test artifact: it shares the real row's `tournament_ref` and its
 * `*_prize` category, so counting it here would make the flow look as though it
 * had settled twice. Excluding it by id keeps the invariant about the PRODUCTION
 * path — one settlement, one prize row, no matter how often it is replayed.
 */
async function flowPrizeTxCount(
  tournamentId: string,
  exclude: readonly string[] = []
): Promise<number> {
  const snap = await db
    .collection("transactions")
    .where("tournament_ref", "==", db.collection("tournaments").doc(tournamentId))
    .get();
  return snap.docs.filter(
    (d) =>
      String(d.data().category ?? "").endsWith("prize") && !exclude.includes(d.id)
  ).length;
}

function isServable(seasonId: string): boolean {
  try {
    assertSeasonServable(seasonId, seasonIdFromInstant(new Date()));
    return true;
  } catch {
    return false;
  }
}

// ─── Per-economy state ───────────────────────────────────────────────────────

interface Cycle {
  economy: string;
  tournamentId: string;
  winnerUid: string;
  /** The prize row the real flow settled. */
  realTxId: string;
  /** The row whose ranking is asserted — real, or the pre-activation bridge. */
  rankedTxId: string;
  bridged: boolean;

  // ── A saída VERDADEIRA do trigger ────────────────────────────────────────
  /** Season the trigger actually ranked into. Never fabricated. */
  rankedSeasonId: string;
  rankedParentPath: string;

  // ── A temporada que as CALLABLES conseguem servir ────────────────────────
  /**
   * Equal to the ranked season whenever that season is servable. Otherwise the
   * current business month, carrying a canonical PROJECTION of what the trigger
   * produced — see `publishProjection`.
   */
  readSeasonId: string;
  readParentPath: string;
  projected: boolean;

  publicPlayerId: string;
  guard: Record<string, unknown>;
  entry: Record<string, unknown>;
  expectedCentavos: number;
}

const cycles: Record<string, Cycle> = {};
const tokens: Record<string, string> = {};

function parentPathOf(economy: string, seasonId: string): string {
  return `${SEASON_RANKINGS_COLLECTION}/${seasonDocumentId(
    economy as never,
    seasonId
  )}`;
}

/**
 * Projects the trigger's REAL output into a servable season, as an E2E fixture.
 *
 * The trigger's own documents are never modified — this only copies them. The
 * copy exists for one reason: `getSeasonLeaderboard` and `getMySeasonRanking`
 * refuse a season newer than the current business month, so while the ranked
 * season is in the future neither endpoint could execute its SUCCESS path, and
 * the suite would prove only that they refuse.
 *
 * What is copied is exactly what the trigger produced: `economy`,
 * `publicPlayerId`, the ordering tuple (`scoreOrder`, `winsOrder`),
 * `scoreCentavos`, `winsCount` and the prize timestamps. Only the paths and
 * `seasonId` change, plus the parent's window, which must describe the season it
 * now names or the documents would be internally incoherent.
 *
 * The parent is rebuilt in the canonical shape the trigger itself writes, with
 * `playerCount` and `totalScoreCentavos` carried over from the real parent, so
 * `assertSeasonIntegrity` (parent.playerCount === canonical entry count) holds
 * on the read path exactly as it does for a genuinely-ranked season.
 */
async function publishProjection(input: {
  economy: string;
  publicPlayerId: string;
  fromParentPath: string;
  toParentPath: string;
  toSeasonId: string;
  entry: Record<string, unknown>;
}): Promise<void> {
  const realParent = await readDoc(input.fromParentPath);
  assert.ok(realParent, "o parent real deve existir para ser projetado");

  const window = seasonWindow(input.toSeasonId);

  await db.doc(input.toParentPath).set({
    economy: input.economy,
    seasonId: input.toSeasonId,
    timezone: realParent!.timezone,
    playerCount: realParent!.playerCount,
    totalScoreCentavos: realParent!.totalScoreCentavos,
    windowStart: Timestamp.fromDate(window.start),
    windowEnd: Timestamp.fromDate(window.end),
    updatedAt: realParent!.updatedAt,
  });

  await db
    .doc(input.toParentPath)
    .collection(SEASON_ENTRIES_SUBCOLLECTION)
    .doc(input.publicPlayerId)
    .set({
      ...input.entry,
      seasonId: input.toSeasonId,
    });
}

/**
 * Publishes the pre-activation bridge event: a copy of the real prize row with
 * the canonical shape preserved, changing only the id, `external_id` and the
 * timestamp. Returns the new transaction id.
 */
async function publishBridge(realTxId: string): Promise<string> {
  const real = await readDoc(`transactions/${realTxId}`);
  assert.ok(real, `a transação real ${realTxId} deve existir para ser copiada`);

  const bridgeId = `${realTxId}-bridge`;
  await db
    .collection("transactions")
    .doc(bridgeId)
    .set({
      ...real,
      timestamp: Timestamp.fromDate(BRIDGE_AT),
      external_id: bridgeId,
    });
  return bridgeId;
}

/** Runs one complete economy cycle through the HTTP endpoints. */
async function runCycle(opts: {
  economy: string;
  winner: { uid: string; email: string };
  other: { uid: string; email: string };
  entryFee: number;
  prize: number;
}): Promise<Cycle> {
  const { economy, winner, other, entryFee, prize } = opts;

  // 4. criar torneio com economy_type explícito
  const created = await mustCall(tokens[OPERATOR.uid], "createTournament", {
    name: `E2E Season Ranking — ${economy}`,
    description: "",
    entry_fee: entryFee,
    prize,
    max_players: 8,
    game_mode: "solo",
    economy_type: economy,
  });
  const tournamentId = created.tournament_id as string;
  assert.ok(tournamentId, "createTournament deve devolver tournament_id");

  // 5. registrar jogadores
  for (const player of [winner, other]) {
    await mustCall(tokens[player.uid], "jointournament", {
      tournamentid: tournamentId,
    });
  }

  // 6. publicar sala (+ leitura pelo jogador registrado)
  await mustCall(tokens[OPERATOR.uid], "setTournamentRoom", {
    tournamentid: tournamentId,
    roomid: `SRF-${economy}`,
    roompassword: "srf-secret",
  });
  await mustCall(tokens[winner.uid], "getTournamentRoom", {
    tournamentid: tournamentId,
  });

  // 7. iniciar
  await mustCall(tokens[OPERATOR.uid], "startTournament", {
    tournamentid: tournamentId,
  });

  // 8. declarar resultado (a liquidação é inline na mesma transação)
  await mustCall(tokens[OPERATOR.uid], "declareTournamentResult", {
    tournamentid: tournamentId,
    winneruid: winner.uid,
  });

  const realTxId = `prize_${tournamentId}`;
  const realTx = await awaitDoc(`transactions/${realTxId}`);

  // ── Ponte temporal, decidida pelo timestamp REAL da transação ─────────────
  const realPrizeAt = (realTx.timestamp as Timestamp).toDate();
  const realSeason = seasonIdFromInstant(realPrizeAt);
  const bridged = !isActiveSeason(realSeason);
  const rankedTxId = bridged ? await publishBridge(realTxId) : realTxId;
  const rankedSeasonId = bridged ? seasonIdFromInstant(BRIDGE_AT) : realSeason;

  // 9. observar o trigger automático
  const guard = await awaitDoc(`${RANKING_EVENTS_COLLECTION}/${rankedTxId}`);
  const publicPlayerId = guard.publicPlayerId as string;
  assert.ok(publicPlayerId, "o guard deve nomear o publicPlayerId cunhado");

  const rankedParentPath = parentPathOf(economy, rankedSeasonId);
  const entry = await awaitDoc(
    `${rankedParentPath}/${SEASON_ENTRIES_SUBCOLLECTION}/${publicPlayerId}`
  );

  // ── Temporada de LEITURA ─────────────────────────────────────────────────
  // A saída do trigger acima é a verdade e não é tocada. Quando ela cai numa
  // temporada que as callables ainda não servem (futura, pela retenção), o
  // teste projeta uma cópia canônica dela no mês corrente — que é servível por
  // definição — apenas para que os dois endpoints possam executar o caminho de
  // SUCESSO. Quando a temporada ranqueada já é servível, nada é projetado.
  const projected = !isServable(rankedSeasonId);
  const readSeasonId = projected
    ? seasonIdFromInstant(new Date())
    : rankedSeasonId;
  const readParentPath = parentPathOf(economy, readSeasonId);

  if (projected) {
    await publishProjection({
      economy,
      publicPlayerId,
      fromParentPath: rankedParentPath,
      toParentPath: readParentPath,
      toSeasonId: readSeasonId,
      entry,
    });
  }

  return {
    economy,
    tournamentId,
    winnerUid: winner.uid,
    realTxId,
    rankedTxId,
    bridged,
    rankedSeasonId,
    rankedParentPath,
    readSeasonId,
    readParentPath,
    projected,
    publicPlayerId,
    guard,
    entry,
    expectedCentavos: Math.round(prize * 100),
  };
}

/**
 * True when a season is at or after the first active one.
 *
 * Uses the PRODUCTION gate itself (`decideActivation` + `FIRST_ACTIVE_SEASON_ID`)
 * rather than a copied literal, so the bridge follows the activation constant
 * automatically and can never disagree with the trigger about what is active.
 */
function isActiveSeason(seasonId: string): boolean {
  return decideActivation(FIRST_ACTIVE_SEASON_ID, seasonId).kind === "active";
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function deleteParent(parentPath: string): Promise<void> {
  const ref = db.doc(parentPath);
  for (const sub of await ref.listCollections()) {
    const snap = await sub.get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await ref.delete();
}

async function cleanup(): Promise<void> {
  for (const cycle of Object.values(cycles)) {
    await db.collection("transactions").doc(cycle.realTxId).delete();
    await db.collection("transactions").doc(cycle.rankedTxId).delete();
    await db.collection(RANKING_EVENTS_COLLECTION).doc(cycle.rankedTxId).delete();
    await deleteParent(cycle.rankedParentPath);
    if (cycle.projected) await deleteParent(cycle.readParentPath);
    await db.collection("tournaments").doc(cycle.tournamentId).delete();
    await db.collection("tournament_rooms").doc(cycle.tournamentId).delete();
  }

  // Ledger, registros e carteiras de TODOS os usuários desta suíte.
  for (const user of ALL_USERS) {
    const userRef = db.collection("users").doc(user.uid);
    for (const col of ["transactions", "registrations"]) {
      const snap = await db.collection(col).where("user_ref", "==", userRef).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
    await db.collection("wallets").doc(user.uid).delete();
    await db.collection("users").doc(user.uid).delete();

    const identity = await readDoc(`public_player_ids/${user.uid}`);
    const ppid = identity?.publicPlayerId as string | undefined;
    if (ppid) {
      await db.collection("public_player_id_index").doc(ppid).delete();
    }
    await db.collection("public_player_ids").doc(user.uid).delete();

    try {
      await admin.auth().deleteUser(user.uid);
    } catch {
      /* já ausente */
    }
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

before(async () => {
  assertEmulatorOnly(PROJECT_ID); // fail-closed ANTES de qualquer uso de SDK

  process.env.GCLOUD_PROJECT = PROJECT_ID;
  if (admin.apps.length === 0) admin.initializeApp();
  db = admin.firestore();


    // Criar campeonato agora exige ORGANIZAÇÃO, não a claim de plataforma.
    await seedOrganization(db, OPERATOR.uid);

    // O caixa precisa cobrir prêmios acima do arrecadado — a mesma coisa que
    // o operador terá de fazer em produção antes de garantir premiação.
    await seedHouse(db, "cash", 100_000_00);
    await seedHouse(db, "beta_credit", 100_000_00);

  try {
    await fetchWithTimeout(`http://${FUNCTIONS_HOST}/`, {}, 10_000);
  } catch (error) {
    throw new Error(
      `FAIL-CLOSED (E2E aborted): emulador de Functions inacessível em ` +
        `${FUNCTIONS_HOST} — ${(error as Error).message}`
    );
  }

  await cleanup();

  // 1. autenticar — identidades reais no emulador de Auth
  const auth = admin.auth();
  for (const user of ALL_USERS) {
    try {
      await auth.deleteUser(user.uid);
    } catch {
      /* ausente */
    }
    await auth.createUser({ uid: user.uid, email: user.email, password: PW });
  }
  await auth.setCustomUserClaims(OPERATOR.uid, { admin: true });

  // `onUserCreated` é assíncrono e escreve `balance: 0` com merge — financiar
  // antes dele zeraria a carteira. Esperar é o padrão das suítes existentes.
  for (const user of ALL_USERS) {
    await awaitDoc(`wallets/${user.uid}`, 20_000);
  }

  for (const user of ALL_USERS) tokens[user.uid] = await signIn(user.email);

  // 2/3. financiar.
  // testdeposit é exercido pelo endpoint real com o caller ADMIN, e credita
  // exclusivamente a própria carteira do caller — provado abaixo.
  await mustCall(tokens[OPERATOR.uid], "testdeposit", {
    amount: 25,
    externalid: "srf-operator-deposit",
  });

  // Jogadores cash: não existe endpoint público de crédito para não-admin, então
  // a carteira é semeada pelo Admin SDK — o padrão já usado pelas suítes atuais.
  for (const player of [CASH_WINNER, CASH_OTHER]) {
    await db
      .collection("wallets")
      .doc(player.uid)
      .set(
        {
          balance: CASH_ENTRY,
          total_deposited: 0,
          total_won: 0,
          total_spent: 0,
          total_withdrawn: 0,
          user_ref: db.collection("users").doc(player.uid),
        },
        { merge: true }
      );
  }

  // Jogadores beta: há endpoint público (admin-only), então usamos o endpoint.
  for (const player of [BETA_WINNER, BETA_OTHER]) {
    await mustCall(tokens[OPERATOR.uid], "grantBetaCredit", {
      uid: player.uid,
      amount: BETA_GRANT,
      grant_id: `srf-${player.uid}`,
      campaign_id: "srf-e2e",
      reason: "Créditos do beta fechado",
    });
  }

  cycles[ECONOMY_CASH] = await runCycle({
    economy: ECONOMY_CASH,
    winner: CASH_WINNER,
    other: CASH_OTHER,
    entryFee: CASH_ENTRY,
    prize: CASH_PRIZE,
  });

  cycles[ECONOMY_BETA_CREDIT] = await runCycle({
    economy: ECONOMY_BETA_CREDIT,
    winner: BETA_WINNER,
    other: BETA_OTHER,
    entryFee: BETA_ENTRY,
    prize: BETA_PRIZE,
  });
});

after(async () => {
  await cleanup();
});

describe("E2E season ranking — o ciclo roda pelos endpoints reais", () => {
  it("testdeposit creditou SOMENTE a carteira do próprio caller admin", async () => {
    const operator = await readDoc(`wallets/${OPERATOR.uid}`);
    assert.equal(operator?.balance, 25, "o admin foi creditado pelo endpoint");
    assert.equal(operator?.total_deposited, 25);

    // Nenhuma outra carteira recebeu depósito.
    for (const other of [CASH_WINNER, CASH_OTHER, BETA_WINNER, BETA_OTHER]) {
      const wallet = await readDoc(`wallets/${other.uid}`);
      assert.equal(
        wallet?.total_deposited,
        0,
        `${other.uid} não pode ter sido creditado por testdeposit`
      );
    }
  });

  it("os dois torneios foram concluídos pelos endpoints", async () => {
    for (const cycle of Object.values(cycles)) {
      const tournament = await readDoc(`tournaments/${cycle.tournamentId}`);
      assert.equal(tournament?.status, "completed", cycle.economy);
      assert.equal(tournament?.economy_type, cycle.economy);
      assert.equal(tournament?.locked_economy_type, cycle.economy);
      assert.notEqual(await readDoc(`tournament_rooms/${cycle.tournamentId}`), null);
    }
  });

  it("a ponte temporal só existe antes da primeira temporada ativa", () => {
    for (const cycle of Object.values(cycles)) {
      if (cycle.bridged) {
        assert.ok(
          !isActiveSeason(seasonIdFromInstant(new Date())),
          "a ponte só pode existir enquanto o mês corrente ainda não for ativo"
        );
        assert.ok(
          isActiveSeason(cycle.rankedSeasonId),
          "a ponte deve pousar numa temporada ativa"
        );
      } else {
        assert.equal(
          cycle.rankedTxId,
          cycle.realTxId,
          "sem ponte, o ranking observado é o da transação real"
        );
      }
    }
  });
});

for (const economy of [ECONOMY_CASH, ECONOMY_BETA_CREDIT]) {
  describe(`E2E season ranking — economia ${economy}`, () => {
    it("a prize transaction canônica existe", async () => {
      const cycle = cycles[economy];
      const tx = await readDoc(`transactions/${cycle.rankedTxId}`);
      assert.ok(tx, "a prize transaction deve existir");
      assert.equal(tx?.status, "completed");
      assert.equal(
        (tx?.user_ref as { path?: string })?.path,
        `users/${cycle.winnerUid}`
      );
      assert.equal(
        (tx?.tournament_ref as { path?: string })?.path,
        `tournaments/${cycle.tournamentId}`
      );
    });

    it("ranking_events/{transactionId} foi criado pelo trigger", () => {
      const cycle = cycles[economy];
      assert.equal(
        (cycle.guard.transactionRef as { path?: string })?.path,
        `transactions/${cycle.rankedTxId}`
      );
      assert.equal(cycle.guard.economy, economy);
      assert.equal(cycle.guard.seasonId, cycle.rankedSeasonId);
      assert.equal(cycle.guard.amountCentavos, cycle.expectedCentavos);
    });

    it("o parent season_rankings/{economy}_{seasonId} tem playerCount correto", async () => {
      const cycle = cycles[economy];
      const parent = await readDoc(cycle.rankedParentPath);
      assert.ok(parent, `parent ausente em ${cycle.rankedParentPath}`);
      assert.equal(parent?.playerCount, 1, "apenas o vencedor pontuou");
      assert.equal(parent?.totalScoreCentavos, cycle.expectedCentavos);
    });

    it("a entry pelo publicPlayerId bate com a transação", () => {
      const cycle = cycles[economy];
      assert.equal(cycle.entry.publicPlayerId, cycle.publicPlayerId);
      assert.equal(cycle.entry.economy, economy);
      assert.equal(cycle.entry.seasonId, cycle.rankedSeasonId);
      assert.equal(cycle.entry.winsCount, 1);
      // O contrato atual nomeia o valor acumulado `scoreCentavos`; não existe
      // campo `wonAmount` em lugar algum do backend.
      assert.equal(cycle.entry.scoreCentavos, cycle.expectedCentavos);
      assert.ok(cycle.entry.firstPrizeAt instanceof Timestamp);
      assert.ok(cycle.entry.lastPrizeAt instanceof Timestamp);
    });

    it("a entry NÃO contém uid", () => {
      const cycle = cycles[economy];
      const serialized = JSON.stringify(cycle.entry);
      for (const user of ALL_USERS) {
        assert.ok(
          !serialized.includes(user.uid),
          `a entry não pode conter o uid ${user.uid}`
        );
      }
    });

    it("getSeasonLeaderboard devolve o vencedor pelo endpoint real", async () => {
      const cycle = cycles[economy];

      // SEMPRE o caminho de sucesso: a temporada de leitura é servível por
      // construção (a ranqueada, ou a projeção canônica dela no mês corrente).
      const page = await mustCall(tokens[cycle.winnerUid], "getSeasonLeaderboard", {
        economy,
        seasonId: cycle.readSeasonId,
      });

      assert.equal(page.success, true);
      assert.equal(page.amountUnit, "centavos");
      assert.equal(page.economy, economy);
      assert.equal(page.seasonId, cycle.readSeasonId);
      assert.equal(page.playerCount, 1);
      assert.equal(page.entries.length, 1);

      const [top] = page.entries;
      assert.equal(top.position, 1, "o vencedor é o primeiro");
      assert.equal(top.publicPlayerId, cycle.publicPlayerId);
      assert.equal(top.scoreCentavos, cycle.expectedCentavos);
      assert.equal(top.winsCount, 1);
      assert.equal(top.economy, economy);

      const serialized = JSON.stringify(page);
      for (const user of ALL_USERS) {
        assert.ok(
          !serialized.includes(user.uid),
          `nenhum uid pode aparecer no payload (${user.uid})`
        );
      }
    });

    it("getMySeasonRanking devolve rank 1 pelo endpoint real", async () => {
      const cycle = cycles[economy];

      const mine = await mustCall(tokens[cycle.winnerUid], "getMySeasonRanking", {
        economy,
        seasonId: cycle.readSeasonId,
      });

      assert.equal(mine.success, true);
      assert.equal(mine.amountUnit, "centavos");
      assert.equal(mine.economy, economy);
      assert.equal(mine.seasonId, cycle.readSeasonId);
      assert.equal(mine.isRanked, true);
      assert.equal(mine.rank, 1, "o vencedor está em primeiro");
      assert.equal(mine.playerCount, 1);

      // Forma confirmada no handler: entry = {publicPlayerId,label,scoreCentavos,winsCount}
      assert.equal(mine.entry.publicPlayerId, cycle.publicPlayerId);
      assert.equal(mine.entry.scoreCentavos, cycle.expectedCentavos);
      assert.equal(mine.entry.winsCount, 1);

      const serialized = JSON.stringify(mine);
      for (const user of ALL_USERS) {
        assert.ok(!serialized.includes(user.uid), `uid vazou: ${user.uid}`);
      }
    });

    it("uma temporada futura continua sendo recusada pela retenção", async (t) => {
      const cycle = cycles[economy];
      if (!cycle.projected) {
        t.skip("a temporada ranqueada já é servível — não há futuro a recusar");
        return;
      }

      // Prova ADICIONAL, nunca substituta: a ranqueada está no futuro e a
      // retenção a recusa por contrato.
      const res = await callAs(tokens[cycle.winnerUid], "getSeasonLeaderboard", {
        economy,
        seasonId: cycle.rankedSeasonId,
      });
      assert.equal(res.ok, false);
      assert.equal(res.code, "INVALID_ARGUMENT");
      assert.match(res.message ?? "", /Temporada indispon/);
    });
  });
}

describe("E2E season ranking — as economias não se contaminam", () => {
  it("os vencedores são pseudônimos distintos", () => {
    assert.notEqual(
      cycles[ECONOMY_CASH].publicPlayerId,
      cycles[ECONOMY_BETA_CREDIT].publicPlayerId
    );
  });

  it("os parents são documentos distintos, ranqueado e de leitura", () => {
    assert.notEqual(
      cycles[ECONOMY_CASH].rankedParentPath,
      cycles[ECONOMY_BETA_CREDIT].rankedParentPath
    );
    assert.notEqual(
      cycles[ECONOMY_CASH].readParentPath,
      cycles[ECONOMY_BETA_CREDIT].readParentPath
    );
  });

  it("o vencedor cash não aparece no ranking beta, e vice-versa", async () => {
    const cash = cycles[ECONOMY_CASH];
    const beta = cycles[ECONOMY_BETA_CREDIT];

    for (const [label, cashPath, betaPath] of [
      ["ranqueada", cash.rankedParentPath, beta.rankedParentPath],
      ["de leitura", cash.readParentPath, beta.readParentPath],
    ] as const) {
      assert.equal(
        await readDoc(
          `${betaPath}/${SEASON_ENTRIES_SUBCOLLECTION}/${cash.publicPlayerId}`
        ),
        null,
        `${label}: o pseudônimo cash não pode ter entry no ranking beta`
      );
      assert.equal(
        await readDoc(
          `${cashPath}/${SEASON_ENTRIES_SUBCOLLECTION}/${beta.publicPlayerId}`
        ),
        null,
        `${label}: o pseudônimo beta não pode ter entry no ranking cash`
      );
    }
  });

  it("cada temporada contém exatamente uma entry", async () => {
    for (const cycle of Object.values(cycles)) {
      const entries = await db
        .doc(cycle.rankedParentPath)
        .collection(SEASON_ENTRIES_SUBCOLLECTION)
        .get();
      assert.equal(entries.size, 1, `${cycle.economy} deve ter uma única entry`);
    }
  });
});

describe("E2E season ranking — idempotência da declaração/liquidação", () => {
  it("repetir declareTournamentResult não duplica prêmio nem ranking", async () => {
    for (const economy of [ECONOMY_CASH, ECONOMY_BETA_CREDIT]) {
      const cycle = cycles[economy];

      // A cópia-ponte, quando existe, é artefato de teste e não conta como
      // liquidação do fluxo.
      const bridgeArtifacts = cycle.bridged ? [cycle.rankedTxId] : [];

      const before = {
        prize: await readDoc(`transactions/${cycle.realTxId}`),
        guard: await readDoc(`${RANKING_EVENTS_COLLECTION}/${cycle.rankedTxId}`),
        parent: await readDoc(cycle.rankedParentPath),
        entry: await readDoc(
          `${cycle.rankedParentPath}/${SEASON_ENTRIES_SUBCOLLECTION}/${cycle.publicPlayerId}`
        ),
        wallet: await readDoc(`wallets/${cycle.winnerUid}`),
        prizeCount: await flowPrizeTxCount(cycle.tournamentId, bridgeArtifacts),
      };
      assert.equal(before.prizeCount, 1, `${economy}: exatamente um prêmio`);

      // Replay pelo MESMO endpoint HTTP.
      await mustCall(tokens[OPERATOR.uid], "declareTournamentResult", {
        tournamentid: cycle.tournamentId,
        winneruid: cycle.winnerUid,
      });

      // Uma segunda entrega de trigger, se houvesse, já teria ocorrido: a
      // ausência de nova prize transaction é o que a impede de existir.
      const after = {
        prize: await readDoc(`transactions/${cycle.realTxId}`),
        guard: await readDoc(`${RANKING_EVENTS_COLLECTION}/${cycle.rankedTxId}`),
        parent: await readDoc(cycle.rankedParentPath),
        entry: await readDoc(
          `${cycle.rankedParentPath}/${SEASON_ENTRIES_SUBCOLLECTION}/${cycle.publicPlayerId}`
        ),
        wallet: await readDoc(`wallets/${cycle.winnerUid}`),
        prizeCount: await flowPrizeTxCount(cycle.tournamentId, bridgeArtifacts),
      };

      assert.equal(after.prizeCount, 1, `${economy}: nenhuma prize transaction nova`);
      assert.equal(after.entry?.winsCount, 1, `${economy}: winsCount não cresce`);
      assert.equal(
        after.entry?.scoreCentavos,
        cycle.expectedCentavos,
        `${economy}: o valor acumulado não cresce`
      );
      assert.deepEqual(after, before, `${economy}: tudo byte-idêntico após o replay`);
    }
  });

  it("existe exatamente um ranking_event por transação ranqueada", async () => {
    for (const cycle of Object.values(cycles)) {
      const events = await db
        .collection(RANKING_EVENTS_COLLECTION)
        .where("transactionRef", "==", db.doc(`transactions/${cycle.rankedTxId}`))
        .get();
      assert.equal(events.size, 1, `${cycle.economy}: um único ranking_event`);
    }
  });
});
