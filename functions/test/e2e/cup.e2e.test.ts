import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * A COPA CONTRA UM FIRESTORE DE VERDADE, do sorteio ao pagamento.
 *
 * O que só o emulador prova: que a semeadura sai da ORDEM DE INSCRIÇÃO gravada
 * (e não da ordem em que o Firestore devolve os documentos), que sortear duas
 * vezes não redesenha chaves que jogadores já viram, e — o teste que dá sentido
 * ao formato — que o dinheiro chega na carteira certa, no valor certo, pela
 * MESMA liquidação que paga um campeonato por pontos.
 */

const PROJECT_ID = "demo-sparta-battle";
const ADMIN = "e2e-cup-admin";
const ctx = () => ({ auth: { uid: ADMIN, token: { admin: true } } });

/** Cinco inscritos: chaveamento de oito, três byes. */
const PLAYERS = ["e2e-cup-a", "e2e-cup-b", "e2e-cup-c", "e2e-cup-d", "e2e-cup-e"];

let db: admin.firestore.Firestore;
let createTournament: (d: unknown, c: unknown) => Promise<any>;
let drawBracket: (d: unknown, c: unknown) => Promise<any>;
let declareMatch: (d: unknown, c: unknown) => Promise<any>;
let settle: (d: unknown, c: unknown) => Promise<any>;

const created: string[] = [];

async function create(extra: Record<string, unknown>) {
  const out = await createTournament(
    {
      name: "Copa E2E",
      description: "",
      economy_type: "beta_credit",
      entry_fee: 5,
      prize: 100,
      max_players: 64,
      game_mode: "copa",
      ...extra,
    },
    ctx()
  );
  const id = out.tournament_id as string;
  created.push(id);
  return id;
}

/** Inscreve com carimbo EXPLÍCITO: a semeadura sai daqui. */
async function register(
  tournamentId: string,
  uid: string,
  minuteOffset: number
) {
  await db
    .collection("registrations")
    .doc(`${tournamentId}_${uid}`)
    .set({
      user_ref: db.collection("users").doc(uid),
      tournament_ref: db.collection("tournaments").doc(tournamentId),
      status: "registered",
      entry_fee: 5,
      entry_fee_snapshot: 5,
      economy_type: "beta_credit",
      created_at: admin.firestore.Timestamp.fromMillis(
        Date.UTC(2026, 7, 1) + minuteOffset * 60_000
      ),
    });
}

async function bracketOf(tournamentId: string) {
  const snap = await db
    .collection("tournaments")
    .doc(tournamentId)
    .collection("bracket")
    .doc("state")
    .get();
  return snap.data() ?? {};
}

