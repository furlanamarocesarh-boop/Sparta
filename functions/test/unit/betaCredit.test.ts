import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  BETA_ECONOMY_TYPE,
  BETA_GRANT_CATEGORY,
  betaGrantTransactionId,
  checkBetaGrantReplay,
  MAX_REASON_LENGTH,
  normalizeBetaGrantUid,
  normalizeCampaignId,
  normalizeGrantId,
  normalizeReason,
  validateBetaGrantAmount,
} from "../../src/domain/betaCredit.js";
import { DomainError } from "../../src/domain/errors.js";

/**
 * Pure Beta Credit domain rules + STRUCTURAL isolation guards.
 *
 * The structural section is the unit-level proof of the branch's core promise:
 * no cash flow (withdrawal, entry fee, settlement, deposit) reads or writes
 * `beta_balance`, and `debit()` stays completely source-agnostic — Beta
 * Credits can never leak into withdrawable money.
 */

function srcDir(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "src", "index.ts"))) return join(cwd, "src");
  if (existsSync(join(cwd, "functions", "src", "index.ts"))) {
    return join(cwd, "functions", "src");
  }
  throw new Error(`cannot locate functions/src from cwd: ${cwd}`);
}

const INDEX_SOURCE = readFileSync(join(srcDir(), "index.ts"), "utf8");

/** The source slice between two export markers (order-verified). */
function sliceBetween(start: string, end: string): string {
  const from = INDEX_SOURCE.indexOf(start);
  const to = INDEX_SOURCE.indexOf(end);
  assert.ok(from >= 0, `marker not found: ${start}`);
  assert.ok(to > from, `marker not found after ${start}: ${end}`);
  return INDEX_SOURCE.slice(from, to);
}

