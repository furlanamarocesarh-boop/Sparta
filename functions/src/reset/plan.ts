import { WALLET_MONEY_FIELDS } from "../audit/walletAudit.js";
import { inspectReais, MAX_BALANCE_CENTAVOS } from "../domain/money.js";
import {
  CANONICAL_CURRENT,
  CANONICAL_MAX,
  LEGACY_CURRENT,
  LEGACY_MAX,
} from "../domain/tournamentFields.js";
import { computeFingerprint, DocumentStamp } from "./fingerprint.js";

/**
 * Planning for the test-financial reset — pure, no Firebase.
 *
 * Produces an EXPLICIT, enumerated list of operations. Nothing is recursive,
 * nothing is a collection-wide delete: every document to be removed was read,
 * stamped into the fingerprint, and is deleted by its own path. If a document
 * was not enumerated, it is not touched.
 */

/** Firestore allows at most 500 writes in a single transaction. */
export const MAX_TRANSACTION_WRITES = 500;

/**
 * A ledger collection above this size is not what we expect from a test
 * project. It triggers a refusal, not an automatic apply — a reset that would
 * delete thousands of documents deserves a human looking at it first.
 */
export const LARGE_COLLECTION_THRESHOLD = 1_000;

/** The three ledger collections that are wiped. Nothing else is ever deleted. */
export const LEDGER_COLLECTIONS = [
  "transactions",
  "withdrawals",
  "registrations",
] as const;

export type LedgerCollection = (typeof LEDGER_COLLECTIONS)[number];

export interface WalletSnapshot {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly updateTime: string;
  /** Does users/{id} exist? A wallet without its user aborts the whole plan. */
  readonly userExists: boolean;
}

export interface TournamentSnapshot {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly updateTime: string;
}

export interface LedgerSnapshot {
  readonly collection: LedgerCollection;
  readonly id: string;
  readonly updateTime: string;
}

export interface ResetSnapshot {
  readonly userCount: number;
  readonly wallets: readonly WalletSnapshot[];
  readonly tournaments: readonly TournamentSnapshot[];
  readonly ledger: readonly LedgerSnapshot[];
}

export type ResetOperation =
  | {
      readonly kind: "update-wallet";
      readonly id: string;
      readonly moneyFields: Readonly<Record<string, number>>;
      /** The CLI attaches the real users/{id} DocumentReference. */
      readonly setUserRef: true;
    }
  | {
      readonly kind: "update-tournament";
      readonly id: string;
      readonly fields: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "delete";
      readonly collection: LedgerCollection;
      readonly id: string;
    };

export interface ResetPlan {
  readonly operations: readonly ResetOperation[];
  readonly writes: number;
  readonly fingerprint: string;

  readonly usersPreserved: number;
  readonly walletsToZero: number;
  readonly walletsAlreadyClean: number;
  readonly tournamentsToNormalize: number;
  readonly tournamentsAlreadyCanonical: number;
  readonly ledgerCounts: Readonly<Record<LedgerCollection, number>>;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: ResetPlan }
  | { readonly ok: false; readonly reason: string };

/** Zeroed money fields written to every wallet that needs it. */
export function walletMoneyZeros(): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const field of WALLET_MONEY_FIELDS) fields[field] = 0;
  return fields;
}

/**
 * The tournament fields written. `max_players` is deliberately NOT written — it
 * is PRESERVED, and `max_participants` is set from it, which is what makes both
 * pairs canonical and equal.
 */
export function tournamentNormalizedFields(
  maxPlayers: number
): Record<string, number> {
  return {
    [CANONICAL_CURRENT]: 0,
    [LEGACY_CURRENT]: 0,
    [CANONICAL_MAX]: maxPlayers,
  };
}

/** A wallet still needs writing unless it is already fully zeroed and linked. */
export function walletNeedsReset(wallet: WalletSnapshot): boolean {
  for (const field of WALLET_MONEY_FIELDS) {
    const inspection = inspectReais(wallet.data[field], {
      allowZero: true,
      maxCentavos: MAX_BALANCE_CENTAVOS,
    });
    if (!inspection.ok || inspection.centavos !== 0) return true;
  }

  const userRef = wallet.data.user_ref as { path?: string } | undefined | null;
  return userRef?.path !== `users/${wallet.id}`;
}

