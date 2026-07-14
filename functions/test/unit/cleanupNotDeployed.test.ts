import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * The cleanup tool must never reach production as code.
 *
 * Three independent barriers, each asserted here:
 *   1. it is not exported from `src/index.ts`, so it cannot become a callable;
 *   2. `firebase.json` excludes `lib/cleanup` from the deploy package;
 *   3. it does not use `https.onCall` / `onRequest` anywhere.
 *
 * Assertions run against the real files, so deleting a barrier fails the build
 * rather than silently shipping an operator tool that deletes documents.
 */

const fromFunctions = (...parts: string[]) =>
  readFileSync(resolve(process.cwd(), ...parts), "utf8");

describe("the cleanup tool is not deployable", () => {
  it("is NOT exported from src/index.ts", () => {
    const index = fromFunctions("src", "index.ts");

    assert.ok(
      !index.includes("cleanup"),
      "index.ts must not reference the cleanup tool at all"
    );
  });

  it("is excluded from the deploy package in firebase.json", () => {
    // firebase.json lives one level up from functions/.
    const raw = readFileSync(
      resolve(process.cwd(), "..", "firebase.json"),
      "utf8"
    );
    const config = JSON.parse(raw) as {
      functions: { ignore: string[] }[];
    };

    const ignore = config.functions[0].ignore;
    assert.ok(
      ignore.includes("lib/cleanup"),
      "firebase.json must ignore lib/cleanup"
    );
  });

  it("never declares a callable or an HTTP endpoint", () => {
    for (const file of ["cli.ts", "guard.ts", "plan.ts", "signature.ts"]) {
      const source = fromFunctions("src", "cleanup", file);

      for (const forbidden of ["onCall", "onRequest", "functions.https"]) {
        assert.ok(
          !source.includes(forbidden),
          `cleanup/${file} must not contain "${forbidden}"`
        );
      }
    }
  });

  it("does not import firebase-functions at all", () => {
    for (const file of ["cli.ts", "guard.ts", "plan.ts", "signature.ts"]) {
      const source = fromFunctions("src", "cleanup", file);
      assert.ok(
        !source.includes("firebase-functions"),
        `cleanup/${file} must not import firebase-functions`
      );
    }
  });
});
