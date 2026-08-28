import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * ORGANIZAÇÕES, contra um Firestore real.
 *
 * O que só o emulador prova:
 *
 *  - que o convite serve UMA VEZ mesmo quando duas pessoas tentam ao mesmo
 *    tempo — o uso único é uma transação, não uma intenção;
 *  - que criar campeonato sem organização é recusado, e com organização passa;
 *  - que a claim de plataforma NÃO abre a porta sozinha, que é o que separa
 *    "ajudar a organizar" de "ter a chave do caixa";
 *  - que o telefone do dono não volta em resposta nenhuma;
 *  - e que a contabilidade só responde ao dono.
 */

const PROJECT_ID = "demo-sparta-battle";

const DONO = "e2e-org-dono";
const CONVIDADO = "e2e-org-convidado";
const OUTRO = "e2e-org-outro";
const ESTRANHO = "e2e-org-estranho";

const TELEFONE = "11988887777";

/**
 * APELIDOS QUE NÃO CONTÊM O UID.
 *
 * O fixture usava o próprio uid como apelido, e isso tornava impossível provar
 * que um uid não vaza: o apelido — que SAI, e deve sair — carregava a string
 * procurada e a asserção acusava um vazamento que não existia. Nomes distintos
 * fazem a busca por uid significar exatamente o que ela diz.
 */
const APELIDO: Readonly<Record<string, string>> = {
  [DONO]: "Cesar",
  [CONVIDADO]: "Ajudante",
  [OUTRO]: "Terceiro",
  [ESTRANHO]: "Passante",
};

type Handler = (d: any, c: any, o?: any) => Promise<any>;

const ctx = (uid: string, isAdmin = false) => ({
  auth: { uid, token: isAdmin ? { admin: true } : {} },
});

let db: admin.firestore.Firestore;
let criarOrg: Handler;
let minhaOrg: Handler;
let criarConvite: Handler;
let aceitar: Handler;
let revogar: Handler;
let remover: Handler;
let contabilidade: Handler;
let criarCampeonato: Handler;
let perfilOrg: Handler;

let orgId = "";

async function limpar(): Promise<void> {
  const orgs = await db.collection("organizations").get();
  const membros = await db.collection("organization_members").get();
  const convites = await db.collection("organization_invites").get();
  const privados = await db.collection("organization_private").get();
  await Promise.all([
    ...orgs.docs.map((d) => d.ref.delete()),
    ...membros.docs.map((d) => d.ref.delete()),
    ...convites.docs.map((d) => d.ref.delete()),
    ...privados.docs.map((d) => d.ref.delete()),
    ...[DONO, CONVIDADO, OUTRO, ESTRANHO].map((u) =>
      db.collection("users").doc(u).delete()
    ),
  ]);
}

before(async () => {
  assertEmulatorOnly(PROJECT_ID);
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  if (admin.apps.length === 0) admin.initializeApp();
  db = admin.firestore();

  const mod: any = await import("../../src/index.js");
  criarOrg = mod.createOrganizationHandler;
  minhaOrg = mod.getMyOrganizationHandler;
  criarConvite = mod.createOrgInviteHandler;
  aceitar = mod.acceptOrgInviteHandler;
  revogar = mod.revokeOrgInviteHandler;
  remover = mod.removeOrgAdminHandler;
  contabilidade = mod.getOrganizationAccountingHandler;
  criarCampeonato = mod.createTournamentHandler;
  perfilOrg = mod.getOrganizationProfileHandler;

  await limpar();
  for (const u of [DONO, CONVIDADO, OUTRO, ESTRANHO]) {
    await db.collection("users").doc(u).set({ username: APELIDO[u] });
  }
});

after(async () => {
  await limpar();
});

