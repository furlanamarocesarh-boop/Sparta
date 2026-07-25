import { DomainError } from "./errors.js";
import {
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
  type EconomyType,
} from "./economy.js";
import { inspectReais, MAX_CENTAVOS } from "./money.js";
import { type Check } from "./settlement.js";

/**
 * Tournament cancellation + deterministic refunds — the PURE rules, with no
 * `firebase-functions` and no Admin SDK import.
 *
 * THE CONTRACT (frozen):
 *  - only a tournament in the canonical pre-start state (`status: "open"`,
 *    with NO persisted settlement evidence) can be cancelled;
 *  - `cancelled` is TERMINAL: no join, no start, no result, no prize, no room;
 *  - EVERY paid registration is refunded in the SAME single Firestore
 *    transaction that cancels the tournament — all or nothing, never partial;
 *  - each refund goes to EXACTLY the bucket that paid the entry:
 *    cash → `balance` (+ `total_spent` reduced), beta → `beta_balance`;
 *  - the refunded amount is the registration's own server-authoritative
 *    snapshot — never the tournament's CURRENT price, never client input;
 *  - refunds are idempotent via deterministic ledger ids derived from the
 *    deterministic registration id.
 */

/** Ledger category of a cash entry-fee refund. NOT part of the cash identity
 * yet — the reconciler learns it in feat/beta-rules-audit. */
export const ENTRY_REFUND_CATEGORY = "entry_refund";

/** Ledger category of a beta entry-fee refund. */
export const BETA_REFUND_CATEGORY = "beta_refund";

/** The terminal state written by cancelTournament. */
export const STATUS_CANCELLED = "cancelled";

/**
 * Firestore's classic per-transaction write ceiling. Newer server versions
 * lifted it, but the EMULATOR and older backends enforce it — so the guard
 * assumes the conservative value.
 */
export const FIRESTORE_TRANSACTION_WRITE_LIMIT = 500;

/**
 * A cancellation writes 3 documents per registration (wallet + refund ledger +
 * registration) plus 1 tournament update.
 */
export function writesRequiredForCancellation(registrations: number): number {
  return registrations * 3 + 1;
}

/**
 * Hard cap on refundable registrations per cancellation: 150 → 451 writes,
 * comfortably inside the 500-write ceiling. A tournament with more paid
 * registrations is REFUSED (failed-precondition) before any write — partial
 * refunds and multi-batch sagas are deliberately not implemented.
 */
export const MAX_CANCELLABLE_REGISTRATIONS = 150;

/** True when the whole cancellation fits one atomic transaction. */
export function canCancelAtomically(registrations: number): boolean {
  return (
    registrations <= MAX_CANCELLABLE_REGISTRATIONS &&
    writesRequiredForCancellation(registrations) <=
      FIRESTORE_TRANSACTION_WRITE_LIMIT
  );
}

/**
 * The deterministic refund-ledger id, derived from the deterministic
 * registration id `{uid}_{tournamentid}` — one refund per registration, ever.
 */
export function refundTransactionId(registrationDocId: string): string {
  return `refund_${registrationDocId}`;
}

/** Extracts the uid from a `users/{uid}` path; null for anything else. */
function uidFromUserPath(path: string | null): string | null {
  if (!path || !path.startsWith("users/")) return null;
  const uid = path.slice("users/".length);
  return uid.length > 0 && !uid.includes("/") ? uid : null;
}

/** One validated, ready-to-execute refund. Amounts in integer centavo-units. */
export interface RefundPlanItem {
  readonly uid: string;
  readonly registrationDocId: string;
  readonly amountCentavos: number;
  readonly economy: EconomyType;
  /**
   * Path of the original entry ledger. Null ONLY for a legacy cash item,
   * meaning "locate the single matching entry_fee ledger by query and
   * validate it" — never "skip the ledger proof".
   */
  readonly entryTransactionPath: string | null;
  /** True when this is a pre-economy legacy cash registration. */
  readonly legacy: boolean;
}

export type RefundPlanResult =
  | { readonly ok: true; readonly item: RefundPlanItem }
  | { readonly ok: false; readonly message: string };

/**
 * Validates ONE registration into a refund-plan item, failing closed on every
 * ambiguity. Rules:
 *
 *  - status must be exactly "registered" (anything else is divergent state);
 *  - the doc id must be the deterministic `{uid}_{tournamentid}` derived from
 *    its own `user_ref`, and `tournament_ref` must point at this tournament;
 *  - provenance: `economy_type` present must equal the tournament economy.
 *    Absent provenance is LEGACY and acceptable ONLY when the tournament is
 *    cash — a beta tournament with a provenance-less registration fails;
 *  - amount: `entry_fee_snapshot` is the normal source. A NEW-STYLE
 *    registration (with provenance) without a valid snapshot or without its
 *    `transaction_ref` is divergent and fails. A LEGACY cash registration may
 *    fall back to its server-written `entry_fee` only when that value is
 *    provably a valid, strictly-positive charge; otherwise it fails closed.
 *    The refund NEVER uses the tournament's current price.
 */
