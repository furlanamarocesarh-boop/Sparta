import { DomainError } from "./errors.js";

/**
 * Tournament room access — the PURE rules, with no `firebase-functions` import,
 * so every branch is unit-tested without the Admin SDK or a network. `index.ts`
 * does the Firestore reads and feeds their results into these functions.
 *
 * The room credentials (id + password) are sensitive: they live ONLY in
 * `tournament_rooms/{tournamentId}`, which the client cannot read directly, and
 * are handed out solely by `getTournamentRoom` to a registered player once the
 * room is published.
 */

/** Blocks control characters and other invisible junk in room fields. */
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

/** Upper bound for a room id / password, shared by the input and stored checks. */
const MAX_ROOM_FIELD = 200;

/** True when a room field is a non-empty, bounded, control-char-free string. */
function isValidRoomField(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ROOM_FIELD &&
    !CONTROL_CHARS.test(value)
  );
}

/**
 * Validates the credentials ALREADY STORED in `tournament_rooms/{id}` against the
 * exact same rules `validateSetRoomPayload` enforces on input. Used by
 * `startTournament` to require a genuinely publishable room before a tournament
 * may move to `in_progress`. Non-throwing: returns a boolean so the caller can
 * raise `failed-precondition` (stored data), not `invalid-argument` (input).
 */
export function hasValidPublishedCredentials(
  roomId: unknown,
  roomPassword: unknown
): boolean {
  return isValidRoomField(roomId) && isValidRoomField(roomPassword);
}

export interface SetRoomInput {
  readonly tournamentid: string;
  readonly roomid: string;
  readonly roompassword: string;
}

/** Validates + normalizes the `setTournamentRoom` payload. */
export function validateSetRoomPayload(data: any): SetRoomInput {
  const tournamentid = String(data?.tournamentid || "").trim();
  const roomid = String(data?.roomid || "").trim();
  const roompassword = String(data?.roompassword || "").trim();

  if (!tournamentid) {
    throw new DomainError("invalid-argument", "ID do torneio é obrigatório.");
  }
  if (tournamentid.includes("/") || tournamentid.length > 200) {
    throw new DomainError("invalid-argument", "ID do torneio inválido.");
  }
  if (!roomid) {
    throw new DomainError("invalid-argument", "O ID da sala é obrigatório.");
  }
  if (roomid.length > 200) {
    throw new DomainError("invalid-argument", "ID da sala inválido.");
  }
  if (!roompassword) {
    throw new DomainError("invalid-argument", "A senha da sala é obrigatória.");
  }
  if (roompassword.length > 200) {
    throw new DomainError("invalid-argument", "Senha da sala inválida.");
  }
  if (CONTROL_CHARS.test(roomid) || CONTROL_CHARS.test(roompassword)) {
    throw new DomainError(
      "invalid-argument",
      "A sala contém caracteres inválidos."
    );
  }

  return { tournamentid, roomid, roompassword };
}

/** Validates the `getTournamentRoom` payload and returns the tournament id. */
export function validateGetRoomPayload(data: any): string {
  const tournamentid = String(data?.tournamentid || "").trim();
  if (!tournamentid) {
    throw new DomainError("invalid-argument", "ID do torneio é obrigatório.");
  }
  if (tournamentid.includes("/") || tournamentid.length > 200) {
    throw new DomainError("invalid-argument", "ID do torneio inválido.");
  }
  return tournamentid;
}

/** The deterministic registration id, mirroring `jointournament` exactly. */
export function registrationId(uid: string, tournamentid: string): string {
  return `${uid}_${tournamentid}`;
}

/**
 * Allowlisted, non-sensitive reasons attached to a room-access failure as
 * `details.reason`. Never any internal detail.
 */
export const ROOM_REASON_REGISTRATION_REQUIRED = "registration-required";
export const ROOM_REASON_NOT_PUBLISHED = "room-not-published";

export interface RoomCredentials {
  readonly room_id: string;
  readonly room_password: string;
}

export type RoomAccessDecision =
  | { readonly ok: true; readonly credentials: RoomCredentials }
  | {
      readonly ok: false;
      readonly code: "permission-denied" | "failed-precondition";
      readonly reason: string;
      readonly message: string;
    };

/**
 * Decides whether a player may receive the room credentials, from the observed
 * state alone.
 *
 * Registration is checked FIRST: a caller who is not registered gets
 * `registration-required` regardless of whether the room exists, so room state
 * is never leaked to a non-participant. Only a registered caller can learn that
 * the room is not yet published, and only a published room yields credentials.
 */
export function decideRoomAccess(input: {
  registrationExists: boolean;
  roomExists: boolean;
  roomId: unknown;
  roomPassword: unknown;
}): RoomAccessDecision {
  if (!input.registrationExists) {
    return {
      ok: false,
      code: "permission-denied",
      reason: ROOM_REASON_REGISTRATION_REQUIRED,
      message:
        "Você precisa estar inscrito neste torneio para acessar a sala.",
    };
  }

  const roomId = typeof input.roomId === "string" ? input.roomId : "";
  const roomPassword =
    typeof input.roomPassword === "string" ? input.roomPassword : "";

  if (!input.roomExists || !roomId || !roomPassword) {
    return {
      ok: false,
      code: "failed-precondition",
      reason: ROOM_REASON_NOT_PUBLISHED,
      message: "A sala deste torneio ainda não foi publicada.",
    };
  }

  return { ok: true, credentials: { room_id: roomId, room_password: roomPassword } };
}