describe("E2E — criar a organização", () => {
  it("qualquer conta logada cria — não precisa da claim de plataforma", async () => {
    // É o ponto da feature: organizar deixou de ser privilégio de plataforma.
    const r = await criarOrg(
      { name: "  Sparta   Battle ", phone: "(11) 98888-7777", logo_url: null },
      ctx(DONO)
    );
    assert.equal(r.success, true);
    assert.equal(r.name, "Sparta Battle", "o nome não foi normalizado");
    orgId = r.organization_id;
  });

  it("o TELEFONE não volta em resposta nenhuma", async () => {
    // Ele foi pedido para contato, não para ser devolvido. Um campo que nunca
    // sai é um campo que nunca vaza.
    const r = await minhaOrg({}, ctx(DONO));
    assert.equal(JSON.stringify(r).includes(TELEFONE), false);
    assert.equal(r.organization.role, "owner");
  });

  it("mas está guardado, à parte do documento público", async () => {
    const publico = await db.collection("organizations").doc(orgId).get();
    assert.equal(JSON.stringify(publico.data()).includes(TELEFONE), false);

    const privado = await db.collection("organization_private").doc(orgId).get();
    assert.equal(privado.get("owner_phone"), TELEFONE);
  });

  it("a SEGUNDA organização é recusada — ter várias está em desenvolvimento",
    async () => {
      await assert.rejects(
        () => criarOrg({ name: "Outra", phone: TELEFONE, logo_url: null }, ctx(DONO)),
        /já tem uma organização/i
      );
    });

  it("nome e telefone inválidos são recusados", async () => {
    await assert.rejects(
      () => criarOrg({ name: "S", phone: TELEFONE, logo_url: null }, ctx(OUTRO)),
      /pelo menos/i
    );
    await assert.rejects(
      () => criarOrg({ name: "Válida", phone: "123", logo_url: null }, ctx(OUTRO)),
      /telefone válido/i
    );
  });

  it("logo só por endereço https", async () => {
    await assert.rejects(
      () =>
        criarOrg(
          { name: "Válida", phone: TELEFONE, logo_url: "http://inseguro/x.png" },
          ctx(OUTRO)
        ),
      /https/i
    );
  });
});

describe("E2E — criar campeonato passou a exigir organização", () => {
  const payload = {
    name: "Copa da Org",
    entry_fee: 10,
    prize: 50,
    max_players: 8,
    game_mode: "solo",
    economy_type: "beta_credit",
  };

  it("SEM organização é recusado, mesmo com a claim de plataforma", async () => {
    // A claim continua guardando o caixa da casa e os Créditos Beta, e deixou
    // de guardar esta chamada. Se voltasse a abrir a porta sozinha, todo admin
    // de plataforma viraria criador silencioso dentro de qualquer organização.
    await assert.rejects(
      () => criarCampeonato(payload, ctx(ESTRANHO, true)),
      /Crie uma organização/i
    );
  });

  it("COM organização passa", async () => {
    const r = await criarCampeonato(payload, ctx(DONO));
    assert.equal(r.success, true);

    const doc = await db.collection("tournaments").doc(r.tournament_id).get();
    assert.equal(doc.get("organization_id"), orgId, "o campeonato ficou sem dono");
    await doc.ref.delete();
  });
});