export function resolveRefundPlanItem(input: {
  readonly docId: string;
  readonly tournamentid: string;
  readonly tournamentEconomy: EconomyType;
  readonly status: unknown;
  readonly userRefPath: string | null;
  readonly tournamentRefPath: string | null;
  readonly registrationEconomy: unknown;
  readonly entryFeeSnapshot: unknown;
  readonly entryFee: unknown;
  readonly transactionRefPath: string | null;
}): RefundPlanResult {
  const fail = (message: string): RefundPlanResult => ({ ok: false, message });

  if (input.status !== "registered") {
    return fail(
      `Inscrição ${input.docId} em estado inesperado para reembolso.`
    );
  }

  const uid = uidFromUserPath(input.userRefPath);
  if (!uid) {
    return fail(`Inscrição ${input.docId} sem usuário válido.`);
  }
  if (input.docId !== `${uid}_${input.tournamentid}`) {
    return fail(`Inscrição ${input.docId} não corresponde ao usuário.`);
  }
  if (input.tournamentRefPath !== `tournaments/${input.tournamentid}`) {
    return fail(`Inscrição ${input.docId} não pertence a este torneio.`);
  }

  // Provenance.
  const raw = input.registrationEconomy;
  let legacy = false;
  if (raw === undefined) {
    if (input.tournamentEconomy !== ECONOMY_CASH) {
      return fail(
        `Inscrição ${input.docId} não possui proveniência econômica beta.`
      );
    }
    legacy = true;
  } else if (raw !== ECONOMY_CASH && raw !== ECONOMY_BETA_CREDIT) {
    return fail(`Inscrição ${input.docId} com proveniência inválida.`);
  } else if (raw !== input.tournamentEconomy) {
    return fail(
      `Inscrição ${input.docId} diverge da economia do torneio.`
    );
  }

  // Amount: snapshot first; safe cash legacy fallback; otherwise fail closed.
  const snapshot = inspectReais(input.entryFeeSnapshot, {
    allowZero: false,
    maxCentavos: MAX_CENTAVOS,
  });
  let amountCentavos: number;
  if (snapshot.ok) {
    amountCentavos = snapshot.centavos;
  } else if (legacy) {
    const charged = inspectReais(input.entryFee, {
      allowZero: false,
      maxCentavos: MAX_CENTAVOS,
    });
    if (!charged.ok) {
      return fail(
        `Inscrição ${input.docId} sem valor de cobrança comprovável.`
      );
    }
    amountCentavos = charged.centavos;
  } else {
    return fail(
      `Inscrição ${input.docId} sem snapshot de inscrição válido.`
    );
  }

  // Original ledger reference: mandatory for new-style registrations.
  if (!legacy && !input.transactionRefPath) {
    return fail(
      `Inscrição ${input.docId} sem referência ao ledger original.`
    );
  }

  return {
    ok: true,
    item: {
      uid,
      registrationDocId: input.docId,
      amountCentavos,
      economy: input.tournamentEconomy,
      entryTransactionPath: legacy ? null : input.transactionRefPath,
      legacy,
    },
  };
}

/**
 * Cross-validates the ORIGINAL entry ledger of a LEGACY cash registration,
 * located by query (category == "entry_fee", user_ref, tournament_ref) —
 * the pre-economy `jointournament` wrote exactly one such ledger per
 * (user, tournament) under a random id, unreferenced by the registration.
 *
 * A legacy refund is accepted ONLY when exactly ONE ledger matches and its
 * category, user, tournament and amount prove the charge. Zero matches
 * (absent), two or more (ambiguous), or any field divergence fail the WHOLE
 * cancellation — `registration.entry_fee` alone is never sufficient, and the
 * tournament's current price is never consulted.
 */
export function checkLegacyEntryLedger(input: {
  readonly registrationDocId: string;
  readonly tournamentid: string;
  readonly uid: string;
  readonly matches: number;
  readonly category: unknown;
  readonly economyType: unknown;
  readonly userRefPath: string | null;
  readonly tournamentRefPath: string | null;
  readonly amountReais: unknown;
  readonly expectedAmountReais: number;
}): Check {
  const id = input.registrationDocId;
  if (input.matches === 0) {
    return {
      ok: false,
      message: `Ledger original da inscrição ${id} não encontrado.`,
    };
  }
  if (input.matches > 1) {
    return {
      ok: false,
      message: `Ledger original da inscrição ${id} é ambíguo.`,
    };
  }
  // A legacy ledger predates economy tagging (no economy_type); a cash-tagged
  // one is also acceptable. Anything else is not a cash entry charge.
  const economyOk =
    input.economyType === undefined || input.economyType === ECONOMY_CASH;
  const consistent =
    economyOk &&
    input.category === "entry_fee" &&
    input.userRefPath === `users/${input.uid}` &&
    input.tournamentRefPath === `tournaments/${input.tournamentid}` &&
    input.amountReais === input.expectedAmountReais;
  if (!consistent) {
    return {
      ok: false,
      message: `Ledger original da inscrição ${id} diverge do esperado.`,
    };
  }
  return { ok: true };
}

