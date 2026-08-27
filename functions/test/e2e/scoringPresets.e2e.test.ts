import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { seedOrganization } from "../support/orgSeed.js";

import { MAX_PRESETS_PER_OWNER } from "../../src/domain/scoringPreset.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * CONFIGURAÇÕES SALVAS DE PONTUAÇÃO, contra um Firestore real.
 *
 * O que só o emulador prova: que salvar o mesmo nome SUBSTITUI em vez de
 * duplicar, que as configurações de um criador são invisíveis para outro, que o
 * teto conta só o que já existe, e — o teste que dá sentido à feature — que uma
 * configuração salva CRIA um campeonato de verdade. Uma tabela que salva limpa
 * e falha na hora de usar seria pior do que não ter tabela nenhuma.
 */

const PROJECT_ID = "demo-sparta-battle";
const ME = "e2e-preset-admin";
const OTHER = "e2e-preset-other-admin";

const ctx = (uid: string, isAdmin = true) => ({
  auth: { uid, token: isAdmin ? { admin: true } : {} },
});

let db: admin.firestore.Firestore;
let save: (d: unknown, c: unknown) => Promise<any>;
let list: (d: unknown, c: unknown) => Promise<any>;
let remove: (d: unknown, c: unknown) => Promise<any>;
let createTournament: (d: unknown, c: unknown) => Promise<any>;

const SQUAD = {
  name: "Squad 6 partidas",
  matches_count: 6,
  kill_points: 1,
  placement_points: [12, 9, 8, 7, 6],
  prize_distribution: [
    { position: 1, amount_centavos: 5000 },
    { position: 2, amount_centavos: 3000 },
    { position: 3, amount_centavos: 2000 },
  ],
};

async function wipe(uid: string): Promise<void> {
  const presets = await db
    .collection("scoring_presets")
    .doc(uid)
    .collection("presets")
    .get();
  await Promise.all(presets.docs.map((doc) => doc.ref.delete()));
}

