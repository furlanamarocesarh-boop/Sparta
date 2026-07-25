import { DomainError } from "./errors.js";
import {
  prizeTransactionId,
  registrationId,
  type Check,
} from "./settlement.js";

/**
 * Tournament economy — the PURE rules that keep the two money pools apart,
 * with no `firebase-functions` and no Admin SDK import.
 *
 * THE CONTRACT (frozen for the closed beta):
 *
 *   EconomyType = "cash" | "beta_credit"   — nothing else, ever.
 *
 *  - `"cash"` tournaments move REAL money: entry fees debit `wallet.balance`,
 *    prizes credit `balance` + `total_won` — exactly the pre-existing flow.
 *  - `"beta_credit"` tournaments move ONLY Beta Credits: entry fees debit
 *    `wallet.beta_balance`, prizes credit `beta_balance`. They never read or
 *    write any of the five cash fields, and Beta Credits stay non-withdrawable.
 *  - There is NO fallback, NO split and NO conversion between the pools, in
 *    either direction, under any balance condition.
 *
 * LEGACY: a persisted tournament WITHOUT `economy_type` predates this contract
 * and is interpreted as `"cash"` — read-side only, no mass migration. A
 * persisted value that exists but is not exactly one of the two strings is
 * corrupt state and FAILS CLOSED (`failed-precondition`) — it is never
 * silently coerced to cash.
 *
 * IMMUTABILITY: `economy_type` can never change after creation. New tournaments
 * are born with a durable lock, `locked_economy_type`, equal to the authorized
 * type. Every financial operation resolves BOTH fields (absent → cash) and
 * rejects any divergence, so flipping `economy_type` after the fact is
 * detected even before the Firestore Rules for these fields land
 * (feat/beta-rules-audit). Registrations additionally snapshot the economy
 * they were paid under, and settlement re-checks that snapshot against the
 * tournament — a second, independent tripwire.
 */

export type EconomyType = "cash" | "beta_credit";

export const ECONOMY_CASH = "cash" as const;
export const ECONOMY_BETA_CREDIT = "beta_credit" as const;

/** Ledger category of a beta entry-fee debit. NOT part of the cash identity. */
export const BETA_ENTRY_FEE_CATEGORY = "beta_entry_fee";

/** Ledger category of a beta prize credit. NOT part of the cash identity. */
export const BETA_PRIZE_CATEGORY = "beta_prize";

/**
 * Parses the `economy_type` a CALLER requested (createTournament). Only the
 * two exact strings are accepted — no aliases, no case variations, no empty
 * string, no null, no coercion. A missing or invalid value is the caller's
 * mistake: invalid-argument.
 */
export function parseRequestedEconomyType(value: unknown): EconomyType {
  if (value === ECONOMY_CASH || value === ECONOMY_BETA_CREDIT) {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    throw new DomainError("invalid-argument", "economy_type é obrigatório.");
  }
  throw new DomainError(
    "invalid-argument",
    'economy_type inválido. Use "cash" ou "beta_credit".'
  );
}

/**
 * Resolves an `economy_type`-like field PERSISTED on a document.
 *  - absent (undefined)  → "cash" — the legacy interpretation;
 *  - exactly "cash" / "beta_credit" → that value;
 *  - anything else (null, "", wrong case, other strings, numbers) → the stored
 *    state is corrupt: failed-precondition, NEVER silently cash.
 */
export function resolveStoredEconomyType(
  value: unknown,
  field: string
): EconomyType {
  if (value === undefined) return ECONOMY_CASH;
  if (value === ECONOMY_CASH || value === ECONOMY_BETA_CREDIT) {
    return value;
  }
  throw new DomainError(
    "failed-precondition",
    `Tipo econômico persistido inválido (${field}).`
  );
}

/**
 * Resolves a TOURNAMENT's effective economy from `economy_type` + the durable
 * lock `locked_economy_type`, failing closed on any divergence.
 *
 * Divergence matrix (absent resolves to cash on each side):
 *   absent/absent            → cash (legacy)            ✔
 *   cash/absent, absent/cash → cash                     ✔
 *   beta/beta                → beta_credit              ✔
 *   beta/absent              → a legacy doc had its type flipped → FAIL
 *   cash/beta, beta/cash     → the type or the lock was flipped  → FAIL
 *   invalid either side      → corrupt persisted state           → FAIL
 *
 * On failure NOTHING may proceed: no debit, no credit, no registration, no
 * transaction, no participant/status/result change.
 */
