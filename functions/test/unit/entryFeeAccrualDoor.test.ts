import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * THE FRONT DOOR of the commission accrual — and deliberately nothing else.
 *
 * `onEntryFeeTransactionCreatedHandler` refuses several classes of ledger row
 * BEFORE it reads anything from Firestore. Those branches are pure, so they are
 * provable here with a hand-built snapshot, exactly as the ranking trigger's
 * ineligible paths are.
 *
 * The ACCEPTED path is not tested here: past the door the handler reads the
 * user, reads the partner and writes a transaction, which only a running
 * emulator can exercise honestly. Faking the Admin SDK would test the fake.
 *
 * WHY THIS FILE EXISTS AT ALL. The single rule that must never break is that a
 * beta entry cannot accrue a real-money commission. That rule is enforced twice
 * — here by category, and again inside `decideCommission` by economy — and this
 * pins the outer of the two, the one that runs before any I/O.
 */

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? "demo-sparta-battle";

/**
 * Carregado por import dinâmico dentro de cada teste: o build de teste é
 * CommonJS, que não permite `await` no topo do módulo. Mesma forma de
 * `functionRegions.test.ts`.
 */
async function loadHandler(): Promise<
  (snapshot: unknown) => Promise<{ accrued: boolean; reason?: string }>
> {
  const mod = await import("../../src/index.js");
  return (mod as Record<string, unknown>)
    .onEntryFeeTransactionCreatedHandler as (
    snapshot: unknown
  ) => Promise<{ accrued: boolean; reason?: string }>;
}

/** A snapshot shaped like the Firestore one, with only what the door reads. */
function snapshot(data: Record<string, unknown> | null): unknown {
  return {
    id: "some-transaction",
    data: () => data,
  };
}

/** A healthy cash entry-fee row. Amount is NEGATIVE — it is a debit. */
function cashEntryFee(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    category: "entry_fee",
    amount: -100,
    user_ref: { path: "users/uid-player" },
    tournament_ref: { path: "tournaments/torneio-1" },
    ...overrides,
  };
}

describe("porta de entrada do acúmulo de comissão", () => {
  it("recusa uma inscrição BETA pela categoria, antes de qualquer leitura", async () => {
    const outcome = await (await loadHandler())(
      snapshot(cashEntryFee({ category: "beta_entry_fee" }))
    );
    assert.deepEqual(outcome, {
      accrued: false,
      reason: "not-a-cash-entry-fee",
    });
  });

  it("recusa qualquer outra categoria de razão", async () => {
    for (const category of [
      "prize",
      "beta_prize",
      "withdrawal",
      "refund",
      "commission_accrued",
      "deposit",
      undefined,
    ]) {
      const outcome = await (await loadHandler())(
        snapshot(cashEntryFee({ category }))
      );
      assert.deepEqual(
        outcome,
        { accrued: false, reason: "not-a-cash-entry-fee" },
        `deveria recusar categoria ${String(category)}`
      );
    }
  });

  it("recusa entrega sem dados em vez de estourar", async () => {
    assert.deepEqual(await (await loadHandler())(snapshot(null)), {
      accrued: false,
      reason: "no-data",
    });
    assert.deepEqual(await (await loadHandler())({}), {
      accrued: false,
      reason: "no-data",
    });
    assert.deepEqual(await (await loadHandler())(undefined), {
      accrued: false,
      reason: "no-data",
    });
  });

  it("recusa referência de usuário ausente ou de outra coleção", async () => {
    for (const user_ref of [
      undefined,
      null,
      { path: "wallets/uid-player" },
      { path: "" },
      "users/uid-player",
    ]) {
      const outcome = await (await loadHandler())(
        snapshot(cashEntryFee({ user_ref }))
      );
      assert.deepEqual(
        outcome,
        { accrued: false, reason: "no-user-ref" },
        `deveria recusar user_ref ${JSON.stringify(user_ref)}`
      );
    }
  });

  it("recusa referência de torneio ausente ou de outra coleção", async () => {
    for (const tournament_ref of [
      undefined,
      null,
      { path: "registrations/x" },
      { path: "" },
    ]) {
      const outcome = await (await loadHandler())(
        snapshot(cashEntryFee({ tournament_ref }))
      );
      assert.deepEqual(
        outcome,
        { accrued: false, reason: "no-tournament-ref" },
        `deveria recusar tournament_ref ${JSON.stringify(tournament_ref)}`
      );
    }
  });

  it("recusa valor monetário inutilizável", async () => {
    for (const amount of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "100",
      { toString: () => "100" },
      10.001,
    ]) {
      const outcome = await (await loadHandler())(
        snapshot(cashEntryFee({ amount }))
      );
      assert.deepEqual(
        outcome,
        { accrued: false, reason: "bad-amount" },
        `deveria recusar amount ${String(amount)}`
      );
    }
  });

  it("nenhuma recusa LANÇA — jogar faria o Firestore reentregar para sempre", async () => {
    // Uma entrega inelegível nunca pode virar sucesso: ela seria reentregue
    // indefinidamente, já que nenhuma retentativa a tornaria elegível.
    for (const bad of [
      snapshot(null),
      snapshot(cashEntryFee({ category: "beta_entry_fee" })),
      snapshot(cashEntryFee({ user_ref: null })),
      snapshot(cashEntryFee({ amount: Number.NaN })),
    ]) {
      const handler = await loadHandler();
      await assert.doesNotReject(() => handler(bad));
    }
  });
});
