import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * The reset tool must never reach production as code.
 *
 * Asserted against the REAL files, so removing a barrier fails the build instead
 * of silently shipping a tool that wipes the ledger.
 */

const RESET_FILES = ["cli.ts", "guard.ts", "plan.ts", "execute.ts", "fingerprint.ts"];

/**
 * Reads a file with its comments stripped.
 *
 * What matters is the CODE. The header comments legitimately mention `onCall`
 * and `firebase-functions` in order to state that the tool does not use them —
 * asserting over the raw text would flag that documentation as a violation.
 */
const readSource = (file: string): string => {
  const raw = readFileSync(resolve(process.cwd(), "src", "reset", file), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/.*$/gm, ""); // line comments
};

describe("the reset tool is not deployable", () => {
  it("is NOT exported from src/index.ts", () => {
    const index = readFileSync(resolve(process.cwd(), "src", "index.ts"), "utf8");
    assert.ok(
      !index.includes("reset"),
      "index.ts must not reference the reset tool"
    );
  });

  it("is excluded from the deploy package in firebase.json", () => {
    const raw = readFileSync(resolve(process.cwd(), "..", "firebase.json"), "utf8");
    const config = JSON.parse(raw) as { functions: { ignore: string[] }[] };

    assert.ok(
      config.functions[0].ignore.includes("lib/reset"),
      "firebase.json must ignore lib/reset"
    );
  });

  it("never declares a callable or an HTTP endpoint", () => {
    for (const file of RESET_FILES) {
      const source = readSource(file);
      for (const forbidden of ["onCall", "onRequest", "functions.https"]) {
        assert.ok(
          !source.includes(forbidden),
          `reset/${file} must not contain "${forbidden}"`
        );
      }
    }
  });

  it("does not import firebase-functions at all", () => {
    for (const file of RESET_FILES) {
      assert.ok(
        !readSource(file).includes("firebase-functions"),
        `reset/${file} must not import firebase-functions`
      );
    }
  });

  it("uses no recursive or collection-wide delete", () => {
    for (const file of RESET_FILES) {
      const source = readSource(file);
      for (const forbidden of ["recursiveDelete", "bulkWriter", "deleteCollection"]) {
        assert.ok(
          !source.includes(forbidden),
          `reset/${file} must not use "${forbidden}" — documents are enumerated`
        );
      }
    }
  });
});