describe("E2E — Copa", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    createTournament = (mod as any).createTournamentHandler;
    drawBracket = (mod as any).drawCupBracketHandler;
    declareMatch = (mod as any).declareCupMatchHandler;
    settle = (mod as any).settleTournamentByPointsHandler;

    await db.collection("users").doc(ADMIN).set({ username: "CUPADMIN" });
    await Promise.all(
      PLAYERS.map((uid) => db.collection("users").doc(uid).set({ username: uid }))
    );
  });

  after(async () => {
    const registrations = await db
      .collection("registrations")
      .where("status", "==", "registered")
      .get();
    await Promise.all([
      ...created.map(async (id) => {
        await db
          .collection("tournaments")
          .doc(id)
          .collection("bracket")
          .doc("state")
          .delete();
        await db.collection("tournaments").doc(id).delete();
      }),
      ...registrations.docs
        .filter((d) => d.id.includes("e2e-cup-"))
        .map((d) => d.ref.delete()),
      db.collection("users").doc(ADMIN).delete(),
      ...PLAYERS.map((uid) => db.collection("users").doc(uid).delete()),
      ...PLAYERS.map((uid) => db.collection("wallets").doc(uid).delete()),
      db.collection("house").doc("beta_credit").delete(),
    ]);
  });

  it("cria com o tamanho de equipe escolhido pelo criador", async () => {
    const id = await create({ team_size: 4, max_players: 32 });
    const doc = await db.collection("tournaments").doc(id).get();
    assert.equal(doc.get("format_type"), "cup");
    assert.equal(doc.get("team_size"), 4);
    assert.equal(doc.get("game_mode"), "copa");
  });

  it("Copa individual é o padrão quando o tamanho não vem", async () => {
    const id = await create({ max_players: 8 });
    assert.equal(
      (await db.collection("tournaments").doc(id).get()).get("team_size"),
      1
    );
  });

  it("um tamanho de equipe impossível é recusado", async () => {
    await assert.rejects(
      () => create({ team_size: 3, max_players: 12 }),
      /tamanho da equipe/
    );
  });

  it("A SEMEADURA SAI DA ORDEM DE INSCRIÇÃO — o bye vai para os primeiros", async () => {
    // Inscritos FORA de ordem cronológica de propósito: se a semeadura viesse
    // da ordem que o Firestore devolve, este teste passaria por acidente.
    const id = await create({ max_players: 8 });
    await register(id, "e2e-cup-c", 30);
    await register(id, "e2e-cup-a", 10);
    await register(id, "e2e-cup-e", 50);
    await register(id, "e2e-cup-b", 20);
    await register(id, "e2e-cup-d", 40);

    const out = await drawBracket({ tournamentid: id }, ctx());
    assert.equal(out.success, true);
    assert.equal(out.entrants, 5);
    assert.equal(out.size, 8);
    assert.equal(out.byes, 3);

    const stored = await bracketOf(id);
    // A ordem gravada é a cronológica, não a de chegada do documento.
    assert.deepEqual(stored.entrants, [
      "e2e-cup-a",
      "e2e-cup-b",
      "e2e-cup-c",
      "e2e-cup-d",
      "e2e-cup-e",
    ]);

    const byeWinners = (stored.matches as any[])
      .filter((m) => m.bye)
      .map((m) => m.winner)
      .sort();
    assert.deepEqual(byeWinners, ["e2e-cup-a", "e2e-cup-b", "e2e-cup-c"]);

    // E o campeonato largou.
    assert.equal(
      (await db.collection("tournaments").doc(id).get()).get("status"),
      "in_progress"
    );
  });

  it("sortear DE NOVO devolve o mesmo chaveamento", async () => {
    // Um segundo toque não pode redesenhar chaves que jogadores já viram.
    const id = created[created.length - 1];
    const before = await bracketOf(id);
    const out = await drawBracket({ tournamentid: id }, ctx());
    assert.equal(out.idempotent, true);
    assert.deepEqual((await bracketOf(id)).matches, before.matches);
  });

  it("sem inscritos suficientes não há sorteio", async () => {
    const id = await create({ max_players: 8 });
    await register(id, "e2e-cup-a", 10);
    await assert.rejects(
      () => drawBracket({ tournamentid: id }, ctx()),
      /pelo menos 2/
    );
  });

  it("um campeonato que NÃO é Copa não sorteia chaveamento", async () => {
    const id = await create({ game_mode: "squad", max_players: 8, team_size: 4 });
    await assert.rejects(
      () => drawBracket({ tournamentid: id }, ctx()),
      /não é uma Copa/
    );
  });

  describe("jogando a Copa até o fim", () => {
    let id: string;

    before(async () => {
      // A divisão entra na CRIAÇÃO: um campeonato sem ela nem chega ao
      // chaveamento na hora de liquidar, e o teste do meio da Copa precisa
      // falhar pelo motivo certo.
      id = await create({
        max_players: 8,
        prize: 100,
        prize_distribution: [
          { position: 1, amount_centavos: 6000 },
          { position: 2, amount_centavos: 3000 },
          { position: 3, amount_centavos: 1000 },
        ],
      });
      // a, b, c, d — chaveamento de 4, cheio, sem bye.
      await register(id, "e2e-cup-a", 10);
      await register(id, "e2e-cup-b", 20);
      await register(id, "e2e-cup-c", 30);
      await register(id, "e2e-cup-d", 40);
      await drawBracket({ tournamentid: id }, ctx());

      for (const uid of PLAYERS) {
        await db.collection("wallets").doc(uid).set({ beta_balance: 0 });
      }
      // Prêmio 100 contra 20 arrecadados: o caixa banca a diferença.
      await db
        .collection("house")
        .doc("beta_credit")
        .set({ balance_centavos: 20_000, economy_type: "beta_credit" });
    });

    it("o chaveamento de 4 nasce cheio: a x d, b x c", async () => {
      const stored = await bracketOf(id);
      const first = (stored.matches as any[]).filter((m) => m.round === 1);
      assert.deepEqual(
        first.map((m) => [m.home, m.away]),
        [
          ["e2e-cup-a", "e2e-cup-d"],
          ["e2e-cup-b", "e2e-cup-c"],
        ]
      );
    });

    it("liquidar no meio da Copa é RECUSADO", async () => {
      // Pagar com confronto em aberto pagaria uma classificação provisória.
      await assert.rejects(
        () => settle({ tournamentid: id }, ctx()),
        /confrontos sem resultado/
      );
    });

    it("o vencedor sobe para a final", async () => {
      await declareMatch(
        { tournamentid: id, match_number: 1, winner_uid: "e2e-cup-d" },
        ctx()
      );
      const stored = await bracketOf(id);
      const final = (stored.matches as any[]).find((m) => m.round === 2);
      assert.equal(final.home, "e2e-cup-d");
      assert.equal(final.away, null);
    });

    it("relançar o mesmo confronto é recusado", async () => {
      await assert.rejects(
        () =>
          declareMatch(
            { tournamentid: id, match_number: 1, winner_uid: "e2e-cup-a" },
            ctx()
          ),
        /já foi decidido/
      );
    });

    it("quem não está no confronto não pode vencer", async () => {
      await assert.rejects(
        () =>
          declareMatch(
            { tournamentid: id, match_number: 2, winner_uid: "e2e-cup-a" },
            ctx()
          ),
        /um dos dois lados/
      );
    });

    it("a final decide o campeão", async () => {
      await declareMatch(
        { tournamentid: id, match_number: 2, winner_uid: "e2e-cup-b" },
        ctx()
      );
      const out = await declareMatch(
        { tournamentid: id, match_number: 3, winner_uid: "e2e-cup-d" },
        ctx()
      );
      assert.equal(out.complete, true);
      assert.equal(out.champion, "e2e-cup-d");
    });

    it("A LIQUIDAÇÃO PAGA PELA CLASSIFICAÇÃO DA COPA", async () => {
      // Divisão configurada na criação: 60 / 30 / 10 sobre 100.
      const out = await settle({ tournamentid: id }, ctx());
      assert.equal(out.success, true);

      const doc = await db.collection("tournaments").doc(id).get();
      assert.equal(doc.get("status"), "completed");
      assert.equal(doc.get("result").mode, "cup");

      // d foi campeão, b vice. O 3º é o semifinalista que se inscreveu antes.
      const awards = doc.get("result").awards as any[];
      assert.equal(awards[0].uid, "e2e-cup-d");
      assert.equal(awards[1].uid, "e2e-cup-b");
      assert.equal(awards[2].uid, "e2e-cup-a");
    });

    it("o dinheiro chegou na carteira certa, no valor certo", async () => {
      const wallet = async (uid: string) =>
        (await db.collection("wallets").doc(uid).get()).get("beta_balance");
      assert.equal(await wallet("e2e-cup-d"), 60);
      assert.equal(await wallet("e2e-cup-b"), 30);
      assert.equal(await wallet("e2e-cup-a"), 10);
      assert.equal(await wallet("e2e-cup-c"), 0);
    });

    it("liquidar DE NOVO é recusado", async () => {
      await assert.rejects(
        () => settle({ tournamentid: id }, ctx()),
        /já foi encerrado/
      );
    });

    it("e o chaveamento não aceita mais resultado", async () => {
      await assert.rejects(
        () =>
          declareMatch(
            { tournamentid: id, match_number: 3, winner_uid: "e2e-cup-b" },
            ctx()
          ),
        /já foi encerrado/
      );
    });
  });

  it("um não-admin não sorteia nem lança", async () => {
    const player = { auth: { uid: "e2e-cup-a", token: {} } };
    await assert.rejects(
      () => drawBracket({ tournamentid: created[0] }, player),
      /Apenas admin/
    );
    await assert.rejects(
      () =>
        declareMatch(
          { tournamentid: created[0], match_number: 1, winner_uid: "x" },
          player
        ),
      /Apenas admin/
    );
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () => drawBracket({ tournamentid: created[0], seed: "eu" }, ctx()),
      /.+/
    );
  });
});
