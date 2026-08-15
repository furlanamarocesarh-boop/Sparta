import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_AGGREGATE_CENTAVOS } from "../../src/domain/aggregateMoney.js";
import {
  BETA_PRIZE_CATEGORY,
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
} from "../../src/domain/economy.js";
import { DomainError } from "../../src/domain/errors.js";
import { MAX_BALANCE_CENTAVOS } from "../../src/domain/money.js";
import { ACTIVITY_TIMEZONE } from "../../src/domain/playerActivity.js";
import {
  CASH_PRIZE_CATEGORY,
  FIRST_ACTIVE_SEASON_ID,
  RANKING_EVENTS_COLLECTION,
  RANKING_TIMEZONE,
  SEASON_ENTRIES_SUBCOLLECTION,
  SEASON_RANKINGS_COLLECTION,
  checkExistingGuard,
  classifyPrizeCategory,
  decideActivation,
  decideEntry,
  decideParent,
  isCompletedStatus,
  isPrizeTransactionId,
  seasonDocumentId,
  seasonIdFromInstant,
  seasonWindow,
  toUsableDate,
  type PrizeRankingEvent,
} from "../../src/domain/seasonRanking.js";

/** A canonical 22-character public identity (design section 5.5). */
const PLAYER = "A7fQ2_kB9xLm3NpQr5TzUw";
const OTHER_PLAYER = "B8gR3_lC0yMn4OqRs6UaVx";

const TX_REF_PATH = "transactions/prize_t1";

function eventOf(overrides: Partial<PrizeRankingEvent> = {}): PrizeRankingEvent {
  return {
    transactionId: "prize_t1",
    publicPlayerId: PLAYER,
    economy: ECONOMY_CASH,
    amountCentavos: 50_000,
    seasonId: "2026-08",
    dayKey: "2026-08-03",
    prizeAt: new Date("2026-08-03T18:22:11.000Z"),
    ...overrides,
  };
}

/** Asserts a DomainError with the expected code is thrown. */
function assertDomain(fn: () => unknown, code: string, label: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof DomainError, `${label}: not a DomainError`);
      assert.equal(error.code, code, `${label}: wrong code`);
      return true;
    },
    label
  );
}

