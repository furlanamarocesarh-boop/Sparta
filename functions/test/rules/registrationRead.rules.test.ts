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
 * REGISTRATION READ AUTHORIZATION — regression + security matrix.
 *
 * THE BUG THIS LOCKS (production incident, beta 0.1.0+1):
 * before rendering the join CTA, the app does a DIRECT get of the deterministic
 * document `registrations/{uid}_{tournamentId}`
 * (`FirestorePlayerRegistrationsRepository.isRegistered`). Authorization was
 * `resource.data.user_ref == users/{me}` — but on a MISSING document `resource`
 * is null, so the read was denied with `permission-denied`. The provider went to
 * its error state, the join button was never rendered, and `jointournament` was
 * never invoked. A player who had never registered could therefore never
 * register at all.
 *
 * THE SECURITY INVARIANT the fix must preserve:
 *  - an EXISTING registration is readable ONLY when the canonical stored
 *    `user_ref` identifies the caller. Ownership is NEVER inferred from the
 *    document id, so a malformed document whose id merely starts with the
 *    caller's uid stays private;
 *  - the missing-document exception is narrow: it applies ONLY when the
 *    document does not exist AND the id is exactly the caller's own
 *    deterministic path `{request.auth.uid}_{...}`. It can never return data,
 *    because there is no data to return;
 *  - `list` is unchanged: still owner-filtered only.
 *
 * NEVER touches production: project id `demo-*`, local emulator only.
 */

const PROJECT_ID = "demo-sparta-registration-read";

const OWNER = "owner-uid-aaa";
const OTHER = "other-uid-bbb";

/** Prefix-similar uids: "abc" is a string prefix of "abcdef". */
const SHORT = "abc";
const LONG = "abcdef";

const TOURNAMENT = "t-open";
const MISSING_DOC = `registrations/${OWNER}_${TOURNAMENT}`;
const OWNER_EXISTING = `registrations/${OWNER}_t-joined`;
const OTHER_EXISTING = `registrations/${OTHER}_t-joined`;
/** Id looks like the OWNER's, but the stored user_ref belongs to OTHER. */
const MALFORMED = `registrations/${OWNER}_t-malformed`;
const SHORT_EXISTING = `registrations/${SHORT}_t-joined`;
const LONG_EXISTING = `registrations/${LONG}_t-joined`;

let testEnv: RulesTestEnvironment;

const asUser = (uid: string) => testEnv.authenticatedContext(uid).firestore();
const asAdmin = () =>
  testEnv.authenticatedContext("admin-uid", { admin: true }).firestore();
const asAnon = () => testEnv.unauthenticatedContext().firestore();

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
    for (const uid of [OWNER, OTHER, SHORT, LONG]) {
      await db.doc(`users/${uid}`).set({ email: `${uid}@example.com` });
    }

    const reg = (uid: string) => ({
      user_ref: db.doc(`users/${uid}`),
      tournament_ref: db.doc("tournaments/t-joined"),
      status: "registered",
      entry_fee: 5,
      economy_type: "beta_credit",
    });

    await db.doc(OWNER_EXISTING).set(reg(OWNER));
    await db.doc(OTHER_EXISTING).set(reg(OTHER));
    await db.doc(SHORT_EXISTING).set(reg(SHORT));
    await db.doc(LONG_EXISTING).set(reg(LONG));
    // Corrupt on purpose: the id carries OWNER's prefix, the data does not.
    await db.doc(MALFORMED).set(reg(OTHER));

    // `registrations/${OWNER}_${TOURNAMENT}` is deliberately NOT created.
  });
});

describe("registrations — get de documento INEXISTENTE (a regressão)", () => {
  it("(1) anônimo NÃO lê um caminho determinístico inexistente", async () => {
    await assertFails(asAnon().doc(MISSING_DOC).get());
  });

  it("(2) o DONO lê o próprio caminho determinístico inexistente e recebe exists=false", async () => {
    // Este é exatamente o get que o app 0.1.0+1 faz antes de mostrar o botão.
    const snapshot = await assertSucceeds(asUser(OWNER).doc(MISSING_DOC).get());
    // A permissão não pode virar um vazamento: não há documento algum.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((snapshot as any).exists !== false) {
      throw new Error("o documento não deveria existir");
    }
  });

  it("(3) um jogador NÃO lê o caminho inexistente de OUTRO jogador", async () => {
    await assertFails(asUser(OTHER).doc(MISSING_DOC).get());
    await assertFails(
      asUser(OTHER).doc(`registrations/${OWNER}_qualquer-torneio`).get()
    );
  });

  it("(3b) o id precisa ser o caminho determinístico COMPLETO do chamador", async () => {
    // Sem separador: não é um caminho determinístico.
    await assertFails(asUser(OWNER).doc(`registrations/${OWNER}`).get());
    // Prefixo sem o separador "_" não vale.
    await assertFails(
      asUser(OWNER).doc(`registrations/${OWNER}xt-open`).get()
    );
    // Nada depois do separador: não identifica torneio nenhum.
    await assertFails(asUser(OWNER).doc(`registrations/${OWNER}_`).get());
  });
});

