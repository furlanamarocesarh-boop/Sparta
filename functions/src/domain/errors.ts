/**
 * Domain error carrying a Firebase Functions error code.
 *
 * The domain modules (money, tournament fields, admin auth) deliberately do NOT
 * import `firebase-functions`. That keeps them pure: they can be unit-tested
 * with Node's built-in test runner without initializing the Admin SDK or
 * touching a network. `index.ts` converts these into `https.HttpsError` at the
 * callable boundary, preserving the exact codes and pt-BR messages the existing
 * clients already receive.
 */
export type ErrorCode =
  | "invalid-argument"
  | "failed-precondition"
  | "unauthenticated"
  | "permission-denied"
  | "already-exists"
  | "not-found"
  | "internal";

export class DomainError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export function invalidArgument(message: string): DomainError {
  return new DomainError("invalid-argument", message);
}

export function failedPrecondition(message: string): DomainError {
  return new DomainError("failed-precondition", message);
}