/** Renders an instant as São Paulo wall time, for boundary assertions. */
function localWallTime(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ACTIVITY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(instant);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe("elegibilidade — identificador da transação", () => {
  it("aceita o id determinístico de liquidação", () => {
    assert.equal(isPrizeTransactionId("prize_t1"), true);
    assert.equal(isPrizeTransactionId("prize_torneio-123"), true);
  });

  it("recusa qualquer id fora do namespace prize_*", () => {
    for (const bad of [
      "prize_", // prefixo sem torneio
      "beta_grant_seed",
      "withdrawal_1_abc",
      "entry_fee_1",
      "Prize_t1",
      "",
    ]) {
      assert.equal(isPrizeTransactionId(bad), false, bad);
    }
  });

  it("recusa valores que nem sequer são texto", () => {
    for (const bad of [undefined, null, 1, {}, [], () => "prize_t1"]) {
      assert.equal(isPrizeTransactionId(bad), false, String(bad));
    }
  });
});

describe("elegibilidade — categoria e economia", () => {
  it("mapeia prize para cash", () => {
    assert.equal(classifyPrizeCategory(CASH_PRIZE_CATEGORY), ECONOMY_CASH);
    assert.equal(classifyPrizeCategory("prize"), ECONOMY_CASH);
  });

  it("mapeia beta_prize para beta_credit", () => {
    assert.equal(
      classifyPrizeCategory(BETA_PRIZE_CATEGORY),
      ECONOMY_BETA_CREDIT
    );
  });

  it("NENHUMA categoria beta entra na economia cash", () => {
    assert.notEqual(
      classifyPrizeCategory(BETA_PRIZE_CATEGORY),
      ECONOMY_CASH
    );
    assert.equal(classifyPrizeCategory("beta_entry_fee"), null);
    assert.equal(classifyPrizeCategory("beta_refund"), null);
    assert.equal(classifyPrizeCategory("beta_grant"), null);
  });

  it("recusa todas as demais categorias do ledger", () => {
    for (const bad of [
      "entry_fee",
      "entry_refund",
      "deposit",
      "withdrawal",
      "beta_entry_fee",
      "beta_refund",
      "beta_grant",
    ]) {
      assert.equal(classifyPrizeCategory(bad), null, bad);
    }
  });

  it("recusa admin_correction — allowlist, nunca denylist", () => {
    assert.equal(classifyPrizeCategory("admin_correction"), null);
  });

  it("recusa categorias ausentes ou de outro tipo", () => {
    for (const bad of [undefined, null, "", "PRIZE", 1, {}]) {
      assert.equal(classifyPrizeCategory(bad), null, String(bad));
    }
  });
});

describe("elegibilidade — status", () => {
  it("aceita somente completed", () => {
    assert.equal(isCompletedStatus("completed"), true);
  });

  it("recusa qualquer outro status, inclusive pending", () => {
    for (const bad of [undefined, null, "", "pending", "Completed", "COMPLETED", 1]) {
      assert.equal(isCompletedStatus(bad), false, String(bad));
    }
  });
});

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

describe("tempo — calendário de negócio", () => {
  it("usa o fuso canônico do repositório, sem redefini-lo", () => {
    assert.equal(RANKING_TIMEZONE, ACTIVITY_TIMEZONE);
    assert.equal(RANKING_TIMEZONE, "America/Sao_Paulo");
  });

  it("02:00Z de 1º de agosto ainda é julho em São Paulo", () => {
    assert.equal(
      seasonIdFromInstant(new Date("2026-08-01T02:00:00Z")),
      "2026-07"
    );
  });

  it("04:00Z de 1º de agosto já é agosto", () => {
    assert.equal(
      seasonIdFromInstant(new Date("2026-08-01T04:00:00Z")),
      "2026-08"
    );
  });

  it("o último instante local do mês ainda pertence ao mês", () => {
    const last = new Date("2026-09-01T02:59:59.999Z");
    assert.equal(localWallTime(last).startsWith("2026-08-31"), true);
    assert.equal(seasonIdFromInstant(last), "2026-08");
  });

  it("o primeiro instante local do mês seguinte já pertence a ele", () => {
    const first = new Date("2026-09-01T03:00:00.000Z");
    assert.equal(localWallTime(first).startsWith("2026-09-01"), true);
    assert.equal(seasonIdFromInstant(first), "2026-09");
  });

  it("um timestamp inutilizável é rejeitado pelo conversor", () => {
    for (const bad of [undefined, null, "2026-08-03", 0, {}, new Date(NaN)]) {
      assert.equal(toUsableDate(bad), null, String(bad));
    }
  });

  it("aceita Date e objetos com toDate() — Timestamp do Firestore", () => {
    const real = new Date("2026-08-03T18:22:11.000Z");
    assert.equal(toUsableDate(real)?.getTime(), real.getTime());
    assert.equal(
      toUsableDate({ toDate: () => real })?.getTime(),
      real.getTime()
    );
    assert.equal(toUsableDate({ toDate: () => new Date(NaN) }), null);
    assert.equal(
      toUsableDate({
        toDate: () => {
          throw new Error("boom");
        },
      }),
      null
    );
  });
});

describe("tempo — janela semiaberta da temporada", () => {
  it("começa à meia-noite local do primeiro dia", () => {
    const { start } = seasonWindow("2026-08");
    assert.equal(localWallTime(start), "2026-08-01, 00:00:00");
  });

  it("termina à meia-noite local do primeiro dia do mês seguinte", () => {
    const { end } = seasonWindow("2026-08");
    assert.equal(localWallTime(end), "2026-09-01, 00:00:00");
  });

  it("atravessa a virada de ano corretamente", () => {
    const { start, end } = seasonWindow("2026-12");
    assert.equal(localWallTime(start), "2026-12-01, 00:00:00");
    assert.equal(localWallTime(end), "2027-01-01, 00:00:00");
  });

  it("não deixa lacuna entre meses consecutivos", () => {
    assert.equal(
      seasonWindow("2026-08").end.getTime(),
      seasonWindow("2026-09").start.getTime()
    );
  });

  it("não se sobrepõe: o fim é EXCLUSIVO", () => {
    const august = seasonWindow("2026-08");
    // O instante exato do fim já pertence a setembro.
    assert.equal(seasonIdFromInstant(august.end), "2026-09");
    // E um milissegundo antes ainda é agosto.
    assert.equal(
      seasonIdFromInstant(new Date(august.end.getTime() - 1)),
      "2026-08"
    );
  });

  it("recusa uma temporada malformada", () => {
    for (const bad of ["2026-13", "2026", "26-08", "", "abc"]) {
      assert.throws(() => seasonWindow(bad), DomainError, bad);
    }
  });
});

describe("identificadores de documento", () => {
  it("compõe o id do parent com economia e temporada", () => {
    assert.equal(seasonDocumentId(ECONOMY_CASH, "2026-08"), "cash_2026-08");
    assert.equal(
      seasonDocumentId(ECONOMY_BETA_CREDIT, "2026-08"),
      "beta_credit_2026-08"
    );
  });

  it("cash e beta nunca compartilham documento", () => {
    assert.notEqual(
      seasonDocumentId(ECONOMY_CASH, "2026-08"),
      seasonDocumentId(ECONOMY_BETA_CREDIT, "2026-08")
    );
  });

  it("usa os nomes de coleção congelados", () => {
    assert.equal(SEASON_RANKINGS_COLLECTION, "season_rankings");
    assert.equal(SEASON_ENTRIES_SUBCOLLECTION, "entries");
    assert.equal(RANKING_EVENTS_COLLECTION, "ranking_events");
  });
});

// ---------------------------------------------------------------------------
// Ativação
// ---------------------------------------------------------------------------

describe("ativação — firstActiveSeasonId", () => {
  it("está configurado para a primeira temporada 2026-09", () => {
    assert.equal(FIRST_ACTIVE_SEASON_ID, "2026-09");
  });

  it("agosto/2026 é anterior ao marco de produção — parcial, nunca ranqueado", () => {
    // A decisão de ativação foi tomada DURANTE agosto/2026, então agosto é um
    // mês parcial e a seção 3.3 do design o proíbe como primeira temporada.
    assert.deepEqual(decideActivation(FIRST_ACTIVE_SEASON_ID, "2026-08"), {
      kind: "before-first-season",
    });
  });

  it("setembro/2026 é o primeiro mês completo processado em produção", () => {
    assert.deepEqual(decideActivation(FIRST_ACTIVE_SEASON_ID, "2026-09"), {
      kind: "active",
    });
  });

  it("configuração ausente deixa o sistema inerte", () => {
    for (const absent of [null, undefined]) {
      assert.deepEqual(decideActivation(absent, "2026-08"), { kind: "inert" });
    }
  });

  it("configuração inválida deixa o sistema inerte, sem coerção", () => {
    for (const bad of ["", "2026", "2026-13", "2026-00", "1999-01", "abc", 202608, {}]) {
      assert.deepEqual(
        decideActivation(bad, "2026-08"),
        { kind: "inert" },
        String(bad)
      );
    }
  });

  it("evento anterior ao marco é ignorado — não há backfill", () => {
    assert.deepEqual(decideActivation("2026-08", "2026-07"), {
      kind: "before-first-season",
    });
    assert.deepEqual(decideActivation("2026-08", "2025-12"), {
      kind: "before-first-season",
    });
  });

  it("evento no primeiro mês autorizado é processado", () => {
    assert.deepEqual(decideActivation("2026-08", "2026-08"), { kind: "active" });
  });

  it("evento em mês posterior é processado", () => {
    assert.deepEqual(decideActivation("2026-08", "2026-09"), { kind: "active" });
    assert.deepEqual(decideActivation("2026-08", "2027-01"), { kind: "active" });
  });

  it("a comparação é cronológica, não apenas textual por acaso", () => {
    // `YYYY-MM` tem largura fixa, então a ordem lexicográfica É a cronológica.
    assert.deepEqual(decideActivation("2026-09", "2026-10"), { kind: "active" });
    assert.deepEqual(decideActivation("2026-10", "2026-09"), {
      kind: "before-first-season",
    });
  });
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

describe("entry — criação", () => {
  it("a primeira vitória cria a entry com uma vitória", () => {
    const plan = decideEntry({ event: eventOf(), stored: null });

    assert.equal(plan.kind, "create");
    if (plan.kind !== "create") return;
    assert.equal(plan.scoreCentavos, 50_000);
    assert.equal(plan.winsCount, 1);
    assert.equal(plan.firstPrizeAt.getTime(), plan.lastPrizeAt.getTime());
  });

  it("um prêmio de zero centavos ainda conta uma vitória", () => {
    const plan = decideEntry({
      event: eventOf({ amountCentavos: 0 }),
      stored: null,
    });

    assert.equal(plan.kind, "create");
    if (plan.kind !== "create") return;
    assert.equal(plan.scoreCentavos, 0);
    assert.equal(plan.winsCount, 1);
  });

  it("recusa um identificador público malformado", () => {
    assertDomain(
      () =>
        decideEntry({
          event: eventOf({ publicPlayerId: "PLR-123456" }),
          stored: null,
        }),
      "failed-precondition",
      "publicPlayerId inválido"
    );
  });
});

describe("entry — acumulação", () => {
  const existing = {
    publicPlayerId: PLAYER,
    economy: ECONOMY_CASH,
    seasonId: "2026-08",
    scoreCentavos: 125_000,
    winsCount: 3,
    firstPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
    lastPrizeAt: new Date("2026-08-02T10:00:00.000Z"),
  };

  it("soma a pontuação e incrementa as vitórias", () => {
    const plan = decideEntry({ event: eventOf(), stored: existing });

    assert.equal(plan.kind, "update");
    if (plan.kind !== "update") return;
    assert.equal(plan.scoreCentavos, 175_000);
    assert.equal(plan.winsCount, 4);
  });

  it("preserva firstPrizeAt e avança lastPrizeAt para o timestamp DO PRÊMIO", () => {
    const event = eventOf();
    const plan = decideEntry({ event, stored: existing });

    assert.equal(plan.kind, "update");
    if (plan.kind !== "update") return;
    // O plano de update não carrega firstPrizeAt: ele nunca é reescrito.
    assert.equal("firstPrizeAt" in plan, false);
    assert.equal(plan.lastPrizeAt.getTime(), event.prizeAt.getTime());
  });

  it("soma exatamente uma vez", () => {
    const plan = decideEntry({
      event: eventOf({ amountCentavos: 1 }),
      stored: { ...existing, scoreCentavos: 10 },
    });
    assert.equal(plan.kind === "update" && plan.scoreCentavos, 11);
  });

  it("um zero acumulado não altera o total mas conta a vitória", () => {
    const plan = decideEntry({
      event: eventOf({ amountCentavos: 0 }),
      stored: existing,
    });

    assert.equal(plan.kind, "update");
    if (plan.kind !== "update") return;
    assert.equal(plan.scoreCentavos, existing.scoreCentavos);
    assert.equal(plan.winsCount, 4);
  });
});

describe("entry — corrupção estrutural falha fechado", () => {
  const base = {
    publicPlayerId: PLAYER,
    economy: ECONOMY_CASH,
    seasonId: "2026-08",
    scoreCentavos: 100,
    winsCount: 1,
    firstPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
    lastPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
  };

  const corruptions: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["jogador divergente", { publicPlayerId: OTHER_PLAYER }],
    ["economia divergente", { economy: ECONOMY_BETA_CREDIT }],
    ["temporada divergente", { seasonId: "2026-07" }],
    ["pontuação negativa", { scoreCentavos: -1 }],
    ["pontuação fracionária", { scoreCentavos: 1.5 }],
    ["pontuação NaN", { scoreCentavos: NaN }],
    ["pontuação inteiro inseguro", { scoreCentavos: 2 ** 53 + 2 }],
    ["pontuação não numérica", { scoreCentavos: "100" }],
    ["vitórias zero", { winsCount: 0 }],
    ["vitórias negativas", { winsCount: -1 }],
    ["vitórias fracionárias", { winsCount: 1.5 }],
    ["firstPrizeAt inutilizável", { firstPrizeAt: "ontem" }],
    ["lastPrizeAt inutilizável", { lastPrizeAt: null }],
  ];

  for (const [label, patch] of corruptions) {
    it(`recusa ${label}`, () => {
      assertDomain(
        () => decideEntry({ event: eventOf(), stored: { ...base, ...patch } }),
        "failed-precondition",
        label
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

describe("parent — criação sob demanda", () => {
  it("a primeira entry da temporada cria o parent", () => {
    const window = seasonWindow("2026-08");
    const plan = decideParent({
      event: eventOf(),
      stored: null,
      entryCreated: true,
      window,
    });

    assert.equal(plan.kind, "create");
    if (plan.kind !== "create") return;
    assert.equal(plan.playerCount, 1);
    assert.equal(plan.totalScoreCentavos, 50_000);
    assert.equal(plan.windowStart.getTime(), window.start.getTime());
    assert.equal(plan.windowEnd.getTime(), window.end.getTime());
  });

  it("parent AUSENTE com entry já existente falha fechado", () => {
    // O Firestore mantém a subcoleção viva depois que o documento pai é
    // apagado, então "sem parent, mas com entry" é alcançável de verdade.
    // Reconstruir daí republicaria playerCount 1 e o total de um único prêmio
    // por cima de quantas entries tiverem sobrevivido — reparo silencioso, que
    // o contrato proíbe.
    assertDomain(
      () =>
        decideParent({
          event: eventOf(),
          stored: null,
          entryCreated: false,
          window: seasonWindow("2026-08"),
        }),
      "failed-precondition",
      "parent ausente com entry existente"
    );
  });

  it("nunca devolve um plano de criação quando a entry não é nova", () => {
    // Blindagem contra regressão: qualquer retorno aqui já seria perda de dados.
    let returned: unknown = "not called";
    try {
      returned = decideParent({
        event: eventOf(),
        stored: null,
        entryCreated: false,
        window: seasonWindow("2026-08"),
      });
    } catch {
      returned = "threw";
    }
    assert.equal(returned, "threw");
  });
});

describe("parent — atualização", () => {
  const window = seasonWindow("2026-08");
  const existing = {
    economy: ECONOMY_CASH,
    seasonId: "2026-08",
    timezone: RANKING_TIMEZONE,
    playerCount: 2,
    totalScoreCentavos: 300_000,
    windowStart: window.start,
    windowEnd: window.end,
  };

  it("uma entry NOVA incrementa playerCount e soma o total", () => {
    const plan = decideParent({
      event: eventOf(),
      stored: existing,
      entryCreated: true,
      window,
    });

    assert.equal(plan.kind, "update");
    if (plan.kind !== "update") return;
    assert.equal(plan.playerCount, 3);
    assert.equal(plan.totalScoreCentavos, 350_000);
  });

  it("uma entry EXISTENTE soma o total sem mexer em playerCount", () => {
    const plan = decideParent({
      event: eventOf(),
      stored: existing,
      entryCreated: false,
      window,
    });

    assert.equal(plan.kind, "update");
    if (plan.kind !== "update") return;
    assert.equal(plan.playerCount, 2);
    assert.equal(plan.totalScoreCentavos, 350_000);
  });
});

describe("parent — corrupção estrutural falha fechado", () => {
  const window = seasonWindow("2026-08");
  const base = {
    economy: ECONOMY_CASH,
    seasonId: "2026-08",
    timezone: RANKING_TIMEZONE,
    playerCount: 1,
    totalScoreCentavos: 100,
    windowStart: window.start,
    windowEnd: window.end,
  };

  const corruptions: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["economia divergente", { economy: ECONOMY_BETA_CREDIT }],
    ["temporada divergente", { seasonId: "2026-07" }],
    ["fuso divergente", { timezone: "UTC" }],
    ["playerCount zero", { playerCount: 0 }],
    ["playerCount negativo", { playerCount: -1 }],
    ["total negativo", { totalScoreCentavos: -1 }],
    ["total fracionário", { totalScoreCentavos: 0.5 }],
    ["janela inutilizável", { windowStart: "agosto" }],
    ["início de janela divergente", { windowStart: new Date("2026-08-02T03:00:00Z") }],
    ["fim de janela divergente", { windowEnd: new Date("2026-09-02T03:00:00Z") }],
  ];

  for (const [label, patch] of corruptions) {
    it(`recusa ${label}`, () => {
      assertDomain(
        () =>
          decideParent({
            event: eventOf(),
            stored: { ...base, ...patch },
            entryCreated: false,
            window,
          }),
        "failed-precondition",
        label
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Dinheiro
// ---------------------------------------------------------------------------

describe("dinheiro — domínio agregado, nunca o da carteira", () => {
  const window = seasonWindow("2026-08");

  it("um total acima do teto da carteira continua válido para o ranking", () => {
    const above = MAX_BALANCE_CENTAVOS + 1;
    const plan = decideEntry({
      event: eventOf({ amountCentavos: 1 }),
      stored: {
        publicPlayerId: PLAYER,
        economy: ECONOMY_CASH,
        seasonId: "2026-08",
        scoreCentavos: MAX_BALANCE_CENTAVOS,
        winsCount: 1,
        firstPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
        lastPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    });

    assert.equal(plan.kind === "update" && plan.scoreCentavos, above);
  });

  it("um resultado EXATAMENTE igual ao teto agregado é aceito", () => {
    const plan = decideEntry({
      event: eventOf({ amountCentavos: 1 }),
      stored: {
        publicPlayerId: PLAYER,
        economy: ECONOMY_CASH,
        seasonId: "2026-08",
        scoreCentavos: MAX_AGGREGATE_CENTAVOS - 1,
        winsCount: 1,
        firstPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
        lastPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    });

    assert.equal(
      plan.kind === "update" && plan.scoreCentavos,
      MAX_AGGREGATE_CENTAVOS
    );
  });

  it("um overflow na entry falha fechado, sem clamp nem saturação", () => {
    let returned: unknown = "not called";
    try {
      returned = decideEntry({
        event: eventOf({ amountCentavos: 1 }),
        stored: {
          publicPlayerId: PLAYER,
          economy: ECONOMY_CASH,
          seasonId: "2026-08",
          scoreCentavos: MAX_AGGREGATE_CENTAVOS,
          winsCount: 1,
          firstPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
          lastPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
        },
      });
    } catch (error) {
      returned = "threw";
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "failed-precondition");
    }
    // Nunca devolve o teto (clamp) nem um valor pequeno (wraparound).
    assert.equal(returned, "threw");
  });

  it("um overflow no parent falha fechado", () => {
    assertDomain(
      () =>
        decideParent({
          event: eventOf({ amountCentavos: 1 }),
          stored: {
            economy: ECONOMY_CASH,
            seasonId: "2026-08",
            timezone: RANKING_TIMEZONE,
            playerCount: 1,
            totalScoreCentavos: MAX_AGGREGATE_CENTAVOS,
            windowStart: window.start,
            windowEnd: window.end,
          },
          entryCreated: false,
          window,
        }),
      "failed-precondition",
      "overflow do parent"
    );
  });
});

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

describe("guard — idempotência", () => {
  const canonical = {
    transactionRefPath: TX_REF_PATH,
    publicPlayerId: PLAYER,
    economy: ECONOMY_CASH,
    amountCentavos: 50_000,
    seasonId: "2026-08",
    dayKey: "2026-08-03",
    appliedAt: new Date("2026-08-03T18:22:12.000Z"),
  };

  it("guard ausente manda aplicar", () => {
    assert.deepEqual(
      checkExistingGuard({
        event: eventOf(),
        expectedTransactionRefPath: TX_REF_PATH,
        stored: null,
      }),
      { kind: "apply" }
    );
  });

  it("guard canônico existente vira no-op", () => {
    assert.deepEqual(
      checkExistingGuard({
        event: eventOf(),
        expectedTransactionRefPath: TX_REF_PATH,
        stored: canonical,
      }),
      { kind: "replay" }
    );
  });

  it("aceita qualquer appliedAt utilizável, sem compará-lo com agora", () => {
    for (const stamp of [
      new Date("2020-01-01T00:00:00.000Z"),
      { toDate: () => new Date("2030-01-01T00:00:00.000Z") },
    ]) {
      assert.deepEqual(
        checkExistingGuard({
          event: eventOf(),
          expectedTransactionRefPath: TX_REF_PATH,
          stored: { ...canonical, appliedAt: stamp },
        }),
        { kind: "replay" }
      );
    }
  });

  const conflicts: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["referência da transação divergente", { transactionRefPath: "transactions/prize_other" }],
    ["referência ausente", { transactionRefPath: undefined }],
    ["jogador divergente", { publicPlayerId: OTHER_PLAYER }],
    ["economia divergente", { economy: ECONOMY_BETA_CREDIT }],
    ["valor divergente", { amountCentavos: 1 }],
    ["temporada divergente", { seasonId: "2026-07" }],
    ["dia divergente", { dayKey: "2026-08-04" }],
    ["appliedAt inutilizável", { appliedAt: "ontem" }],
    ["appliedAt ausente", { appliedAt: undefined }],
  ];

  for (const [label, patch] of conflicts) {
    it(`guard com ${label} falha fechado`, () => {
      assertDomain(
        () =>
          checkExistingGuard({
            event: eventOf(),
            expectedTransactionRefPath: TX_REF_PATH,
            stored: { ...canonical, ...patch },
          }),
        "failed-precondition",
        label
      );
    });
  }

  it("um guard vazio é incompleto, não um replay", () => {
    assertDomain(
      () =>
        checkExistingGuard({
          event: eventOf(),
          expectedTransactionRefPath: TX_REF_PATH,
          stored: {},
        }),
      "failed-precondition",
      "guard vazio"
    );
  });
});

// ---------------------------------------------------------------------------
// Isolamento entre economias e temporadas
// ---------------------------------------------------------------------------

describe("isolamento", () => {
  it("o mesmo jogador tem entries independentes por economia", () => {
    assert.notEqual(
      seasonDocumentId(ECONOMY_CASH, "2026-08"),
      seasonDocumentId(ECONOMY_BETA_CREDIT, "2026-08")
    );
  });

  it("o mesmo jogador tem entries independentes por temporada", () => {
    assert.notEqual(
      seasonDocumentId(ECONOMY_CASH, "2026-08"),
      seasonDocumentId(ECONOMY_CASH, "2026-09")
    );
  });

  it("uma entry de outra economia é corrupção, não acumulação", () => {
    assertDomain(
      () =>
        decideEntry({
          event: eventOf({ economy: ECONOMY_BETA_CREDIT }),
          stored: {
            publicPlayerId: PLAYER,
            economy: ECONOMY_CASH,
            seasonId: "2026-08",
            scoreCentavos: 1,
            winsCount: 1,
            firstPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
            lastPrizeAt: new Date("2026-08-01T10:00:00.000Z"),
          },
        }),
      "failed-precondition",
      "economias cruzadas"
    );
  });
});

// ---------------------------------------------------------------------------
// Escopo — o passo 6 NÃO está aqui
// ---------------------------------------------------------------------------

describe("escopo do passo 5", () => {
  it("o módulo não exporta posição, comparador, cursor nem paginação", async () => {
    const module = await import("../../src/domain/seasonRanking.js");
    const exported = Object.keys(module);

    // Padrões de ORDENAÇÃO. Deliberadamente não usam o radical "rank", que
    // aparece legitimamente em `season_rankings` e `RANKING_TIMEZONE` — a
    // proibição é sobre posição, não sobre a palavra.
    const forbidden =
      /position|placement|comparator|compareEntries|cursor|paginat|tiebreak|leaderboard|standings|sortEntries/i;

    const offenders = exported.filter((name) => forbidden.test(name));
    assert.deepEqual(
      offenders,
      [],
      `estes símbolos pertencem ao passo 6: ${offenders.join(", ")}`
    );
  });
});
