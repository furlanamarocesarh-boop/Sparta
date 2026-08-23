import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ATTRIBUTION_WINDOW_MONTHS,
  BPS_DENOMINATOR,
  COMMISSION_ACCRUED_CATEGORY,
  PARTNERS_COLLECTION,
  PARTNER_COMMISSION_BPS,
  REFERRAL_CODES_COLLECTION,
  REFERRAL_CODE_MAX_LENGTH,
  REFERRAL_CODE_MIN_LENGTH,
  RESERVED_REFERRAL_CODES,
  SPARTA_FEE_BPS,
  addMonths,
  attributionExpiresAt,
  commissionAccrualId,
  commissionCentavosFor,
  decideAttribution,
  decideCommission,
  feeCentavosFor,
  inspectReferralCode,
  normalizeReferralCode,
  normalizeRecentLimit,
  PARTNER_RECENT_LIMIT_DEFAULT,
  PARTNER_RECENT_LIMIT_MAX,
  PARTNER_TOTAL_FIELD,
  projectPartnerAccrual,
  type CommissionInput,
} from "../../src/domain/partnerReferral.js";

/**
 * The rates are PRODUCT POLICY transcribed from
 * docs/design/season-rankings-admin-metrics.md section 10.6.1. These tests pin
 * them so a future edit to the constants is a deliberate, visible act rather
 * than a silent repricing of every partner contract.
 */
describe("taxas aprovadas", () => {
  it("são exatamente as do documento de design", () => {
    assert.equal(SPARTA_FEE_BPS, 750);
    assert.equal(PARTNER_COMMISSION_BPS, 4000);
    assert.equal(BPS_DENOMINATOR, 10_000);
    assert.equal(ATTRIBUTION_WINDOW_MONTHS, 12);
  });

  it("equivalem a 3% de uma inscrição atribuída", () => {
    // R$ 100,00 -> taxa R$ 7,50 -> comissão R$ 3,00.
    assert.equal(feeCentavosFor(10_000), 750);
    assert.equal(commissionCentavosFor(10_000), 300);
  });

  it("nomeia as coleções sem colidir com as existentes", () => {
    assert.equal(PARTNERS_COLLECTION, "partners");
    assert.equal(REFERRAL_CODES_COLLECTION, "referral_codes");
    assert.equal(COMMISSION_ACCRUED_CATEGORY, "commission_accrued");
  });
});

describe("cálculo em centavos inteiros", () => {
  it("arredonda para baixo, nunca para cima", () => {
    // R$ 10,01 -> 7,5% = 75,075 centavos -> 75, nunca 76.
    assert.equal(feeCentavosFor(1_001), 75);
    // 40% de 75 = 30.
    assert.equal(commissionCentavosFor(1_001), 30);
  });

  it("nunca deixa a comissão passar da taxa, nem a taxa da inscrição", () => {
    for (let entry = 0; entry <= 5_000; entry += 7) {
      const fee = feeCentavosFor(entry);
      const commission = commissionCentavosFor(entry);
      assert.ok(
        commission <= fee,
        `comissão ${commission} > taxa ${fee} em ${entry}`
      );
      assert.ok(fee <= entry, `taxa ${fee} > inscrição ${entry} em ${entry}`);
    }
  });

  it("devolve inteiros sempre", () => {
    for (const entry of [1, 13, 999, 1_234, 99_999]) {
      assert.ok(Number.isInteger(feeCentavosFor(entry)));
      assert.ok(Number.isInteger(commissionCentavosFor(entry)));
    }
  });

  it("rejeita entrada que não é inteiro não negativo", () => {
    assert.throws(() => feeCentavosFor(-1));
    assert.throws(() => feeCentavosFor(10.5));
    assert.throws(() => feeCentavosFor(Number.NaN));
  });

  it("inscrição pequena demais gera taxa zero, e não fração", () => {
    // 7,5% de 13 centavos = 0,975 -> 0.
    assert.equal(feeCentavosFor(13), 0);
    assert.equal(commissionCentavosFor(13), 0);
  });
});

