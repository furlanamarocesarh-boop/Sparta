import { WALLET_MONEY_FIELDS } from "../audit/walletAudit.js";
import { classify, TargetKind, WalletCandidate } from "./signature.js";

/**
 * Planning and execution of the cleanup — pure, no Firebase.
 *
 * The write surface is [TxLike]: `update` and `delete`, nothing else. There is
 * no `set` (which would clobber the non-financial fields of Wallet A), no
 * collection delete, and no batch. A test drives this with a recorder and
 * asserts the EXACT list of operations, so "we only touch three documents" is a
 * verified fact rather than a claim.
 */

/** The minimal Firestore transaction surface this cleanup is allowed to use. */
export interface TxLike {
  update(ref: unknown, data: Record<string, unknown>): void;
  delete(ref: unknown): void;
}

export interface CandidateWithId {
  /** Internal only — never rendered. */
  readonly id: string;
  readonly candidate: WalletCandidate;
}

export interface CleanupTargets {
  readonly walletA: CandidateWithId;
  readonly walletB: CandidateWithId;
}

export type PlanResult =
  | { readonly ok: true; readonly targets: CleanupTargets }
  | { readonly ok: false; readonly reason: string };

/**
 * Requires EXACTLY one Wallet A and EXACTLY one Wallet B.
 *
 * Zero matches means the cleanup already ran (or the data changed) — safe, and
 * reported as "nothing to do". Two matches means the signature is not as unique
 * as we believed, which is a reason to stop and think, never to guess.
 */
export function buildPlan(
  candidates: readonly CandidateWithId[]
): PlanResult {
  const matches = candidates.map((entry) => ({
    entry,
    kind: classify(entry.candidate),
  }));

  const walletAs = matches.filter((m) => m.kind === "wallet-a");
  const walletBs = matches.filter((m) => m.kind === "wallet-b");

  if (walletAs.length === 0 && walletBs.length === 0) {
    return {
      ok: false,
      reason:
        "Nenhum alvo encontrado. Os dados já foram limpos ou mudaram. " +
        "Nada a fazer — nenhuma escrita.",
    };
  }

  if (walletAs.length !== 1) {
    return {
      ok: false,
      reason: `Esperava exatamente 1 Wallet A, encontrei ${walletAs.length}. Abortando sem escrever.`,
    };
  }

  if (walletBs.length !== 1) {
    return {
      ok: false,
      reason: `Esperava exatamente 1 Wallet B, encontrei ${walletBs.length}. Abortando sem escrever.`,
    };
  }

  return {
    ok: true,
    targets: { walletA: walletAs[0].entry, walletB: walletBs[0].entry },
  };
}

/** The exact field writes applied to Wallet A. */
export function walletAResetFields(userRef: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of WALLET_MONEY_FIELDS) {
    fields[field] = 0;
  }
  // Repairs the absent user_ref, pointing it at its own owner.
  fields.user_ref = userRef;
  return fields;
}

export interface CleanupRefs {
  readonly walletARef: unknown;
  readonly walletAUserRef: unknown;
  /** The single fake prize transaction on Wallet A. */
  readonly fakeTransactionRef: unknown;
  readonly walletBRef: unknown;
}

/**
 * Performs the cleanup. Three operations, no more.
 *
 * `update` (not `set`) is what preserves Wallet A's non-financial fields: it
 * merges the listed keys and leaves everything else — `user_ref` aside — exactly
 * as it was. A `set` would silently erase them.
 *
 * Called INSIDE a Firestore transaction by the CLI, so either all three land or
 * none do. There is no partial success.
 */
export function executeCleanup(tx: TxLike, refs: CleanupRefs): void {
  tx.update(refs.walletARef, walletAResetFields(refs.walletAUserRef));
  tx.delete(refs.fakeTransactionRef);
  tx.delete(refs.walletBRef);
}

/** Human-readable, anonymized description of what the plan would do. */
export function describePlan(): string[] {
  return [
    "Wallet A:",
    "  - preservar o documento e todos os campos não financeiros;",
    "  - definir balance          = 0",
    "  - definir total_deposited  = 0",
    "  - definir total_won        = 0",
    "  - definir total_spent      = 0",
    "  - definir total_withdrawn  = 0",
    "  - definir user_ref para o users/{uid} correspondente;",
    "  - remover 1 transaction falsa (category=prize, status=completed, R$ 20,00);",
    "  - NÃO remover o usuário nem a autenticação.",
    "",
    "Wallet B:",
    "  - remover exclusivamente o documento da wallet órfã.",
  ];
}

export type { TargetKind };
