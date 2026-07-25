import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BETA_ENTRY_FEE_CATEGORY,
  BETA_PRIZE_CATEGORY,
  checkRegistrationEconomy,
  decideBetaCompletedReplay,
  economyLockMaterialization,
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
  parseRequestedEconomyType,
  resolveStoredEconomyType,
  resolveTournamentEconomy,
} from "../../src/domain/economy.js";
import { DomainError } from "../../src/domain/errors.js";
import { assertExactPayload } from "../../src/domain/settlement.js";

/** Captures the DomainError a call throws, asserting the expected code. */
function expectDomainError(fn: () => unknown, code: string): DomainError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected DomainError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  return assert.fail("expected the call to throw");
}

describe("parseRequestedEconomyType (payload do createTournament)", () => {
  it("aceita SOMENTE 'cash' e 'beta_credit', exatos", () => {
    assert.equal(parseRequestedEconomyType("cash"), "cash");
    assert.equal(parseRequestedEconomyType("beta_credit"), "beta_credit");
  });

  it("ausente/null/vazio → invalid-argument (obrigatório)", () => {
    for (const bad of [undefined, null, ""]) {
      const e = expectDomainError(
        () => parseRequestedEconomyType(bad),
        "invalid-argument"
      );
      assert.ok(e.message.includes("obrigatório"));
    }
  });

  it("aliases, capitalização, outros valores e coerção → invalid-argument", () => {
    for (const bad of [
      "CASH",
      "Cash",
      "BETA_CREDIT",
      "Beta_Credit",
      "beta",
      "credit",
      "real",
      "brl",
      " cash",
      "cash ",
      0,
      1,
      true,
      false,
      {},
      [],
      ["cash"],
    ]) {
      expectDomainError(() => parseRequestedEconomyType(bad), "invalid-argument");
    }
  });
});

describe("resolveStoredEconomyType (documentos persistidos)", () => {
  it("campo AUSENTE resolve como cash (legado, somente leitura)", () => {
    assert.equal(resolveStoredEconomyType(undefined, "economy_type"), "cash");
  });

  it("valores exatos passam", () => {
    assert.equal(resolveStoredEconomyType("cash", "economy_type"), "cash");
    assert.equal(
      resolveStoredEconomyType("beta_credit", "economy_type"),
      "beta_credit"
    );
  });

  it("valor persistido inválido FALHA FECHADO (nunca cash silencioso)", () => {
    for (const bad of [null, "", "CASH", "Beta_Credit", "credit", 1, true, {}]) {
      const e = expectDomainError(
        () => resolveStoredEconomyType(bad, "economy_type"),
        "failed-precondition"
      );
      assert.ok(e.message.includes("economy_type"));
    }
  });
});

describe("resolveTournamentEconomy — trava econômica durável", () => {
  it("legado: ambos ausentes → cash", () => {
    assert.equal(resolveTournamentEconomy({}), "cash");
  });

  it("consistentes: cash/cash e beta/beta passam; cash com trava ausente passa", () => {
    assert.equal(
      resolveTournamentEconomy({
        economy_type: "cash",
        locked_economy_type: "cash",
      }),
      "cash"
    );
    assert.equal(
      resolveTournamentEconomy({
        economy_type: "beta_credit",
        locked_economy_type: "beta_credit",
      }),
      "beta_credit"
    );
    // Um doc legado que só materializou economy_type: cash continua coerente.
    assert.equal(resolveTournamentEconomy({ economy_type: "cash" }), "cash");
    assert.equal(
      resolveTournamentEconomy({ locked_economy_type: "cash" }),
      "cash"
    );
  });

  it("flip detectado: beta sem trava, cash/beta e beta/cash FALHAM", () => {
    // Um legado (originalmente cash) que ganhou economy_type beta → divergência.
    expectDomainError(
      () => resolveTournamentEconomy({ economy_type: "beta_credit" }),
      "failed-precondition"
    );
    expectDomainError(
      () =>
        resolveTournamentEconomy({
          economy_type: "cash",
          locked_economy_type: "beta_credit",
        }),
      "failed-precondition"
    );
    expectDomainError(
      () =>
        resolveTournamentEconomy({
          economy_type: "beta_credit",
          locked_economy_type: "cash",
        }),
      "failed-precondition"
    );
  });

  it("qualquer lado inválido FALHA FECHADO", () => {
    expectDomainError(
      () => resolveTournamentEconomy({ economy_type: null }),
      "failed-precondition"
    );
    expectDomainError(
      () =>
        resolveTournamentEconomy({
          economy_type: "cash",
          locked_economy_type: "CASH",
        }),
      "failed-precondition"
    );
  });
});

describe("economyLockMaterialization", () => {
  it("materializa SOMENTE campos ausentes, com o valor resolvido", () => {
    assert.deepEqual(economyLockMaterialization({}, ECONOMY_CASH), {
      economy_type: "cash",
      locked_economy_type: "cash",
    });
    assert.deepEqual(
      economyLockMaterialization({ economy_type: "cash" }, ECONOMY_CASH),
      { locked_economy_type: "cash" }
    );
    assert.deepEqual(
      economyLockMaterialization(
        { economy_type: "cash", locked_economy_type: "cash" },
        ECONOMY_CASH
      ),
      {}
    );
  });
});

