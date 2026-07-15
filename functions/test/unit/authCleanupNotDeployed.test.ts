import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const FILES = ["cli.ts", "guard.ts", "plan.ts", "detect.ts", "apply.ts"];

/** Reads a reset/authcleanup source with comments stripped (code is what matters). */
const readSource = (file: string): string => {
  const raw = readFileSync(
    resolve(process.cwd(), "src", "authcleanup", file),
    "utf8"
  );
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
};

describe("the orphan-auth cleanup is not deployable", () => {
  it("is NOT exported from src/index.ts", () => {
    const index = readFileSync(resolve(process.cwd(), "src", "index.ts"), "utf8");
    assert.ok(
      !index.includes("authcleanup"),
      "index.ts must not reference the tool"
    );
  });

  it("is excluded from the deploy package in firebase.json", () => {
    const raw = readFileSync(resolve(process.cwd(), "..", "firebase.json"), "utf8");
    const config = JSON.parse(raw) as { functions: { ignore: string[] }[] };
    assert.ok(
      config.functions[0].ignore.includes("lib/authcleanup"),
      "firebase.json must ignore lib/authcleanup"
    );
  });

  it("never declares a callable or an HTTP endpoint", () => {
    for (const file of FILES) {
      const source = readSource(file);
      for (const forbidden of ["onCall", "onRequest", "functions.https"]) {
        assert.ok(
          !source.includes(forbidden),
          `authcleanup/${file} must not contain "${forbidden}"`
        );
      }
    }
  });

  it("does not import firebase-functions", () => {
    for (const file of FILES) {
      assert.ok(
        !readSource(file).includes("firebase-functions"),
        `authcleanup/${file} must not import firebase-functions`
      );
    }
  });

  it("performs no Firestore write anywhere in the tool", () => {
    // The only mutation this tool may do is auth.deleteUser. No Firestore write
    // method may appear. NOTE: `.add(` is intentionally NOT in this list — the
    // tool calls `Set.prototype.add` while building the snapshot, which is not
    // a Firestore write; matching it would be a false positive.
    for (const file of FILES) {
      const source = readSource(file);
      for (const write of [
        ".set(",
        ".create(",
        ".update(",
        ".delete(",
        "bulkWriter",
        "runTransaction",
        "recursiveDelete",
      ]) {
        assert.ok(
          !source.includes(write),
          `authcleanup/${file} must not call Firestore "${write}"`
        );
      }
    }
  });

  it("calls the real auth.deleteUser exactly once, at a single wiring point", () => {
    // The Firebase call itself (`auth.deleteUser`) must appear exactly once, in
    // cli.ts, where it is handed into applyOrphanDeletion. Everywhere else
    // "deleteUser" is a type or a plain parameter, not a live Auth deletion.
    const allSources = FILES.map(readSource).join("\n");
    const realCalls = allSources.match(/auth\.deleteUser\(/g) ?? [];
    assert.equal(
      realCalls.length,
      1,
      `auth.deleteUser must be called exactly once, found ${realCalls.length}`
    );
  });
});
