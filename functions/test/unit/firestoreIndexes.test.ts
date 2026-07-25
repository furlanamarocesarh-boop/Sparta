import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Versioned Firestore composite indexes.
 *
 * The legacy-cash refund path in `cancelTournament` locates the original entry
 * ledger with the in-transaction query
 *   transactions WHERE category == X AND user_ref == Y AND tournament_ref == Z
 * The emulator serves it without an index, but PRODUCTION requires the
 * composite index below — so it is versioned and wired into firebase.json,
 * ready for a future `firebase deploy --only firestore:indexes` (NOT run here).
 */

function repoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "firestore.indexes.json"))) return cwd;
  if (existsSync(join(cwd, "..", "firestore.indexes.json"))) {
    return join(cwd, "..");
  }
  throw new Error(`cannot locate firestore.indexes.json from cwd: ${cwd}`);
}

describe("firestore.indexes.json", () => {
  const raw = readFileSync(join(repoRoot(), "firestore.indexes.json"), "utf8");

  it("é JSON sintaticamente válido no formato oficial", () => {
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.indexes), "indexes must be an array");
    assert.ok(
      Array.isArray(parsed.fieldOverrides),
      "fieldOverrides must be preserved as an array"
    );
  });

  it("contém EXATAMENTE o índice composto do ledger legado (category, user_ref, tournament_ref ASC)", () => {
    const parsed = JSON.parse(raw) as {
      indexes: Array<{
        collectionGroup: string;
        queryScope: string;
        fields: Array<{ fieldPath: string; order: string }>;
      }>;
    };

    const match = parsed.indexes.find(
      (index) =>
        index.collectionGroup === "transactions" &&
        index.queryScope === "COLLECTION" &&
        index.fields.length === 3 &&
        index.fields[0].fieldPath === "category" &&
        index.fields[0].order === "ASCENDING" &&
        index.fields[1].fieldPath === "user_ref" &&
        index.fields[1].order === "ASCENDING" &&
        index.fields[2].fieldPath === "tournament_ref" &&
        index.fields[2].order === "ASCENDING"
    );
    assert.ok(match, "the legacy-ledger composite index must be present");

    // Sem duplicatas equivalentes.
    const equivalents = parsed.indexes.filter(
      (index) =>
        index.collectionGroup === "transactions" &&
        JSON.stringify(index.fields.map((f) => f.fieldPath)) ===
          JSON.stringify(["category", "user_ref", "tournament_ref"])
    );
    assert.equal(equivalents.length, 1, "no duplicated equivalent index");
  });

  it("firebase.json aponta para o arquivo de índices", () => {
    const firebaseJson = JSON.parse(
      readFileSync(join(repoRoot(), "firebase.json"), "utf8")
    ) as { firestore?: { rules?: string; indexes?: string } };
    assert.equal(firebaseJson.firestore?.rules, "firestore.rules");
    assert.equal(firebaseJson.firestore?.indexes, "firestore.indexes.json");
  });
});
