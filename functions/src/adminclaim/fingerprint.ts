import { createHash } from "node:crypto";

/**
 * A deterministic fingerprint of the target's identity and current authorization
 * state. PURE: no Firebase, no I/O — just a hash of the values handed to it.
 *
 * WHY it exists: a custom-claim write is a check-then-act. The operator inspects
 * the account in a dry-run, then applies later. If ANY of the account's relevant
 * state (uid, disabled, existing claims) changed in between, applying the plan
 * from the stale dry-run could be wrong. The apply path recomputes this
 * fingerprint immediately before writing and refuses on any divergence.
 *
 * WHY a hash: it is safe to print and to pass on the command line. It reveals
 * neither the uid nor the claim values — only whether the state moved.
 */

export interface FingerprintInput {
  readonly uid: string;
  readonly disabled: boolean;
  readonly customClaims: Record<string, unknown> | undefined;
}

/** Recursively sorts object keys so serialization is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

export function computeFingerprint(input: FingerprintInput): string {
  const canonical = canonicalize({
    uid: input.uid,
    disabled: input.disabled,
    claims: input.customClaims ?? {},
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
