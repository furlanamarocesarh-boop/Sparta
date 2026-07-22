/**
 * The administrative account the local `admin:claim` tool targets.
 *
 * WHY it lives HERE and not in `domain/adminAuth.ts`: as of phase 2 of
 * `docs/admin-transition.md`, the legacy UID is no longer an authorization
 * mechanism anywhere in deployable code. This constant is used ONLY by the
 * non-deployable `admin:claim` tool to name WHICH already-registered account
 * should receive (or be verified for) the `admin: true` custom claim.
 *
 * It grants no access on its own, is never imported by `index.ts` or any Cloud
 * Function, and its compiled output (`lib/adminclaim`) is excluded from the
 * deploy package (`firebase.json`). It must never be used for authorization.
 */
export const ADMIN_ACCOUNT_UID = "Fnj4w17GGeP7XgQ5yF3gXTL1yR42";
