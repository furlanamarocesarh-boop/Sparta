import { DomainError } from "./errors.js";
import { inspectStoredPrize } from "./operations.js";
import { hasValidPublishedCredentials } from "./room.js";

/**
 * Tournament start / result / prize settlement — the PURE rules, with no
 * `firebase-functions` and no Admin SDK import, so every branch is unit-tested
 * without a database. `index.ts` performs the Firestore reads inside a single
 * transaction and feeds their extracted results into these functions.
 *
 * THE LIFECYCLE this guards (frozen contract):
 *
 *   open ── startTournament ──▶ in_progress ── declareTournamentResult ──▶ completed
 *
 * `open` is the only status `createTournament` writes and the only one
 * `jointournament` accepts. `in_progress` and `completed` are introduced here.
 * `closed` / `paid` are deliberately NOT introduced.
 *
 * The client never supplies money, ids, status, or references: the prize comes
 * from `tournaments/{id}.prize`, the financial id is the deterministic
 * `prize_{tournamentid}`, and the winner's identity is verified against the
 * canonical registration.
 */

export const STATUS_OPEN = "open";
export const STATUS_IN_PROGRESS = "in_progress";
export const STATUS_COMPLETED = "completed";

/** The registration status that represents a confirmed entry (jointournament). */
export const REGISTRATION_CONFIRMED = "registered";

/** A pure yes/no decision carrying the pt-BR failure message when it is "no". */
export type Check = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Rejects a payload that is not an object or that carries ANY key outside the
 * exact allowlist. This is what makes `amount`, `externalid`, `transactionid`,
 * `prize`, `status`, and any stray reference an `invalid-argument` rather than a
 * silently ignored field.
 *
 * THE SHAPE IS VALIDATED, NOT JUST THE KEYS. `Object.keys` alone is bypassable:
 * a JSON body with a `__proto__` member reaches the handler (through the SDK's
 * `obj[k] = v` decode loop) as an object whose PROTOTYPE carries the smuggled
 * fields — its own key set is empty, yet `(data ?? {}).x` still resolves them
 * through the chain. So a payload must also:
 *
 *   - sit directly on `Object.prototype` (or none at all) — any other
 *     prototype is client-controlled;
 *   - carry no symbol keys — JSON cannot produce them;
 *   - hold every field as an OWN PLAIN DATA property — no accessors, and the
 *     own-name enumeration (`getOwnPropertyNames`, not `Object.keys`) also
 *     catches a literal own `__proto__` / non-enumerable smuggling.
 *
 * Every structural rejection uses one GENERIC public message: the shape of a
 * hostile payload is not information we return to its author.
 */
export function assertExactPayload(
  data: unknown,
  allowed: readonly string[]
): void {
  const reject = (): never => {
    throw new DomainError("invalid-argument", "Payload inválido.");
  };

  if (data === null || typeof data !== "object") reject();

  // EVERY reflective step is wrapped: on an exotic object (a Proxy with a
  // throwing trap, a revoked Proxy) these throw a plain TypeError, which would
  // otherwise escape the domain and surface as an INTERNAL 500 that looks like
  // a server fault. A hostile shape is a bad request, so it fails as one — and
  // the trap's own message is discarded rather than echoed.
  try {
    if (Array.isArray(data)) reject();

    const proto = Object.getPrototypeOf(data);
    if (proto !== Object.prototype && proto !== null) reject();

    if (Object.getOwnPropertySymbols(data).length > 0) reject();

    for (const key of Object.getOwnPropertyNames(data)) {
      // The key NAME is never echoed. It is attacker-chosen text that would
      // otherwise reach both the client and the log stream verbatim — and JSON
      // permits newlines in a key, so echoing it lets a caller forge log lines.
      if (!allowed.includes(key)) reject();

      const descriptor = Object.getOwnPropertyDescriptor(data, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        reject();
      }
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("invalid-argument", "Payload inválido.");
  }
}

/**
 * Normalizes and validates an identifier with the secure pattern already used
 * by `jointournament` and the room callables: trimmed, non-empty, no "/", and no
 * longer than 200 chars — so it can never escape its document path.
 */
function normalizeIdentifier(
  value: unknown,
  requiredMessage: string,
  invalidMessage: string
): string {
  const id = String(value || "").trim();
  if (!id) {
    throw new DomainError("invalid-argument", requiredMessage);
  }
  if (id.includes("/") || id.length > 200) {
    throw new DomainError("invalid-argument", invalidMessage);
  }
  return id;
}

export function normalizeTournamentId(value: unknown): string {
  return normalizeIdentifier(
    value,
    "ID do torneio é obrigatório.",
    "ID do torneio inválido."
  );
}

export function normalizeWinnerUid(value: unknown): string {
  return normalizeIdentifier(
    value,
    "UID do vencedor é obrigatório.",
    "UID do vencedor inválido."
  );
}

/** The deterministic registration id, mirroring `jointournament` exactly. */
export function registrationId(uid: string, tournamentid: string): string {
  return `${uid}_${tournamentid}`;
}

/** The deterministic prize transaction id — one prize per tournament. */
export function prizeTransactionId(tournamentid: string): string {
  return `prize_${tournamentid}`;
}

/**
 * Extracts the `.path` of a Firestore DocumentReference (e.g. `users/uid`),
 * returning null for anything that is not a reference. Used to compare stored
 * references by their canonical path without importing the Admin SDK here.
 */
export function documentPath(value: unknown): string | null {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { path?: unknown }).path === "string"
  ) {
    return (value as { path: string }).path;
  }
  return null;
}