describe("código de indicação", () => {
  it("aceita um slug legível e o normaliza", () => {
    assert.deepEqual(inspectReferralCode("  JoaoGamer  "), {
      ok: true,
      code: "joaogamer",
    });
    assert.equal(normalizeReferralCode("JOAO-GAMER"), "joao-gamer");
  });

  it("aceita hífen entre grupos, nunca nas pontas nem duplicado", () => {
    assert.ok(inspectReferralCode("joao-gamer-br").ok);
    assert.equal(inspectReferralCode("-joao").ok, false);
    assert.equal(inspectReferralCode("joao-").ok, false);
    assert.equal(inspectReferralCode("joao--gamer").ok, false);
  });

  it("classifica cada problema como dado, não como exceção", () => {
    assert.deepEqual(inspectReferralCode(undefined), {
      ok: false,
      problem: "missing",
    });
    assert.deepEqual(inspectReferralCode(42), {
      ok: false,
      problem: "not-a-string",
    });
    assert.deepEqual(inspectReferralCode("ab"), {
      ok: false,
      problem: "too-short",
    });
    assert.deepEqual(inspectReferralCode("a".repeat(25)), {
      ok: false,
      problem: "too-long",
    });
    assert.deepEqual(inspectReferralCode("joão"), {
      ok: false,
      problem: "bad-characters",
    });
    assert.deepEqual(inspectReferralCode("sparta"), {
      ok: false,
      problem: "reserved",
    });
  });

  it("recusa caracteres que quebrariam uma URL ou um caminho", () => {
    for (const bad of ["a/b", "a b", "a.b", "a_b", "a%2Fb", "..", "a?b"]) {
      assert.equal(
        inspectReferralCode(bad).ok,
        false,
        `deveria recusar ${JSON.stringify(bad)}`
      );
    }
  });

  it("reserva os nomes que colidiriam com rota ou com a marca", () => {
    for (const reserved of RESERVED_REFERRAL_CODES) {
      assert.deepEqual(inspectReferralCode(reserved), {
        ok: false,
        problem: "reserved",
      });
    }
    // O segmento do link de torneio está entre eles.
    assert.ok(RESERVED_REFERRAL_CODES.includes("t"));
  });

  it("respeita os limites declarados", () => {
    assert.ok(inspectReferralCode("a".repeat(REFERRAL_CODE_MIN_LENGTH)).ok);
    assert.ok(inspectReferralCode("a".repeat(REFERRAL_CODE_MAX_LENGTH)).ok);
  });
});

describe("janela de atribuição", () => {
  it("soma 12 meses", () => {
    const at = new Date("2026-08-23T12:00:00.000Z");
    assert.equal(
      attributionExpiresAt(at).toISOString(),
      "2027-08-23T12:00:00.000Z"
    );
  });

  it("não transborda o fim do mês", () => {
    // 31 de janeiro + 1 mês é 28 de fevereiro, nunca 3 de março.
    assert.equal(
      addMonths(new Date("2026-01-31T00:00:00.000Z"), 1).toISOString(),
      "2026-02-28T00:00:00.000Z"
    );
    // Ano bissexto.
    assert.equal(
      addMonths(new Date("2028-01-31T00:00:00.000Z"), 1).toISOString(),
      "2028-02-29T00:00:00.000Z"
    );
  });

  it("29 de fevereiro + 12 meses cai em 28 de fevereiro", () => {
    assert.equal(
      attributionExpiresAt(new Date("2028-02-29T00:00:00.000Z")).toISOString(),
      "2029-02-28T00:00:00.000Z"
    );
  });
});

