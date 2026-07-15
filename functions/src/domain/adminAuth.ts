import { DomainError } from "./errors.js";

/**
 * Admin authorization.
 *
 * WHY: the deployed code repeats `uid !== "Fnj4w17..."` inside `testdeposit`
 * and `payprize`. Duplicated authorization is how one copy eventually drifts
 * from the other. There is now exactly one check.
 *
 * TRANSITION: authorization is moving from "this one hard-coded UID" to a
 * Firebase Auth custom claim (`admin: true`). Both are accepted for now. The
 * legacy UID is kept ONLY so the existing administrator is not locked out the
 * moment this deploys — removing it before the claim is live would be an
 * outage, not a hardening.
 *
 * See `docs/admin-transition.md` for the two-stage removal procedure. The
 * fallback must not be removed until the claim is assigned, the ID token has
 * been refreshed, and admin operations have been verified.
 */

/**
 * COMPATIBILITY CONSTANT — TEMPORARY.
 *
 * The single legacy administrator UID, previously hard-coded in two separate
 * functions and in `firestore.rules`. Delete this (and the `firestore.rules`
 * fallback) only after completing stage 2 of `docs/admin-transition.md`.
 */
export const LEGACY_ADMIN_UID = "Fnj4w17GGeP7XgQ5yF3gXTL1yR42";

/**
 * The subset of a callable's `context.auth` this check needs.
 *
 * `token` is an open record rather than `{ admin?: boolean }` so that Firebase's
 * `DecodedIdToken` (which carries an `[key: string]: any` index signature plus
 * its own claims) is structurally assignable to it. A narrow shape would have
 * no properties in common with `DecodedIdToken` and fail to type-check.
 */
export interface AuthLike {
  readonly uid: string;
  readonly token?: Record<string, unknown>;
}

export interface ContextLike {
  readonly auth?: AuthLike | null;
}

/** True when the caller holds the `admin: true` custom claim. */
export function hasAdminClaim(auth: AuthLike): boolean {
  // Strict `=== true`: a truthy string like "false" must not grant admin.
  return auth.token?.admin === true;
}

/** True when the caller is the legacy administrator (transitional). */
export function isLegacyAdmin(auth: AuthLike): boolean {
  return auth.uid === LEGACY_ADMIN_UID;
}

export function isAdmin(auth: AuthLike): boolean {
  return hasAdminClaim(auth) || isLegacyAdmin(auth);
}

/**
 * Throws unless the caller is signed in AND an administrator.
 *
 * Messages are unchanged from the deployed functions so existing clients keep
 * showing the same text.
 */
export function assertAdmin(
  context: ContextLike,
  unauthenticatedMessage: string,
  permissionDeniedMessage: string
): AuthLike {
  const auth = context.auth;

  if (!auth) {
    throw new DomainError("unauthenticated", unauthenticatedMessage);
  }

  if (!isAdmin(auth)) {
    throw new DomainError("permission-denied", permissionDeniedMessage);
  }

  return auth;
}

/** Throws unless the caller is signed in. Returns the auth for convenience. */
export function assertSignedIn(
  context: ContextLike,
  message: string
): AuthLike {
  const auth = context.auth;
  if (!auth) {
    throw new DomainError("unauthenticated", message);
  }
  return auth;
}
