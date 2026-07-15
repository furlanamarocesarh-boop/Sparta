/**
 * Paged, read-only collection reader.
 *
 * The type it accepts — [ReadOnlyQuery] — exposes ONLY `orderBy`, `limit`,
 * `startAfter` and `get`. There is no `set`, `add`, `update`, `delete`,
 * `batch`, `bulkWriter` or `runTransaction` on it. That is the point: a write
 * from this layer is not "forbidden by convention", it is unrepresentable in
 * the type system. Firestore's real `CollectionReference` satisfies this
 * interface structurally, so nothing is lost at the call site.
 *
 * Reading is paged so a large collection is never held in memory at once: one
 * page is fetched, each document handed to the callback, and the page dropped
 * before the next is requested.
 */

export interface ReadOnlyDoc {
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}

export interface ReadOnlySnapshot {
  readonly docs: readonly ReadOnlyDoc[];
  readonly empty: boolean;
}

export interface ReadOnlyQuery {
  /** Equality filter. A read operation — it narrows, it never mutates. */
  where(field: string, op: "==", value: unknown): ReadOnlyQuery;
  orderBy(field: unknown): ReadOnlyQuery;
  limit(count: number): ReadOnlyQuery;
  startAfter(cursor: unknown): ReadOnlyQuery;
  get(): Promise<ReadOnlySnapshot>;
}

export const DEFAULT_PAGE_SIZE = 200;

export interface ScanOptions {
  /** The field to page by. The CLI passes Firestore's document-id FieldPath. */
  readonly orderByField: unknown;
  readonly pageSize?: number;
}

/**
 * Streams every document of a collection through [onDocument].
 *
 * Returns the number of documents read. Paging uses the document id as the
 * cursor, which is stable and total — no document can be skipped or visited
 * twice, even if documents are written concurrently by the live app.
 */
export async function scanCollection(
  collection: ReadOnlyQuery,
  options: ScanOptions,
  onDocument: (id: string, data: Record<string, unknown>) => void
): Promise<number> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  let cursor: string | undefined;
  let scanned = 0;

  for (;;) {
    let query = collection.orderBy(options.orderByField).limit(pageSize);
    if (cursor !== undefined) {
      query = query.startAfter(cursor);
    }

    const snapshot = await query.get();
    if (snapshot.empty || snapshot.docs.length === 0) {
      return scanned;
    }

    for (const doc of snapshot.docs) {
      onDocument(doc.id, doc.data() ?? {});
      scanned++;
      cursor = doc.id;
    }

    // A short page means we reached the end; asking again would be a wasted
    // round trip against production.
    if (snapshot.docs.length < pageSize) {
      return scanned;
    }
  }
}