/** Reads `max_players`, requiring a positive safe integer. */
export function readMaxPlayers(
  tournament: TournamentSnapshot
): number | undefined {
  const value = tournament.data[LEGACY_MAX];
  if (typeof value !== "number") return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/** A tournament is already canonical when both pairs are zeroed and equal. */
export function tournamentNeedsNormalize(
  tournament: TournamentSnapshot,
  maxPlayers: number
): boolean {
  const data = tournament.data;
  return (
    data[CANONICAL_CURRENT] !== 0 ||
    data[LEGACY_CURRENT] !== 0 ||
    data[CANONICAL_MAX] !== maxPlayers
  );
}

/**
 * Builds the plan, or refuses.
 *
 * Any single invalid document aborts the ENTIRE plan. A reset that half-works is
 * worse than one that does not run: it would leave the database in a state
 * nobody has reviewed.
 */
export function buildResetPlan(snapshot: ResetSnapshot): PlanResult {
  // --- Refuse on anything unexpected, before planning a single write. -------
  for (const wallet of snapshot.wallets) {
    if (!wallet.userExists) {
      return {
        ok: false,
        reason:
          "Existe wallet sem o users/{uid} correspondente. " +
          "Abortando o plano inteiro — nenhuma escrita.",
      };
    }
  }

  const maxPlayersById = new Map<string, number>();
  for (const tournament of snapshot.tournaments) {
    const maxPlayers = readMaxPlayers(tournament);
    if (maxPlayers === undefined) {
      return {
        ok: false,
        reason:
          "Existe torneio com max_players ausente ou inválido " +
          "(precisa ser inteiro positivo). Abortando o plano inteiro.",
      };
    }

    const current = tournament.data[LEGACY_CURRENT];
    if (
      current !== undefined &&
      current !== null &&
      (typeof current !== "number" ||
        !Number.isSafeInteger(current) ||
        current < 0)
    ) {
      return {
        ok: false,
        reason:
          "Existe torneio com current_players inválido. Abortando o plano inteiro.",
      };
    }

    maxPlayersById.set(tournament.id, maxPlayers);
  }

  const ledgerCounts = countLedger(snapshot.ledger);

  for (const collection of LEDGER_COLLECTIONS) {
    if (ledgerCounts[collection] > LARGE_COLLECTION_THRESHOLD) {
      return {
        ok: false,
        reason:
          `A collection "${collection}" tem ${ledgerCounts[collection]} documentos, ` +
          `acima do limite de revisão (${LARGE_COLLECTION_THRESHOLD}). ` +
          "Isso não é o esperado para um projeto de teste. " +
          "REVISÃO MANUAL NECESSÁRIA — nenhuma escrita automática.",
      };
    }
  }

  // --- Build the operation list. --------------------------------------------
  const operations: ResetOperation[] = [];

  let walletsToZero = 0;
  let walletsAlreadyClean = 0;

  for (const wallet of snapshot.wallets) {
    if (!walletNeedsReset(wallet)) {
      walletsAlreadyClean++;
      continue;
    }
    walletsToZero++;
    operations.push({
      kind: "update-wallet",
      id: wallet.id,
      moneyFields: walletMoneyZeros(),
      setUserRef: true,
    });
  }

  let tournamentsToNormalize = 0;
  let tournamentsAlreadyCanonical = 0;

  for (const tournament of snapshot.tournaments) {
    const maxPlayers = maxPlayersById.get(tournament.id) as number;

    if (!tournamentNeedsNormalize(tournament, maxPlayers)) {
      tournamentsAlreadyCanonical++;
      continue;
    }
    tournamentsToNormalize++;
    operations.push({
      kind: "update-tournament",
      id: tournament.id,
      fields: tournamentNormalizedFields(maxPlayers),
    });
  }

  for (const doc of snapshot.ledger) {
    operations.push({
      kind: "delete",
      collection: doc.collection,
      id: doc.id,
    });
  }

  const writes = operations.length;

  // Refuse rather than silently splitting into batches: a batched "atomic" reset
  // is not atomic, and a partial reset is exactly the outcome to avoid.
  if (writes > MAX_TRANSACTION_WRITES) {
    return {
      ok: false,
      reason:
        `O plano exige ${writes} writes, acima do limite de ${MAX_TRANSACTION_WRITES} ` +
        "de uma transaction do Firestore. RECUSADO — não vamos dividir em " +
        "batches, porque isso deixaria de ser atômico.",
    };
  }

  return {
    ok: true,
    plan: {
      operations,
      writes,
      fingerprint: computeFingerprint(stampsFor(snapshot)),
      usersPreserved: snapshot.userCount,
      walletsToZero,
      walletsAlreadyClean,
      tournamentsToNormalize,
      tournamentsAlreadyCanonical,
      ledgerCounts,
    },
  };
}

/**
 * The documents that go into the fingerprint: the FULL financial scope.
 *
 * Deliberately a superset of "documents that would be touched" — a wallet that
 * currently needs no write is still stamped, so if someone dirties it between
 * the dry run and the apply, the fingerprint changes and the apply aborts.
 */
export function stampsFor(snapshot: ResetSnapshot): DocumentStamp[] {
  const stamps: DocumentStamp[] = [];

  for (const wallet of snapshot.wallets) {
    stamps.push({ path: `wallets/${wallet.id}`, updateTime: wallet.updateTime });
  }
  for (const tournament of snapshot.tournaments) {
    stamps.push({
      path: `tournaments/${tournament.id}`,
      updateTime: tournament.updateTime,
    });
  }
  for (const doc of snapshot.ledger) {
    stamps.push({
      path: `${doc.collection}/${doc.id}`,
      updateTime: doc.updateTime,
    });
  }

  return stamps;
}

function countLedger(
  ledger: readonly LedgerSnapshot[]
): Record<LedgerCollection, number> {
  const counts: Record<LedgerCollection, number> = {
    transactions: 0,
    withdrawals: 0,
    registrations: 0,
  };
  for (const doc of ledger) counts[doc.collection]++;
  return counts;
}