describe("checkRegistrationEconomy", () => {
  it("inscrição legada (sem proveniência) passa SOMENTE no caminho cash", () => {
    assert.deepEqual(
      checkRegistrationEconomy({
        registrationEconomy: undefined,
        tournamentEconomy: ECONOMY_CASH,
      }),
      { ok: true }
    );
    const beta = checkRegistrationEconomy({
      registrationEconomy: undefined,
      tournamentEconomy: ECONOMY_BETA_CREDIT,
    });
    assert.equal(beta.ok, false);
  });

  it("proveniência igual passa; divergente falha; inválida falha", () => {
    assert.deepEqual(
      checkRegistrationEconomy({
        registrationEconomy: "beta_credit",
        tournamentEconomy: ECONOMY_BETA_CREDIT,
      }),
      { ok: true }
    );
    assert.equal(
      checkRegistrationEconomy({
        registrationEconomy: "cash",
        tournamentEconomy: ECONOMY_BETA_CREDIT,
      }).ok,
      false
    );
    assert.equal(
      checkRegistrationEconomy({
        registrationEconomy: "beta_credit",
        tournamentEconomy: ECONOMY_CASH,
      }).ok,
      false
    );
    assert.equal(
      checkRegistrationEconomy({
        registrationEconomy: "BETA",
        tournamentEconomy: ECONOMY_BETA_CREDIT,
      }).ok,
      false
    );
  });
});

describe("decideBetaCompletedReplay", () => {
  const base = {
    winneruid: "u1",
    tournamentid: "t1",
    resultExists: true,
    txExists: true,
    result: {
      winner_uid: "u1",
      winner_ref: "users/u1",
      registration_ref: "registrations/u1_t1",
      transaction_ref: "transactions/prize_t1",
      prize: 100,
      economy_type: "beta_credit",
    },
    tx: {
      category: BETA_PRIZE_CATEGORY,
      economy_type: "beta_credit",
      external_id: "prize_t1",
      user_ref: "users/u1",
      tournament_ref: "tournaments/t1",
      amount: 100,
    },
  };

  it("replay beta totalmente equivalente é ok", () => {
    assert.deepEqual(decideBetaCompletedReplay(base), { ok: true });
  });

  it("estado parcial falha", () => {
    assert.equal(
      decideBetaCompletedReplay({ ...base, txExists: false, tx: null }).ok,
      false
    );
    assert.equal(
      decideBetaCompletedReplay({ ...base, resultExists: false, result: null })
        .ok,
      false
    );
  });

  it("outro vencedor tem a mensagem própria", () => {
    const r = decideBetaCompletedReplay({ ...base, winneruid: "u2" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.message.includes("outro vencedor"));
  });

  it("uma liquidação CASH nunca é replay equivalente de um torneio beta", () => {
    // O formato cash: category 'prize', sem economy_type.
    const cashShaped = decideBetaCompletedReplay({
      ...base,
      result: { ...base.result, economy_type: undefined },
      tx: { ...base.tx, category: "prize", economy_type: undefined },
    });
    assert.equal(cashShaped.ok, false);
  });

  it("qualquer divergência de refs/valor/economia falha", () => {
    const divergences = [
      { result: { ...base.result, winner_ref: "users/u2" } },
      { result: { ...base.result, prize: 99 } },
      { tx: { ...base.tx, amount: 99 } },
      { tx: { ...base.tx, external_id: "prize_t2" } },
      { tx: { ...base.tx, economy_type: "cash" } },
      { result: { ...base.result, economy_type: "cash" } },
    ];
    for (const diff of divergences) {
      assert.equal(
        decideBetaCompletedReplay({ ...base, ...diff }).ok,
        false,
        JSON.stringify(diff)
      );
    }
  });
});

describe("payloads exatos continuam rejeitando economy_type", () => {
  it("startTournament e declareTournamentResult não aceitam economy_type", () => {
    for (const allowed of [
      ["tournamentid"],
      ["tournamentid", "winneruid"],
    ]) {
      const e = expectDomainError(
        () =>
          assertExactPayload(
            { tournamentid: "t1", economy_type: "beta_credit" },
            allowed
          ),
        "invalid-argument"
      );
      assert.ok(e.message.includes("economy_type"));
    }
  });
});

describe("categorias beta nunca entram na identidade cash", () => {
  it("as categorias novas são distintas das quatro categorias cash", () => {
    const cash = ["deposit", "prize", "entry_fee", "withdrawal"];
    assert.ok(!cash.includes(BETA_ENTRY_FEE_CATEGORY));
    assert.ok(!cash.includes(BETA_PRIZE_CATEGORY));
    assert.equal(BETA_ENTRY_FEE_CATEGORY, "beta_entry_fee");
    assert.equal(BETA_PRIZE_CATEGORY, "beta_prize");
  });
});