describe("E2E — configurações salvas de pontuação", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();


    // Criar campeonato agora exige ORGANIZAÇÃO, não a claim de plataforma.
    await seedOrganization(db, ME);

    const mod = await import("../../src/index.js");
    save = (mod as any).saveScoringPresetHandler;
    list = (mod as any).listScoringPresetsHandler;
    remove = (mod as any).deleteScoringPresetHandler;
    createTournament = (mod as any).createTournamentHandler;

    await Promise.all([wipe(ME), wipe(OTHER)]);
    // `createTournament` exige a conta do criador. O teste que prova que um
    // preset cria um campeonato de verdade passa por lá.
    await db
      .collection("users")
      .doc(ME)
      .set({ username: "PRESETADMIN", email: "preset@sparta.gg" });
  });

  after(async () => {
    await Promise.all([
      wipe(ME),
      wipe(OTHER),
      db.collection("users").doc(ME).delete(),
    ]);
  });

  it("salva e devolve exatamente o que foi guardado", async () => {
    const response = await save(SQUAD, ctx(ME));
    assert.equal(response.saved, true);
    assert.equal(response.preset.preset_id, "squad-6-partidas");
    assert.equal(response.preset.matches_count, 6);
    assert.deepEqual(response.preset.placement_points, [12, 9, 8, 7, 6]);
    assert.deepEqual(response.preset.prize_distribution, SQUAD.prize_distribution);

    const listed = await list({}, ctx(ME));
    assert.equal(listed.presets.length, 1);
    assert.deepEqual(listed.presets[0], response.preset);
  });

  it("salvar o MESMO nome substitui — nunca duplica", async () => {
    // É o que um botão de salvar significa em qualquer outro lugar, e é o que
    // torna um toque duplo inofensivo.
    await save({ ...SQUAD, kill_points: 2 }, ctx(ME));
    const listed = await list({}, ctx(ME));
    assert.equal(listed.presets.length, 1, "duplicou");
    assert.equal(listed.presets[0].kill_points, 2);
  });

  it("mudar para 'só o campeão' APAGA a divisão anterior", async () => {
    // Gravar a divisão só quando ela existe deixaria a antiga colada numa
    // configuração que o criador acabou de simplificar.
    await save({ ...SQUAD, prize_distribution: null }, ctx(ME));
    const listed = await list({}, ctx(ME));
    assert.equal(listed.presets[0].prize_distribution, null);

    // E volta ao normal quando ele configura de novo.
    await save(SQUAD, ctx(ME));
    const again = await list({}, ctx(ME));
    assert.equal(again.presets[0].prize_distribution.length, 3);
  });

  it("uma configuração salva CRIA um campeonato de verdade", async () => {
    // O teste que dá sentido à feature: as duas validações não podem divergir.
    const saved = (await list({}, ctx(ME))).presets[0];

    const created = await createTournament(
      {
        name: "Campeonato do preset",
        description: "",
        entry_fee: 10,
        prize: 100,
        max_players: 48,
        game_mode: "squad",
        economy_type: "beta_credit",
        matches_count: saved.matches_count,
        kill_points: saved.kill_points,
        placement_points: saved.placement_points,
        prize_distribution: saved.prize_distribution,
      },
      ctx(ME)
    );

    const tournamentId = String(created.tournament_id ?? "");
    assert.equal(tournamentId.length > 0, true, "não veio id do campeonato");

    const stored = await db.collection("tournaments").doc(tournamentId).get();
    assert.equal(stored.get("matches_count"), 6);
    assert.equal(stored.get("kill_points"), 1);
    assert.deepEqual(stored.get("placement_points"), [12, 9, 8, 7, 6]);

    await stored.ref.delete();
  });

  it("as configurações de um criador são invisíveis para outro", async () => {
    // O uid vem do token verificado, nunca do payload — não há alvo para mirar.
    const theirs = await list({}, ctx(OTHER));
    assert.deepEqual(theirs.presets, []);

    await save({ ...SQUAD, name: "Solo do outro" }, ctx(OTHER));
    const mine = await list({}, ctx(ME));
    assert.equal(
      mine.presets.some((p: any) => p.name === "Solo do outro"),
      false,
      "vazou entre criadores"
    );
    await wipe(OTHER);
  });

  it("apaga, e apagar de novo não é erro", async () => {
    // Um segundo toque — ou um item que outra aba já apagou — chega aqui com o
    // resultado desejado já verdadeiro.
    const first = await remove({ preset_id: "squad-6-partidas" }, ctx(ME));
    assert.equal(first.deleted, true);
    const second = await remove({ preset_id: "squad-6-partidas" }, ctx(ME));
    assert.equal(second.deleted, false);
    assert.deepEqual((await list({}, ctx(ME))).presets, []);
  });

  it("o teto conta só as que existem — substituir a última sempre cabe", async () => {
    for (let i = 1; i <= MAX_PRESETS_PER_OWNER; i += 1) {
      await save({ ...SQUAD, name: `Formato ${i}` }, ctx(ME));
    }
    assert.equal((await list({}, ctx(ME))).presets.length, MAX_PRESETS_PER_OWNER);

    // Corrigir uma que já existe, no teto, tem que continuar possível.
    const fixed = await save(
      { ...SQUAD, name: "Formato 1", kill_points: 3 },
      ctx(ME)
    );
    assert.equal(fixed.preset.kill_points, 3);

    // Uma NOVA, não.
    await assert.rejects(
      () => save({ ...SQUAD, name: "Uma a mais" }, ctx(ME)),
      /Apague uma/i
    );

    await wipe(ME);
  });

  it("um não-admin não salva, não lista e não apaga", async () => {
    for (const call of [
      () => save(SQUAD, ctx("e2e-preset-player", false)),
      () => list({}, ctx("e2e-preset-player", false)),
      () => remove({ preset_id: "squad-6" }, ctx("e2e-preset-player", false)),
    ]) {
      await assert.rejects(call, /Apenas admin/i);
    }
  });

  it("deslogado não chega em nada", async () => {
    for (const call of [
      () => save(SQUAD, { auth: null }),
      () => list({}, { auth: null }),
      () => remove({ preset_id: "squad-6" }, { auth: null }),
    ]) {
      await assert.rejects(call, /precisa estar logado/i);
    }
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () => save({ ...SQUAD, owner_uid: OTHER }, ctx(ME)),
      /.+/
    );
    await assert.rejects(() => list({ uid: OTHER }, ctx(ME)), /.+/);
    await assert.rejects(
      () => remove({ preset_id: "squad-6", uid: OTHER }, ctx(ME)),
      /.+/
    );
  });

  it("um id fora do alfabeto não vira caminho de documento", async () => {
    for (const bad of ["../users/admin", "Squad-6", "a/b", "", "squad_6"]) {
      await assert.rejects(
        () => remove({ preset_id: bad }, ctx(ME)),
        /não encontrada/i,
        bad
      );
    }
  });

  it("a recusa de pontuação é a MESMA frase da criação de campeonato", async () => {
    await assert.rejects(
      () => save({ ...SQUAD, matches_count: 51 }, ctx(ME)),
      /1 a 50/
    );
    // UM PRESET NÃO CONFERE A SOMA — ele não tem premiação para conferir
    // contra. O que ele confere é a forma, e com as mesmas frases.
    await assert.rejects(
      () =>
        save(
          {
            ...SQUAD,
            prize_distribution: [
              { position: 1, amount_centavos: 5000 },
              { position: 3, amount_centavos: 5000 },
            ],
          },
          ctx(ME)
        ),
      /pular posições/
    );
    await assert.rejects(
      () =>
        save(
          { ...SQUAD, prize_distribution: [{ position: 1, amount_centavos: 0 }] },
          ctx(ME)
        ),
      /maior que zero/
    );
  });
});
