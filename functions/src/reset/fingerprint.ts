import { createHash } from "node:crypto";

/**
 * Deterministic fingerprint of the exact Firestore snapshot in scope.
 *
 * WHAT IT PROTECTS AGAINST: the dry run and the apply are two separate commands,
 * possibly minutes apart. In between, the live app could create a transaction,
 * a player could join a tournament, someone could edit a wallet. Applying a plan
 * built from stale data would then delete or overwrite documents that were never
 * reviewed.
 *
 * The fingerprint makes that impossible: it hashes every in-scope document's
 * PATH and UPDATE TIME. A document that is new, deleted, or modified changes the
 * hash, and the apply refuses to run unless the operator passes back the exact
 * fingerprint the dry run produced.
 *
 * It is a hash, so it reveals no id, uid or content — the paths go IN, only the
 * digest comes out.
 *
 * Scope is deliberately the FULL financial snapshot (every wallet, every
 * tournament, every ledger document), not merely the documents that need
 * changing. That is strictly stronger: a wallet that currently needs no write
 * would still be caught if someone dirtied it after the dry run.
 */

export interface DocumentStamp {
  /** Full document path, e.g. `wallets/abc`. Used only inside the hash. */
  readonly path: string;
  /** Firestore updateTime, as a stable string. */
  readonly updateTime: string;
}

/**
 * SHA-256 over the sorted `path@updateTime` lines.
 *
 * Sorting is what makes it deterministic: Firestore may return documents in any
 * order across runs, and an order-dependent hash would produce false aborts.
 */
export function computeFingerprint(stamps: readonly DocumentStamp[]): string {
  const canonical = stamps
    .map((stamp) => `${stamp.path}@${stamp.updateTime}`)
    .sort()
    .join("\n");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Short form for display. The full hex is what the apply requires. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16);
}
