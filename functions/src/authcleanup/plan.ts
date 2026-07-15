import { AuthSnapshot, computeAuthFingerprint, countSnapshot, findOrphans } from "./detect.js";

/**
 * Planning for the orphan-auth cleanup — pure, no Firebase.
 *
 * The ONLY operation this tool can ever plan is a single `auth.deleteUser`. No
 * Firestore write is ever planned — not a create, not an update, not a delete.
 * That is enforced by the plan shape itself: there is nowhere to put a Firestore
 * operation.
 */

/**
 * More Auth accounts than this is not a test project. It triggers a refusal, not
 * an automatic delete — a cleanup touching thousands of accounts deserves a
 * human first.
 */
export const LARGE_AUTH_THRESHOLD = 1_000;

export interface AuthCleanupPlan {
  /** The single account to delete. Its uid is internal — never rendered. */
  readonly targetUid: string;
  readonly fingerprint: string;
  readonly counts: ReturnType<typeof countSnapshot>;
  /** Always exactly 1 when a plan exists: one deleteUser, zero Firestore ops. */
  readonly deleteUserOps: 1;
  readonly firestoreOps: 0;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: AuthCleanupPlan }
  | { readonly ok: false; readonly reason: string; readonly counts: ReturnType<typeof countSnapshot> };

export function buildAuthCleanupPlan(snapshot: AuthSnapshot): PlanResult {
  const counts = countSnapshot(snapshot);

  if (snapshot.accounts.length > LARGE_AUTH_THRESHOLD) {
    return {
      ok: false,
      counts,
      reason:
        `Existem ${snapshot.accounts.length} contas de Auth, acima do limite de ` +
        `revisão (${LARGE_AUTH_THRESHOLD}). Isso não é o esperado para um projeto ` +
        "de teste. REVISÃO MANUAL NECESSÁRIA — nenhuma exclusão automática.",
    };
  }

  const orphans = findOrphans(snapshot);

  if (orphans.length === 0) {
    return {
      ok: false,
      counts,
      reason:
        "Nenhuma conta órfã encontrada. Os dados já estão limpos ou mudaram. " +
        "Nada a fazer — nenhuma exclusão.",
    };
  }

  if (orphans.length !== 1) {
    return {
      ok: false,
      counts,
      reason:
        `Esperava exatamente 1 conta órfã, encontrei ${orphans.length}. ` +
        "Abortando — nenhuma exclusão.",
    };
  }

  return {
    ok: true,
    plan: {
      targetUid: orphans[0].uid,
      fingerprint: computeAuthFingerprint(snapshot),
      counts,
      deleteUserOps: 1,
      firestoreOps: 0,
    },
  };
}
