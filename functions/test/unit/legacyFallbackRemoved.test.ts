import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ADMIN_ACCOUNT_UID } from "../../src/adminclaim/target.js";

/**
 * Structural guard for phase 2: the legacy-UID authorization fallback is gone
 * from every DEPLOYABLE path, and the historical identifier survives ONLY inside
 * the local, non-deployable admin:claim tool (`src/adminclaim`, compiled to
 * `lib/adminclaim`, which `firebase.json` excludes from deploy).
 */

function functionsDir(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "src", "domain", "adminAuth.ts"))) return cwd;
  if (existsSync(join(cwd, "functions", "src", "domain", "adminAuth.ts"))) {
    return join(cwd, "functions");
  }
  throw new Error(`cannot locate functions dir from cwd: ${cwd}`);
}

/** Every `.ts` file under a directory, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const ROOT = functionsDir();
const SRC = join(ROOT, "src");
const read = (path: string): string => readFileSync(path, "utf8");
const isToolFile = (path: string): boolean =>
  path.includes(join("src", "adminclaim"));

describe("phase 2 — no deployable UID fallback remains", () => {
  it("no deployable source carries the account uid, LEGACY_ADMIN_UID, or isLegacyAdmin", () => {
    const deployable = tsFiles(SRC).filter((path) => !isToolFile(path));
    for (const file of deployable) {
      const src = read(file);
      assert.ok(!src.includes(ADMIN_ACCOUNT_UID), `${file}: has the account uid`);
      assert.ok(!/LEGACY_ADMIN_UID/.test(src), `${file}: refs LEGACY_ADMIN_UID`);
      assert.ok(!/isLegacyAdmin/.test(src), `${file}: refs isLegacyAdmin`);
    }
  });

  it("the account uid lives ONLY inside the non-deployable tool", () => {
    const withUid = tsFiles(SRC).filter((path) => read(path).includes(ADMIN_ACCOUNT_UID));
    assert.ok(withUid.length > 0, "the uid must still exist for the tool");
    for (const file of withUid) {
      assert.ok(isToolFile(file), `${file}: uid outside the local tool`);
    }
  });

  it("firestore.rules has no legacy UID fallback, only the claim check", () => {
    const rules = read(join(ROOT, "..", "firestore.rules"));
    assert.ok(!rules.includes(ADMIN_ACCOUNT_UID), "rules still name the uid");
    assert.doesNotMatch(rules, /isLegacyAdmin/);
    assert.match(rules, /hasAdminClaim/);
  });

  it("index.ts does not export or reference the adminclaim tool", () => {
    assert.ok(!read(join(SRC, "index.ts")).includes("adminclaim"));
  });

  it("lib/adminclaim stays excluded from the deploy package", () => {
    const firebaseJson = JSON.parse(read(join(ROOT, "..", "firebase.json"))) as {
      functions: Array<{ ignore: string[] }>;
    };
    assert.ok(firebaseJson.functions[0].ignore.includes("lib/adminclaim"));
  });
});
