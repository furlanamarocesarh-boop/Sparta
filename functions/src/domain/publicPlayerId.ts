import { invalidArgument } from "./errors.js";

/**
 * Public pseudonymous player identity — the PURE domain rules, with no
 * `firebase-functions` and no Admin SDK import, so every branch is unit-tested
 * without a database.
 *
 * WHAT A `publicPlayerId` IS (frozen contract — design section 5.2):
 *  - 16 cryptographically random bytes, encoded base64url without padding,
 *    which is EXACTLY 22 characters matching `[A-Za-z0-9_-]{22}`;
 *  - created exclusively by the server, create-only, immutable once assigned,
 *    never reused by another account, and stable across seasons;
 *  - NOT derived from the uid, from `player_id`, from an e-mail, a phone or a
 *    name. Randomness — not derivation — is what makes it safe: a derived id
 *    (even hashed) would let anyone holding a uid confirm a player's presence
 *    on a public leaderboard.
 *
 * WHY A NEW IDENTITY EXISTS AT ALL. Every identifier already in the backend was
 * rejected: the raw uid is an enumeration surface, `users.player_id` is a
 * 900 000-value `PLR-` space with no reservation, `users.username` is
 * permanently empty, and e-mail/phone are PII that is never public.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. Generating an id needs a source of
 * randomness, and reserving one needs a transaction over
 * `public_player_ids/{uid}` and `public_player_id_index/{publicPlayerId}`;
 * both belong to the handler layer. This module owns only the frozen FORMAT,
 * its VALIDATION and the LABEL derivation — the parts that are deterministic
 * and therefore provable in a unit test.
 */

/**
 * The private, server-only uid -> `publicPlayerId` association. Keyed by uid,
 * created once, never updated and never deleted — which is what makes the
 * pseudonym immutable. Rules-denied to every client in both directions, so the
 * pseudonym can never be resolved back to an account.
 */
export const PUBLIC_PLAYER_ID_COLLECTION = "public_player_ids";

/**
 * The reverse uniqueness guard, keyed BY the `publicPlayerId`. The document id
 * *is* the lock — Firestore guarantees at most one — so a collision check is a
 * create-only write rather than a read-then-write race, and a released id can
 * never be handed to a second account.
 */
export const PUBLIC_PLAYER_ID_INDEX_COLLECTION = "public_player_id_index";

/**
 * The entropy behind one identity. 16 bytes is what makes the id unguessable
 * and makes a collision vanishingly improbable; the index collection above then
 * makes create-only correctness structural rather than probabilistic.
 */
export const PUBLIC_PLAYER_ID_ENTROPY_BYTES = 16;

/**
 * 16 bytes in base64url without padding is exactly 22 characters — the length
 * is a consequence of the entropy, not an independent choice, so the two
 * constants must never be edited apart.
 */
export const PUBLIC_PLAYER_ID_LENGTH = 22;

/** The literal prefix of the MVP's visual label (design section 5.3). */
export const PUBLIC_PLAYER_LABEL_PREFIX = "Jogador ";

/** How many leading characters of the id the label shows. */
export const PUBLIC_PLAYER_LABEL_VISIBLE_CHARS = 8;

/**
 * The base64url alphabet and nothing else: `+`, `/` and `=` are standard
 * base64 and must never appear, because the id travels in document ids and in
 * paging cursors where those characters are not safe.
 *
 * Built from [PUBLIC_PLAYER_ID_LENGTH] so the length lives in one place.
 */
const PUBLIC_PLAYER_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${PUBLIC_PLAYER_ID_LENGTH}}$`
);

/**
 * Encodes exactly [PUBLIC_PLAYER_ID_ENTROPY_BYTES] random bytes into the frozen
 * id format.
 *
 * The bytes come from the caller — this module never invents them. That split
 * is what keeps the domain deterministic: the same bytes always produce the
 * same id, so the format is unit-testable, while the randomness that makes a
 * real id unguessable stays in the handler layer.
 *
 * A wrong byte count is rejected rather than truncated or padded: silently
 * accepting 8 bytes would ship an id that still LOOKS valid while carrying half
 * the entropy the contract promises.
 */
export function encodePublicPlayerId(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw invalidArgument("Bytes inválidos para o identificador público.");
  }

  if (bytes.length !== PUBLIC_PLAYER_ID_ENTROPY_BYTES) {
    throw invalidArgument(
      "O identificador público exige exatamente " +
        `${PUBLIC_PLAYER_ID_ENTROPY_BYTES} bytes de entropia.`
    );
  }

  const encoded = Buffer.from(bytes).toString("base64url");

  // Defensive, not decorative: the format is the security contract, so it is
  // verified on the way out instead of being assumed from the byte count.
  return assertPublicPlayerId(encoded);
}

/** Whether a value is a well-formed `publicPlayerId`. */
export function isPublicPlayerId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_PLAYER_ID_PATTERN.test(value);
}

/**
 * Returns the value when it is a well-formed `publicPlayerId`, and throws
 * otherwise. Used at every boundary that accepts an id from outside this
 * module, so a malformed pseudonym can never reach a document id, a cursor or
 * a public response.
 */
export function assertPublicPlayerId(value: unknown): string {
  if (!isPublicPlayerId(value)) {
    throw invalidArgument("Identificador público inválido.");
  }

  return value;
}

/**
 * The MVP's presentation label: `Jogador ` followed by the first eight
 * characters of the id.
 *
 * PRESENTATION ONLY. The full 22-character id remains the technical identity of
 * a leaderboard row, its ordering key and the value `getMySeasonRanking` and
 * the paging cursors use. Two players may therefore share a visual label; that
 * is accepted for the MVP precisely BECAUSE the label carries no authority —
 * nothing is ever looked up, ordered or identified by it.
 */
export function publicPlayerLabel(publicPlayerId: string): string {
  const validated = assertPublicPlayerId(publicPlayerId);

  return (
    PUBLIC_PLAYER_LABEL_PREFIX +
    validated.slice(0, PUBLIC_PLAYER_LABEL_VISIBLE_CHARS)
  );
}