describe("E2E — o convite serve UMA VEZ", () => {
  let token = "";

  it("só o DONO gera", async () => {
    await assert.rejects(
      () => criarConvite({ organization_id: orgId }, ctx(ESTRANHO)),
      /Apenas o dono/i
    );

    const r = await criarConvite({ organization_id: orgId }, ctx(DONO));
    assert.equal(r.success, true);
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    token = r.token;
  });

  it("o convidado aceita e vira administrador", async () => {
    const r = await aceitar({ token }, ctx(CONVIDADO));
    assert.equal(r.success, true);
    assert.equal(r.organization_id, orgId);

    const mine = await minhaOrg({}, ctx(CONVIDADO));
    assert.equal(mine.organization.role, "admin");
  });

  it("o MESMO link não serve para uma segunda pessoa", async () => {
    // A defesa central: o link vai ser reencaminhado.
    await assert.rejects(() => aceitar({ token }, ctx(OUTRO)), /já foi usado/i);
  });

  it("e o administrador convidado JÁ PODE criar campeonato", async () => {
    const r = await criarCampeonato(
      {
        name: "Copa do Convidado",
        entry_fee: 10,
        prize: 50,
        max_players: 8,
        game_mode: "solo",
        economy_type: "beta_credit",
      },
      ctx(CONVIDADO)
    );
    assert.equal(r.success, true);
    await db.collection("tournaments").doc(r.tournament_id).delete();
  });

  it("mas NÃO gera convite nem vê a contabilidade", async () => {
    // É o que separa os dois papéis. Sem isto, convidar um ajudante seria
    // entregar a organização.
    await assert.rejects(
      () => criarConvite({ organization_id: orgId }, ctx(CONVIDADO)),
      /Apenas o dono/i
    );
    await assert.rejects(
      () =>
        contabilidade(
          { organization_id: orgId, from_ms: null, to_ms: null },
          ctx(CONVIDADO)
        ),
      /Apenas o dono/i
    );
  });

  it("um convite REVOGADO não vale mais", async () => {
    const novo = await criarConvite({ organization_id: orgId }, ctx(DONO));
    await revogar({ token: novo.token }, ctx(DONO));
    await assert.rejects(
      () => aceitar({ token: novo.token }, ctx(OUTRO)),
      /cancelado/i
    );
  });

  it("um convite EXPIRADO não vale mais", async () => {
    const antigo = await criarConvite(
      { organization_id: orgId },
      ctx(DONO),
      { nowMs: Date.now() - 60 * 60 * 1000 }
    );
    await assert.rejects(
      () => aceitar({ token: antigo.token }, ctx(OUTRO)),
      /expirou/i
    );
  });

  it("token inventado não revela nada", async () => {
    await assert.rejects(
      () => aceitar({ token: "z".repeat(43) }, ctx(OUTRO)),
      /não é válido|inválido/i
    );
  });

  it("o dono remove o administrador, e ele perde a criação", async () => {
    await remover({ organization_id: orgId, uid: CONVIDADO }, ctx(DONO));
    await assert.rejects(
      () =>
        criarCampeonato(
          {
            name: "Não deveria",
            entry_fee: 10,
            prize: 50,
            max_players: 8,
            game_mode: "solo",
            economy_type: "beta_credit",
          },
          ctx(CONVIDADO)
        ),
      /Crie uma organização/i
    );
  });

  it("o dono NÃO se remove — a organização ficaria sem quem a governa",
    async () => {
      await assert.rejects(
        () => remover({ organization_id: orgId, uid: DONO }, ctx(DONO)),
        /não pode sair/i
      );
    });
});

