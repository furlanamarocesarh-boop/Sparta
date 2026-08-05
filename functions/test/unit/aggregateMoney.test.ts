import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  addAggregateCentavos,
  MAX_AGGREGATE_CENTAVOS,
} from "../../src/domain/aggregateMoney.js";
import { DomainError } from "../../src/domain/errors.js";
import { addCentavos, MAX_BALANCE_CENTAVOS } from "../../src/domain/money.js";

const INVALID_OPERAND = "Valor agregado interno inválido.";
const OVERFLOW = "Operação excede o limite de agregado permitido.";

/** Asserts that `fn` throws a DomainError with the given code and message. */
function assertRejects(
  fn: () => unknown,
  message: string,
  label: string
): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof DomainError, `${label}: not a DomainError`);
      assert.equal(error.code, "failed-precondition", `${label}: wrong code`);
      assert.equal(error.message, message, `${label}: wrong message`);
      return true;
    },
    label
  );
}

describe("MAX_AGGREGATE_CENTAVOS", () => {
  it("is exactly Number.MAX_SAFE_INTEGER", () => {
    assert.equal(MAX_AGGREGATE_CENTAVOS, Number.MAX_SAFE_INTEGER);
  });

  it("is exactly 9 007 199 254 740 991 centavos", () => {
    assert.equal(MAX_AGGREGATE_CENTAVOS, 9_007_199_254_740_991);
  });

  it("is not the withdrawn 1_000_000_000_000 ceiling", () => {
    // The design's supersession table replaced that value; a regression to it
    // would silently cap platform aggregates at R$ 10 bilhões.
    assert.notEqual(MAX_AGGREGATE_CENTAVOS, 1_000_000_000_000);
  });

  it("is far above the wallet ceiling it must never reuse", () => {
    assert.ok(MAX_AGGREGATE_CENTAVOS > MAX_BALANCE_CENTAVOS);
  });
});

describe("addAggregateCentavos — valid arithmetic", () => {
  it("adds zero to zero", () => {
    assert.equal(addAggregateCentavos(0, 0), 0);
  });

  it("adds an ordinary pair exactly", () => {
    assert.equal(addAggregateCentavos(125_000, 50_000), 175_000);
    assert.equal(addAggregateCentavos(0, 42), 42);
    assert.equal(addAggregateCentavos(42, 0), 42);
  });

  it("accepts a result exactly equal to the ceiling", () => {
    // The contract forbids EXCEEDING the ceiling, not reaching it.
    assert.equal(
      addAggregateCentavos(MAX_AGGREGATE_CENTAVOS - 1, 1),
      MAX_AGGREGATE_CENTAVOS
    );
    assert.equal(
      addAggregateCentavos(1, MAX_AGGREGATE_CENTAVOS - 1),
      MAX_AGGREGATE_CENTAVOS
    );
  });

  it("accepts the ceiling itself as an operand when nothing is added", () => {
    assert.equal(
      addAggregateCentavos(MAX_AGGREGATE_CENTAVOS, 0),
      MAX_AGGREGATE_CENTAVOS
    );
    assert.equal(
      addAggregateCentavos(0, MAX_AGGREGATE_CENTAVOS),
      MAX_AGGREGATE_CENTAVOS
    );
  });

  it("accumulates the way a season total does", () => {
    let total = 0;
    for (const prize of [50_000, 125_000, 1, 0, 7_500]) {
      total = addAggregateCentavos(total, prize);
    }
    assert.equal(total, 182_501);
  });
});

describe("addAggregateCentavos — overflow", () => {
  it("rejects one centavo above the ceiling", () => {
    assertRejects(
      () => addAggregateCentavos(MAX_AGGREGATE_CENTAVOS, 1),
      OVERFLOW,
      "MAX + 1"
    );
    assertRejects(
      () => addAggregateCentavos(1, MAX_AGGREGATE_CENTAVOS),
      OVERFLOW,
      "1 + MAX"
    );
  });

  it("rejects a large-but-safe pair whose SUM overflows", () => {
    // Both operands are individually valid; only the sum is not. This is the
    // case the pre-addition check exists for.
    const half = Math.floor(MAX_AGGREGATE_CENTAVOS / 2) + 1;
    assertRejects(
      () => addAggregateCentavos(half, half),
      OVERFLOW,
      "half + half"
    );
  });

  it("never clamps, saturates or wraps around", () => {
    // A clamping implementation would return MAX; a wrapping one would return
    // something small or negative. Both are excluded by construction: the only
    // legal outcome is a throw.
    let returned: unknown = "not called";
    try {
      returned = addAggregateCentavos(MAX_AGGREGATE_CENTAVOS, 1);
    } catch {
      returned = "threw";
    }
    assert.equal(returned, "threw");

    // And the same inputs never yield the ceiling, a negative, or a value
    // smaller than an operand.
    for (const [a, b] of [
      [MAX_AGGREGATE_CENTAVOS, 1],
      [MAX_AGGREGATE_CENTAVOS, MAX_AGGREGATE_CENTAVOS],
      [MAX_AGGREGATE_CENTAVOS - 1, 5],
    ] as const) {
      assert.throws(() => addAggregateCentavos(a, b), DomainError);
    }
  });

  it("proves the raw sum it refuses is genuinely inexact", () => {
    // Why the sum cannot be its own evidence: above 2^53 a double stops
    // representing every integer.
    assert.equal(MAX_AGGREGATE_CENTAVOS + 1, MAX_AGGREGATE_CENTAVOS + 2);
    assert.equal(Number.isSafeInteger(MAX_AGGREGATE_CENTAVOS + 1), false);
  });
});

