import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEMO_PROJECT_REFUSED_MESSAGE } from "../../src/domain/demoProject.js";

/**
 * `testdeposit` mints WITHDRAWABLE cash and is an authorized production deploy
 * target, so it carries two independent gates: WHO (the `admin: true` claim) and
 * WHERE (the effective project must be a `demo-` project).
 *
 * These are BEHAVIORAL tests of the real handler, in the same style as
 * createTournamentAuth.test.ts: every case here is a REFUSAL, and every refusal
 * throws before the handler touches Firestore — which is exactly why no emulator
 * and no credentials are needed. A case that reached Firestore would fail with a
 * connection error instead of the code asserted below, so "no write happened" is
 * not merely asserted here, it is what makes the test runnable at all.
 *
 * The authorized path (admin + demo project, which really does write) lives in
 * functions/test/rules/testdeposit.handlers.test.ts, under the emulator.
 */

type Handler = (
  data: unknown,
  context: unknown,
  options?: { projectCandidates?: readonly unknown[] }
) => Promise<unknown>;

const REAL = "sparta-battle";
const DEMO = "demo-sparta-battle";

const ADMIN_CTX = { auth: { uid: "admin-1", token: { admin: true } } };
const VALID_PAYLOAD = { amount: 100 };

let cached: Handler | undefined;

async function handler(): Promise<Handler> {
  if (cached) return cached;
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? DEMO;
  const mod = await import("../../src/index.js");
  cached = (mod as unknown as { testdepositHandler: Handler }).testdepositHandler;
  return cached;
}

async function failureOf(
  data: unknown,
  context: unknown,
  options?: { projectCandidates?: readonly unknown[] }
): Promise<{ code: string; message: string }> {
  const fn = await handler();
  try {
    await fn(data, context, options);
    return { code: "ACEITO-INESPERADO", message: "" };
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return {
      code: typeof code === "string" ? code : "SEM-CODIGO",
      message: typeof message === "string" ? message : "",
    };
  }
}

describe("testdeposit — WHO continua valendo", () => {
  it("recusa chamada sem autenticação", async () => {
    // Projeto real nos candidatos: ainda assim o erro é de autenticação, porque
    // a identidade é verificada primeiro.
    for (const context of [{}, { auth: null }]) {
      const failure = await failureOf(VALID_PAYLOAD, context, {
        projectCandidates: [REAL],
      });
      assert.equal(failure.code, "unauthenticated");
    }
  });

  it("recusa usuário autenticado sem a claim admin", async () => {
    for (const token of [undefined, {}, { admin: false }, { admin: "true" }, { admin: 1 }]) {
      const failure = await failureOf(
        VALID_PAYLOAD,
        { auth: { uid: "player-1", token } },
        { projectCandidates: [DEMO] }
      );
      assert.equal(failure.code, "permission-denied", JSON.stringify(token));
    }
  });
});

describe("testdeposit — WHERE: o projeto real é recusado", () => {
  it("admin no projeto real é recusado, com mensagem curada", async () => {
    const failure = await failureOf(VALID_PAYLOAD, ADMIN_CTX, {
      projectCandidates: [REAL],
    });

    assert.equal(failure.code, "failed-precondition");
    assert.equal(failure.message, DEMO_PROJECT_REFUSED_MESSAGE);
    assert.ok(!failure.message.includes(REAL), "não pode citar o projeto");
  });

  it("admin sem projectId algum é recusado", async () => {
    for (const candidates of [[], [undefined], [null], [""]]) {
      const failure = await failureOf(VALID_PAYLOAD, ADMIN_CTX, {
        projectCandidates: candidates,
      });
      assert.equal(failure.code, "failed-precondition", JSON.stringify(candidates));
      assert.equal(failure.message, DEMO_PROJECT_REFUSED_MESSAGE);
    }
  });

  it("admin com projectId ambíguo é recusado", async () => {
    const failure = await failureOf(VALID_PAYLOAD, ADMIN_CTX, {
      projectCandidates: [DEMO, REAL],
    });
    assert.equal(failure.code, "failed-precondition");
  });

  it("o portão roda ANTES da validação de valor", async () => {
    // Valor inválido E projeto real: se a validação financeira viesse primeiro,
    // o código seria invalid-argument. O ambiente é decidido antes.
    for (const amount of [0, -5, "100", null, undefined, 10.005]) {
      const failure = await failureOf({ amount }, ADMIN_CTX, {
        projectCandidates: [REAL],
      });
      assert.equal(failure.code, "failed-precondition", String(amount));
    }
  });
});

