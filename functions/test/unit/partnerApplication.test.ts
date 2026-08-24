import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canApplicantSubmit,
  parsePartnerApplication,
  submitRefusalMessage,
  PARTNER_PLATFORMS,
} from "../../src/domain/partnerApplication.js";

const good = {
  platform: "instagram",
  handle: "@fulano",
  followers: 12_000,
  averageViews: 3_500,
  expectedPlayers: 80,
  proposedCode: "Fulano",
};

describe("candidatura a parceiro", () => {
  it("lê uma candidatura completa", () => {
    const a = parsePartnerApplication(good);
    assert.equal(a.platform, "instagram");
    assert.equal(a.handle, "@fulano");
    assert.equal(a.followers, 12_000);
    assert.equal(a.expectedPlayers, 80);
  });

  it("normaliza o código para minúsculas — o link não distingue caixa", () => {
    assert.equal(parsePartnerApplication(good).proposedCode, "fulano");
  });

  it("aceita ZERO em qualquer métrica", () => {
    // Quem está começando tem zero visualizações e ainda pode valer a pena.
    // Recusar seria o formulário tomando a decisão que é do admin.
    const a = parsePartnerApplication({
      ...good,
      followers: 0,
      averageViews: 0,
      expectedPlayers: 0,
    });
    assert.equal(a.followers, 0);
    assert.equal(a.averageViews, 0);
  });

  it("recusa plataforma fora da lista", () => {
    // Texto livre aqui deixaria a lista do admin impossível de ordenar.
    assert.throws(
      () => parsePartnerApplication({ ...good, platform: "orkut" }),
      /plataforma válida/i
    );
  });

  it("toda plataforma da lista é aceita", () => {
    for (const platform of PARTNER_PLATFORMS) {
      assert.ok(parsePartnerApplication({ ...good, platform }));
    }
  });

  it("recusa métrica que não é contagem", () => {
    for (const bad of [-1, 1.5, "12000", null, undefined, Number.NaN]) {
      assert.throws(
        () => parsePartnerApplication({ ...good, followers: bad }),
        `deveria recusar ${String(bad)}`
      );
    }
  });

  it("recusa número absurdo — é bravata ou erro de digitação", () => {
    assert.throws(() =>
      parsePartnerApplication({ ...good, followers: 5_000_000_000 })
    );
  });

  it("exige perfil e código", () => {
    assert.throws(() => parsePartnerApplication({ ...good, handle: "  " }));
    assert.throws(() => parsePartnerApplication({ ...good, proposedCode: "" }));
  });

  it("limita o tamanho de perfil e código", () => {
    assert.throws(() =>
      parsePartnerApplication({ ...good, handle: "x".repeat(65) })
    );
    assert.throws(() =>
      parsePartnerApplication({ ...good, proposedCode: "x".repeat(33) })
    );
  });
});

describe("quem pode reenviar", () => {
  it("quem nunca se candidatou pode", () => {
    assert.equal(canApplicantSubmit(null), true);
  });

  it("quem está pendente pode corrigir", () => {
    assert.equal(canApplicantSubmit("pending"), true);
  });

  it("uma candidatura JÁ AVALIADA não é reaberta pelo candidato", () => {
    // Reenviar depois de recusado enterraria a decisão sob um formulário novo;
    // mexer numa aprovada reescreveria a base em que a pessoa foi aceita.
    assert.equal(canApplicantSubmit("approved"), false);
    assert.equal(canApplicantSubmit("rejected"), false);
  });

  it("a recusa diz qual dos dois casos é", () => {
    assert.match(submitRefusalMessage("approved"), /já é parceiro/i);
    assert.match(submitRefusalMessage("rejected"), /avaliada/i);
  });
});