describe("addAggregateCentavos — invalid operands", () => {
  it("rejects an unsafe integer in either position", () => {
    const unsafe = 2 ** 53 + 2;
    assertRejects(() => addAggregateCentavos(unsafe, 0), INVALID_OPERAND, "a");
    assertRejects(() => addAggregateCentavos(0, unsafe), INVALID_OPERAND, "b");
  });

  it("rejects NaN in either position", () => {
    assertRejects(() => addAggregateCentavos(NaN, 0), INVALID_OPERAND, "a");
    assertRejects(() => addAggregateCentavos(0, NaN), INVALID_OPERAND, "b");
  });

  it("rejects Infinity and -Infinity in either position", () => {
    for (const bad of [Infinity, -Infinity]) {
      assertRejects(() => addAggregateCentavos(bad, 0), INVALID_OPERAND, "a");
      assertRejects(() => addAggregateCentavos(0, bad), INVALID_OPERAND, "b");
    }
  });

  it("rejects a float in either position", () => {
    for (const bad of [1.5, 0.01, -0.5, 1e-7]) {
      assertRejects(() => addAggregateCentavos(bad, 0), INVALID_OPERAND, "a");
      assertRejects(() => addAggregateCentavos(0, bad), INVALID_OPERAND, "b");
    }
  });

  it("rejects a negative in either position", () => {
    for (const bad of [-1, -100, -MAX_AGGREGATE_CENTAVOS]) {
      assertRejects(() => addAggregateCentavos(bad, 0), INVALID_OPERAND, "a");
      assertRejects(() => addAggregateCentavos(0, bad), INVALID_OPERAND, "b");
    }
  });

  it("rejects runtime values that are not numbers at all", () => {
    // Stored aggregates come back from Firestore as `unknown`; the signature
    // cannot protect the boundary, so the guard does.
    for (const bad of [undefined, null, "1000", true, {}, [], () => 1]) {
      assertRejects(
        () => addAggregateCentavos(bad as unknown as number, 0),
        INVALID_OPERAND,
        `a = ${String(bad)}`
      );
      assertRejects(
        () => addAggregateCentavos(0, bad as unknown as number),
        INVALID_OPERAND,
        `b = ${String(bad)}`
      );
    }
  });
});

describe("the wallet cap is not reused", () => {
  it("accepts a total the wallet helper refuses", () => {
    // The whole reason this module exists: R$ 10 M is a wallet bound, and a
    // platform aggregate crossing it is ordinary, not exceptional.
    const above = MAX_BALANCE_CENTAVOS + 1;

    assert.equal(addAggregateCentavos(MAX_BALANCE_CENTAVOS, 1), above);
    assert.equal(
      addAggregateCentavos(MAX_BALANCE_CENTAVOS, MAX_BALANCE_CENTAVOS),
      2 * MAX_BALANCE_CENTAVOS
    );
  });

  it("the SAME operands are refused by addCentavos, proving the domains differ", () => {
    assert.throws(
      () => addCentavos(MAX_BALANCE_CENTAVOS, 1),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, "failed-precondition");
        return true;
      },
      "the wallet helper must still enforce its own, lower ceiling"
    );
  });
});

// ---------------------------------------------------------------------------
// Structural guard
// ---------------------------------------------------------------------------

/**
 * Because the ceiling IS `Number.MAX_SAFE_INTEGER`, no safe integer can exceed
 * it — so `Number.isSafeInteger(sum)` alone would make `MAX + 1` fail even if
 * the explicit comparison were deleted. No behavioural test can tell the two
 * implementations apart.
 *
 * This guard closes exactly that gap, in the structural style the repository
 * already uses over `src/index.ts` in `payprizeAliasSecure.test.ts`.
 */
function srcDir(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "src", "domain", "money.ts"))) return join(cwd, "src");
  if (existsSync(join(cwd, "functions", "src", "domain", "money.ts"))) {
    return join(cwd, "functions", "src");
  }
  throw new Error(`cannot locate src from cwd: ${cwd}`);
}

// CRLF normalized: a Windows checkout writes \r\n and the delimiters are \n.
const SOURCE = readFileSync(
  join(srcDir(), "domain", "aggregateMoney.ts"),
  "utf8"
).replace(/\r\n/g, "\n");

/** The source text of `addAggregateCentavos`, and nothing else. */
function addFunctionBody(): string {
  const start = SOURCE.indexOf("export function addAggregateCentavos");
  assert.ok(start >= 0, "the checked add must exist");
  const end = SOURCE.indexOf("\n}\n", start);
  assert.ok(end > start, "could not delimit the function body");
  return SOURCE.slice(start, end);
}

describe("structural guard — the explicit overflow check exists", () => {
  it("examines the function body, not the constant declaration", () => {
    const body = addFunctionBody();

    assert.ok(
      !body.includes("export const MAX_AGGREGATE_CENTAVOS"),
      "the slice must not reach the constant declaration"
    );
    assert.ok(
      body.includes("assertAggregateCentavos(a)"),
      "the slice must really be the checked add"
    );
  });

  it("checks the ceiling BEFORE trusting the sum", () => {
    // The discriminating form: the pre-addition comparison, decided entirely
    // inside the safe range. Deleting it leaves `isSafeInteger` catching
    // MAX + 1 incidentally — and this assertion failing deliberately.
    const body = addFunctionBody().replace(/\s+/g, " ");

    assert.ok(
      body.includes("a > MAX_AGGREGATE_CENTAVOS - b"),
      "the pre-addition overflow comparison must be present verbatim"
    );

    const guardIndex = body.indexOf("a > MAX_AGGREGATE_CENTAVOS - b");
    const sumIndex = body.indexOf("const sum = a + b");
    assert.ok(sumIndex > guardIndex, "the check must precede the addition");
  });
});