export function resolveTournamentEconomy(data: {
  readonly economy_type?: unknown;
  readonly locked_economy_type?: unknown;
}): EconomyType {
  const declared = resolveStoredEconomyType(data.economy_type, "economy_type");
  const locked = resolveStoredEconomyType(
    data.locked_economy_type,
    "locked_economy_type"
  );
  if (declared !== locked) {
    throw new DomainError(
      "failed-precondition",
      "O tipo econômico do torneio diverge da trava econômica."
    );
  }
  return declared;
}

/**
 * The partial update that materializes the economy fields on a LEGACY document
 * — only the ABSENT fields, only with the already-resolved economy, and only
 * to be merged into a write a legitimate financial operation is performing
 * anyway (never a standalone normalization write). For documents that already
 * carry both fields this is `{}` — no churn.
 */
export function economyLockMaterialization(
  data: {
    readonly economy_type?: unknown;
    readonly locked_economy_type?: unknown;
  },
  economy: EconomyType
): Record<string, EconomyType> {
  const update: Record<string, EconomyType> = {};
  if (data.economy_type === undefined) update.economy_type = economy;
  if (data.locked_economy_type === undefined) {
    update.locked_economy_type = economy;
  }
  return update;
}

/**
 * Validates a REGISTRATION's economic provenance against the tournament it is
 * being used with (join replay and prize settlement).
 *
 *  - absent provenance is LEGACY and is accepted ONLY on the cash path — a
 *    beta tournament with a provenance-less registration is a divergence
 *    (e.g. the tournament's economy was flipped after cash registrations);
 *  - an invalid persisted value fails closed;
 *  - a provenance different from the tournament's economy fails closed.
 */
export function checkRegistrationEconomy(input: {
  readonly registrationEconomy: unknown;
  readonly tournamentEconomy: EconomyType;
}): Check {
  const raw = input.registrationEconomy;
  if (raw === undefined) {
    return input.tournamentEconomy === ECONOMY_CASH
      ? { ok: true }
      : {
          ok: false,
          message: "A inscrição não possui proveniência econômica beta.",
        };
  }
  if (raw !== ECONOMY_CASH && raw !== ECONOMY_BETA_CREDIT) {
    return {
      ok: false,
      message: "Proveniência econômica da inscrição inválida.",
    };
  }
  if (raw !== input.tournamentEconomy) {
    return {
      ok: false,
      message: "A economia da inscrição diverge da economia do torneio.",
    };
  }
  return { ok: true };
}

/** The persisted beta result fields the replay check compares. */
export interface PersistedBetaResult {
  readonly winner_uid?: unknown;
  readonly winner_ref?: string | null;
  readonly registration_ref?: string | null;
  readonly transaction_ref?: string | null;
  readonly prize?: unknown;
  readonly economy_type?: unknown;
}

/** The persisted beta prize-transaction fields the replay check compares. */
export interface PersistedBetaPrizeTx {
  readonly category?: unknown;
  readonly economy_type?: unknown;
  readonly external_id?: unknown;
  readonly user_ref?: string | null;
  readonly tournament_ref?: string | null;
  readonly amount?: unknown;
}

/**
 * Decides whether a `completed` BETA tournament may return an idempotent
 * success for the given winner — the beta mirror of `decideCompletedReplay`.
 * Both the result and the deterministic transaction must exist and match the
 * declared winner, tournament AND the beta economy EXACTLY (category
 * `beta_prize`, economy `beta_credit`). A different winner, a cash-shaped
 * settlement, a partial state, or any divergence is failed-precondition — the
 * settlement is never re-run and no credit happens a second time.
 */
export function decideBetaCompletedReplay(input: {
  readonly winneruid: string;
  readonly tournamentid: string;
  readonly resultExists: boolean;
  readonly txExists: boolean;
  readonly result: PersistedBetaResult | null;
  readonly tx: PersistedBetaPrizeTx | null;
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
    result.economy_type === ECONOMY_BETA_CREDIT &&
    tx.category === BETA_PRIZE_CATEGORY &&
    tx.economy_type === ECONOMY_BETA_CREDIT &&
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