describe("registrations — get de documento EXISTENTE", () => {
  it("(4) o dono lê a própria inscrição existente", async () => {
    await assertSucceeds(asUser(OWNER).doc(OWNER_EXISTING).get());
  });

  it("(5) um jogador NÃO lê a inscrição existente de outro", async () => {
    await assertFails(asUser(OWNER).doc(OTHER_EXISTING).get());
    await assertFails(asUser(OTHER).doc(OWNER_EXISTING).get());
    await assertFails(asAnon().doc(OWNER_EXISTING).get());
  });

  it("(6) documento MALFORMADO com id do dono mas user_ref de outro continua privado", async () => {
    // A posse NUNCA é inferida do id. Como o documento EXISTE, a exceção de
    // inexistência não se aplica e o `user_ref` canônico decide — e ele aponta
    // para OTHER. Então o dono do PREFIXO não alcança o dado.
    await assertFails(asUser(OWNER).doc(MALFORMED).get());

    // Contrapartida do mesmo invariante: quem o `user_ref` identifica CONTINUA
    // sendo o dono, por mais enganoso que o id seja. Negar aqui esconderia de
    // OTHER um dado que é dele. A posse é do `user_ref`, nunca do id.
    await assertSucceeds(asUser(OTHER).doc(MALFORMED).get());
  });

  it("(7) uids com prefixo semelhante não expõem inscrição existente", async () => {
    // "abc" é prefixo de "abcdef", mas "abcdef_t-joined" não começa com "abc_".
    await assertFails(asUser(SHORT).doc(LONG_EXISTING).get());
    await assertFails(asUser(LONG).doc(SHORT_EXISTING).get());
    // E cada um continua lendo o seu.
    await assertSucceeds(asUser(SHORT).doc(SHORT_EXISTING).get());
    await assertSucceeds(asUser(LONG).doc(LONG_EXISTING).get());
  });

  it("(7b) prefixo semelhante também não abre o caminho INEXISTENTE do outro", async () => {
    await assertFails(asUser(SHORT).doc(`registrations/${LONG}_t-novo`).get());
    await assertFails(asUser(LONG).doc(`registrations/${SHORT}_t-novo`).get());
  });

  it("o admin continua lendo qualquer inscrição", async () => {
    await assertSucceeds(asAdmin().doc(OWNER_EXISTING).get());
    await assertSucceeds(asAdmin().doc(OTHER_EXISTING).get());
    await assertSucceeds(asAdmin().doc(MALFORMED).get());
  });
});

describe("registrations — list/query NÃO foi ampliado", () => {
  it("(8) a query filtrada pelo próprio user_ref continua permitida", async () => {
    const db = asUser(OWNER);
    await assertSucceeds(
      db
        .collection("registrations")
        .where("user_ref", "==", db.doc(`users/${OWNER}`))
        .get()
    );
  });

  it("(9) a query filtrada pelo user_ref de OUTRO é negada", async () => {
    const db = asUser(OWNER);
    await assertFails(
      db
        .collection("registrations")
        .where("user_ref", "==", db.doc(`users/${OTHER}`))
        .get()
    );
  });

  it("(10) a listagem SEM filtro continua negada", async () => {
    await assertFails(asUser(OWNER).collection("registrations").get());
    await assertFails(asAnon().collection("registrations").get());
    // Nem mesmo filtrando por um campo que não seja o dono.
    await assertFails(
      asUser(OWNER)
        .collection("registrations")
        .where("status", "==", "registered")
        .get()
    );
  });

  it("(10b) o novo caminho determinístico não vira uma brecha de listagem", async () => {
    // Um id determinístico não autoriza varrer a coleção.
    await assertFails(
      asUser(OWNER)
        .collection("registrations")
        .where("economy_type", "==", "beta_credit")
        .get()
    );
  });
});

describe("registrations — escrita de cliente permanece proibida", () => {
  it("(11) o dono não cria — nem no próprio caminho determinístico inexistente", async () => {
    const db = asUser(OWNER);
    await assertFails(
      db.doc(MISSING_DOC).set({
        user_ref: db.doc(`users/${OWNER}`),
        tournament_ref: db.doc(`tournaments/${TOURNAMENT}`),
        status: "registered",
      })
    );
  });

  it("(12) o dono não atualiza a própria inscrição", async () => {
    await assertFails(
      asUser(OWNER).doc(OWNER_EXISTING).update({ status: "refunded" })
    );
  });

  it("(13) o dono não apaga a própria inscrição", async () => {
    await assertFails(asUser(OWNER).doc(OWNER_EXISTING).delete());
  });

  it("(13b) nem admin nem anônimo escrevem", async () => {
    await assertFails(
      asAdmin().doc(OWNER_EXISTING).update({ status: "refunded" })
    );
    await assertFails(asAdmin().doc(OWNER_EXISTING).delete());
    await assertFails(asAnon().doc(MISSING_DOC).set({ status: "registered" }));
  });
});

describe("registrations — o fix não vaza para outras coleções", () => {
  it("um caminho determinístico não abre wallets nem transactions", async () => {
    const db = asUser(OWNER);
    // Carteira alheia continua fechada.
    await assertFails(db.doc(`wallets/${OTHER}`).get());
    // E um documento INEXISTENTE em transactions continua negado: a exceção
    // vale só para registrations.
    await assertFails(db.doc(`transactions/${OWNER}_inexistente`).get());
    await assertFails(db.doc(`withdrawals/${OWNER}_inexistente`).get());
  });
});
