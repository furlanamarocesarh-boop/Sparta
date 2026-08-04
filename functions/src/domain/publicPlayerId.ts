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
 * both belong to the handler layer. This module owns the frozen FORMAT, its
 * VALIDATION, the LABEL derivation and the pure RESERVATION DECISION — every
 * part that is deterministic and therefore provable in a unit test.
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

/**
 * How many independent candidates one reservation may try before giving up.
 *
 * With 16 random bytes a real collision is vanishingly improbable, so this is
 * not a capacity plan — it is a defensive budget that bounds the work an
 * unexpected state (a corrupted index, a hostile clock on the entropy source)
 * can cause, and turns "retry forever" into an observable failure. The exact
 * value is an internal detail, not part of the frozen contract.
 */
export const PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS = 5;

/**
 * Normalizes the uid with the secure pattern already used by `jointournament`,
 * `grantBetaCredit`, the settlement module and `recordDailyAppOpen`: trimmed,
 * non-empty, no "/", and no longer than 200 chars — so it can never escape its
 * document path.
 */
export function normalizeIdentityUid(value: unknown): string {
  const uid = String(value || "").trim();
  if (!uid) {
    throw invalidArgument("UID do jogador é obrigatório.");
  }
  if (uid.includes("/") || uid.length > 200) {
    throw invalidArgument("UID do jogador inválido.");
  }
  return uid;
}

/** The same rule as [normalizeIdentityUid], as a predicate over stored data. */
function isUsableUid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !value.includes("/") &&
    value.length <= 200
  );
}

/** The persisted fields of `public_player_ids/{uid}`. */
export interface StoredPublicIdentityMap {
  readonly publicPlayerId?: unknown;
}

/** The persisted fields of `public_player_id_index/{publicPlayerId}`. */
export interface StoredPublicIdentityIndex {
  readonly uid?: unknown;
}

/**
 * Everything one reservation attempt read, before it decides anything.
 *
 * [indexId] records WHICH index document [index] came from. It is not
 * redundant: the authoritative index depends on what the map says — an existing
 * map must be corroborated by the index of ITS id, never of a fresh candidate —
 * so a caller that read the wrong document is caught here instead of silently
 * validating the wrong pair.
 */
export interface PublicPlayerIdReservationState {
  readonly uid: string;
  readonly candidate: string;
  readonly map: StoredPublicIdentityMap | null;
  readonly indexId: string;
  readonly index: StoredPublicIdentityIndex | null;
}

/**
 * What an attempt should do. `collision` is the ONLY outcome that may be
 * retried with fresh entropy; `fail` is terminal by design.
 */
export type PublicPlayerIdReservation =
  | { readonly kind: "reuse"; readonly publicPlayerId: string }
  | { readonly kind: "reserve"; readonly publicPlayerId: string }
  | { readonly kind: "collision"; readonly candidate: string }
  | { readonly kind: "fail"; readonly message: string };

function reservationFailure(message: string): PublicPlayerIdReservation {
  return { kind: "fail", message };
}

/**
 * Decides one reservation attempt from what it read — pure, total, and with no
 * Firestore, Admin SDK or `node:crypto` anywhere near it.
 *
 * FAIL-CLOSED IS THE WHOLE POINT. Every structural inconsistency returns
 * `fail`: a map without its index, an index without its map, an index owned by
 * a different account, a malformed field. None of them is repaired,
 * overwritten or ignored, because each one is a symptom of something this
 * module cannot see, and because "repairing" an identity would either break the
 * immutability of section 5.2 or hand a released id to a second account.
 *
 * `collision` is reserved for the ONE benign case: a candidate that legitimately
 * belongs to somebody else. That is the only state where trying again with new
 * entropy is correct rather than destructive.
 */
export function decidePublicPlayerIdReservation(
  state: PublicPlayerIdReservationState
): PublicPlayerIdReservation {
  const { uid, candidate, map, indexId, index } = state;

  if (!isUsableUid(uid)) {
    return reservationFailure("UID do jogador inválido.");
  }
  if (!isPublicPlayerId(candidate)) {
    return reservationFailure("Candidato a identificador público inválido.");
  }

  // No map: this uid has no identity yet, so the candidate's OWN index decides.
  if (map === null) {
    if (indexId !== candidate) {
      return reservationFailure(
        "Índice reverso lido não corresponde ao candidato."
      );
    }
    if (index === null) {
      return { kind: "reserve", publicPlayerId: candidate };
    }

    const ownerUid = index.uid;
    if (!isUsableUid(ownerUid)) {
      return reservationFailure("Índice reverso malformado.");
    }
    if (ownerUid === uid) {
      // The index claims this uid already holds the candidate, yet no map
      // exists. Creating the map now would adopt a reservation whose other half
      // is missing — the exact state a create-only pair is designed to prevent.
      return reservationFailure(
        "Índice reverso órfão: identificador reservado para este UID sem mapa correspondente."
      );
    }
    // Legitimately somebody else's. The only retryable outcome.
    return { kind: "collision", candidate };
  }

  // A map exists: it is authoritative, and it must be corroborated.
  const mappedId = map.publicPlayerId;
  if (!isPublicPlayerId(mappedId)) {
    return reservationFailure("Mapa de identidade pública malformado.");
  }
  if (indexId !== mappedId) {
    return reservationFailure(
      "Índice reverso lido não corresponde ao identificador mapeado."
    );
  }
  if (index === null) {
    return reservationFailure(
      "Índice reverso ausente para o identificador mapeado."
    );
  }

  const ownerUid = index.uid;
  if (!isUsableUid(ownerUid)) {
    return reservationFailure("Índice reverso malformado.");
  }
  if (ownerUid !== uid) {
    return reservationFailure("Índice reverso pertence a outro UID.");
  }

  // Both halves agree: the identity already exists. No write, ever — this is
  // what makes it immutable and stable across seasons.
  return { kind: "reuse", publicPlayerId: mappedId };
}