// ── startTournament ────────────────────────────────────────────────────────

export type StartGate =
  | { readonly kind: "start" }
  | { readonly kind: "replay" }
  | { readonly kind: "fail"; readonly message: string };

/**
 * Decides the start path from the tournament status alone.
 *  - `open`        → first execution (open → in_progress).
 *  - `in_progress` → idempotent replay (verify structure, do not rewrite).
 *  - anything else → failed-precondition (completed / unknown).
 */
export function gateStartStatus(status: string): StartGate {
  if (status === STATUS_OPEN) return { kind: "start" };
  if (status === STATUS_IN_PROGRESS) return { kind: "replay" };
  return {
    kind: "fail",
    message: "O torneio não pode ser iniciado a partir do estado atual.",
  };
}

/**
 * The structural preconditions shared by the first start AND the idempotent
 * replay: the room must exist with valid published credentials pointing at THIS
 * tournament, and the stored prize must be monetarily valid and strictly
 * positive. On the replay path a failure here means the invariant no longer
 * holds, so the caller returns failed-precondition rather than a false success.
 */
export function checkStartPreconditions(input: {
  readonly tournamentid: string;
  readonly roomExists: boolean;
  readonly roomId: unknown;
  readonly roomPassword: unknown;
  readonly roomTournamentRefPath: string | null;
  readonly prize: unknown;
}): Check {
  if (!input.roomExists) {
    return { ok: false, message: "A sala do torneio ainda não foi publicada." };
  }
  if (!hasValidPublishedCredentials(input.roomId, input.roomPassword)) {
    return { ok: false, message: "As credenciais da sala são inválidas." };
  }
  if (input.roomTournamentRefPath !== `tournaments/${input.tournamentid}`) {
    return {
      ok: false,
      message: "A sala não corresponde a este torneio.",
    };
  }
  const prize = inspectStoredPrize(input.prize);
  if (!prize.ok) {
    return { ok: false, message: prize.message };
  }
  return { ok: true };
}

// ── declareTournamentResult ─────────────────────────────────────────────────

export type SettlementGate =
  | { readonly kind: "settle" }
  | { readonly kind: "replay" }
  | { readonly kind: "fail"; readonly message: string };

/**
 * Decides the settlement path from the persisted status and the presence of the
 * result / prize transaction.
 *  - `completed`   → idempotent replay (must be fully equivalent — see below).
 *  - `in_progress` → settle, but ONLY when neither result nor transaction exists
 *                    yet; a partial state is a failed-precondition, never repaired.
 *  - anything else → failed-precondition (open / unknown).
 */
