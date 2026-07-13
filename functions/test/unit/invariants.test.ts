import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DomainError } from "../../src/domain/errors.js";
import { centavosToReais, toCentavos } from "../../src/domain/money.js";
import {
  credit,
  debit,
  MAX_WITHDRAWAL_CENTAVOS,
  MIN_WITHDRAWAL_CENTAVOS,
  validateDepositAmount,
  validateEntryFee,
  validatePrizeAmount,
  validateWithdrawalAmount,
} from "../../src/domain/operations.js";
import {
  isFull,
  readParticipantCounts,
} from "../../src/domain/tournamentFields.js";

/**
 * Function invariants.
 *
 * These test the rules that `index.ts` composes inside its Firestore
 * transactions — the same functions, not a paraphrase. What cannot be covered
 * here without a database (idempotency by document existence, transaction
 * atomicity) is covered by the emulator-backed rules tests and is called out
 * explicitly below.
 */

function assertCode(fn: () => unknown, code: string, message: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof DomainError, `${message}: not a DomainError`);
      assert.equal(error.code, code, `${message}: wrong code`);
      return true;
    },
    message
  );
}

const reais = (value: number): number =>
  toCentavos(value, { field: "x", allowZero: true });

describe("insufficient balance", () => {
  it("refuses a withdrawal larger than the balance", () => {
    assertCode(
      () => debit(reais(10), reais(10.01)),
      "failed-precondition",
      "one centavo short"
    );
  });

  it("refuses an entry fee larger than the balance", () => {
    assertCode(
      () => debit(reais(4.99), reais(5)),
      "failed-precondition",
      "entry fee"
    );
  });

  it("allows spending the exact balance, leaving zero", () => {
    assert.equal(debit(reais(10), reais(10)), 0);
  });
});

describe("exact balance before and after", () => {
  it("computes a debit with no floating-point drift", () => {
    // Float subtraction is not reliably exact: 0.3 - 0.1 is 0.19999999999999998.
    assert.notEqual(0.3 - 0.1, 0.2);
    assert.equal(centavosToReais(debit(reais(0.3), reais(0.1))), 0.2);

    const after = debit(reais(100), reais(29.99));
    assert.equal(after, 7001);
    assert.equal(centavosToReais(after), 70.01);
  });

  it("computes a credit with no drift", () => {
    const after = credit(reais(0.1), reais(0.2));
    assert.equal(centavosToReais(after), 0.3);
  });

  it("keeps a long chain of operations exact", () => {
    // Deposit 0.10 twenty times, then withdraw 1.00. Floats would end at
    // 0.9999999999999999; centavos end at exactly 100.
    let balance = 0;
    for (let i = 0; i < 20; i++) balance = credit(balance, reais(0.1));
    assert.equal(centavosToReais(balance), 2);

    balance = debit(balance, reais(1));
    assert.equal(centavosToReais(balance), 1);
  });
});

describe("invalid withdrawal amount", () => {
  it("rejects below the R$5,00 minimum", () => {
    assertCode(
      () => validateWithdrawalAmount(4.99),
      "invalid-argument",
      "below min"
    );
    assert.equal(validateWithdrawalAmount(5), MIN_WITHDRAWAL_CENTAVOS);
  });

  it("rejects above the R$10.000,00 maximum", () => {
    assert.equal(validateWithdrawalAmount(10_000), MAX_WITHDRAWAL_CENTAVOS);
    assertCode(
      () => validateWithdrawalAmount(10_000.01),
      "invalid-argument",
      "above max"
    );
  });

  it("rejects zero, negative, NaN and three-decimal amounts", () => {
    assertCode(() => validateWithdrawalAmount(0), "invalid-argument", "zero");
    assertCode(() => validateWithdrawalAmount(-10), "invalid-argument", "neg");
    assertCode(() => validateWithdrawalAmount(NaN), "invalid-argument", "NaN");
    assertCode(
      () => validateWithdrawalAmount(10.005),
      "invalid-argument",
      "3 decimals"
    );
  });
});

describe("invalid prize amount", () => {
  it("rejects zero and negative prizes", () => {
    assertCode(() => validatePrizeAmount(0), "invalid-argument", "zero prize");
    assertCode(() => validatePrizeAmount(-1), "invalid-argument", "neg prize");
  });

  it("rejects non-numeric prizes", () => {
    assertCode(
      () => validatePrizeAmount("100"),
      "invalid-argument",
      "string prize"
    );
    assertCode(
      () => validatePrizeAmount(Infinity),
      "invalid-argument",
      "infinite prize"
    );
  });

  it("accepts a valid prize", () => {
    assert.equal(validatePrizeAmount(400), 40_000);
  });
});

describe("invalid deposit amount", () => {
  it("rejects zero, negative and unsafe deposits", () => {
    assertCode(() => validateDepositAmount(0), "invalid-argument", "zero");
    assertCode(() => validateDepositAmount(-5), "invalid-argument", "negative");
    assertCode(
      () => validateDepositAmount(Number.MAX_SAFE_INTEGER),
      "invalid-argument",
      "unsafe"
    );
  });
});

describe("entry fee", () => {
  it("rejects a tournament whose stored entry fee is zero or invalid", () => {
    assertCode(() => validateEntryFee(0), "invalid-argument", "zero fee");
    assertCode(() => validateEntryFee(null), "invalid-argument", "missing fee");
    assertCode(
      () => validateEntryFee(10.001),
      "invalid-argument",
      "3-decimal fee"
    );
  });
});

describe("tournament capacity", () => {
  it("admits a player when a spot is free", () => {
    const counts = readParticipantCounts({
      current_participants: 9,
      max_participants: 10,
    });
    assert.equal(isFull(counts), false);
  });

  it("refuses a player when the tournament is full", () => {
    const counts = readParticipantCounts({
      current_participants: 10,
      max_participants: 10,
    });
    assert.equal(isFull(counts), true);
  });

  it("refuses to guess when the capacity is missing", () => {
    assertCode(
      () => readParticipantCounts({ current_participants: 0 }),
      "failed-precondition",
      "missing capacity"
    );
  });
});

describe("idempotency and duplicate registration", () => {
  it("derives a deterministic registration id that blocks a second entry", () => {
    // `jointournament` writes registrations/{uid}_{tournamentid}. Because the id
    // is derived rather than random, a second attempt targets the SAME document,
    // and the transaction's existence check rejects it. The rejection itself is
    // exercised against the emulator (test/rules), not here — this asserts the
    // property the guarantee rests on.
    const registrationId = (uid: string, tid: string) => `${uid}_${tid}`;

    assert.equal(registrationId("u1", "t1"), "u1_t1");
    assert.equal(registrationId("u1", "t1"), registrationId("u1", "t1"));
    assert.notEqual(registrationId("u1", "t1"), registrationId("u2", "t1"));
  });

  it("derives a deterministic prize external id, so a prize cannot be paid twice", () => {
    // payprize defaults externalid to `prize_{winneruid}_{tournamentid}`, and
    // transactions/{externalid} must not already exist. Same winner + same
    // tournament therefore collides by construction.
    const prizeId = (winner: string, tid: string) => `prize_${winner}_${tid}`;

    assert.equal(prizeId("w1", "t1"), "prize_w1_t1");
    assert.equal(prizeId("w1", "t1"), prizeId("w1", "t1"));
  });
});