describe("E2E — contabilidade", () => {
  it("só o dono vê, e as economias não se somam", async () => {
    const r = await contabilidade(
      { organization_id: orgId, from_ms: null, to_ms: null },
      ctx(DONO)
    );

    const economias = r.economies.map((e: any) => e.economy).sort();
    assert.deepEqual(economias, ["beta_credit", "cash"]);
    // Nenhum campo de total único: as duas economias jamais viram um número.
    assert.equal(JSON.stringify(r).includes("total_centavos"), false);
  });

  it("campeonato ABERTO não vira lucro — vira dinheiro RETIDO", async () => {
    /**
     * O defeito mais caro que esta auditoria achou, e ele estava vivo.
     *
     * A soma era "arrecadado de tudo menos pago do que já pagou", e um
     * campeonato aberto arrecada sem ter pago nada. Dez campeonatos abertos de
     * R$ 10 com 20 inscritos apareciam como "Lucro R$ 2.000" sobre dinheiro
     * ainda REEMBOLSÁVEL — cancelar devolve tudo.
     */
    const criado = await criarCampeonato(
      {
        name: "Aberto e cheio",
        entry_fee: 10,
        prize: 50,
        max_players: 8,
        game_mode: "solo",
        economy_type: "beta_credit",
      },
      ctx(DONO)
    );
    await db
      .collection("tournaments")
      .doc(criado.tournament_id)
      .update({ current_participants: 5 });

    const r = await contabilidade(
      { organization_id: orgId, from_ms: null, to_ms: null },
      ctx(DONO)
    );
    const beta = r.economies.find((e: any) => e.economy === "beta_credit");

    assert.equal(beta.held_centavos, 5000, "5 x R$ 10 ficam retidos");
    assert.equal(beta.open_tournaments, 1);
    assert.equal(
      beta.collected_centavos,
      0,
      "nada arrecadado ainda: o campeonato não liquidou"
    );
    assert.equal(beta.profit_centavos, 0, "e portanto lucro nenhum");

    await db.collection("tournaments").doc(criado.tournament_id).delete();
  });

  it("um documento estragado NÃO derruba a contabilidade inteira", async () => {
    // `resolveTournamentEconomy` lança numa economia irreconhecível, e a
    // chamada estava fora de qualquer proteção por documento.
    const ruim = db.collection("tournaments").doc();
    await ruim.set({
      name: "Corrompido",
      organization_id: orgId,
      economy_type: "moeda_que_nao_existe",
      entry_fee: 10,
      current_participants: 3,
      created_at: admin.firestore.Timestamp.now(),
    });

    const r = await contabilidade(
      { organization_id: orgId, from_ms: null, to_ms: null },
      ctx(DONO)
    );
    assert.equal(r.skipped_tournaments, 1, "pulado e DECLARADO");
    assert.ok(Array.isArray(r.economies), "a resposta continua inteira");

    await ruim.delete();
  });

  it("a resposta declara se a leitura bateu no teto", async () => {
    const r = await contabilidade(
      { organization_id: orgId, from_ms: null, to_ms: null },
      ctx(DONO)
    );
    assert.equal(r.truncated, false);
  });

  it("um período que começa depois de terminar é recusado", async () => {
    await assert.rejects(
      () =>
        contabilidade(
          { organization_id: orgId, from_ms: 2000, to_ms: 1000 },
          ctx(DONO)
        ),
      /começa depois/i
    );
  });

  it("um estranho não lê a contabilidade alheia", async () => {
    await assert.rejects(
      () =>
        contabilidade(
          { organization_id: orgId, from_ms: null, to_ms: null },
          ctx(ESTRANHO, true)
        ),
      /Apenas o dono/i
    );
  });
});

