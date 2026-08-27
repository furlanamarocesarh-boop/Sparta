import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Authorization tests for `createTournamentHandler` (shared by the
 * `createTournament` and `createtournament` callables).
 *
 * These are BEHAVIORAL: they invoke the real handler with a forged callable
 * context and assert the HttpsError CODE it produces.
 *
 * O CONTRATO MUDOU COM AS ORGANIZAÇÕES, e este arquivo mudou junto. Criar
 * campeonato exigia a claim `admin: true`, que pertence a UMA conta e é
 * concedida por uma ferramenta local — não havia como um segundo organizador
 * existir. Agora quem autoriza é a ASSOCIAÇÃO a uma organização.
 *
 * A consequência para ESTES testes é que a autorização deixou de ser
 * respondível sem banco: saber se alguém é membro é uma leitura. Então aqui
 * fica só o que continua sendo decidido antes de qualquer leitura — a ausência
 * de sessão — e a recusa de quem não tem organização é provada no e2e, contra
 * o emulador, onde ela pode ser provada de verdade.
 */

type Handler = (data: unknown, context: unknown) => Promise<unknown>;

let cached: Handler | undefined;

async function handler(): Promise<Handler> {
  if (cached) return cached;
  // Mirror functionRegions.test.ts: set the project so firebase-functions v1
  // initialization does not complain about a missing environment.
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? "demo-sparta-battle";
  const mod = await import("../../src/index.js");
  cached = (mod as unknown as { createTournamentHandler: Handler })
    .createTournamentHandler;
  return cached;
}

/** Invokes the handler and returns the thrown error code (or a sentinel). */
async function codeOf(data: unknown, context: unknown): Promise<string> {
  const fn = await handler();
  try {
    await fn(data, context);
    // A success here means an unauthorized/invalid call was accepted.
    return "ACEITO-INESPERADO";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "SEM-CODIGO";
  }
}

// A payload that WOULD create a tournament if it reached the write. Used to prove
// that a non-admin is stopped at authorization, before any read or write, even
// with input the handler would otherwise accept.
const VALID_PAYLOAD = {
  name: "Copa Teste",
  entry_fee: 0,
  prize: 0,
  max_players: 8,
  game_mode: "solo",
  // Required since feat/beta-economy-type: every new tournament names its
  // economy explicitly.
  economy_type: "cash",
};

describe("createTournamentHandler — unauthenticated", () => {
  it("rejects a call with no auth as unauthenticated", async () => {
    assert.equal(await codeOf({}, {}), "unauthenticated");
    assert.equal(await codeOf({}, { auth: null }), "unauthenticated");
    // Even a valid payload cannot get in without authentication.
    assert.equal(await codeOf(VALID_PAYLOAD, {}), "unauthenticated");
  });
});

describe("createTournamentHandler — sem sessão, antes de qualquer leitura", () => {
  it("payload VÁLIDO sem sessão continua sendo unauthenticated", async () => {
    // A única recusa que ainda acontece sem tocar no banco, e continua vindo
    // antes de qualquer validação. As outras — não tem organização, não é
    // membro dela — dependem de uma leitura e são provadas no e2e.
    assert.equal(await codeOf(VALID_PAYLOAD, { auth: null }), "unauthenticated");
  });
});

// Complementary structural defense — not a substitute for the behavioral tests.
describe("createTournamentHandler — structural guarantees", () => {
  function functionsDir(): string {
    const cwd = process.cwd();
    if (existsSync(join(cwd, "src", "index.ts"))) return cwd;
    if (existsSync(join(cwd, "functions", "src", "index.ts"))) {
      return join(cwd, "functions");
    }
    throw new Error(`cannot locate functions dir from cwd: ${cwd}`);
  }
  const indexSrc = (): string =>
    readFileSync(join(functionsDir(), "src", "index.ts"), "utf8");

  it("a criação exige ORGANIZAÇÃO, não a claim de plataforma", () => {
    // A troca de porteiro é o coração da feature: a claim continua guardando o
    // caixa da casa e os Créditos Beta, e deixou de guardar esta chamada.
    const src = indexSrc();
    const handler = src.slice(src.indexOf("createTournamentHandler"));
    const corpo = handler.slice(0, handler.indexOf("export const createTournament "));
    assert.match(corpo, /assertOrgMember\(/);
    assert.match(corpo, /Crie uma organização/);
  });

  it("both callables wrap the same guarded handler", () => {
    const src = indexSrc();
    assert.match(
      src,
      /export const createTournament = central\.https\.onCall\(createTournamentHandler\)/
    );
    assert.match(
      src,
      /export const createtournament = central\.https\.onCall\(createTournamentHandler\)/
    );
  });

  it("a sessão é exigida ANTES de qualquer leitura", () => {
    // A garantia mudou de nome, não de força. Antes era "a claim vem antes do
    // banco"; agora a claim não é mais a pergunta certa, e o que não pode
    // acontecer é uma leitura em nome de quem não provou quem é.
    const src = indexSrc();
    const start = src.indexOf("createTournamentHandler = async");
    assert.ok(start !== -1, "handler não encontrado");
    const end = src.indexOf("export const createTournament =", start);
    const body = src.slice(start, end === -1 ? undefined : end);

    const idxAuth = body.indexOf("assertSignedIn(");
    const firstDb = ["db.collection", "db.doc", "db.runTransaction"]
      .map((token) => body.indexOf(token))
      .filter((i) => i !== -1)
      .reduce((min, i) => Math.min(min, i), Number.POSITIVE_INFINITY);

    assert.ok(idxAuth !== -1, "o handler não exige sessão");
    assert.ok(idxAuth < firstDb, "leu o banco antes de saber quem chamou");
  });

  it("a associação é conferida ANTES de qualquer escrita", () => {
    // Ler para descobrir se a pessoa é membro é inevitável — decidir isso é
    // uma leitura. O que não pode é ESCREVER antes de a resposta chegar.
    const src = indexSrc();
    const start = src.indexOf("createTournamentHandler = async");
    const end = src.indexOf("export const createTournament =", start);
    const body = src.slice(start, end === -1 ? undefined : end);

    const idxMember = body.indexOf("assertOrgMember(");
    const firstWrite = [".set(", ".create(", ".update(", "batch.commit("]
      .map((token) => body.indexOf(token))
      .filter((i) => i !== -1)
      .reduce((min, i) => Math.min(min, i), Number.POSITIVE_INFINITY);

    assert.ok(idxMember !== -1, "o handler não confere a associação");
    assert.ok(idxMember < firstWrite, "escreveu antes de autorizar");
  });

  it("a claim de plataforma NÃO guarda mais esta chamada", () => {
    // Ela continua guardando o caixa da casa e os Créditos Beta. Se voltar a
    // aparecer aqui, um administrador convidado deixa de conseguir criar
    // campeonato — que é justamente o ponto da feature.
    const src = indexSrc();
    const start = src.indexOf("createTournamentHandler = async");
    const end = src.indexOf("export const createTournament =", start);
    const body = src.slice(start, end === -1 ? undefined : end);
    assert.equal(body.includes("assertAdmin("), false);
  });
});
