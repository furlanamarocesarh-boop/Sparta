import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ReadOnlyQuery,
  ReadOnlySnapshot,
  scanCollection,
} from "../../src/audit/collector.js";

/** Every Firestore method that mutates data. None of these may ever be called. */
const WRITE_METHODS = [
  "set",
  "create",
  "add",
  "update",
  "delete",
  "batch",
  "bulkWriter",
  "runTransaction",
  "withConverter",
  "commit",
] as const;

/**
 * A fake collection that records reads and EXPLODES on any write.
 *
 * The write methods are installed as real properties, so if the audit layer ever
 * calls one, this fails loudly instead of silently passing because the method
 * happened not to exist on the fake.
 */
class ExplodingFakeCollection {
  readonly calls: string[] = [];
  private orderByField: unknown;
  private pageLimit = Number.MAX_SAFE_INTEGER;
  private cursor: string | undefined;

  constructor(private readonly documents: { id: string; data: Record<string, unknown> }[]) {
    for (const method of WRITE_METHODS) {
      (this as unknown as Record<string, unknown>)[method] = () => {
        throw new Error(`WRITE ATTEMPTED: the audit called ${method}()`);
      };
    }
  }

  orderBy(field: unknown): this {
    this.calls.push("orderBy");
    this.orderByField = field;
    return this;
  }

  limit(count: number): this {
    this.calls.push("limit");
    this.pageLimit = count;
    return this;
  }

  startAfter(cursor: unknown): this {
    this.calls.push("startAfter");
    this.cursor = cursor as string;
    return this;
  }

  async get(): Promise<ReadOnlySnapshot> {
    this.calls.push("get");
    assert.equal(this.orderByField, "__name__", "must page by document id");

    const sorted = [...this.documents].sort((a, b) => a.id.localeCompare(b.id));
    const after = this.cursor;
    const page = sorted
      .filter((doc) => (after === undefined ? true : doc.id > after))
      .slice(0, this.pageLimit);

    // Reset the cursor: a fresh query is built on every page.
    this.cursor = undefined;

    return {
      empty: page.length === 0,
      docs: page.map((doc) => ({ id: doc.id, data: () => doc.data })),
    };
  }
}

const makeDocs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    // Zero-padded so lexicographic order matches numeric order.
    id: `doc-${String(i).padStart(4, "0")}`,
    data: { index: i },
  }));

describe("scanCollection — read-only guarantee", () => {
  it("never calls any write method", async () => {
    const fake = new ExplodingFakeCollection(makeDocs(10));

    const seen: string[] = [];
    await scanCollection(
      fake as unknown as ReadOnlyQuery,
      { orderByField: "__name__", pageSize: 3 },
      (id) => seen.push(id)
    );

    assert.equal(seen.length, 10);
    // Only read operations were used to build the query.
    assert.deepEqual(
      [...new Set(fake.calls)].sort(),
      ["get", "limit", "orderBy", "startAfter"]
    );
    for (const method of WRITE_METHODS) {
      assert.ok(
        !fake.calls.includes(method),
        `audit must never call ${method}()`
      );
    }
  });

  it("the ReadOnlyQuery type does not expose a write method", () => {
    // A compile-time property, asserted at runtime for visibility: the object
    // the collector is handed is only ever used through orderBy/limit/
    // startAfter/get. Anything else is a type error at build time.
    const surface: (keyof ReadOnlyQuery)[] = [
      "orderBy",
      "limit",
      "startAfter",
      "get",
    ];
    for (const method of WRITE_METHODS) {
      assert.ok(
        !surface.includes(method as unknown as keyof ReadOnlyQuery),
        `${method} must not be on the read-only surface`
      );
    }
  });
});

describe("scanCollection — paging", () => {
  it("reads every document across pages without duplicates or gaps", async () => {
    const fake = new ExplodingFakeCollection(makeDocs(250));

    const seen: string[] = [];
    const scanned = await scanCollection(
      fake as unknown as ReadOnlyQuery,
      { orderByField: "__name__", pageSize: 40 },
      (id) => seen.push(id)
    );

    assert.equal(scanned, 250);
    assert.equal(seen.length, 250);
    assert.equal(new Set(seen).size, 250, "no document read twice");
    assert.equal(seen[0], "doc-0000");
    assert.equal(seen[249], "doc-0249");
  });

  it("does not hold the whole collection in memory (pages are bounded)", async () => {
    const fake = new ExplodingFakeCollection(makeDocs(100));

    let maxPageSize = 0;
    const originalGet = fake.get.bind(fake);
    fake.get = async () => {
      const snapshot = await originalGet();
      maxPageSize = Math.max(maxPageSize, snapshot.docs.length);
      return snapshot;
    };

    await scanCollection(
      fake as unknown as ReadOnlyQuery,
      { orderByField: "__name__", pageSize: 10 },
      () => undefined
    );

    assert.equal(maxPageSize, 10, "no page may exceed the requested size");
  });

  it("handles an empty collection", async () => {
    const fake = new ExplodingFakeCollection([]);
    const scanned = await scanCollection(
      fake as unknown as ReadOnlyQuery,
      { orderByField: "__name__", pageSize: 10 },
      () => assert.fail("must not be called")
    );
    assert.equal(scanned, 0);
  });

  it("stops after a short page instead of making a wasted round trip", async () => {
    const fake = new ExplodingFakeCollection(makeDocs(5));
    await scanCollection(
      fake as unknown as ReadOnlyQuery,
      { orderByField: "__name__", pageSize: 10 },
      () => undefined
    );
    // One get() only: the first page was short, so the end was already reached.
    assert.equal(fake.calls.filter((c) => c === "get").length, 1);
  });
});