function expectInvalidArgument(fn: () => unknown, contains?: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected DomainError, got ${error}`);
    assert.equal(error.code, "invalid-argument");
    if (contains) {
      assert.ok(
        error.message.includes(contains),
        `message "${error.message}" should include "${contains}"`
      );
    }
    return;
  }
  assert.fail("expected the validator to throw");
}

describe("betaGrantTransactionId", () => {
  it("é determinístico: beta_grant_{grant_id}", () => {
    assert.equal(betaGrantTransactionId("g-1"), "beta_grant_g-1");
    assert.equal(
      betaGrantTransactionId("welcome_2026"),
      "beta_grant_welcome_2026"
    );
  });
});

describe("identificadores (uid, grant_id, campaign_id)", () => {
  it("normaliza com trim", () => {
    assert.equal(normalizeBetaGrantUid("  u-1  "), "u-1");
    assert.equal(normalizeGrantId("  g-1  "), "g-1");
    assert.equal(normalizeCampaignId("  c-1  "), "c-1");
  });

  it("rejeita ausente/vazio", () => {
    for (const bad of [undefined, null, "", "   "]) {
      expectInvalidArgument(() => normalizeBetaGrantUid(bad), "obrigatório");
      expectInvalidArgument(() => normalizeGrantId(bad), "obrigatório");
      expectInvalidArgument(() => normalizeCampaignId(bad), "obrigatório");
    }
  });

  it("rejeita '/' e comprimento > 200 (não pode escapar do document path)", () => {
    const long = "x".repeat(201);
    for (const bad of ["a/b", long]) {
      expectInvalidArgument(() => normalizeBetaGrantUid(bad), "inválido");
      expectInvalidArgument(() => normalizeGrantId(bad), "inválido");
      expectInvalidArgument(() => normalizeCampaignId(bad), "inválido");
    }
  });
});

describe("normalizeReason", () => {
  it("aceita e normaliza um motivo válido", () => {
    assert.equal(normalizeReason("  Boas-vindas ao beta  "), "Boas-vindas ao beta");
    assert.equal(normalizeReason("x".repeat(MAX_REASON_LENGTH)).length, 500);
  });

  it("rejeita ausente/vazio, caracteres de controle e excesso de tamanho", () => {
    expectInvalidArgument(() => normalizeReason(undefined), "obrigatório");
    expectInvalidArgument(() => normalizeReason("   "), "obrigatório");
    expectInvalidArgument(() => normalizeReason("a\nb"), "caracteres inválidos");
    expectInvalidArgument(() => normalizeReason("a\x00b"), "caracteres inválidos");
    expectInvalidArgument(
      () => normalizeReason("x".repeat(MAX_REASON_LENGTH + 1)),
      "longo demais"
    );
  });
});

describe("validateBetaGrantAmount", () => {
  it("converte valores válidos para unidades inteiras exatas", () => {
    assert.equal(validateBetaGrantAmount(10), 1000);
    assert.equal(validateBetaGrantAmount(10.5), 1050);
    assert.equal(validateBetaGrantAmount(0.01), 1);
    // Drift IEEE-754 é absorvido, nunca truncado errado.
    assert.equal(validateBetaGrantAmount(1.15), 115);
  });

  it("rejeita zero, negativo, NaN, Infinity, 3 casas, não-número e acima do limite", () => {
    for (const bad of [
      0,
      -1,
      -0.01,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.234,
      1_000_000.01, // acima de R$-like 1.000.000,00 por operação
      "10",
      null,
      undefined,
      true,
      {},
    ]) {
      expectInvalidArgument(() => validateBetaGrantAmount(bad));
    }
  });
});

describe("checkBetaGrantReplay", () => {
  const request = {
    grantId: "g-1",
    uid: "u-1",
    amountReais: 50,
    campaignId: "c-1",
    reason: "Boas-vindas",
  };
  const equivalentStored = {
    category: BETA_GRANT_CATEGORY,
    economyType: BETA_ECONOMY_TYPE,
    grantId: "g-1",
    amountReais: 50,
    campaignId: "c-1",
    reason: "Boas-vindas",
    userRefPath: "users/u-1",
  };

  it("replay totalmente equivalente é ok (idempotente)", () => {
    assert.deepEqual(
      checkBetaGrantReplay({ ...request, stored: equivalentStored }),
      { ok: true }
    );
  });

  it("QUALQUER divergência falha: uid, amount, campaign, reason, grant_id", () => {
    const divergences: Array<Partial<typeof equivalentStored>> = [
      { userRefPath: "users/u-2" },
      { amountReais: 51 },
      { campaignId: "c-2" },
      { reason: "Outra razão" },
      { grantId: "g-2" },
    ];
    for (const diff of divergences) {
      const result = checkBetaGrantReplay({
        ...request,
        stored: { ...equivalentStored, ...diff },
      });
      assert.equal(result.ok, false, JSON.stringify(diff));
      assert.ok(!result.ok && result.message.includes("grant_id"));
    }
  });

  it("colisão com uma transação que NÃO é beta grant falha (nunca sobrescreve)", () => {
    // Ex.: um testdeposit cujo externalid colidiu com beta_grant_{id}.
    const foreign = checkBetaGrantReplay({
      ...request,
      stored: {
        category: "deposit",
        economyType: undefined,
        grantId: undefined,
        amountReais: 50,
        campaignId: undefined,
        reason: undefined,
        userRefPath: "users/u-1",
      },
    });
    assert.equal(foreign.ok, false);
  });

  it("granted_by deliberadamente NÃO participa da equivalência", () => {
    // O tipo StoredBetaGrant nem carrega granted_by: outro admin repetindo a
    // MESMA concessão continua sendo a mesma concessão.
    assert.deepEqual(
      checkBetaGrantReplay({ ...request, stored: { ...equivalentStored } }),
      { ok: true }
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL isolation — beta can never leak into cash flows.
// ─────────────────────────────────────────────────────────────────────────────

describe("isolamento estrutural do beta_balance", () => {
  it("requestwithdrawal não lê nem consome beta_balance (saque é 100% cash)", () => {
    const block = sliceBetween(
      "export const requestwithdrawal",
      "export const jointournament"
    );
    assert.ok(!/beta/i.test(block), "requestwithdrawal must not mention beta");
  });

  // NOTA (feat/beta-economy-type): os locks estruturais de estágio 1 que
  // afirmavam "jointournament/settlement não mencionam beta" foram
  // deliberadamente substituídos — o roteamento por economy_type agora
  // EXISTE nesses handlers. O não-mistura passou a ser provado
  // comportamentalmente (economyRouting.handlers.test.ts: inscrição/prêmio
  // cash nunca tocam beta_balance; inscrição/prêmio beta nunca tocam os
  // cinco campos cash). Os locks de saque/depósito/domínio-cash continuam.

  it("jointournament nunca faz fallback: cada ramo enxerga UM único bucket", () => {
    const block = sliceBetween(
      "export const jointournament",
      "export const startTournamentHandler"
    );
    // Fatia os dois ramos do roteamento e prova o isolamento de cada um.
    const betaStart = block.indexOf("if (economy === ECONOMY_BETA_CREDIT) {");
    const betaEnd = block.indexOf("} else {", betaStart);
    const cashEnd = block.indexOf("// Advances BOTH", betaEnd);
    assert.ok(betaStart > 0 && betaEnd > betaStart && cashEnd > betaEnd);

    const betaBranch = block.slice(betaStart, betaEnd);
    const cashBranch = block.slice(betaEnd, cashEnd);

    // O ramo beta nunca lê/escreve o pool cash nem os agregados cash.
    assert.ok(!betaBranch.includes("walletData.balance"), "beta lê balance");
    assert.ok(!/total_(deposited|won|spent|withdrawn)/.test(betaBranch));
    // O ramo cash nunca lê/escreve o pool beta.
    assert.ok(!/beta/i.test(cashBranch), "cash branch must not mention beta");
  });

  it("testdeposit não é o mecanismo beta (não menciona beta)", () => {
    const block = sliceBetween(
      "export const testdeposit",
      "export const requestwithdrawal"
    );
    assert.ok(!/beta/i.test(block), "testdeposit must not mention beta");
  });

  it("debit/credit (operations.ts) e money.ts continuam source-agnostic", () => {
    const operations = readFileSync(
      join(srcDir(), "domain", "operations.ts"),
      "utf8"
    );
    const money = readFileSync(join(srcDir(), "domain", "money.ts"), "utf8");
    assert.ok(!/beta/i.test(operations), "operations.ts must not mention beta");
    assert.ok(!/beta/i.test(money), "money.ts must not mention beta");
  });

  it("grantBetaCredit nunca escreve os cinco campos cash da carteira", () => {
    const block = INDEX_SOURCE.slice(
      INDEX_SOURCE.indexOf("export const grantBetaCreditHandler")
    );
    assert.ok(block.length > 0, "grantBetaCreditHandler must exist");
    // O update da carteira é exatamente { beta_balance: ... } e nenhum outro
    // campo monetário aparece como chave de escrita no handler.
    for (const cashField of [
      "balance:",
      "total_deposited:",
      "total_won:",
      "total_spent:",
      "total_withdrawn:",
    ]) {
      // beta_balance: é permitido; os campos cash não podem aparecer como
      // chaves. "beta_balance:" contém "balance:" — então removemos as
      // ocorrências beta_* antes de procurar.
      const scrubbed = block
        .replace(/beta_balance:/g, "")
        .replace(/beta_previous_balance:/g, "")
        .replace(/beta_balance_after:/g, "");
      assert.ok(
        !scrubbed.includes(cashField),
        `grantBetaCredit must never write ${cashField}`
      );
    }
  });
});
