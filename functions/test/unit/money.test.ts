import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DomainError } from "../../src/domain/errors.js";
import {
  addCentavos,
  centavosToReais,
  MAX_CENTAVOS,
  storedReaisToCentavos,
  subtractCentavos,
  toCentavos,
} from "../../src/domain/money.js";

const deposit = { field: "valor do depósito" } as const;

/** Asserts that `fn` throws a DomainError with the given code. */
function assertRejects(fn: () => unknown, code: string, message: string): void {
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

describe("toCentavos — conversion", () => {
  it("converts R$10.00 to 1000 centavos", () => {
    assert.equal(toCentavos(10, deposit), 1000);
    assert.equal(toCentavos(10.0, deposit), 1000);
  });

  it("converts R$0.01 to 1 centavo", () => {
    assert.equal(toCentavos(0.01, deposit), 1);
  });

  it("converts R$10.10 to 1010 centavos", () => {
    assert.equal(toCentavos(10.1, deposit), 1010);
  });

  it("converts values whose scaling genuinely drifts in IEEE-754", () => {
    // These are the real hazard: `1.15 * 100` is 114.99999999999999 and
    // `0.07 * 100` is 7.000000000000001. Truncating instead of rounding would
    // silently lose a centavo on the first and is why the conversion rounds
    // and then verifies the result against an epsilon.
    assert.equal(1.15 * 100, 114.99999999999999);
    assert.equal(0.07 * 100, 7.000000000000001);

    assert.equal(toCentavos(1.15, deposit), 115);
    assert.equal(toCentavos(0.07, deposit), 7);
  });

  it("converts other representative values exactly", () => {
    assert.equal(toCentavos(29.99, deposit), 2999);
    assert.equal(toCentavos(1234.56, deposit), 123456);
  });
});

describe("toCentavos — rejection", () => {
  it("rejects three decimal places instead of truncating", () => {
    assertRejects(
      () => toCentavos(10.101, deposit),
      "invalid-argument",
      "10.101"
    );
    assertRejects(
      () => toCentavos(0.005, deposit),
      "invalid-argument",
      "0.005"
    );
  });

  it("rejects NaN", () => {
    assertRejects(() => toCentavos(NaN, deposit), "invalid-argument", "NaN");
  });

  it("rejects Infinity and -Infinity", () => {
    assertRejects(
      () => toCentavos(Infinity, deposit),
      "invalid-argument",
      "Infinity"
    );
    assertRejects(
      () => toCentavos(-Infinity, deposit),
      "invalid-argument",
      "-Infinity"
    );
  });

  it("rejects strings, even numeric-looking ones", () => {
    assertRejects(
      () => toCentavos("10", deposit),
      "invalid-argument",
      "string '10'"
    );
    assertRejects(
      () => toCentavos("abc", deposit),
      "invalid-argument",
      "string 'abc'"
    );
  });

  it("rejects null, undefined, booleans and objects", () => {
    assertRejects(() => toCentavos(null, deposit), "invalid-argument", "null");
    assertRejects(
      () => toCentavos(undefined, deposit),
      "invalid-argument",
      "undefined"
    );
    assertRejects(() => toCentavos(true, deposit), "invalid-argument", "true");
    assertRejects(() => toCentavos({}, deposit), "invalid-argument", "object");
  });

  it("rejects unsafe / oversized values", () => {
    assertRejects(
      () => toCentavos(Number.MAX_SAFE_INTEGER, deposit),
      "invalid-argument",
      "MAX_SAFE_INTEGER"
    );
    assertRejects(
      () => toCentavos(Number.MAX_VALUE, deposit),
      "invalid-argument",
      "MAX_VALUE"
    );
  });

  it("rejects negative amounts where forbidden", () => {
    assertRejects(
      () => toCentavos(-1, deposit),
      "invalid-argument",
      "negative"
    );
    assertRejects(
      () => toCentavos(-0.01, deposit),
      "invalid-argument",
      "negative centavo"
    );
  });

  it("enforces the maximum limit", () => {
    assert.equal(toCentavos(1_000_000, deposit), MAX_CENTAVOS);
    assertRejects(
      () => toCentavos(1_000_000.01, deposit),
      "invalid-argument",
      "above max"
    );
  });
});

describe("toCentavos — zero", () => {
  it("rejects zero by default (deposits, fees, prizes, withdrawals)", () => {
    assertRejects(() => toCentavos(0, deposit), "invalid-argument", "zero");
  });

  it("accepts zero only where the operation allows it", () => {
    assert.equal(
      toCentavos(0, { field: "valor da inscrição", allowZero: true }),
      0
    );
  });
});

describe("storedReaisToCentavos", () => {
  it("reads a stored balance, allowing zero", () => {
    assert.equal(storedReaisToCentavos(0, "saldo"), 0);
    assert.equal(storedReaisToCentavos(10.5, "saldo"), 1050);
  });

  it("reports corrupt stored data as failed-precondition, not invalid-argument", () => {
    // A bad number in Firestore is a server-side data problem, not the caller's
    // fault — the error code must reflect that.
    assertRejects(
      () => storedReaisToCentavos("10", "saldo"),
      "failed-precondition",
      "stored string"
    );
    assertRejects(
      () => storedReaisToCentavos(NaN, "saldo"),
      "failed-precondition",
      "stored NaN"
    );
    assertRejects(
      () => storedReaisToCentavos(-5, "saldo"),
      "failed-precondition",
      "stored negative"
    );
  });
});

describe("centavosToReais", () => {
  it("round-trips exactly", () => {
    for (const reais of [0.01, 0.07, 1.15, 10, 10.1, 29.99, 1234.56]) {
      const centavos = toCentavos(reais, { field: "x", allowZero: true });
      assert.equal(centavosToReais(centavos), reais);
    }
  });

  it("normalizes to a clean two-decimal number", () => {
    assert.equal(centavosToReais(1050), 10.5);
    assert.equal(centavosToReais(1), 0.01);
    assert.equal(centavosToReais(0), 0);
  });
});

describe("exact arithmetic", () => {
  it("adds without floating-point drift", () => {
    // The classic failure: 0.1 + 0.2 !== 0.3 in floats.
    assert.notEqual(0.1 + 0.2, 0.3);

    const a = toCentavos(0.1, { field: "x" });
    const b = toCentavos(0.2, { field: "x" });
    assert.equal(addCentavos(a, b), 30);
    assert.equal(centavosToReais(addCentavos(a, b)), 0.3);
  });

  it("subtracts exactly", () => {
    const balance = toCentavos(100, { field: "x" });
    const fee = toCentavos(29.99, { field: "x" });
    assert.equal(subtractCentavos(balance, fee), 7001);
    assert.equal(centavosToReais(subtractCentavos(balance, fee)), 70.01);
  });

  it("survives repeated operations that would drift in floats", () => {
    let float = 0;
    let centavos = 0;
    for (let i = 0; i < 10; i++) {
      float += 0.1;
      centavos = addCentavos(centavos, 10);
    }
    assert.notEqual(float, 1); // 0.9999999999999999
    assert.equal(centavosToReais(centavos), 1);
  });

  it("refuses to overflow the balance ceiling", () => {
    assertRejects(
      () => addCentavos(1_000_000_000, 1),
      "failed-precondition",
      "balance overflow"
    );
  });
});