/** Um caso atribuído, saudável e dentro da janela. */
function baseInput(overrides: Partial<CommissionInput> = {}): CommissionInput {
  return {
    partnerRef: "partner-1",
    attributedAt: new Date("2026-01-01T00:00:00.000Z"),
    partnerActive: true,
    partnerOwnerUid: "uid-partner",
    payerUid: "uid-player",
    economy: "cash",
    entryCentavos: 10_000,
    now: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("decisão de comissão", () => {
  it("acumula sobre a taxa, não sobre o valor gasto", () => {
    const decision = decideCommission(baseInput());
    assert.equal(decision.accrues, true);
    if (!decision.accrues) return;
    assert.equal(decision.entryCentavos, 10_000);
    assert.equal(decision.feeCentavos, 750);
    assert.equal(decision.commissionCentavos, 300);
    assert.equal(decision.partnerRef, "partner-1");
  });

  it("não acumula sem atribuição", () => {
    assert.deepEqual(
      decideCommission(baseInput({ partnerRef: null, attributedAt: null })),
      { accrues: false, reason: "not-attributed" }
    );
  });

  it("NUNCA acumula em economia beta", () => {
    assert.deepEqual(decideCommission(baseInput({ economy: "beta_credit" })), {
      accrues: false,
      reason: "beta-economy",
    });
  });

  it("não acumula em torneio gratuito", () => {
    assert.deepEqual(decideCommission(baseInput({ entryCentavos: 0 })), {
      accrues: false,
      reason: "free-entry",
    });
  });

  it("recusa autoindicação antes de olhar a janela", () => {
    const decision = decideCommission(
      baseInput({
        partnerOwnerUid: "uid-mesmo",
        payerUid: "uid-mesmo",
        // Janela já expirada: mesmo assim o motivo tem que ser a fraude.
        now: new Date("2030-01-01T00:00:00.000Z"),
      })
    );
    assert.deepEqual(decision, { accrues: false, reason: "self-referral" });
  });

  it("não acumula para parceiro inativo", () => {
    assert.deepEqual(decideCommission(baseInput({ partnerActive: false })), {
      accrues: false,
      reason: "partner-inactive",
    });
  });

  it("para de acumular exatamente no fim da janela", () => {
    const attributedAt = new Date("2026-01-01T00:00:00.000Z");
    const expiry = attributionExpiresAt(attributedAt);

    const umMsAntes = decideCommission(
      baseInput({
        attributedAt,
        now: new Date(expiry.getTime() - 1),
      })
    );
    assert.equal(umMsAntes.accrues, true);

    const noInstante = decideCommission(baseInput({ attributedAt, now: expiry }));
    assert.deepEqual(noInstante, { accrues: false, reason: "window-expired" });
  });

  it("inscrição pequena que zera a comissão não vira linha de razão", () => {
    assert.deepEqual(decideCommission(baseInput({ entryCentavos: 13 })), {
      accrues: false,
      reason: "free-entry",
    });
  });

  it("parceiro sem dono não dispara autoindicação", () => {
    const decision = decideCommission(baseInput({ partnerOwnerUid: null }));
    assert.equal(decision.accrues, true);
  });
});

describe("idempotência do acúmulo", () => {
  it("deriva o id da inscrição, então um replay encontra a mesma linha", () => {
    assert.equal(commissionAccrualId("reg-123"), "commission_reg-123");
    assert.equal(
      commissionAccrualId("reg-123"),
      commissionAccrualId("reg-123")
    );
  });

  it("inscrições diferentes nunca colidem", () => {
    assert.notEqual(commissionAccrualId("reg-1"), commissionAccrualId("reg-2"));
  });

  it("exige a inscrição", () => {
    assert.throws(() => commissionAccrualId(""));
  });
});

describe("decisão de atribuição", () => {
  it("atribui quando o usuário ainda não tem parceiro", () => {
    assert.deepEqual(
      decideAttribution({
        existingPartnerRef: null,
        code: "joaogamer",
        partnerOwnerUid: "uid-partner",
        claimantUid: "uid-player",
      }),
      { attributes: true, code: "joaogamer" }
    );
  });

  it("nunca sobrescreve uma atribuição existente", () => {
    assert.deepEqual(
      decideAttribution({
        existingPartnerRef: "partner-antigo",
        code: "outro",
        partnerOwnerUid: "uid-partner",
        claimantUid: "uid-player",
      }),
      { attributes: false, reason: "already-attributed" }
    );
  });

  it("recusa alguém que tenta resgatar o próprio código", () => {
    assert.deepEqual(
      decideAttribution({
        existingPartnerRef: null,
        code: "joaogamer",
        partnerOwnerUid: "uid-mesmo",
        claimantUid: "uid-mesmo",
      }),
      { attributes: false, reason: "self-referral" }
    );
  });
});

describe("projeção de ganhos do parceiro", () => {
  it("expõe apenas valor e data — nunca quem é o jogador", () => {
    const view = projectPartnerAccrual(
      {
        amount_centavos: 300,
        fee_centavos: 750,
        entry_centavos: 10_000,
        partner_ref: "partner-1",
        // Campos que NÃO podem vazar, mesmo estando na linha armazenada.
        source_registration_id: "uid-secreto_torneio-9",
        tournament_ref: { path: "tournaments/torneio-9" },
        user_ref: { path: "users/uid-secreto" },
      },
      "2026-08-23T00:00:00.000Z"
    );

    assert.deepEqual(view, {
      accruedAt: "2026-08-23T00:00:00.000Z",
      commissionCentavos: 300,
    });
    assert.deepEqual(Object.keys(view!), ["accruedAt", "commissionCentavos"]);
  });

  it("descarta linha inutilizável em vez de repassá-la crua", () => {
    assert.equal(projectPartnerAccrual(null, "2026-01-01T00:00:00.000Z"), null);
    assert.equal(projectPartnerAccrual("texto", "2026-01-01T00:00:00.000Z"), null);
    assert.equal(
      projectPartnerAccrual({ amount_centavos: 1.5 }, "2026-01-01T00:00:00.000Z"),
      null
    );
    assert.equal(
      projectPartnerAccrual({ amount_centavos: 0 }, "2026-01-01T00:00:00.000Z"),
      null
    );
    // Sem data utilizável não há linha.
    assert.equal(projectPartnerAccrual({ amount_centavos: 300 }, null), null);
  });

  it("limita a página, sem confiar no número do cliente", () => {
    assert.equal(normalizeRecentLimit(undefined), PARTNER_RECENT_LIMIT_DEFAULT);
    assert.equal(normalizeRecentLimit(5), 5);
    assert.equal(normalizeRecentLimit(9999), PARTNER_RECENT_LIMIT_MAX);
    assert.throws(() => normalizeRecentLimit(0));
    assert.throws(() => normalizeRecentLimit(-1));
    assert.throws(() => normalizeRecentLimit(2.5));
    assert.throws(() => normalizeRecentLimit("10"));
  });

  it("o total do parceiro vive em centavos inteiros", () => {
    assert.equal(PARTNER_TOTAL_FIELD, "total_accrued_centavos");
  });
});
