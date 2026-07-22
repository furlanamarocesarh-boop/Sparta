import { DomainError } from "./errors.js";

/**
 * Admin authorization.
 *
 * Authorization is the Firebase Auth custom claim `admin: true` — and ONLY that.
 * No UID, email, or any other identifier grants access. This is phase 2 of
 * `docs/admin-transition.md`: the transitional legacy-UID fallback has been
 * removed from every deployable path, leaving a single, claim-based check.
 *
 * There is exactly one authorization check, centralized here and reused by the
 * callables in `index.ts`, so it can never drift between functions.
 */

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

/**
 * True when the caller holds the `admin: true` custom claim.
 *
 * Strict `=== true`: a truthy value such as the string "true", the number 1, a
 * missing claim, `false`, or `null` must NOT grant admin. This is the sole
 * authorization signal — the caller's uid is deliberately never consulted.
 */
export function hasAdminClaim(auth: AuthLike): boolean {
  return auth.token?.admin === true;
}

/** Admin access is granted by the custom claim alone. */
export function isAdmin(auth: AuthLike): boolean {
  return hasAdminClaim(auth);
}

/**
 * Throws unless the caller is signed in AND an administrator.
 *
 * Messages and error codes are unchanged from the deployed functions so existing
 * clients keep showing the same text.
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
