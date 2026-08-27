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
 * Matriz de regras da CAIXA DE AVISOS e dos TOKENS DE APARELHO.
 *
 * As duas coleções têm posturas OPOSTAS de propósito, e é isso que este
 * arquivo trava:
 *
 *  - a caixa é LIDA direto pelo dono. É a única forma de o aviso aparecer no
 *    instante em que é escrito, sem o app ficar perguntando. Pode ser lida
 *    porque nada nela é sigiloso: o aviso diz que a sala abriu e NUNCA carrega
 *    o ID nem a senha, que continuam saindo só do `getTournamentRoom`, depois
 *    de conferir a inscrição;
 *  - os tokens são fechados dos DOIS lados, para todo cliente. Ler um token é
 *    ler que aparelho pertence a que conta, e nem o admin precisa disso.
 *
 * E escrever é server-only nas duas, inclusive para o próprio dono: `read_at`
 * é marcado por `markNotificationsRead`. Sem isso, qualquer conta fabricaria
 * um aviso na própria caixa.
 *
 * NUNCA toca produção: projeto `demo-*`, só emulador local.
 */

const PROJECT_ID = "demo-sparta-battle-notif-rules";

const OWNER = "notif-owner";
const OTHER = "notif-other";
const ADMIN = "notif-admin";

const ITEM = "room_open_t-1";
const OWNER_ITEM = `notifications/${OWNER}/items/${ITEM}`;
const OTHER_ITEM = `notifications/${OTHER}/items/${ITEM}`;
const TOKEN_DOC = "device_tokens/fMEP0vJqS0:APA91bH-abc";

let testEnv: RulesTestEnvironment;

/** O aviso como o backend o escreve — sem credencial nenhuma. */
function aviso(): Record<string, unknown> {
  return {
    kind: "room_open",
    title: "Copa Sparta",
    body: "A sala está aberta. Toque para ver o ID e a senha.",
    tournament_id: "t-1",
    created_at: new Date("2026-08-26T20:00:00Z"),
    read_at: null,
  };
}

/** Todo formato de cliente que precisa ser negado, com nome para a falha. */
function todoCliente(): ReadonlyArray<readonly [string, any]> {
  return [
    ["deslogado", testEnv.unauthenticatedContext().firestore()],
    ["dono", testEnv.authenticatedContext(OWNER).firestore()],
    ["terceiro", testEnv.authenticatedContext(OTHER).firestore()],
    ["admin", testEnv.authenticatedContext(ADMIN, { admin: true }).firestore()],
  ];
}

/**
 * `assertFails` com o nome do cliente na mensagem.
 *
 * Sem isto, uma regra frouxa falha dizendo só que a operação foi permitida —
 * e num laço de quatro clientes ninguém sabe QUAL deles passou.
 */
async function negado(rotulo: string, operacao: Promise<unknown>): Promise<void> {
  try {
    await assertFails(operacao);
  } catch (erro) {
    throw new Error(`${rotulo}: ${(erro as Error).message}`);
  }
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(
        resolve(process.cwd(), "..", "firestore.rules"),
        "utf8"
      ),
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
    // Duas caixas com conteúdo, para que "ler a do outro" seja uma pergunta de
    // verdade e não um documento ausente.
    await db.doc(OWNER_ITEM).set(aviso());
    await db.doc(OTHER_ITEM).set(aviso());
    await db.doc(TOKEN_DOC).set({
      uid: OWNER,
      platform: "android",
      updated_at: new Date("2026-08-26T20:00:00Z"),
    });
  });
});

describe("caixa de avisos — leitura", () => {
  it("o DONO lê a própria caixa", async () => {
    // É o ponto da coleção: sem esta leitura o app teria de perguntar de tempos
    // em tempos, e o aviso de sala aberta chegaria atrasado por construção.
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertSucceeds(db.doc(OWNER_ITEM).get());
  });

  it("um TERCEIRO não lê a caixa alheia", async () => {
    const db = testEnv.authenticatedContext(OTHER).firestore();
    await assertFails(db.doc(OWNER_ITEM).get());
  });

  it("DESLOGADO não lê caixa nenhuma", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.doc(OWNER_ITEM).get());
  });

  it("nem o ADMIN lê a caixa de outra pessoa", async () => {
    // A claim de admin serve para operar a plataforma, não para ler a
    // correspondência de quem joga nela.
    const db = testEnv.authenticatedContext(ADMIN, { admin: true }).firestore();
    await assertFails(db.doc(OWNER_ITEM).get());
  });

  it("listar a própria caixa funciona", async () => {
    // O app assina a coleção inteira, não um documento por vez.
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertSucceeds(db.collection(`notifications/${OWNER}/items`).get());
  });

  it("listar a caixa alheia não funciona", async () => {
    const db = testEnv.authenticatedContext(OTHER).firestore();
    await assertFails(db.collection(`notifications/${OWNER}/items`).get());
  });
});

describe("caixa de avisos — escrita", () => {
  it("nem o DONO escreve na própria caixa", async () => {
    // Poder escrever aqui seria poder fabricar um aviso para si mesmo. Não
    // serve a nada e é superfície de sobra.
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(
      db.doc(`notifications/${OWNER}/items/forjado`).set(aviso())
    );
  });

  it("o dono não marca como lido por conta própria", async () => {
    // `read_at` é do `markNotificationsRead`, que roda pelo Admin SDK.
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(db.doc(OWNER_ITEM).update({ read_at: new Date() }));
  });

  it("o dono não apaga o próprio aviso", async () => {
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(db.doc(OWNER_ITEM).delete());
  });

  it("ninguém escreve na caixa de outra pessoa", async () => {
    for (const [rotulo, db] of todoCliente()) {
      if (rotulo === "dono") continue;
      await negado(rotulo, db.doc(OWNER_ITEM).set(aviso()));
      await negado(rotulo, db.doc(OWNER_ITEM).delete());
    }
  });
});

describe("tokens de aparelho — fechados dos dois lados", () => {
  it("nenhum cliente LÊ um token, nem o dono", async () => {
    // Ler é descobrir que aparelho é de que conta. O dono não ganha nada com
    // isso e um vazamento aqui mapeia a base inteira de usuários a aparelhos.
    for (const [rotulo, db] of todoCliente()) {
      await negado(rotulo, db.doc(TOKEN_DOC).get());
    }
  });

  it("nenhum cliente ESCREVE um token", async () => {
    // Escrever seria apontar o aparelho de outra pessoa para a própria conta,
    // ou apagar o token de alguém e silenciar os avisos dela. As duas coisas
    // passam por callable, que tira o uid do token verificado.
    for (const [rotulo, db] of todoCliente()) {
      await negado(rotulo, db.doc(TOKEN_DOC).set({ uid: OTHER }));
      await negado(rotulo, db.doc(TOKEN_DOC).delete());
      await negado(rotulo, db.doc("device_tokens/novo").set({ uid: OTHER }));
    }
  });

  it("listar a coleção de tokens é negado", async () => {
    const db = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(db.collection("device_tokens").get());
  });
});

describe("o backend continua conseguindo escrever", () => {
  it("o contexto SEM Rules escreve caixa e token", async () => {
    // Prova que a negação total não trava o produto: o Admin SDK ignora Rules,
    // e é assim que o aviso realmente chega em produção.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.doc(`notifications/${OWNER}/items/room_open_t-2`).set(aviso());
      await db.doc("device_tokens/outro").set({ uid: OWNER });
    });
  });
});
