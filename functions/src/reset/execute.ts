import { ResetOperation } from "./plan.js";

/**
 * Execution of the reset — pure over an abstract write surface.
 *
 * [ResetTx] exposes only `update` and `delete`. There is no `set` (which would
 * clobber a wallet's non-financial fields), no `create`, no recursive delete and
 * no collection delete. A test drives this with a recorder and asserts the exact
 * operation list, so "we never touch users" is a verified fact, not a promise.
 */

export interface ResetTx {
  update(ref: unknown, data: Record<string, unknown>): void;
  delete(ref: unknown): void;
}

/** Resolves an operation's target into a real Firestore DocumentReference. */
export interface RefResolver {
  wallet(id: string): unknown;
  user(id: string): unknown;
  tournament(id: string): unknown;
  ledger(collection: string, id: string): unknown;
}

/**
 * Issues every planned operation onto one transaction.
 *
 * `update` (not `set`) is what preserves the non-financial fields of wallets and
 * tournaments: it merges the listed keys and leaves everything else — title,
 * prize, price, status, dates, rules, username, player_id, pix_key, whatsapp —
 * exactly as it was.
 *
 * Users are never an operand. There is no code path here that writes to
 * `users/*` or touches Firebase Auth.
 */
export function executeReset(
  tx: ResetTx,
  operations: readonly ResetOperation[],
  refs: RefResolver
): void {
  for (const operation of operations) {
    switch (operation.kind) {
      case "update-wallet": {
        tx.update(refs.wallet(operation.id), {
          ...operation.moneyFields,
          // Repairs/sets the link to its own owner. The user document itself is
          // only READ (to build this reference) — never written.
          user_ref: refs.user(operation.id),
        });
        break;
      }

      case "update-tournament": {
        tx.update(refs.tournament(operation.id), { ...operation.fields });
        break;
      }

      case "delete": {
        // Deleted by its own enumerated path. No recursive or collection-wide
        // delete exists anywhere in this tool.
        tx.delete(refs.ledger(operation.collection, operation.id));
        break;
      }
    }
  }
}