describe("testdeposit — o payload NUNCA escolhe o projeto", () => {
  it("nenhuma chave do payload consegue afirmar um projeto demo", async () => {
    // O cliente tenta, por todos os nomes plausíveis, se declarar em demo
    // enquanto o servidor está no projeto real. Todas devem ser recusadas.
    const forged = {
      amount: 100,
      projectId: DEMO,
      project_id: DEMO,
      project: DEMO,
      gcloud_project: DEMO,
      GCLOUD_PROJECT: DEMO,
      projectCandidates: [DEMO],
      options: { projectCandidates: [DEMO] },
    };

    const failure = await failureOf(forged, ADMIN_CTX, {
      projectCandidates: [REAL],
    });

    assert.equal(failure.code, "failed-precondition");
    assert.equal(failure.message, DEMO_PROJECT_REFUSED_MESSAGE);
  });

  it("o payload também não consegue suprir um projeto ausente", async () => {
    const failure = await failureOf(
      { amount: 100, projectId: DEMO, project: DEMO },
      ADMIN_CTX,
      { projectCandidates: [] }
    );
    assert.equal(failure.code, "failed-precondition");
  });
});

// ---------------------------------------------------------------------------
// Garantias estruturais
// ---------------------------------------------------------------------------

function srcIndex(): string {
  const cwd = process.cwd();
  for (const candidate of [
    join(cwd, "src", "index.ts"),
    join(cwd, "functions", "src", "index.ts"),
    join(cwd, "..", "src", "index.ts"),
  ]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`cannot locate src/index.ts from cwd: ${cwd}`);
}

describe("testdeposit — garantias estruturais", () => {
  const source = srcIndex();
  const start = source.indexOf("export const testdepositHandler");
  const end = source.indexOf("export const requestwithdrawal", start);
  const block = source.slice(start, end);

  it("o handler existe e o callable apenas o embrulha", () => {
    assert.ok(start >= 0, "testdepositHandler deve ser exportado");
    assert.ok(
      /export const testdeposit = central\.https\.onCall\(/.test(block),
      "o callable implantável deve continuar existindo com o mesmo nome"
    );
  });

  it("o portão de ambiente precede QUALQUER acesso ao Firestore", () => {
    const gate = block.indexOf("assertDemoProject(");
    assert.ok(gate > 0, "assertDemoProject deve ser chamado no bloco");

    for (const access of ["db.collection(", "db.runTransaction("]) {
      const first = block.indexOf(access);
      if (first < 0) continue;
      assert.ok(
        gate < first,
        `assertDemoProject deve vir antes de ${access}`
      );
    }
  });

  it("a identidade é verificada antes do ambiente", () => {
    assert.ok(
      block.indexOf("assertAdmin(") < block.indexOf("assertDemoProject("),
      "assertAdmin deve preceder assertDemoProject"
    );
  });

  it("os candidatos não vêm do payload", () => {
    // A única origem permitida é a função de runtime ou o seam de teste.
    assert.ok(
      /options\.projectCandidates \?\? effectiveProjectCandidates\(\)/.test(block),
      "os candidatos devem vir do runtime ou do seam, nunca de `data`"
    );
    const gateCall = /assertDemoProject\(([^;]*)\);/.exec(block);
    assert.ok(gateCall, "chamada do portão não encontrada");
    assert.ok(
      !/\bdata\b/.test(gateCall![1]),
      `o argumento do portão não pode derivar de data: ${gateCall![1]}`
    );
  });

  it("continua creditando apenas o próprio caller", () => {
    assert.ok(
      /const uid = callerAuth\.uid;/.test(block),
      "o uid creditado deve continuar vindo do token do caller"
    );
    assert.ok(
      !/data\.uid|data\.userid|data\.user_id/i.test(block),
      "o payload não pode escolher a carteira creditada"
    );
  });
});