/**
 * Cross-validates the ORIGINAL entry ledger of a new-style registration:
 * category, economy, user, tournament and amount must all match the refund
 * plan exactly. Any divergence fails the WHOLE cancellation atomically.
 */
export function checkOriginalEntryLedger(input: {
  readonly item: RefundPlanItem;
  readonly tournamentid: string;
  readonly txExists: boolean;
  readonly category: unknown;
  readonly economyType: unknown;
  readonly userRefPath: string | null;
  readonly tournamentRefPath: string | null;
  readonly amountReais: unknown;
  readonly expectedAmountReais: number;
}): Check {
  const id = input.item.registrationDocId;
  if (!input.txExists) {
    return {
      ok: false,
      message: `Ledger original da inscrição ${id} não encontrado.`,
    };
  }
  const expectedCategory =
    input.item.economy === ECONOMY_BETA_CREDIT
      ? "beta_entry_fee"
      : "entry_fee";
  const consistent =
    input.category === expectedCategory &&
    input.economyType === input.item.economy &&
    input.userRefPath === `users/${input.item.uid}` &&
    input.tournamentRefPath === `tournaments/${input.tournamentid}` &&
    input.amountReais === input.expectedAmountReais;
  if (!consistent) {
    return {
      ok: false,
      message: `Ledger original da inscrição ${id} diverge do esperado.`,
    };
  }
  return { ok: true };
}

/** Sums plan amounts exactly, rejecting an unsafe (non-integer-safe) total. */
export function sumRefundCentavos(items: readonly RefundPlanItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.amountCentavos;
    if (!Number.isSafeInteger(total)) {
      throw new DomainError(
        "failed-precondition",
        "Total de reembolso excede o limite seguro."
      );
    }
  }
  return total;
}

/**
 * Replay verification of ONE already-refunded registration on an
 * already-cancelled tournament. Nothing is repaired: any missing or divergent
 * artifact is failed-precondition and the replay writes nothing.
 */
export function checkRefundedRegistration(input: {
  readonly docId: string;
  readonly status: unknown;
  readonly refundEconomy: unknown;
  readonly tournamentEconomy: EconomyType;
  readonly refundedAmount: unknown;
  readonly refundTransactionRefPath: string | null;
}): Check {
  const id = input.docId;
  if (input.status !== "refunded") {
    return {
      ok: false,
      message: `Inscrição ${id} não está reembolsada no torneio cancelado.`,
    };
  }
  if (input.refundEconomy !== input.tournamentEconomy) {
    return {
      ok: false,
      message: `Inscrição ${id} reembolsada em economia divergente.`,
    };
  }
  const amount = inspectReais(input.refundedAmount, {
    allowZero: false,
    maxCentavos: MAX_CENTAVOS,
  });
  if (!amount.ok) {
    return {
      ok: false,
      message: `Inscrição ${id} com valor de reembolso inválido.`,
    };
  }
  if (
    input.refundTransactionRefPath !==
    `transactions/${refundTransactionId(id)}`
  ) {
    return {
      ok: false,
      message: `Inscrição ${id} sem ledger de reembolso determinístico.`,
    };
  }
  return { ok: true };
}

/** Replay verification of ONE persisted refund ledger. */
export function checkRefundLedger(input: {
  readonly registrationDocId: string;
  readonly tournamentid: string;
  readonly tournamentEconomy: EconomyType;
  readonly uid: string;
  readonly expectedAmountReais: number;
  readonly txExists: boolean;
  readonly category: unknown;
  readonly economyType: unknown;
  readonly amountReais: unknown;
  readonly userRefPath: string | null;
  readonly tournamentRefPath: string | null;
  readonly registrationRefPath: string | null;
}): Check {
  const id = input.registrationDocId;
  if (!input.txExists) {
    return {
      ok: false,
      message: `Ledger de reembolso da inscrição ${id} não encontrado.`,
    };
  }
  const expectedCategory =
    input.tournamentEconomy === ECONOMY_BETA_CREDIT
      ? BETA_REFUND_CATEGORY
      : ENTRY_REFUND_CATEGORY;
  const consistent =
    input.category === expectedCategory &&
    input.economyType === input.tournamentEconomy &&
    input.amountReais === input.expectedAmountReais &&
    input.userRefPath === `users/${input.uid}` &&
    input.tournamentRefPath === `tournaments/${input.tournamentid}` &&
    input.registrationRefPath === `registrations/${id}`;
  if (!consistent) {
    return {
      ok: false,
      message: `Ledger de reembolso da inscrição ${id} diverge do esperado.`,
    };
  }
  return { ok: true };
}