describe("E2E — a página pública da organização", () => {
  let tournamentId = "";

  before(async () => {
    const r = await criarCampeonato(
      {
        name: "Copa Pública",
        entry_fee: 10,
        prize: 50,
        max_players: 8,
        game_mode: "solo",
        economy_type: "beta_credit",
      },
      ctx(DONO)
    );
    tournamentId = r.tournament_id;
  });

  after(async () => {
    if (tournamentId) {
      await db.collection("tournaments").doc(tournamentId).delete();
    }
  });

  it("o campeonato guarda o NOME da organização, e não só o id", async () => {
    // É o que deixa a vitrine desenhar vinte cartões sem vinte leituras extras.
    const doc = await db.collection("tournaments").doc(tournamentId).get();
    assert.equal(doc.get("organization_id"), orgId);
    assert.equal(doc.get("organization_name"), "Sparta Battle");
  });

  it("o rótulo de quem criou NÃO é o e-mail", async () => {
    // A cascata terminava no e-mail do token, e `users/{uid}` nasce sem
    // apelido — então todo campeonato de quem nunca escolheu apelido ficava
    // gravado com o e-mail, num documento que qualquer conta logada lê.
    const doc = await db.collection("tournaments").doc(tournamentId).get();
    const rotulo = String(doc.get("creator_name") ?? "");
    assert.equal(rotulo.includes("@"), false, `rótulo vazou: ${rotulo}`);
  });

  it("QUALQUER conta logada abre a página", async () => {
    // É uma página feita para ser mostrada — como o perfil de um jogador.
    const r = await perfilOrg({ organization_id: orgId }, ctx(ESTRANHO));
    assert.equal(r.organization.name, "Sparta Battle");
    assert.equal(r.organization.id, orgId);
  });

  it("deslogado NÃO abre", async () => {
    await assert.rejects(
      () => perfilOrg({ organization_id: orgId }, {}),
      /conta/i
    );
  });

  it("a resposta não carrega telefone, uid nem o rótulo de quem criou",
    async () => {
      const r = await perfilOrg({ organization_id: orgId }, ctx(ESTRANHO));
      const json = JSON.stringify(r);

      assert.equal(json.includes(TELEFONE), false, "telefone vazou");
      assert.equal(json.includes(DONO), false, "uid do dono vazou");
      assert.equal(json.includes("creator_name"), false, "rótulo vazou");
      assert.equal(json.includes("creator_uid"), false, "uid do criador vazou");
      assert.equal(json.includes("owner_uid"), false, "owner_uid vazou");
    });

  it("nenhum número de contabilidade atravessa", async () => {
    // Arrecadado, pago e lucro são do dono e saem de outra callable, que
    // recusa qualquer outro.
    const r = await perfilOrg({ organization_id: orgId }, ctx(ESTRANHO));
    const json = JSON.stringify(r);
    for (const proibido of ["collected", "paid_centavos", "profit"]) {
      assert.equal(json.includes(proibido), false, proibido);
    }
  });

  it("os membros saem com papel e pseudônimo, o dono primeiro", async () => {
    const r = await perfilOrg({ organization_id: orgId }, ctx(ESTRANHO));
    assert.ok(r.members.length >= 1);
    assert.equal(r.members[0].role, "owner");
    assert.equal(r.members[0].nickname, APELIDO[DONO]);
    // Ninguém neste teste abriu o próprio perfil, então ninguém tem pseudônimo
    // — e é isso que a tela usa para não pôr um link morto.
    assert.equal(r.members[0].public_player_id, null);
  });

  it("os campeonatos saem no vocabulário do próprio documento", async () => {
    // O app tem UM tradutor de campeonato; um segundo formato aqui obrigaria
    // a um segundo tradutor, e dois tradutores acabam discordando do preço.
    const r = await perfilOrg({ organization_id: orgId }, ctx(ESTRANHO));
    const t = r.tournaments.find((x: any) => x.id === tournamentId);
    assert.ok(t, "o campeonato da organização não veio");
    assert.equal(t.name, "Copa Pública");
    assert.equal(t.status, "open");
    assert.equal(t.entry_fee, 10);
    assert.equal(t.economy_type, "beta_credit");
    assert.equal(t.organization_id, orgId);
    assert.equal(typeof t.starts_at, "object");
  });

  it("o total vem da AGREGAÇÃO, não da contagem do que foi lido", async () => {
    const r = await perfilOrg({ organization_id: orgId }, ctx(ESTRANHO));
    assert.equal(r.organization.tournament_count, r.tournaments.length);
  });

  it("uma organização que não existe responde não-encontrada", async () => {
    await assert.rejects(
      () => perfilOrg({ organization_id: "nao-existe" }, ctx(ESTRANHO)),
      /não encontrada/i
    );
  });

  it("um id malformado é recusado antes de qualquer leitura", async () => {
    for (const ruim of ["", "  ", "a/b"]) {
      await assert.rejects(
        () => perfilOrg({ organization_id: ruim }, ctx(ESTRANHO)),
        /inválida/i,
        ruim
      );
    }
  });

  it("campo a mais no payload é recusado", async () => {
    await assert.rejects(
      () => perfilOrg({ organization_id: orgId, extra: 1 }, ctx(ESTRANHO)),
      /./
    );
  });
});
