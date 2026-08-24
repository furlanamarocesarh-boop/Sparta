import { DomainError } from "./errors.js";

/**
 * The Sparta nickname — the last step of signing up, and the thing that makes
 * a registration COMPLETE.
 *
 * WHY THIS EXISTS. `users/{uid}.username` is written as `""` by the auth
 * trigger and never populated: the client sets a display name on the Auth
 * profile AFTER the trigger has already run, and the trigger gets no callback.
 * `docs/username.md` states the fix outright — "an authenticated callable,
 * deliberately NOT added here". This is that callable's domain.
 *
 * SO THE NAME LIVES IN FIRESTORE, SET BY THE PLAYER, THROUGH THE SERVER. Not
 * on the Auth profile, which no server-side feature can read reliably, and not
 * written by the client, which could then take a name someone else holds.
 *
 * UNIQUENESS IS A RESERVATION, the same shape `referral_codes` uses: a document
 * whose ID is the normalised name. Two people typing "spartano" at the same
 * instant cannot both get it, because the second `create` fails — where a
 * read-then-write check would let both through.
 */

export const NICKNAMES_COLLECTION = "nicknames";

export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 20;

/**
 * The normalised form used as the reservation id.
 *
 * CASE AND ACCENTS ARE FOLDED so "Spartano", "spartano" and "spártano" are ONE
 * name. Letting them coexist is how impersonation starts: a player reading a
 * roster cannot tell them apart, which is the entire point of taking a name
 * that close to someone else's.
 *
 * The DISPLAY form keeps what the player typed — folding is for collision
 * detection, not for taking their capitalisation away.
 */
export function normalizeNickname(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    // Strip combining marks: á -> a. Done after lowercasing so the ranges hold.
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Validates what the player typed and returns both forms, or refuses.
 *
 * ALLOWED: letters, digits, underscore. No spaces, no punctuation, no emoji.
 * A roster, a leaderboard and a share link all render this string, and a name
 * containing a space or a control character breaks at least one of them —
 * usually silently, and usually only for other players.
 */
export function parseNickname(raw: unknown): {
  readonly display: string;
  readonly normalized: string;
} {
  const display = String(raw ?? "").trim();

  if (display.length < NICKNAME_MIN || display.length > NICKNAME_MAX) {
    throw new DomainError(
      "invalid-argument",
      `O nick precisa ter de ${NICKNAME_MIN} a ${NICKNAME_MAX} caracteres.`
    );
  }

  // Checked on the DISPLAY form: folding first would accept an accented name
  // and then silently store a different string than the player chose.
  if (!/^[\p{L}\p{N}_]+$/u.test(display)) {
    throw new DomainError(
      "invalid-argument",
      "O nick aceita apenas letras, números e _."
    );
  }

  const normalized = normalizeNickname(display);
  if (normalized.length < NICKNAME_MIN) {
    // Possible when the name is all combining marks — it renders as something,
    // and folds to almost nothing, which is exactly an impersonation vector.
    throw new DomainError("invalid-argument", "Escolha outro nick.");
  }

  if (RESERVED_NICKNAMES.has(normalized)) {
    throw new DomainError("invalid-argument", "Este nick não está disponível.");
  }

  return { display, normalized };
}

/**
 * Names nobody may hold.
 *
 * They read as the platform speaking rather than a player, and a message from
 * "sparta" or "suporte" in a roster or a chat is the cheapest impersonation
 * there is. Checked BEFORE length so the list is authoritative — a lesson the
 * referral codes already taught, where a short reserved code slipped through a
 * minimum-length check that ran first.
 */
export const RESERVED_NICKNAMES: ReadonlySet<string> = new Set([
  "sparta",
  "spartagg",
  "admin",
  "administrador",
  "suporte",
  "support",
  "oficial",
  "staff",
  "moderador",
  "mod",
  "sistema",
  "system",
  "root",
  "null",
  "undefined",
]);

/**
 * Whether an account's registration is COMPLETE.
 *
 * THE THREE STEPS, in the order they happen: e-mail and password (done at
 * signup), KYC, and the Sparta nickname. All three are required, and this is
 * the single place that says so — every feature that needs "is this a real,
 * finished account" asks here rather than inventing its own test.
 *
 * `kycVerified` is a PARAMETER because KYC does not exist in this backend yet.
 * When it lands it plugs in here and nothing else changes. Until then callers
 * pass what they know, and the flag being required — rather than defaulted to
 * true — is what stops "KYC is coming" from quietly meaning "KYC is optional".
 */
export function isRegistrationComplete(input: {
  readonly nickname: unknown;
  readonly kycVerified: boolean;
}): boolean {
  const nickname = String(input.nickname ?? "").trim();
  return input.kycVerified && nickname.length >= NICKNAME_MIN;
}
