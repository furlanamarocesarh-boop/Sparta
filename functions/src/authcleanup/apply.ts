import { AuthSnapshot, computeAuthFingerprint } from "./detect.js";
import { buildAuthCleanupPlan } from "./plan.js";

/**
 * The apply decision + execution, isolated from the CLI so it can be tested
 * with fakes — no Firebase, no network.
 *
 * The ONLY side-effecting capability it is given is `deleteUser`. It receives no
 * Firestore write surface at all, so a Firestore write is not "avoided by
 * discipline" here — it is impossible, because there is nothing to call.
 */

export interface DeleteUserFn {
  (uid: string): Promise<void>;
}

export type ApplyOutcome =
  | { readonly ok: true; readonly deletedCount: 1 }
  | { readonly ok: false; readonly reason: string };

/**
 * Re-validates the fresh snapshot against the operator's expected fingerprint,
 * then deletes exactly one orphan.
 *
 * @param fresh   the snapshot re-read immediately before applying
 * @param expectedFingerprint  the hash the operator passed on the command line
 * @param deleteUser  the ONLY effect available
 */
export async function applyOrphanDeletion(
  fresh: AuthSnapshot,
  expectedFingerprint: string,
  deleteUser: DeleteUserFn
): Promise<ApplyOutcome> {
  const result = buildAuthCleanupPlan(fresh);
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  if (computeAuthFingerprint(fresh) !== expectedFingerprint) {
    return {
      ok: false,
      reason:
        "o fingerprint não corresponde ao estado atual — alguma conta fez " +
        "login ou os dados mudaram desde o dry-run. Nenhuma exclusão.",
    };
  }

  try {
    await deleteUser(result.plan.targetUid);
  } catch (error) {
    // A failed delete is a FAILURE, never a success.
    return { ok: false, reason: `a exclusão falhou: ${(error as Error).message}` };
  }

  return { ok: true, deletedCount: 1 };
}