export function gateSettlementStatus(
  status: string,
  resultExists: boolean,
  txExists: boolean
): SettlementGate {
  if (status === STATUS_COMPLETED) return { kind: "replay" };
  if (status === STATUS_IN_PROGRESS) {
    if (resultExists || txExists) {
      return {
        kind: "fail",
        message: "Estado de liquidação inconsistente para este torneio.",
      };
    }
    return { kind: "settle" };
  }
  if (status === STATUS_OPEN) {
    return {
      kind: "fail",
      message: "O torneio precisa estar em andamento para declarar o resultado.",
    };
  }
  return {
    kind: "fail",
    message: "Status do torneio inválido para declarar o resultado.",
  };
}

/**
 * Validates the winner's registration for the mutating path: it must exist, be
 * confirmed, and its identity references must resolve to exactly the declared
 * winner and tournament.
 */
export function checkRegistration(input: {
  readonly exists: boolean;
  readonly status: unknown;
  readonly userRefPath: string | null;
  readonly tournamentRefPath: string | null;
  readonly winneruid: string;
  readonly tournamentid: string;
}): Check {
  if (!input.exists) {
    return { ok: false, message: "Inscrição do vencedor não encontrada." };
  }
  if (input.status !== REGISTRATION_CONFIRMED) {
    return { ok: false, message: "A inscrição do vencedor não está confirmada." };
  }
  if (input.userRefPath !== `users/${input.winneruid}`) {
    return {
      ok: false,
      message: "A inscrição não pertence ao vencedor informado.",
    };
  }
  if (input.tournamentRefPath !== `tournaments/${input.tournamentid}`) {
    return {
      ok: false,
      message: "A inscrição não pertence a este torneio.",
    };
  }
  return { ok: true };
}

export interface PersistedResult {
  readonly winner_uid?: unknown;
  readonly winner_ref?: string | null;
  readonly registration_ref?: string | null;
  readonly transaction_ref?: string | null;
  readonly prize?: unknown;
}

export interface PersistedPrizeTx {
  readonly category?: unknown;
  readonly external_id?: unknown;
  readonly user_ref?: string | null;
  readonly tournament_ref?: string | null;
  readonly amount?: unknown;
}

/**
 * Decides whether a `completed` tournament may return an idempotent success for
 * the given winner. Both the result and the transaction must exist and match the
 * declared winner and tournament EXACTLY. A different winner, a partial state, or
 * any divergence is a failed-precondition — the settlement is never re-run and no
 * money is credited a second time.
 *
 * Reference paths are compared canonically; the prize is checked for internal
 * consistency (result.prize === transaction.amount).
 */
export function decideCompletedReplay(input: {
  readonly winneruid: string;
  readonly tournamentid: string;
  readonly resultExists: boolean;
  readonly txExists: boolean;
  readonly result: PersistedResult | null;
  readonly tx: PersistedPrizeTx | null;
}): Check {
  const { winneruid, tournamentid } = input;

  if (!input.resultExists || !input.txExists || !input.result || !input.tx) {
    return {
      ok: false,
      message: "Estado de liquidação parcial para este torneio.",
    };
  }

  const result = input.result;
  const tx = input.tx;

  // A different winner is the headline divergence, called out on its own.
  if (result.winner_uid !== winneruid) {
    return {
      ok: false,
      message: "O resultado já foi declarado para outro vencedor.",
    };
  }

  const userPath = `users/${winneruid}`;
  const regPath = `registrations/${registrationId(winneruid, tournamentid)}`;
  const txPath = `transactions/${prizeTransactionId(tournamentid)}`;
  const tournamentPath = `tournaments/${tournamentid}`;
  const externalId = prizeTransactionId(tournamentid);

  const consistent =
    result.winner_ref === userPath &&
    result.registration_ref === regPath &&
    result.transaction_ref === txPath &&
    tx.category === "prize" &&
    tx.external_id === externalId &&
    tx.user_ref === userPath &&
    tx.tournament_ref === tournamentPath &&
    typeof result.prize === "number" &&
    typeof tx.amount === "number" &&
    result.prize === tx.amount;

  if (!consistent) {
    return {
      ok: false,
      message: "O resultado persistido diverge do esperado.",
    };
  }

  return { ok: true };
}
