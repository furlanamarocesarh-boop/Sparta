import { randomBytes } from "node:crypto";

import * as admin from "firebase-admin";
/**
 * MODULAR FIRESTORE ENTRYPOINTS — required for the Functions emulator, not a
 * style preference.
 *
 * `firebase-tools` hands the loaded module a compatibility `admin` whose
 * `admin.firestore` is a BOUND function. Binding produces a fresh function
 * object and copies none of the original's own properties, so every static
 * hanging off the namespace — `Timestamp`, `FieldValue`, `FieldPath` — is
 * silently lost. Reading them yields `undefined`, and `new undefined(...)`
 * throws "Timestamp is not a constructor".
 *
 * These names come straight from the package instead, so they never travel
 * through that bound namespace and are unaffected by the stub. `admin.firestore()`
 * itself is still used to obtain the instance — it is the namespace CALL that
 * works; only its attached statics are missing.
 */
import {
  AggregateField,
  type CollectionReference,
  FieldPath,
  FieldValue,
  type Query,
  Timestamp,
} from "firebase-admin/firestore";
import { https, region } from "firebase-functions/v1";

import { assertAdmin, assertSignedIn } from "./domain/adminAuth.js";
import { assertDemoProject } from "./domain/demoProject.js";
import { DomainError } from "./domain/errors.js";
import {
  decideRoomAccess,
  registrationId,
  validateGetRoomPayload,
  validateSetRoomPayload,
} from "./domain/room.js";
import {
  addCentavos,
  centavosToReais,
  inspectReais,
  MAX_BALANCE_CENTAVOS,
  storedReaisToCentavos,
  subtractCentavos,
  toCentavos,
} from "./domain/money.js";
import {
  BETA_REFUND_CATEGORY,
  canCancelAtomically,
  checkLegacyEntryLedger,
  checkOriginalEntryLedger,
  checkRefundedRegistration,
  checkRefundLedger,
  ENTRY_REFUND_CATEGORY,
  refundTransactionId,
  resolveRefundPlanItem,
  STATUS_CANCELLED,
  sumRefundCentavos,
  type RefundPlanItem,
} from "./domain/cancellation.js";
import {
  credit,
  debit,
  inspectStoredPrize,
  validateDepositAmount,
  validateEntryFee,
  validateWithdrawalAmount,
} from "./domain/operations.js";
import {
  assertExactPayload,
  checkRegistration,
  checkStartPreconditions,
  decideCompletedReplay,
  documentPath,
  gateSettlementStatus,
  gateStartStatus,
  normalizeTournamentId,
  normalizeWinnerUid,
  parseScheduledStart,
  prizeTransactionId,
} from "./domain/settlement.js";
import {
  isFull,
  newTournamentParticipantFields,
  participantIncrementUpdate,
  readParticipantCounts,
} from "./domain/tournamentFields.js";
import {
  BETA_ECONOMY_TYPE,
  BETA_GRANT_CATEGORY,
  betaGrantTransactionId,
  checkBetaGrantReplay,
  normalizeBetaGrantUid,
  normalizeCampaignId,
  normalizeGrantId,
  normalizeReason,
  validateBetaGrantAmount,
} from "./domain/betaCredit.js";
import {
  BETA_ENTRY_FEE_CATEGORY,
  BETA_PRIZE_CATEGORY,
  checkRegistrationEconomy,
  decideBetaCompletedReplay,
  economyLockMaterialization,
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
  parseRequestedEconomyType,
  resolveTournamentEconomy,
} from "./domain/economy.js";
import {
  ACTIVITY_COLLECTION,
  ACTIVITY_TIMEZONE,
  activityDocumentId,
  businessDayKey,
  checkActivityReplay,
  normalizeActivityUid,
  validateClientDay,
  validateClientOffsetMinutes,
} from "./domain/playerActivity.js";
import {
  activityDaysInMonth,
  aggregateLedger,
  dailyNetArray,
  monthOfDayKey,
  normalizeMonth,
  normalizeStatsUid,
  STATS_TIMEZONE,
  type EconomyTotals,
  type LedgerRow,
} from "./domain/engagementStats.js";
import {
  checkExistingGuard,
  classifyPrizeCategory,
  prizeCountsAsWin,
  decideActivation,
  decideEntry,
  decideParent,
  FIRST_ACTIVE_SEASON_ID,
  isCompletedStatus,
  isPrizeTransactionId,
  RANKING_EVENTS_COLLECTION,
  RANKING_TIMEZONE,
  SEASON_ENTRIES_SUBCOLLECTION,
  SEASON_RANKINGS_COLLECTION,
  seasonDocumentId,
  seasonIdFromInstant,
  seasonWindow,
  toUsableDate,
  type PrizeRankingEvent,
  type RankingEconomy,
} from "./domain/seasonRanking.js";
import {
  assertSeasonServable,
  decodeCursor,
  decodeRankScalar,
  encodeCursor,
  encodeRankScalar,
  MAX_RANK_SCALAR,
  MIN_RANK_SCALAR,
  normalizeEconomy,
  normalizeLimit,
  publicEntry,
  RANKING_CURSOR_SECRET_ENV,
  rankFromAhead,
  type RankScalar,
} from "./domain/seasonLeaderboard.js";
import {
  isValidPublicId,
  projectPublicPreview,
} from "./domain/publicTournamentPreview.js";
import {
  assertPayoutDecision,
  decidePayouts,
  hasKillPrize,
  killPrizeCategoryFor,
  payoutTransactionId,
  payoutsMatchPersisted,
  poolFromRegistrations,
  type KillReport,
  type PersistedPayout,
} from "./domain/killPrize.js";
import {
  isRegistrationComplete,
  parseNickname,
  NICKNAMES_COLLECTION,
} from "./domain/nickname.js";
import {
  projectPublicProfile,
  type PublicProfile,
} from "./domain/publicProfile.js";
import {
  CREATOR_ENTRIES_SUBCOLLECTION,
  CREATOR_SEASONS_COLLECTION,
  CREATOR_LEADERBOARD_PAGE_SIZE,
  CREATOR_RANKINGS_COLLECTION,
  CREATOR_VOLUME_FIELD,
  decideCreatorAccrual,
  projectCreatorRow,
  type CreatorRow,
} from "./domain/creatorRanking.js";
import {
  CASH_PRIZE_CATEGORY,
} from "./domain/seasonRanking.js";
import {
  MAX_PAYOUT_PLAYERS,
} from "./domain/killPrize.js";
import {
  checkPointsConfig,
  checkPrizeDistribution,
  checkPrizeSlices,
  computeStandings,
  MAX_MATCHES,
  splitPrize,
  type MatchResult,
  type PointsConfig,
  type PrizeSlice,
} from "./domain/matchPoints.js";
import {
  checkPreset,
  checkPresetId,
  MAX_PRESETS_PER_OWNER,
  presetMessage,
} from "./domain/scoringPreset.js";
import {
  aggregateToCentavos,
  KNOWN_CATEGORIES,
  rollUpByEconomy,
  specFor,
  splitProfit,
  WINDOW_KEYS,
  windowStart,
  type CategoryTotal,
  type WindowKey,
} from "./domain/adminOverview.js";
import {
  badgeForPlacement,
  SEASON_BADGE_ECONOMY,
  seasonsToSettle,
} from "./domain/seasonBadges.js";
import {
  acknowledgeableIds,
  badgesToAward,
  pendingCelebrations,
  referredPlayerCounts,
} from "./domain/badges.js";
import {
  canApplicantSubmit,
  parsePartnerApplication,
  submitRefusalMessage,
  PARTNER_APPLICATIONS_COLLECTION,
  type ApplicationStatus,
} from "./domain/partnerApplication.js";
import {
  decideHouseFunding,
  houseDocId,
  houseFundingMessage,
  houseMarginCategoryFor,
  decideHouseDeposit,
  houseFundingCategoryFor,
  houseFundingTransactionId,
  HOUSE_BALANCE_FIELD,
  HOUSE_COLLECTION,
} from "./domain/house.js";
import {
  attributionExpiresAt,
  commissionAccrualId,
  COMMISSION_ACCRUED_CATEGORY,
  decideAttribution,
  decideCommission,
  normalizeReferralCode,
  normalizeRecentLimit,
  PARTNER_TOTAL_FIELD,
  PARTNERS_COLLECTION,
  projectPartnerAccrual,
  REFERRAL_CODES_COLLECTION,
  type CommissionDecision,
  type PartnerAccrualView,
  type PartnerEarningsView,
} from "./domain/partnerReferral.js";
import {
  assertPublicPlayerId,
  decidePublicPlayerIdReservation,
  encodePublicPlayerId,
  isPublicPlayerId,
  normalizeIdentityUid,
  PUBLIC_PLAYER_ID_COLLECTION,
  PUBLIC_PLAYER_ID_ENTROPY_BYTES,
  PUBLIC_PLAYER_ID_INDEX_COLLECTION,
  PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS,
} from "./domain/publicPlayerId.js";

admin.initializeApp();

const db = admin.firestore();

/**
 * Deployment regions, made EXPLICIT so a deploy targets exactly the region each
 * function already runs in — never the SDK default (us-central1).
 *
 * `onUserCreated` is deployed in `us-east1` in production; leaving it implicit
 * would make a deploy create a SECOND copy in us-central1. Pinning it here means
 * a future `--only functions:onUserCreated` updates the us-east1 function in
 * place. The six callables are pinned to `us-central1`, matching production.
 *
 * These change ONLY the region — not the trigger type, name, casing, arguments,
 * memory, timeout, runtime or generation.
 */
const REGION_CALLABLES = "us-central1";
const REGION_ON_USER_CREATED = "us-east1";

const central = region(REGION_CALLABLES);
const east = region(REGION_ON_USER_CREATED);

/**
 * PHASE 2.5B HARDENING — what changed, and what deliberately did NOT.
 *
 * UNCHANGED (production compatibility — no data migration required):
 *  - every exported function name, with its exact casing;
 *  - callable argument names (`amount`, `externalid`, `pixkey`, `tournamentid`,
 *    `winneruid`, `entry_fee`, `prize`, `max_players`, `game_mode`, ...);
 *  - collection names, document ids, and transaction `category` values;
 *  - Firestore money fields, which remain NUMBERS OF REAIS.
 *
 * CHANGED (internal only):
 *  - all money arithmetic runs on exact integer centavos and is converted back
 *    to reais only when written. Doubles drift; integers do not.
 *  - the admin UID check, previously duplicated inside two functions, is now a
 *    single transitional check that also accepts an `admin: true` custom claim.
 *  - tournament participant counts are read canonically with a legacy fallback,
 *    and both field pairs are advanced together.
 */

/** Converts a domain failure into the HttpsError the client already expects. */
function toHttpsError(error: unknown): https.HttpsError {
  if (error instanceof https.HttpsError) return error;
  if (error instanceof DomainError) {
    return new https.HttpsError(error.code, error.message);
  }
  console.error("Unexpected error:", error);
  return new https.HttpsError("internal", "Erro interno.");
}

function generateExternalId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}_${random}`;
}

function getExternalId(data: { externalid?: unknown }, prefix: string): string {
  const manualExternalId =
    typeof data.externalid === "string" ? data.externalid.trim() : "";

  if (manualExternalId.length > 0) {
    return manualExternalId;
  }

  return generateExternalId(prefix);
}

function generatePlayerId(): string {
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `PLR-${rand}`;
}

/**
 * Creates the user profile and wallet. UNCHANGED from the deployed version:
 * this trigger remains the authoritative creator of `users/{uid}` and
 * `wallets/{uid}`, and the mobile client writes neither.
 *
 * KNOWN ISSUE (see `docs/username.md`): `username` is seeded empty, and this
 * trigger cannot reliably read a display name the client sets afterwards.
 * Fixing that needs an authenticated callable, deliberately NOT added here.
 */
export const onUserCreated = east.auth.user().onCreate(async (user) => {
  const uid = user.uid;
  const email = user.email ?? "";

  const playerId = generatePlayerId();

  const userRef = db.collection("users").doc(uid);
  const walletRef = db.collection("wallets").doc(uid);

  const userData = {
    email: email,
    username: "",
    player_id: playerId,
    pix_key: "",
    whatsapp: "",
    /**
     * When the account started.
     *
     * WRITTEN HERE BECAUSE NOTHING ELSE WROTE IT. The public profile shows
     * "Desde agosto de 2026", and `projectPublicProfile` reads `created_at` —
     * which no path in this backend had ever set, so the line rendered for
     * nobody. This is the only moment the answer is knowable without guessing.
     *
     * ACCOUNTS THAT PREDATE THIS LINE stay without it, and their profile shows
     * no "Desde". Backfilling would mean inventing a date from whatever
     * artefact happened to survive — a first tournament, a wallet document —
     * and a profile is a bad place to publish a guess as a fact.
     */
    created_at: FieldValue.serverTimestamp(),
  };

  const walletData = {
    balance: 0,
    total_deposited: 0,
    total_won: 0,
    total_spent: 0,
    total_withdrawn: 0,
    // Beta Credits (closed beta): non-monetary, never withdrawable, and kept
    // strictly apart from the five cash fields above. Old wallets without this
    // field are READ as zero — no migration writes it retroactively.
    beta_balance: 0,
    user_ref: userRef,
  };

  try {
    await db.runTransaction(async (transaction) => {
      transaction.set(userRef, userData, { merge: true });
      transaction.set(walletRef, walletData, { merge: true });
    });

    console.log(`onUserCreated: Created user ${uid} and wallet ${uid}`);
  } catch (error) {
    console.error(
      `onUserCreated: Failed to create user/wallet for uid ${uid}`,
      error
    );
  }
});

/**
 * The server-side facts about which project this process writes to.
 *
 * All three are set by the runtime, never by a caller: the two environment
 * variables come from the Functions runtime (or from `emulators:exec`), and the
 * third is what `admin.initializeApp()` actually resolved. NOTHING here derives
 * from the callable payload — that is the property the gate depends on.
 *
 * Undefined entries are dropped downstream; disagreement between the survivors
 * is a refusal, not a vote.
 */
function effectiveProjectCandidates(): unknown[] {
  return [
    process.env.GCLOUD_PROJECT,
    process.env.GOOGLE_CLOUD_PROJECT,
    admin.app().options.projectId,
  ];
}

/**
 * Test-only seam, following the same options-with-defaults convention as
 * `onPrizeTransactionCreatedHandler`. It is a TypeScript parameter, never a
 * payload field, so no client can reach it and no client can choose the project.
 */
export interface TestDepositOptions {
  readonly projectCandidates?: readonly unknown[];
}

/**
 * TEST-ONLY FUNDING — mints withdrawable cash, and therefore carries TWO
 * independent gates.
 *
 * 1. WHO: the `admin: true` custom claim, unchanged.
 * 2. WHERE: the effective project must be a `demo-` project.
 *
 * The second gate exists because the first cannot protect the ledger. This
 * function is an authorized production deploy target, so a single mis-issued
 * admin claim on `sparta-battle` would otherwise be enough to create real money.
 * The environment gate runs BEFORE amount validation, before the external id is
 * derived and before any read or write — a refused call leaves no trace in the
 * wallet, the ledger or the transaction collection.
 *
 * The refusal message is curated and constant (`DEMO_PROJECT_REFUSED_MESSAGE`):
 * it discloses no project id, no environment variable and no configuration.
 */
export const testdepositHandler = async (
  data: any,
  context: any,
  options: TestDepositOptions = {}
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para fazer depósito.",
      "Apenas admin pode fazer depósito de teste."
    );

    // WHERE, immediately after WHO and before everything else. The candidates
    // are read from the runtime here; `options` only ever replaces them in tests.
    assertDemoProject(options.projectCandidates ?? effectiveProjectCandidates());

    const uid = callerAuth.uid;

    const amountCentavos = validateDepositAmount(data.amount);
    const externalId = getExternalId(data, "deposit");

    const walletRef = db.collection("wallets").doc(uid);
    const userRef = db.collection("users").doc(uid);
    const transactionRef = db.collection("transactions").doc(externalId);

    await db.runTransaction(async (transaction) => {
      const existingTransaction = await transaction.get(transactionRef);

      // Idempotency: the same externalid must never be applied twice.
      if (existingTransaction.exists) {
        throw new DomainError(
          "already-exists",
          "Já existe uma transação com esse externalid."
        );
      }

      const walletSnap = await transaction.get(walletRef);
      const walletData = walletSnap.exists ? walletSnap.data() ?? {} : {};

      const previousBalance = storedReaisToCentavos(
        walletData.balance ?? 0,
        "saldo da carteira"
      );
      const totalDeposited = storedReaisToCentavos(
        walletData.total_deposited ?? 0,
        "total depositado"
      );

      const newBalance = credit(previousBalance, amountCentavos);
      const newTotalDeposited = addCentavos(totalDeposited, amountCentavos);

      transaction.set(
        walletRef,
        {
          balance: centavosToReais(newBalance),
          total_deposited: centavosToReais(newTotalDeposited),
          user_ref: userRef,
        },
        { merge: true }
      );

      transaction.set(transactionRef, {
        amount: centavosToReais(amountCentavos),
        category: "deposit",
        user_ref: userRef,
        display_name: "Test Deposit",
        tournament_ref: null,
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(newBalance),
        timestamp: FieldValue.serverTimestamp(),
        status: "completed",
        external_id: externalId,
      });
    });

    return {
      success: true,
      message: "Depósito de teste realizado com sucesso.",
      externalid: externalId,
      amount: centavosToReais(amountCentavos),
    };
  } catch (error) {
    console.error("testdeposit error:", error);
    throw toHttpsError(error);
  }
};

export const testdeposit = central.https.onCall(
  async (data: any, context: any) => testdepositHandler(data, context)
);

export const requestwithdrawal = central.https.onCall(async (data, context) => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para solicitar saque."
    );

    const uid = callerAuth.uid;

    // Enforces the R$5,00 minimum and R$10.000,00 maximum, unchanged.
    const amountCentavos = validateWithdrawalAmount(data.amount);

    const pixkey = String(data.pixkey || "").trim();

    if (!pixkey) {
      throw new DomainError("invalid-argument", "A chave PIX é obrigatória.");
    }

    if (pixkey.length < 5 || pixkey.length > 140) {
      throw new DomainError("invalid-argument", "Chave PIX inválida.");
    }

    // Blocks control characters and other invisible junk.
    if (/[\x00-\x1F\x7F]/.test(pixkey)) {
      throw new DomainError(
        "invalid-argument",
        "Chave PIX contém caracteres inválidos."
      );
    }

    const userRef = db.collection("users").doc(uid);
    const walletRef = db.collection("wallets").doc(uid);

    const externalid = generateExternalId("withdrawal");

    const transactionRef = db.collection("transactions").doc(externalid);
    const withdrawalRef = db.collection("withdrawals").doc(externalid);

    await db.runTransaction(async (transaction) => {
      const walletSnap = await transaction.get(walletRef);

      if (!walletSnap.exists) {
        throw new DomainError(
          "failed-precondition",
          "Carteira não encontrada."
        );
      }

      const walletData = walletSnap.data() ?? {};

      const previousBalance = storedReaisToCentavos(
        walletData.balance ?? 0,
        "saldo da carteira"
      );
      const totalWithdrawn = storedReaisToCentavos(
        walletData.total_withdrawn ?? 0,
        "total sacado"
      );

      // Enforces "you cannot withdraw more than you have".
      const balanceAfter = debit(previousBalance, amountCentavos);

      transaction.update(walletRef, {
        balance: centavosToReais(balanceAfter),
        // Computed from the value read inside this transaction rather than
        // FieldValue.increment(): increment() adds floats, which drift.
        total_withdrawn: centavosToReais(
          addCentavos(totalWithdrawn, amountCentavos)
        ),
      });

      transaction.set(transactionRef, {
        amount: centavosToReais(amountCentavos),
        category: "withdrawal",
        user_ref: userRef,
        display_name: "Saque",
        tournament_ref: null,
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(balanceAfter),
        timestamp: FieldValue.serverTimestamp(),
        status: "pending",
        external_id: externalid,
      });

      transaction.set(withdrawalRef, {
        amount: centavosToReais(amountCentavos),
        user_ref: userRef,
        status: "pending",
        pix_key_snapshot: pixkey,
        transaction_ref: transactionRef,

        // Reserved for the future PIX provider integration.
        provider: null,
        provider_status: null,
        pix_tx_id: null,
        error_message: null,

        requested_at: FieldValue.serverTimestamp(),
        paid_at: null,
        failed_at: null,
      });
    });

    return {
      success: true,
      externalid: externalid,
      amount: centavosToReais(amountCentavos),
      status: "pending",
    };
  } catch (error) {
    console.error("requestwithdrawal error:", error);
    throw toHttpsError(error);
  }
});

export const jointournament = central.https.onCall(async (data, context) => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para entrar no torneio."
    );

    const uid = callerAuth.uid;

    const tournamentid = String(data.tournamentid || "").trim();

    if (!tournamentid) {
      throw new DomainError("invalid-argument", "ID do torneio é obrigatório.");
    }

    if (tournamentid.includes("/") || tournamentid.length > 200) {
      throw new DomainError("invalid-argument", "ID do torneio inválido.");
    }

    const userRef = db.collection("users").doc(uid);
    const walletRef = db.collection("wallets").doc(uid);
    const tournamentRef = db.collection("tournaments").doc(tournamentid);

    // Deterministic id — this is what makes double registration impossible.
    const registrationid = `${uid}_${tournamentid}`;
    const registrationRef = db.collection("registrations").doc(registrationid);

    const externalid = generateExternalId("entryfee");
    const transactionRef = db.collection("transactions").doc(externalid);

    await db.runTransaction(async (transaction) => {
      const walletSnap = await transaction.get(walletRef);
      const tournamentSnap = await transaction.get(tournamentRef);
      const registrationSnap = await transaction.get(registrationRef);

      if (!walletSnap.exists) {
        throw new DomainError(
          "failed-precondition",
          "Carteira não encontrada."
        );
      }

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      const walletData = walletSnap.data() ?? {};
      const tournamentData = tournamentSnap.data() ?? {};

      // The bucket comes EXCLUSIVELY from the stored tournament (economy_type
      // + its durable lock); the caller can never choose it. An invalid or
      // diverged persisted economy fails closed BEFORE any money or state.
      const economy = resolveTournamentEconomy(tournamentData);

      // Duplicate registration is checked before any money is touched. A
      // replay must additionally still be economically consistent: if the
      // stored registration's provenance no longer matches the tournament's
      // economy, that is a divergence — failed-precondition, no write.
      if (registrationSnap.exists) {
        const registrationData = registrationSnap.data() ?? {};
        const replayEconomy = checkRegistrationEconomy({
          registrationEconomy: registrationData.economy_type,
          tournamentEconomy: economy,
        });
        if (!replayEconomy.ok) {
          throw new DomainError("failed-precondition", replayEconomy.message);
        }
        throw new DomainError(
          "already-exists",
          "Você já está inscrito neste torneio."
        );
      }

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();

      if (status !== "open") {
        throw new DomainError(
          "failed-precondition",
          "Este torneio não está aberto para inscrições."
        );
      }

      const entryFeeCentavos = validateEntryFee(tournamentData.entry_fee);

      // Canonical-first with a legacy fallback. Throws when the capacity is
      // missing or the two field pairs disagree — never silently zero.
      const counts = readParticipantCounts(tournamentData);

      if (isFull(counts)) {
        throw new DomainError(
          "failed-precondition",
          "Este torneio já está lotado."
        );
      }

      // ── Debit the ONE bucket the tournament's economy names. There is no
      // fallback, no split and no combination: a cash tournament sees only
      // `balance` (even with plenty of beta), a beta tournament sees only
      // `beta_balance` (even with plenty of cash). `debit()` is pure integer
      // math and stays source-agnostic — the ROUTING happens here.
      let transactionData: Record<string, unknown>;
      if (economy === ECONOMY_BETA_CREDIT) {
        const previousBeta = storedReaisToCentavos(
          walletData.beta_balance ?? 0,
          "saldo beta"
        );
        const betaAfter = debit(previousBeta, entryFeeCentavos);

        // ONLY beta_balance moves. The five cash fields are never touched.
        transaction.update(walletRef, {
          beta_balance: centavosToReais(betaAfter),
        });

        transactionData = {
          amount: centavosToReais(entryFeeCentavos),
          category: BETA_ENTRY_FEE_CATEGORY,
          economy_type: ECONOMY_BETA_CREDIT,
          user_ref: userRef,
          display_name: "Entrada em torneio",
          tournament_ref: tournamentRef,
          // Beta-pool stamps — deliberately NOT previous_balance/balance_after,
          // which in every cash transaction refer to the real `balance`.
          beta_previous_balance: centavosToReais(previousBeta),
          beta_balance_after: centavosToReais(betaAfter),
          timestamp: FieldValue.serverTimestamp(),
          status: "completed",
          external_id: externalid,
        };
      } else {
        const previousBalance = storedReaisToCentavos(
          walletData.balance ?? 0,
          "saldo da carteira"
        );
        const totalSpent = storedReaisToCentavos(
          walletData.total_spent ?? 0,
          "total gasto"
        );

        // Enforces "you cannot spend what you do not have".
        const balanceAfter = debit(previousBalance, entryFeeCentavos);

        transaction.update(walletRef, {
          balance: centavosToReais(balanceAfter),
          total_spent: centavosToReais(
            addCentavos(totalSpent, entryFeeCentavos)
          ),
        });

        transactionData = {
          amount: centavosToReais(entryFeeCentavos),
          category: "entry_fee",
          economy_type: ECONOMY_CASH,
          user_ref: userRef,
          display_name: "Entrada em torneio",
          tournament_ref: tournamentRef,
          previous_balance: centavosToReais(previousBalance),
          balance_after: centavosToReais(balanceAfter),
          timestamp: FieldValue.serverTimestamp(),
          status: "completed",
          external_id: externalid,
        };
      }

      // Advances BOTH the canonical and the legacy counter together, so the two
      // representations can never drift apart. On a LEGACY document this same
      // legitimate update also materializes the resolved economy + lock (absent
      // fields only — never a standalone normalization write).
      transaction.update(tournamentRef, {
        ...participantIncrementUpdate(counts),
        ...economyLockMaterialization(tournamentData, economy),
      });

      /**
       * The player's running count of tournaments played.
       *
       * DENORMALISED because the alternative is unusable: the badge tiers ask
       * "has this account played 500 tournaments", and a partner's tier asks
       * that of EVERY player they brought. Answering from `registrations`
       * would be one query per player per check.
       *
       * Incremented in the same transaction that creates the registration, so
       * the count and the rows it counts can never disagree. `increment` and
       * not a read-modify-write: two concurrent joins must both be counted.
       */
      transaction.set(
        userRef,
        { tournaments_played: FieldValue.increment(1) },
        { merge: true }
      );

      transaction.set(registrationRef, {
        user_ref: userRef,
        tournament_ref: tournamentRef,
        entry_fee: centavosToReais(entryFeeCentavos),
        status: "registered",
        // Economic provenance + server-authoritative snapshot: which economy
        // paid this entry and exactly how much, plus the ledger reference.
        economy_type: economy,
        entry_fee_snapshot: centavosToReais(entryFeeCentavos),
        transaction_ref: transactionRef,
        created_at: FieldValue.serverTimestamp(),
      });

      transaction.set(transactionRef, transactionData);
    });

    return {
      success: true,
      tournamentid: tournamentid,
      registrationid: registrationid,
      externalid: externalid,
      status: "registered",
    };
  } catch (error) {
    console.error("jointournament error:", error);
    throw toHttpsError(error);
  }
});

/**
 * ADMIN-ONLY: moves a tournament `open -> in_progress`, the safe pre-state that
 * must exist before a result can be declared. A tournament may only start once
 * its room is genuinely published (valid credentials pointing at it) and its
 * prize is a valid, strictly-positive amount — so the settlement that follows
 * can never run against a broken tournament.
 *
 * Exported for behavioral tests; a plain function with no trigger metadata is
 * NOT a deployable endpoint.
 */
export const startTournamentHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context,
      "Você precisa estar logado para iniciar o torneio.",
      "Apenas admin pode iniciar o torneio."
    );

    // Exactly `{ tournamentid }`; any extra key is invalid-argument.
    assertExactPayload(data, ["tournamentid"]);
    const tournamentid = normalizeTournamentId(data.tournamentid);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const roomRef = db.collection("tournament_rooms").doc(tournamentid);

    await db.runTransaction(async (transaction) => {
      // Reads first — every read before any write.
      const tournamentSnap = await transaction.get(tournamentRef);
      const roomSnap = await transaction.get(roomRef);

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      const tournamentData = tournamentSnap.data() ?? {};

      // No money moves here, but the transition still fails closed on an
      // invalid or diverged persisted economy — a corrupt tournament is never
      // advanced. The payload cannot carry economy_type (exact allowlist
      // above), the type/lock are never rewritten, and the idempotent replay
      // keeps writing nothing.
      resolveTournamentEconomy(tournamentData);

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();

      const gate = gateStartStatus(status);
      if (gate.kind === "fail") {
        // completed or any status other than open/in_progress.
        throw new DomainError("failed-precondition", gate.message);
      }

      // Structural preconditions apply to BOTH the first start and the
      // idempotent replay: a published, matching room and a valid prize.
      const roomData = roomSnap.exists ? roomSnap.data() ?? {} : {};
      const preconditions = checkStartPreconditions({
        tournamentid,
        roomExists: roomSnap.exists,
        roomId: roomData.room_id,
        roomPassword: roomData.room_password,
        roomTournamentRefPath: documentPath(roomData.tournament_ref),
        prize: tournamentData.prize,
        killPrize: tournamentData.kill_prize,
      });
      if (!preconditions.ok) {
        throw new DomainError("failed-precondition", preconditions.message);
      }

      // Idempotent replay: already in_progress and still structurally valid.
      // Return success WITHOUT rewriting any field — no timestamp churn.
      if (gate.kind === "replay") {
        return;
      }

      // First execution: open -> in_progress. Only status + updated_at move;
      // created_at and starts_at are deliberately left untouched.
      transaction.update(tournamentRef, {
        status: "in_progress",
        updated_at: FieldValue.serverTimestamp(),
      });
    });

    return { success: true };
  } catch (error) {
    console.error("startTournament error:", error);
    throw toHttpsError(error);
  }
};

/**
 * ADMIN-ONLY, CANONICAL settlement: declares the single MVP winner and pays the
 * prize atomically, moving a tournament `in_progress -> completed`.
 *
 * SECURITY: the client supplies ONLY `{ tournamentid, winneruid }`. The prize
 * comes from `tournaments/{id}.prize`, the financial id is the deterministic
 * `prize_{tournamentid}`, and the winner's identity is verified against the
 * canonical registration — nothing financial is ever taken from the caller.
 *
 * IDEMPOTENCY & CONCURRENCY: the tournament and the deterministic prize
 * transaction are read INSIDE the transaction, so Firestore's optimistic retry
 * re-evaluates the state after a concurrent commit. Two identical calls yield two
 * successes and exactly one credit; two different winners yield one success and
 * one failed-precondition.
 *
 * Exported for behavioral tests; not a deployable endpoint (no trigger).
 */
export const declareTournamentResultHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context,
      "Você precisa estar logado para declarar o resultado.",
      "Apenas admin pode declarar o resultado."
    );

    // Exactly `{ tournamentid, winneruid }`. amount/externalid/prize/
    // transactionid/status/refs are NOT accepted keys → invalid-argument.
    assertExactPayload(data, ["tournamentid", "winneruid"]);
    const tournamentid = normalizeTournamentId(data.tournamentid);
    const winneruid = normalizeWinnerUid(data.winneruid);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const winnerUserRef = db.collection("users").doc(winneruid);
    const winnerWalletRef = db.collection("wallets").doc(winneruid);
    const registrationRef = db
      .collection("registrations")
      .doc(registrationId(winneruid, tournamentid));
    const prizeTxRef = db
      .collection("transactions")
      .doc(prizeTransactionId(tournamentid));

    await db.runTransaction(async (transaction) => {
      // ── Reads that gate the decision (before any write) ──
      const tournamentSnap = await transaction.get(tournamentRef);
      const prizeTxSnap = await transaction.get(prizeTxRef);

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      const tournamentData = tournamentSnap.data() ?? {};

      /**
       * A per-kill tournament belongs to the other handler and is refused here.
       *
       * Without this the single-winner path would settle it happily: it would
       * pay the placement prize, IGNORE every kill, and mark the tournament
       * completed — leaving the per-kill payouts permanently unpayable, because
       * the settlement gate refuses a second attempt. The two handlers are
       * mutually exclusive by the tournament's own configuration, so an
       * operator never has a choice to get wrong.
       */
      if (hasKillPrize(tournamentData)) {
        throw new DomainError(
          "failed-precondition",
          "Este torneio paga por abate. Declare o resultado informando os abates."
        );
      }

      // The prize's economy comes EXCLUSIVELY from the stored tournament
      // (economy_type + durable lock), resolved BEFORE anything can move.
      // Invalid or diverged persisted state fails closed: no credit, no
      // status change, no result.
      const economy = resolveTournamentEconomy(tournamentData);

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();
      const resultExists =
        tournamentData.result !== undefined && tournamentData.result !== null;

      const gate = gateSettlementStatus(
        status,
        resultExists,
        prizeTxSnap.exists
      );

      if (gate.kind === "fail") {
        throw new DomainError("failed-precondition", gate.message);
      }

      // ── Idempotent replay: status === completed ──
      // The replay check is ECONOMY-AWARE: a cash tournament demands the
      // canonical cash settlement shape (category "prize"), a beta tournament
      // demands the beta shape (category "beta_prize" + economy stamps). A
      // settlement persisted under the other economy is a divergence, never
      // an equivalent replay. No timestamp is rewritten on an identical replay.
      if (gate.kind === "replay") {
        const persistedResult = resultExists
          ? (tournamentData.result as Record<string, unknown>)
          : null;
        const persistedTx = prizeTxSnap.exists
          ? prizeTxSnap.data() ?? {}
          : null;

        const replay =
          economy === ECONOMY_BETA_CREDIT
            ? decideBetaCompletedReplay({
                winneruid,
                tournamentid,
                resultExists,
                txExists: prizeTxSnap.exists,
                result: persistedResult
                  ? {
                      winner_uid: persistedResult.winner_uid,
                      winner_ref: documentPath(persistedResult.winner_ref),
                      registration_ref: documentPath(
                        persistedResult.registration_ref
                      ),
                      transaction_ref: documentPath(
                        persistedResult.transaction_ref
                      ),
                      prize: persistedResult.prize,
                      economy_type: persistedResult.economy_type,
                    }
                  : null,
                tx: persistedTx
                  ? {
                      category: persistedTx.category,
                      economy_type: persistedTx.economy_type,
                      external_id: persistedTx.external_id,
                      user_ref: documentPath(persistedTx.user_ref),
                      tournament_ref: documentPath(persistedTx.tournament_ref),
                      amount: persistedTx.amount,
                    }
                  : null,
              })
            : decideCompletedReplay({
                winneruid,
                tournamentid,
                resultExists,
                txExists: prizeTxSnap.exists,
                result: persistedResult
                  ? {
                      winner_uid: persistedResult.winner_uid,
                      winner_ref: documentPath(persistedResult.winner_ref),
                      registration_ref: documentPath(
                        persistedResult.registration_ref
                      ),
                      transaction_ref: documentPath(
                        persistedResult.transaction_ref
                      ),
                      prize: persistedResult.prize,
                    }
                  : null,
                tx: persistedTx
                  ? {
                      category: persistedTx.category,
                      external_id: persistedTx.external_id,
                      user_ref: documentPath(persistedTx.user_ref),
                      tournament_ref: documentPath(persistedTx.tournament_ref),
                      amount: persistedTx.amount,
                    }
                  : null,
              });

        if (!replay.ok) {
          throw new DomainError("failed-precondition", replay.message);
        }
        // Fully equivalent: success with NO credit and NO write.
        return;
      }

      // ── Mutating path: status === in_progress, no result, no transaction ──
      const registrationSnap = await transaction.get(registrationRef);
      const walletSnap = await transaction.get(winnerWalletRef);

      const registrationData = registrationSnap.exists
        ? registrationSnap.data() ?? {}
        : {};
      const registration = checkRegistration({
        exists: registrationSnap.exists,
        status: registrationData.status,
        userRefPath: documentPath(registrationData.user_ref),
        tournamentRefPath: documentPath(registrationData.tournament_ref),
        winneruid,
        tournamentid,
      });
      if (!registration.ok) {
        throw new DomainError("failed-precondition", registration.message);
      }

      // ── SOLVENCY, on this path too.
      //
      // This handler had NO ceiling at all: a fixed prize was paid however few
      // players joined, so an underfilled tournament quietly paid out more than
      // it collected with nothing to stop it. Binding only the per-kill path
      // would have left this format as the bypass — an operator wanting to
      // overpay had merely to choose the other one.
      //
      // Reads first, as Firestore requires and as the decision needs.
      const settlementRegistrations = await transaction.get(
        db.collection("registrations").where("tournament_ref", "==", tournamentRef)
      );
      const settlementPool = poolFromRegistrations(
        settlementRegistrations.docs.map((d) => ({
          status: d.get("status"),
          entryFeeSnapshot: d.get("entry_fee_snapshot"),
          uid: uidFromUserRefPath(documentPath(d.get("user_ref"))),
          economyType: d.get("economy_type"),
          tournamentEntryFee: tournamentData.entry_fee,
        })),
        economy
      );
      if (!settlementPool.ok) {
        throw new DomainError(
          "failed-precondition",
          "Não foi possível apurar o total arrecadado deste torneio."
        );
      }

      const settlementHouseRef = db
        .collection(HOUSE_COLLECTION)
        .doc(houseDocId(economy));
      const settlementHouseSnap = await transaction.get(settlementHouseRef);
      const settlementHouseBefore = readHouseBalance(settlementHouseSnap);

      // The winner's registration must have been paid under the SAME economy
      // the tournament settles in. A legacy (provenance-less) registration is
      // accepted only on the cash path; a beta tournament with a cash or
      // provenance-less registration — e.g. after an economy flip — fails
      // closed, atomically: no credit, no status change, no result.
      const registrationEconomy = checkRegistrationEconomy({
        registrationEconomy: registrationData.economy_type,
        tournamentEconomy: economy,
      });
      if (!registrationEconomy.ok) {
        throw new DomainError(
          "failed-precondition",
          registrationEconomy.message
        );
      }

      if (!walletSnap.exists) {
        throw new DomainError(
          "not-found",
          "Carteira do vencedor não encontrada."
        );
      }

      // The prize comes from the tournament, never the client.
      const prize = inspectStoredPrize(tournamentData.prize);
      if (!prize.ok) {
        throw new DomainError("failed-precondition", prize.message);
      }
      const prizeCentavos = prize.centavos;

      // Decided here, where the prize is finally known, from the reads taken
      // above. Refuses BEFORE any wallet, ledger or tournament write.
      const settlementFunding = decideHouseFunding({
        poolCentavos: settlementPool.centavos,
        paidCentavos: prizeCentavos,
        houseCentavos: settlementHouseBefore,
      });
      if (!settlementFunding.ok) {
        throw new DomainError(
          "failed-precondition",
          houseFundingMessage(settlementFunding, (c) =>
            formatCentavos(c, economy)
          )
        );
      }

      const walletData = walletSnap.data() ?? {};

      const externalId = prizeTransactionId(tournamentid);
      const prizeReais = centavosToReais(prizeCentavos);
      // ONE server-timestamp sentinel, reused so every stamp written in this
      // commit resolves to the exact same time.
      const stampedAt = FieldValue.serverTimestamp();

      // ── The treasury moves once, outside the economy branch, because the
      // decision above already resolved which economy's house it belongs to.
      transaction.set(
        settlementHouseRef,
        {
          [HOUSE_BALANCE_FIELD]: settlementFunding.houseAfterCentavos,
          economy_type: economy,
          updated_at: stampedAt,
        },
        { merge: true }
      );
      transaction.create(
        db.collection("transactions").doc(`house_${tournamentid}`),
        {
          amount_centavos: settlementFunding.marginCentavos,
          amount_unit: "centavos",
          balance_after_centavos: settlementFunding.houseAfterCentavos,
          category: houseMarginCategoryFor(economy),
          economy_type: economy,
          pool_centavos: settlementPool.centavos,
          paid_centavos: prizeCentavos,
          subsidised: settlementFunding.subsidised,
          tournament_ref: tournamentRef,
          // NO user_ref: the platform's row, invisible to the wallet reconciler.
          timestamp: stampedAt,
          status: "completed",
        }
      );

      if (economy === ECONOMY_BETA_CREDIT) {
        // ── BETA settlement: the prize is Beta Credits, credited EXCLUSIVELY
        // to beta_balance. None of the five cash fields (balance,
        // total_deposited, total_won, total_spent, total_withdrawn) moves,
        // and the ledger entry is unmistakably beta — it can never be read
        // as a cash deposit or cash prize, and it stays non-withdrawable.
        const previousBeta = storedReaisToCentavos(
          walletData.beta_balance ?? 0,
          "saldo beta"
        );
        const betaAfter = credit(previousBeta, prizeCentavos);

        transaction.update(winnerWalletRef, {
          beta_balance: centavosToReais(betaAfter),
        });

        transaction.set(prizeTxRef, {
          amount: prizeReais,
          category: BETA_PRIZE_CATEGORY,
          economy_type: ECONOMY_BETA_CREDIT,
          user_ref: winnerUserRef,
          display_name: "",
          tournament_ref: tournamentRef,
          beta_previous_balance: centavosToReais(previousBeta),
          beta_balance_after: centavosToReais(betaAfter),
          timestamp: stampedAt,
          status: "completed",
          external_id: externalId,
        });

        transaction.update(tournamentRef, {
          status: "completed",
          result: {
            placement: 1,
            winner_uid: winneruid,
            winner_ref: winnerUserRef,
            registration_ref: registrationRef,
            prize: prizeReais,
            transaction_ref: prizeTxRef,
            economy_type: ECONOMY_BETA_CREDIT,
            declared_at: stampedAt,
            paid_at: stampedAt,
          },
          updated_at: stampedAt,
        });
        return;
      }

      // ── CASH settlement: preserved integrally from the approved flow. ──
      const previousBalance = storedReaisToCentavos(
        walletData.balance ?? 0,
        "saldo da carteira"
      );
      const previousTotalWon = storedReaisToCentavos(
        walletData.total_won ?? 0,
        "total ganho"
      );

      const balanceAfter = credit(previousBalance, prizeCentavos);
      const totalWonAfter = addCentavos(previousTotalWon, prizeCentavos);

      // 1 + 2. Credit the wallet and stamp its updated_at.
      transaction.update(winnerWalletRef, {
        balance: centavosToReais(balanceAfter),
        total_won: centavosToReais(totalWonAfter),
        updated_at: stampedAt,
      });

      // 3. Deterministic prize transaction — the canonical prize schema. The
      // ONLY changes from the legacy path: the id is prize_{tournamentid}, the
      // external_id is derived internally, and the amount comes from the
      // tournament. No field is added or removed.
      transaction.set(prizeTxRef, {
        amount: prizeReais,
        category: "prize",
        user_ref: winnerUserRef,
        display_name: "",
        tournament_ref: tournamentRef,
        previous_balance: centavosToReais(previousBalance),
        balance_after: centavosToReais(balanceAfter),
        timestamp: stampedAt,
        status: "completed",
        external_id: externalId,
      });

      // 4 + 5 + 6. Persist the result, move to completed, stamp updated_at.
      transaction.update(tournamentRef, {
        status: "completed",
        result: {
          placement: 1,
          winner_uid: winneruid,
          winner_ref: winnerUserRef,
          registration_ref: registrationRef,
          prize: prizeReais,
          transaction_ref: prizeTxRef,
          declared_at: stampedAt,
          paid_at: stampedAt,
        },
        updated_at: stampedAt,
      });
    });

    return { success: true };
  } catch (error) {
    console.error("declareTournamentResult error:", error);
    throw toHttpsError(error);
  }
};

// Exported for behavioral tests of the authorization ordering. This is a plain
// function (no trigger metadata), so it is NOT a deployable endpoint — only the
// `createTournament` / `createtournament` onCall wrappers below are. Both wrap
// this same guarded handler.
/** A frozen operator-facing message for each scoring/ distribution refusal. */
function pointsConfigMessage(reason: string): string {
  switch (reason) {
    case "bad-matches-count":
      return `A quantidade de partidas precisa ser um número inteiro de 1 a ${MAX_MATCHES}.`;
    case "bad-kill-points":
      return "Os pontos por abate precisam ser um número inteiro e não negativo.";
    case "bad-placement-points":
      return "Os pontos por colocação precisam ser números inteiros e não negativos.";
    case "too-many-placements":
      return "A tabela de pontos por colocação tem posições demais.";
    case "empty-distribution":
      return "Informe ao menos uma posição na divisão da premiação.";
    case "bad-slice":
      return "Cada posição da divisão precisa de um valor maior que zero.";
    case "duplicate-position":
      return "A mesma posição aparece duas vezes na divisão da premiação.";
    case "non-consecutive-positions":
      return "A divisão precisa começar no 1º lugar e não pular posições.";
    case "must-total-prize":
      return "A soma da divisão precisa dar exatamente o valor da premiação.";
    case "too-many-slices":
      return "A divisão da premiação tem posições demais.";
    default:
      return "Configuração de pontuação inválida.";
  }
}

export const createTournamentHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    // ADMIN-ONLY. Authorization runs BEFORE any payload validation, document
    // read, persistent-reference creation, transaction, batch, or write. It uses
    // the same centralized claim check as the other admin callables: a UID or an
    // email grants nothing, and `admin` must be boolean true. An unauthenticated
    // caller gets `unauthenticated`; an authenticated non-admin gets
    // `permission-denied` — both before the handler touches Firestore.
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para criar um campeonato.",
      "Apenas admin pode criar campeonatos."
    );

    const uid = callerAuth.uid;

    const name = String(data.name || "").trim();
    const description = String(data.description || "").trim();

    if (!name) {
      throw new DomainError(
        "invalid-argument",
        "O nome do campeonato é obrigatório."
      );
    }

    // The economy is chosen EXACTLY once, at creation: "cash" (real BRL) or
    // "beta_credit" (non-withdrawable Beta Credits). Required — no default,
    // no alias, no coercion. It can never change afterwards.
    const economyType = parseRequestedEconomyType(data.economy_type);

    // Entry fee and prize may legitimately be zero (a free tournament), but
    // never negative, and never finer than centavos. The SAME safe numeric
    // representation serves both economies; for "cash" the unit is BRL, for
    // "beta_credit" it is Beta Credit units (never BRL).
    const entryFeeCentavos = toCentavos(data.entry_fee, {
      field: "valor da inscrição",
      allowZero: true,
    });
    const prizeCentavos = toCentavos(data.prize, {
      field: "valor da premiação",
      allowZero: true,
    });

    /**
     * Per-kill prize. Absent means a placement-only tournament, which is the
     * shape every existing tournament has — so omitting it changes nothing.
     *
     * Zero and absent are the SAME thing here on purpose: `hasKillPrize` reads
     * "> 0", and a stored zero would otherwise look configured while behaving
     * as unconfigured, which is exactly the ambiguity that decides WHICH
     * settlement handler a tournament belongs to.
     */
    const killPrizeCentavos =
      data.kill_prize === undefined || data.kill_prize === null
        ? 0
        : toCentavos(data.kill_prize, {
            field: "valor por abate",
            allowZero: true,
          });

    /**
     * A tournament has to pay something. Placement-only and per-kill-only are
     * both legitimate; paying nothing at all is not, and would otherwise be
     * creatable and then impossible to start.
     */
    if (prizeCentavos === 0 && killPrizeCentavos === 0) {
      throw new DomainError(
        "invalid-argument",
        "Informe a premiação por colocação, o valor por abate, ou os dois."
      );
    }

    /**
     * MULTI-PARTIDA E PONTUAÇÃO.
     *
     * `matches_count` ausente significa UMA partida, que é a forma de todo
     * torneio que já existe — omitir não muda nada. Um campeonato de uma
     * partida com pontuação é normal, não um caso especial.
     */
    const matchesCount =
      data.matches_count === undefined || data.matches_count === null
        ? 1
        : Number(data.matches_count);

    const pointsConfig: PointsConfig = {
      killPoints:
        data.kill_points === undefined || data.kill_points === null
          ? 0
          : Number(data.kill_points),
      placementPoints: Array.isArray(data.placement_points)
        ? data.placement_points.map((p: unknown) => Number(p))
        : [],
    };

    const configCheck = checkPointsConfig(matchesCount, pointsConfig);
    if (!configCheck.ok) {
      throw new DomainError(
        "invalid-argument",
        pointsConfigMessage(configCheck.reason)
      );
    }

    /**
     * A DIVISÃO DO PRÊMIO É DO CRIADOR, e vale para qualquer campeonato — de
     * uma partida ou de doze. Ausente mantém o comportamento de sempre: o
     * vencedor único leva a premiação inteira.
     */
    const rawDistribution = data.prize_distribution;
    let prizeDistribution: PrizeSlice[] | null = null;
    if (rawDistribution !== undefined && rawDistribution !== null) {
      if (!Array.isArray(rawDistribution)) {
        throw new DomainError(
          "invalid-argument",
          "A divisão da premiação precisa ser uma lista de posições."
        );
      }
      const slices: PrizeSlice[] = rawDistribution.map((raw: any) => ({
        position: Number(raw?.position),
        centavos: Number(raw?.amount_centavos),
      }));
      /**
       * DIVIDIR ZERO NÃO É DIVIDIR. Conferido ANTES da soma para que quem
       * esqueceu a premiação ouça sobre a premiação, e não sobre um total que
       * nunca teria como fechar.
       */
      if (prizeCentavos === 0) {
        throw new DomainError(
          "invalid-argument",
          "Para dividir a premiação por colocação, informe um valor de premiação."
        );
      }
      /**
       * A SOMA TEM QUE DAR A PREMIAÇÃO, ao centavo. É aqui que os dois números
       * existem juntos — o preset salvo não tem premiação para conferir.
       */
      const check = checkPrizeDistribution(slices, prizeCentavos);
      if (!check.ok) {
        throw new DomainError(
          "invalid-argument",
          pointsConfigMessage(check.reason)
        );
      }
      prizeDistribution = slices;
    }

    const maxPlayers = Number(data.max_players);

    if (!Number.isSafeInteger(maxPlayers) || maxPlayers <= 0) {
      throw new DomainError(
        "invalid-argument",
        "O número máximo de jogadores precisa ser maior que zero."
      );
    }

    const scheduledStart = parseScheduledStart(data.starts_at);

    const gameMode = String(data.game_mode || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");

    let teamSize = 0;
    let gameModeLabel = "";
    let formatType = "";

    if (gameMode === "solo") {
      teamSize = 1;
      gameModeLabel = "Solo";
      formatType = "battle_royale";
    } else if (gameMode === "duo") {
      teamSize = 2;
      gameModeLabel = "Duo";
      formatType = "battle_royale";
    } else if (gameMode === "squad") {
      teamSize = 4;
      gameModeLabel = "Squad";
      formatType = "battle_royale";
    } else if (gameMode === "2v2") {
      teamSize = 2;
      gameModeLabel = "2v2";
      formatType = "versus";
    } else if (gameMode === "4v4") {
      teamSize = 4;
      gameModeLabel = "4v4";
      formatType = "versus";
    } else {
      throw new DomainError(
        "invalid-argument",
        "Modo de jogo inválido. Use solo, duo, squad, 2v2 ou 4v4."
      );
    }

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new DomainError("not-found", "Usuário criador não encontrado.");
    }

    const userData = userSnap.data() ?? {};

    const creatorName =
      userData.display_name ||
      userData.username ||
      userData.name ||
      userData.nickname ||
      context.auth?.token?.email ||
      "Criador";

    const tournamentRef = db.collection("tournaments").doc();

    await tournamentRef.set({
      name,
      description,

      entry_fee: centavosToReais(entryFeeCentavos),
      prize: centavosToReais(prizeCentavos),
      kill_prize: centavosToReais(killPrizeCentavos),
      /**
       * PARTIDAS E PONTUAÇÃO. Sempre gravados, mesmo no formato de sempre:
       * `matches_count: 1` com pontuação zerada descreve exatamente o que um
       * torneio de partida única é, e um campo ausente obrigaria todo leitor a
       * adivinhar de novo qual era o padrão.
       */
      matches_count: matchesCount,
      kill_points: pointsConfig.killPoints,
      placement_points: pointsConfig.placementPoints,
      /**
       * NULO quando o criador não dividiu: o vencedor único leva tudo, que é o
       * comportamento de todo torneio existente. Uma lista vazia diria
       * "dividido entre ninguém", que é outra coisa.
       */
      prize_distribution:
        prizeDistribution === null
          ? null
          : prizeDistribution.map((slice) => ({
              position: slice.position,
              amount_centavos: slice.centavos,
            })),

      status: "open",

      // The authorized economy and its DURABLE LOCK are born equal. Every
      // financial operation re-checks both and fails closed on divergence,
      // making the type immutable in practice even before the Rules land.
      economy_type: economyType,
      locked_economy_type: economyType,

      creator_ref: userRef,
      creator_uid: uid,
      creator_name: creatorName,

      game_mode: gameMode,
      game_mode_label: gameModeLabel,
      team_size: teamSize,
      format_type: formatType,

      // Writes BOTH the canonical (`*_participants`) and the legacy
      // (`*_players`) pairs with identical values. This is the fix for the
      // deployed bug where createTournament wrote one pair and jointournament
      // read the other, and it keeps old clients and queries working.
      ...newTournamentParticipantFields(maxPlayers),

      // The FIRST writer of this field. It has been a literal null since it
      // was introduced, with nothing anywhere updating it — so every existing
      // tournament has no schedule, and anything reading one was dead code.
      // Absent stays null, which is exactly what every old client sends.
      starts_at: scheduledStart === null ? null : Timestamp.fromDate(scheduledStart),
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      tournament_id: tournamentRef.id,
      tournament_ref: tournamentRef.path,
      message: "Campeonato criado com sucesso.",
    };
  } catch (error) {
    console.error("createTournament error:", error);
    throw toHttpsError(error);
  }
};

// BOTH export names are preserved, with their exact casing. The previous client
// calls one or the other; renaming or dropping either would break production.
export const createTournament = central.https.onCall(createTournamentHandler);
export const createtournament = central.https.onCall(createTournamentHandler);

/** The error code alone — logged instead of the error/payload, so room
 * credentials can never reach the logs. */
function safeErrorCode(error: unknown): string {
  if (error instanceof https.HttpsError) return error.code;
  if (error instanceof DomainError) return error.code;
  return "internal";
}

/**
 * ADMIN-ONLY: publishes (or updates) a tournament's room credentials into
 * `tournament_rooms/{tournamentId}` — a document the client can never read or
 * write directly (see firestore.rules). Credentials are never logged and never
 * echoed back in the response.
 *
 * Exported for behavioral tests of the authorization/validation ordering; a
 * plain function with no trigger metadata is NOT a deployable endpoint.
 */
export const setTournamentRoomHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context,
      "Você precisa estar logado para publicar a sala.",
      "Apenas admin pode publicar a sala."
    );

    const { tournamentid, roomid, roompassword } =
      validateSetRoomPayload(data);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const roomRef = db.collection("tournament_rooms").doc(tournamentid);

    await db.runTransaction(async (transaction) => {
      const tournamentSnap = await transaction.get(tournamentRef);
      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }

      // A cancelled tournament is TERMINAL: it never receives a (new) room.
      const tournamentStatus = String(tournamentSnap.data()?.status || "")
        .trim()
        .toLowerCase();
      if (tournamentStatus === STATUS_CANCELLED) {
        throw new DomainError(
          "failed-precondition",
          "Não é possível definir a sala de um torneio cancelado."
        );
      }

      // Preserve created_at across re-publishes; only updated_at moves.
      const roomSnap = await transaction.get(roomRef);
      const createdAt =
        (roomSnap.exists && roomSnap.data()?.created_at) ||
        FieldValue.serverTimestamp();

      transaction.set(roomRef, {
        tournament_ref: tournamentRef,
        room_id: roomid,
        room_password: roompassword,
        created_at: createdAt,
        updated_at: FieldValue.serverTimestamp(),
      });
    });

    // Exactly { success: true } — no id/password, and no extra fields.
    return { success: true };
  } catch (error) {
    // Log only the error CODE — never the error object or the payload, which
    // would leak the room credentials.
    console.error("setTournamentRoom error:", safeErrorCode(error));
    throw toHttpsError(error);
  }
};

/**
 * AUTHENTICATED player access: returns the room credentials for a tournament,
 * but ONLY to a caller who is registered (deterministic `{uid}_{tournamentId}`)
 * AND only once the room has been published. Failures carry an allowlisted
 * `details.reason` and never any internal detail.
 *
 * Exported for behavioral tests; not a deployable endpoint (no trigger).
 */
export const getTournamentRoomHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para acessar a sala."
    );
    const uid = callerAuth.uid;
    const tournamentid = validateGetRoomPayload(data);

    // Contract order: confirm the tournament exists FIRST (not-found), before
    // touching the registration or the room document.
    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const tournamentSnap = await tournamentRef.get();
    if (!tournamentSnap.exists) {
      throw new DomainError("not-found", "Torneio não encontrado.");
    }

    // Registration is then checked via the deterministic id ONLY — no query, no
    // field scan, no fallback. A non-participant never reads the room document.
    const registrationRef = db
      .collection("registrations")
      .doc(registrationId(uid, tournamentid));
    const registrationSnap = await registrationRef.get();

    // Only an ACTIVE registration grants access: a refunded one (cancelled
    // tournament) — or any other non-"registered" state — is treated exactly
    // like no registration at all, fail-closed.
    const registrationActive =
      registrationSnap.exists &&
      (registrationSnap.data() ?? {}).status === "registered";

    if (!registrationActive) {
      const decision = decideRoomAccess({
        registrationExists: false,
        roomExists: false,
        roomId: null,
        roomPassword: null,
      });
      // decision.ok is false here.
      if (!decision.ok) {
        throw new https.HttpsError(decision.code, decision.message, {
          reason: decision.reason,
        });
      }
    }

    const roomRef = db.collection("tournament_rooms").doc(tournamentid);
    const roomSnap = await roomRef.get();
    const roomData = roomSnap.exists ? roomSnap.data() ?? {} : {};

    const decision = decideRoomAccess({
      registrationExists: true,
      roomExists: roomSnap.exists,
      roomId: roomData.room_id,
      roomPassword: roomData.room_password,
    });

    if (!decision.ok) {
      throw new https.HttpsError(decision.code, decision.message, {
        reason: decision.reason,
      });
    }

    // Public contract: exactly { success, roomid, roompassword } — mapped from
    // the stored room_id / room_password, with no snake_case keys, no
    // tournament_ref, no timestamps, and no other fields.
    return {
      success: true,
      roomid: decision.credentials.room_id,
      roompassword: decision.credentials.room_password,
    };
  } catch (error) {
    console.error("getTournamentRoom error:", safeErrorCode(error));
    throw toHttpsError(error);
  }
};

export const setTournamentRoom = central.https.onCall(setTournamentRoomHandler);
export const getTournamentRoom = central.https.onCall(getTournamentRoomHandler);

// Secure start/result/settlement module — the deployable endpoint count goes
// 9 -> 11. `startTournament` opens the safe pre-state; `declareTournamentResult`
// is the canonical settlement.
export const startTournament = central.https.onCall(startTournamentHandler);
export const declareTournamentResult = central.https.onCall(
  declareTournamentResultHandler
);

// `payprize` is now a STRICT ALIAS of the same secure handler. It keeps its
// public name and region for compatibility, but accepts ONLY the new contract
// `{ tournamentid, winneruid }` and never `amount`/`externalid`. The legacy
// insecure body is gone — there is no deployable path to the old behavior.
export const payprize = central.https.onCall(declareTournamentResultHandler);

/**
 * ADMIN-ONLY, ATOMIC, IDEMPOTENT: cancels a not-yet-started tournament and
 * refunds EVERY paid registration to the exact bucket that paid it — cash
 * entries back to `balance` (reducing `total_spent`), beta entries back to
 * `beta_balance` — in ONE Firestore transaction. All or nothing: a failure of
 * any single validation leaves every wallet, registration, ledger and the
 * tournament byte-for-byte unchanged.
 *
 * TERMINAL: `cancelled` can never be joined, started, settled, paid or given
 * a room again, and no handler reopens it.
 *
 * SERVER-AUTHORITATIVE: the caller sends ONLY `{ tournamentid }`. Amounts come
 * from each registration's `entry_fee_snapshot` (or the provably safe cash
 * legacy `entry_fee`), cross-checked against the original entry ledger —
 * never from the tournament's current price, never from the client.
 *
 * IDEMPOTENT: refund ledgers use the deterministic id
 * `refund_{uid}_{tournamentid}`. A replay on an already-cancelled tournament
 * verifies every persisted artifact and returns success WITHOUT writing;
 * any missing or divergent artifact is failed-precondition, never repaired
 * silently.
 *
 * Exported for behavioral tests; a plain function with no trigger metadata is
 * NOT a deployable endpoint.
 */
export const cancelTournamentHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para cancelar o torneio.",
      "Apenas admin pode cancelar o torneio."
    );

    // Exactly `{ tournamentid }`; any extra key is invalid-argument.
    assertExactPayload(data, ["tournamentid"]);
    const tournamentid = normalizeTournamentId(data.tournamentid);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const prizeTxRef = db
      .collection("transactions")
      .doc(prizeTransactionId(tournamentid));

    const outcome = await db.runTransaction(async (transaction) => {
      // ── READS — every read happens before the first write ──
      const tournamentSnap = await transaction.get(tournamentRef);
      const prizeTxSnap = await transaction.get(prizeTxRef);

      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }
      const tournamentData = tournamentSnap.data() ?? {};

      // Economy (type + durable lock), fail-closed on divergence/corruption.
      const economy = resolveTournamentEconomy(tournamentData);

      // Settlement evidence blocks cancellation EVEN IF the status was
      // tampered back to "open": a persisted result or the deterministic
      // prize ledger prove a settlement happened.
      const resultExists =
        tournamentData.result !== undefined && tournamentData.result !== null;
      if (resultExists || prizeTxSnap.exists) {
        throw new DomainError(
          "failed-precondition",
          "O torneio possui liquidação registrada e não pode ser cancelado."
        );
      }

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();

      // All registrations of this tournament, read INSIDE the transaction so
      // a concurrent join/cancel serializes against this decision.
      const registrationsSnap = await transaction.get(
        db
          .collection("registrations")
          .where("tournament_ref", "==", tournamentRef)
      );

      // ── Idempotent replay: already cancelled ──
      if (status === STATUS_CANCELLED) {
        const refundedCount = tournamentData.refunded_registration_count;
        const refundedTotal = tournamentData.refunded_total;
        const refundEconomy = tournamentData.refund_economy_type;
        if (
          !Number.isSafeInteger(refundedCount) ||
          (refundedCount as number) < 0 ||
          typeof refundedTotal !== "number" ||
          refundEconomy !== economy
        ) {
          throw new DomainError(
            "failed-precondition",
            "Torneio cancelado com marcadores de reembolso divergentes."
          );
        }
        if (registrationsSnap.size !== refundedCount) {
          throw new DomainError(
            "failed-precondition",
            "Torneio cancelado com inscrições divergentes do registrado."
          );
        }

        let verifiedTotalCentavos = 0;
        for (const doc of registrationsSnap.docs) {
          const reg = doc.data() ?? {};
          const refunded = checkRefundedRegistration({
            docId: doc.id,
            status: reg.status,
            refundEconomy: reg.refund_economy_type,
            tournamentEconomy: economy,
            refundedAmount: reg.refunded_amount,
            refundTransactionRefPath: documentPath(
              reg.refund_transaction_ref
            ),
          });
          if (!refunded.ok) {
            throw new DomainError("failed-precondition", refunded.message);
          }

          const uid = doc.id.slice(0, doc.id.length - tournamentid.length - 1);
          const refundTxSnap = await transaction.get(
            db.collection("transactions").doc(refundTransactionId(doc.id))
          );
          const refundTx = refundTxSnap.exists ? refundTxSnap.data() ?? {} : {};
          const ledger = checkRefundLedger({
            registrationDocId: doc.id,
            tournamentid,
            tournamentEconomy: economy,
            uid,
            expectedAmountReais: reg.refunded_amount as number,
            txExists: refundTxSnap.exists,
            category: refundTx.category,
            economyType: refundTx.economy_type,
            amountReais: refundTx.amount,
            userRefPath: documentPath(refundTx.user_ref),
            tournamentRefPath: documentPath(refundTx.tournament_ref),
            registrationRefPath: documentPath(refundTx.registration_ref),
          });
          if (!ledger.ok) {
            throw new DomainError("failed-precondition", ledger.message);
          }
          verifiedTotalCentavos += Math.round(
            (reg.refunded_amount as number) * 100
          );
        }
        if (centavosToReais(verifiedTotalCentavos) !== refundedTotal) {
          throw new DomainError(
            "failed-precondition",
            "Total reembolsado diverge dos artefatos persistidos."
          );
        }

        // Fully equivalent: success with NO write and NO timestamp change.
        return {
          idempotent: true,
          economy,
          refundedCount: refundedCount as number,
          refundedTotalReais: refundedTotal as number,
        };
      }

      // ── First execution: only the canonical pre-start state cancels ──
      if (status !== "open") {
        throw new DomainError(
          "failed-precondition",
          "Só é possível cancelar um torneio que ainda não começou."
        );
      }

      // Write-limit guard BEFORE any further work: the whole refund must fit
      // one atomic transaction — partial refunds are never attempted.
      if (!canCancelAtomically(registrationsSnap.size)) {
        throw new DomainError(
          "failed-precondition",
          "O torneio tem inscrições demais para um cancelamento atômico."
        );
      }

      // The persisted participant counters must reconcile with the actual
      // registrations — a divergent count is corrupt state, never guessed at.
      const counts = readParticipantCounts(tournamentData);
      if (counts.current !== registrationsSnap.size) {
        throw new DomainError(
          "failed-precondition",
          "Contagem de participantes diverge das inscrições persistidas."
        );
      }

      // ── Build and validate the COMPLETE refund plan before any write ──
      const plan: RefundPlanItem[] = [];
      const seenUids = new Set<string>();
      for (const doc of registrationsSnap.docs) {
        const reg = doc.data() ?? {};
        const resolved = resolveRefundPlanItem({
          docId: doc.id,
          tournamentid,
          tournamentEconomy: economy,
          status: reg.status,
          userRefPath: documentPath(reg.user_ref),
          tournamentRefPath: documentPath(reg.tournament_ref),
          registrationEconomy: reg.economy_type,
          entryFeeSnapshot: reg.entry_fee_snapshot,
          entryFee: reg.entry_fee,
          transactionRefPath: documentPath(reg.transaction_ref),
        });
        if (!resolved.ok) {
          throw new DomainError("failed-precondition", resolved.message);
        }
        if (seenUids.has(resolved.item.uid)) {
          throw new DomainError(
            "failed-precondition",
            "Inscrições duplicadas para o mesmo usuário."
          );
        }
        seenUids.add(resolved.item.uid);
        plan.push(resolved.item);
      }

      // Cross-check EVERY entry against its original ledger. New-style items
      // carry the reference; legacy items must have their single matching
      // cash entry ledger LOCATED by query and proven — a legacy refund is
      // never granted on `registration.entry_fee` alone.
      const legacyEntryPaths = new Map<string, string>();
      for (const item of plan) {
        if (item.legacy) {
          const legacySnap = await transaction.get(
            db
              .collection("transactions")
              .where("category", "==", "entry_fee")
              .where("user_ref", "==", db.collection("users").doc(item.uid))
              .where("tournament_ref", "==", tournamentRef)
          );
          const only = legacySnap.size === 1 ? legacySnap.docs[0] : null;
          const data = only ? only.data() ?? {} : {};
          const legacyLedger = checkLegacyEntryLedger({
            registrationDocId: item.registrationDocId,
            tournamentid,
            uid: item.uid,
            matches: legacySnap.size,
            category: data.category,
            economyType: data.economy_type,
            userRefPath: documentPath(data.user_ref),
            tournamentRefPath: documentPath(data.tournament_ref),
            amountReais: data.amount,
            expectedAmountReais: centavosToReais(item.amountCentavos),
          });
          if (!legacyLedger.ok) {
            throw new DomainError("failed-precondition", legacyLedger.message);
          }
          legacyEntryPaths.set(
            item.registrationDocId,
            (only as FirebaseFirestore.QueryDocumentSnapshot).ref.path
          );
          continue;
        }
        const entryTxSnap = await transaction.get(
          db.doc(item.entryTransactionPath as string)
        );
        const entryTx = entryTxSnap.exists ? entryTxSnap.data() ?? {} : {};
        const ledger = checkOriginalEntryLedger({
          item,
          tournamentid,
          txExists: entryTxSnap.exists,
          category: entryTx.category,
          economyType: entryTx.economy_type,
          userRefPath: documentPath(entryTx.user_ref),
          tournamentRefPath: documentPath(entryTx.tournament_ref),
          amountReais: entryTx.amount,
          expectedAmountReais: centavosToReais(item.amountCentavos),
        });
        if (!ledger.ok) {
          throw new DomainError("failed-precondition", ledger.message);
        }
      }

      // Read every wallet and pre-compute every credit — the LAST reads, and
      // still before the first write. Any invalid stored value, insufficient
      // total_spent or overflow aborts here, leaving everything untouched.
      const walletWrites: Array<{
        ref: FirebaseFirestore.DocumentReference;
        update: Record<string, unknown>;
        previousCentavos: number;
        afterCentavos: number;
      }> = [];
      for (const item of plan) {
        const walletRef = db.collection("wallets").doc(item.uid);
        const walletSnap = await transaction.get(walletRef);
        if (!walletSnap.exists) {
          throw new DomainError(
            "not-found",
            `Carteira do inscrito ${item.uid} não encontrada.`
          );
        }
        const walletData = walletSnap.data() ?? {};

        if (item.economy === ECONOMY_BETA_CREDIT) {
          const previousBeta = storedReaisToCentavos(
            walletData.beta_balance ?? 0,
            "saldo beta"
          );
          const betaAfter = addCentavos(previousBeta, item.amountCentavos);
          walletWrites.push({
            ref: walletRef,
            update: { beta_balance: centavosToReais(betaAfter) },
            previousCentavos: previousBeta,
            afterCentavos: betaAfter,
          });
        } else {
          const previousBalance = storedReaisToCentavos(
            walletData.balance ?? 0,
            "saldo da carteira"
          );
          const totalSpent = storedReaisToCentavos(
            walletData.total_spent ?? 0,
            "total gasto"
          );
          const spentAfter = subtractCentavos(totalSpent, item.amountCentavos);
          if (spentAfter < 0) {
            throw new DomainError(
              "failed-precondition",
              "Total gasto insuficiente para o reembolso."
            );
          }
          const balanceAfter = addCentavos(
            previousBalance,
            item.amountCentavos
          );
          walletWrites.push({
            ref: walletRef,
            update: {
              balance: centavosToReais(balanceAfter),
              total_spent: centavosToReais(spentAfter),
            },
            previousCentavos: previousBalance,
            afterCentavos: balanceAfter,
          });
        }
      }

      const totalCentavos = sumRefundCentavos(plan);

      // ── WRITES — everything is now validated ──
      // ONE server-timestamp sentinel for every stamp in this commit.
      const stampedAt = FieldValue.serverTimestamp();

      for (let i = 0; i < plan.length; i++) {
        const item = plan[i];
        const write = walletWrites[i];
        const amountReais = centavosToReais(item.amountCentavos);
        const registrationRef = db
          .collection("registrations")
          .doc(item.registrationDocId);
        const refundTxRef = db
          .collection("transactions")
          .doc(refundTransactionId(item.registrationDocId));
        // The refund ALWAYS references the validated original entry ledger:
        // the registration's own ref for new-style items, the query-located
        // ledger for legacy items. Never null.
        const entryTxRef = db.doc(
          item.entryTransactionPath ??
            (legacyEntryPaths.get(item.registrationDocId) as string)
        );

        // 1. Credit the ONE bucket that paid the entry.
        transaction.update(write.ref, write.update);

        // 2. Deterministic refund ledger — unmistakably cash OR beta.
        const base = {
          amount: amountReais,
          user_ref: db.collection("users").doc(item.uid),
          display_name: "Reembolso de inscrição",
          tournament_ref: tournamentRef,
          registration_ref: registrationRef,
          entry_transaction_ref: entryTxRef,
          timestamp: stampedAt,
          created_at: stampedAt,
          status: "completed",
          external_id: refundTransactionId(item.registrationDocId),
        };
        if (item.economy === ECONOMY_BETA_CREDIT) {
          transaction.set(refundTxRef, {
            ...base,
            category: BETA_REFUND_CATEGORY,
            economy_type: ECONOMY_BETA_CREDIT,
            beta_previous_balance: centavosToReais(write.previousCentavos),
            beta_balance_after: centavosToReais(write.afterCentavos),
          });
        } else {
          transaction.set(refundTxRef, {
            ...base,
            category: ENTRY_REFUND_CATEGORY,
            economy_type: ECONOMY_CASH,
            previous_balance: centavosToReais(write.previousCentavos),
            balance_after: centavosToReais(write.afterCentavos),
          });
        }

        // 3. The registration keeps every original field (including the
        // original transaction_ref) and gains the refunded state.
        transaction.update(registrationRef, {
          status: "refunded",
          refunded_at: stampedAt,
          refunded_amount: amountReais,
          refund_transaction_ref: refundTxRef,
          refund_economy_type: item.economy,
        });
      }

      // 4. The tournament becomes TERMINAL. Both participant pairs are zeroed
      // together (the code's own invariant); economy, lock, price and history
      // are preserved untouched.
      transaction.update(tournamentRef, {
        status: STATUS_CANCELLED,
        cancelled_at: stampedAt,
        cancelled_by: callerAuth.uid,
        refunded_registration_count: plan.length,
        refunded_total: centavosToReais(totalCentavos),
        refund_economy_type: economy,
        current_participants: 0,
        current_players: 0,
        updated_at: stampedAt,
      });

      return {
        idempotent: false,
        economy,
        refundedCount: plan.length,
        refundedTotalReais: centavosToReais(totalCentavos),
      };
    });

    return {
      success: true,
      tournament_id: tournamentid,
      economy_type: outcome.economy,
      refunded_registrations: outcome.refundedCount,
      refunded_amount: outcome.refundedTotalReais,
      idempotent: outcome.idempotent,
      message: "Torneio cancelado e inscrições reembolsadas.",
    };
  } catch (error) {
    console.error("cancelTournament error:", error);
    throw toHttpsError(error);
  }
};

export const cancelTournament = central.https.onCall(cancelTournamentHandler);

/**
 * ADMIN-ONLY, IDEMPOTENT: grants non-withdrawable Beta Credits to a player's
 * `wallets/{uid}.beta_balance` for the closed beta.
 *
 * ECONOMY ISOLATION (the whole point): this is the ONLY flow that writes
 * `beta_balance`, and it touches NOTHING else — never `balance`,
 * `total_deposited`, `total_won`, `total_spent` or `total_withdrawn`. Beta
 * Credits have no monetary value, no conversion to `balance` exists, and
 * `requestwithdrawal` never reads `beta_balance`, so a Beta Credit can never
 * become withdrawable money. `testdeposit` is NOT part of the beta flow.
 *
 * IDEMPOTENCY: the transaction id is the deterministic `beta_grant_{grant_id}`,
 * read INSIDE the Firestore transaction. First valid call credits exactly once;
 * an identical replay returns success with NO write; the same `grant_id` with
 * different data is failed-precondition with NO write. `granted_by` comes
 * EXCLUSIVELY from the verified token (`context.auth.uid`) — it is not an
 * accepted payload key.
 *
 * Exported for behavioral tests; a plain function with no trigger metadata is
 * NOT a deployable endpoint.
 */
export const grantBetaCreditHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para conceder créditos beta.",
      "Apenas admin pode conceder créditos beta."
    );

    // Exactly these five keys; `granted_by` (or anything else) is rejected.
    assertExactPayload(data, [
      "uid",
      "amount",
      "grant_id",
      "campaign_id",
      "reason",
    ]);
    const uid = normalizeBetaGrantUid(data.uid);
    const amountCentavos = validateBetaGrantAmount(data.amount);
    const grantId = normalizeGrantId(data.grant_id);
    const campaignId = normalizeCampaignId(data.campaign_id);
    const reason = normalizeReason(data.reason);

    // Provenance comes from the verified token ONLY — never from the payload.
    const grantedBy = callerAuth.uid;

    const walletRef = db.collection("wallets").doc(uid);
    const userRef = db.collection("users").doc(uid);
    const grantTxRef = db
      .collection("transactions")
      .doc(betaGrantTransactionId(grantId));

    const outcome = await db.runTransaction(async (transaction) => {
      // Reads first — every read before any write.
      const grantTxSnap = await transaction.get(grantTxRef);
      const walletSnap = await transaction.get(walletRef);

      if (!walletSnap.exists) {
        throw new DomainError(
          "not-found",
          "Carteira do destinatário não encontrada."
        );
      }

      const walletData = walletSnap.data() ?? {};
      // An old wallet without the field MEANS zero — read-side default only;
      // nothing is written just to normalize old documents.
      const previousBeta = storedReaisToCentavos(
        walletData.beta_balance ?? 0,
        "saldo beta"
      );

      // ── Idempotent replay: the deterministic grant transaction exists ──
      if (grantTxSnap.exists) {
        const stored = grantTxSnap.data() ?? {};
        const replay = checkBetaGrantReplay({
          grantId,
          uid,
          amountReais: centavosToReais(amountCentavos),
          campaignId,
          reason,
          stored: {
            category: stored.category,
            economyType: stored.economy_type,
            grantId: stored.grant_id,
            amountReais: stored.amount,
            campaignId: stored.campaign_id,
            reason: stored.reason,
            userRefPath: documentPath(stored.user_ref),
          },
        });
        if (!replay.ok) {
          throw new DomainError("failed-precondition", replay.message);
        }
        // Fully equivalent: success with NO credit and NO write — balances and
        // timestamps stay exactly as they were.
        return {
          idempotent: true,
          betaBalanceReais: centavosToReais(previousBeta),
        };
      }

      // ── First execution: credit exactly once ──
      // addCentavos enforces the safe ceiling atomically: an overflow throws
      // before any write, so a failed grant leaves no partial state.
      const afterBeta = addCentavos(previousBeta, amountCentavos);

      // ONE server-timestamp sentinel, reused so every stamp in this commit
      // resolves to the exact same time.
      const stampedAt = FieldValue.serverTimestamp();

      // The ONLY wallet field this flow may touch is beta_balance.
      transaction.update(walletRef, {
        beta_balance: centavosToReais(afterBeta),
      });

      transaction.set(grantTxRef, {
        amount: centavosToReais(amountCentavos),
        category: BETA_GRANT_CATEGORY,
        economy_type: BETA_ECONOMY_TYPE,
        grant_id: grantId,
        campaign_id: campaignId,
        reason: reason,
        granted_by: grantedBy,
        user_ref: userRef,
        display_name: "Crédito Beta",
        tournament_ref: null,
        // Beta-pool stamps — deliberately NOT previous_balance/balance_after,
        // which in every cash transaction refer to the real `balance`.
        beta_previous_balance: centavosToReais(previousBeta),
        beta_balance_after: centavosToReais(afterBeta),
        timestamp: stampedAt,
        created_at: stampedAt,
        status: "completed",
        external_id: betaGrantTransactionId(grantId),
      });

      return {
        idempotent: false,
        betaBalanceReais: centavosToReais(afterBeta),
      };
    });

    return {
      success: true,
      idempotent: outcome.idempotent,
      grant_id: grantId,
      beta_balance: outcome.betaBalanceReais,
    };
  } catch (error) {
    console.error("grantBetaCredit error:", error);
    throw toHttpsError(error);
  }
};

export const grantBetaCredit = central.https.onCall(grantBetaCreditHandler);

/**
 * AUTHENTICATED, IDEMPOTENT: records that the caller OPENED the app today.
 *
 * NON-FINANCIAL BY CONSTRUCTION: this is the only flow that writes
 * `player_activity`, and it touches NOTHING else — no wallet, no balance, no
 * transaction, no registration, no tournament, no user document. It carries no
 * amount and has no economy. A failure here can therefore never corrupt money;
 * the client is expected to call it non-blockingly and ignore errors.
 *
 * IDENTITY: the uid comes EXCLUSIVELY from the verified token
 * (`context.auth.uid`). There is no `uid` payload key, so one player can never
 * record activity for another — the exact-payload allowlist rejects the attempt
 * with `invalid-argument` before anything else runs.
 *
 * THE DAY IS THE SERVER'S: the document id uses the business day derived from
 * the SERVER clock in `America/Sao_Paulo`. A client MAY send `client_day` and
 * `client_timezone_offset_minutes`; those are validated against server time and
 * stored as diagnostics, but they never choose the document. A device whose
 * clock is more than a day off is rejected loudly rather than silently writing
 * a day the player never opened the app.
 *
 * IDEMPOTENCY: the id is the deterministic `{uid}_{YYYY-MM-DD}`, read INSIDE the
 * Firestore transaction. The first call of the day creates exactly one document;
 * every later call the same day returns success with NO write; the next day
 * creates exactly one new document.
 *
 * OLD-CLIENT COMPATIBILITY: beta `0.1.0+1` does not call this function and is
 * completely unaffected. Nothing about the existing callables changes.
 *
 * Exported for behavioral tests; a plain function with no trigger metadata is
 * NOT a deployable endpoint.
 */
export const recordDailyAppOpenHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para registrar o acesso."
    );

    // Exactly these two OPTIONAL keys. `uid` is deliberately NOT accepted —
    // sending one is an invalid payload, not a silently ignored field.
    assertExactPayload(data ?? {}, [
      "client_day",
      "client_timezone_offset_minutes",
    ]);

    const uid = normalizeActivityUid(callerAuth.uid);

    // The server clock decides the day. Read once so the id, the stored day and
    // the validation all agree even if the call straddles midnight.
    const serverNow = new Date();
    const dayKey = businessDayKey(serverNow, ACTIVITY_TIMEZONE);

    const payload = (data ?? {}) as Record<string, unknown>;
    const clientDay = validateClientDay(payload.client_day, dayKey);
    const clientOffsetMinutes = validateClientOffsetMinutes(
      payload.client_timezone_offset_minutes
    );

    const userRef = db.collection("users").doc(uid);
    const activityRef = db
      .collection(ACTIVITY_COLLECTION)
      .doc(activityDocumentId(uid, dayKey));

    const outcome = await db.runTransaction(async (transaction) => {
      // Read first — every read before any write.
      const activitySnap = await transaction.get(activityRef);

      if (activitySnap.exists) {
        const stored = activitySnap.data() ?? {};
        const replay = checkActivityReplay({
          uid,
          dayKey,
          stored: {
            uid: stored.uid,
            activityDay: stored.activity_day,
            userRefPath: documentPath(stored.user_ref),
          },
        });
        if (!replay.ok) {
          throw new DomainError("failed-precondition", replay.message);
        }
        // Already recorded today: success with NO write. The stored
        // `first_opened_at` keeps pointing at the FIRST open of the day.
        return { alreadyRecorded: true };
      }

      const stampedAt = FieldValue.serverTimestamp();

      transaction.set(activityRef, {
        uid: uid,
        user_ref: userRef,
        activity_day: dayKey,
        timezone: ACTIVITY_TIMEZONE,
        first_opened_at: stampedAt,
        created_at: stampedAt,
        // Diagnostics only — never used to choose the day.
        client_day: clientDay,
        client_timezone_offset_minutes: clientOffsetMinutes,
      });

      return { alreadyRecorded: false };
    });

    return {
      success: true,
      already_recorded: outcome.alreadyRecorded,
      activity_day: dayKey,
      timezone: ACTIVITY_TIMEZONE,
    };
  } catch (error) {
    console.error("recordDailyAppOpen error:", error);
    throw toHttpsError(error);
  }
};

export const recordDailyAppOpen = central.https.onCall(
  recordDailyAppOpenHandler
);

/**
 * AUTHENTICATED, READ-ONLY: the caller's own activity days for a calendar month
 * plus their competitive tournament net result.
 *
 * READ-ONLY BY CONSTRUCTION: it opens no Firestore transaction and issues no
 * write. It changes no balance, no payment execution, no settlement decision
 * and no existing transaction semantics. It creates NO persisted aggregate —
 * every figure is derived on the fly from the canonical ledger, so there is
 * nothing for a client to tamper with and nothing that can drift from truth.
 *
 * IDENTITY: the uid comes EXCLUSIVELY from the verified token. `month` is the
 * only accepted payload key, so a client cannot ask about another player — the
 * exact-payload allowlist rejects the attempt with `invalid-argument` before
 * anything is read.
 *
 * THE TWO ECONOMIES ARE NEVER SUMMED. `cash` (reais) and `betaCredit`
 * (non-monetary Beta Credits) are returned side by side. The top-level
 * `dailyNet`/`currentWeekNet`/`currentMonthNet`/`lifetimeNet` mirror the CASH
 * economy so the documented response shape holds; beta lives under
 * `betaCredit`. No field carries a combined figure.
 *
 * MONEY UNIT: every amount is an INTEGER of centavos (cash) or centavos-like
 * units (beta). Never a float, never reais.
 *
 * SCOPE OF EACH FIGURE: `activityDays` and `dailyNet` cover the REQUESTED
 * month. `currentWeekNet` (Monday-based) and `currentMonthNet` are anchored to
 * the SERVER's today in America/Sao_Paulo, independent of the requested month.
 * `lifetimeNet` spans the whole ledger.
 *
 * Exported for behavioral tests; a plain function with no trigger metadata is
 * NOT a deployable endpoint.
 */
export const getPlayerEngagementStatsHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para ver suas estatísticas."
    );

    // Exactly one key. `uid` is deliberately NOT accepted.
    assertExactPayload(data ?? {}, ["month"]);

    const uid = normalizeStatsUid(callerAuth.uid);
    const month = normalizeMonth((data ?? {}).month);

    // The server decides "today"; the client never influences the window.
    const today = businessDayKey(new Date(), STATS_TIMEZONE);

    const userRef = db.collection("users").doc(uid);

    // Both queries filter ON `user_ref`, so the query itself is the
    // authorization scope the Rules require — never a broad read narrowed on
    // the client. A single equality filter needs only the automatic
    // single-field index, so NO composite index is required.
    const [txSnap, activitySnap] = await Promise.all([
      db.collection("transactions").where("user_ref", "==", userRef).get(),
      db
        .collection(ACTIVITY_COLLECTION)
        .where("user_ref", "==", userRef)
        .get(),
    ]);

    const rows: LedgerRow[] = txSnap.docs.map((doc) => {
      const d = doc.data() ?? {};
      return {
        id: doc.id,
        category: d.category,
        status: d.status,
        amount: d.amount,
        at: toDateOrNull(d.timestamp ?? d.created_at),
      };
    });

    const totals = aggregateLedger({ rows, requestedMonth: month, today });

    const activityDays = activityDaysInMonth(
      activitySnap.docs.map((doc) => (doc.data() ?? {}).activity_day),
      month
    );

    const shape = (t: EconomyTotals) => ({
      dailyNet: dailyNetArray(t),
      currentWeekNet: t.currentWeekNet,
      currentMonthNet: t.currentMonthNet,
      lifetimeNet: t.lifetimeNet,
    });

    const cash = shape(totals.cash);
    const betaCredit = shape(totals.beta);

    return {
      success: true,
      timezone: STATS_TIMEZONE,
      month: month.key,
      amountUnit: "centavos",
      activityDays,
      // Documented top-level shape — the CASH economy.
      dailyNet: cash.dailyNet,
      currentWeekNet: cash.currentWeekNet,
      currentMonthNet: cash.currentMonthNet,
      lifetimeNet: cash.lifetimeNet,
      // Both economies, explicitly separated. Never summed.
      cash,
      betaCredit,
      // Honest disclosure of what did not reach a total.
      excluded: {
        unknownCategory: totals.excludedUnknownCategory,
        malformedAmount: totals.excludedMalformedAmount,
        undated: totals.excludedUndated,
        notCompleted: totals.excludedNotCompleted,
      },
    };
  } catch (error) {
    console.error("getPlayerEngagementStats error:", error);
    throw toHttpsError(error);
  }
};

export const getPlayerEngagementStats = central.https.onCall(
  getPlayerEngagementStatsHandler
);

/**
 * Assigns — or returns — the caller's pseudonymous `publicPlayerId`.
 *
 * NOT AN ENDPOINT AND NOT A TRIGGER. It carries no `onCall`, `onRequest`,
 * `onDocument*` or `.region()` metadata, so it adds nothing to the deployment
 * surface; `functionRegions.test.ts` discovers deployable exports by their
 * `__trigger` and this has none. It is exported so the ranking trigger and
 * `getMySeasonRanking` can call it internally later, and so its real Firestore
 * behaviour can be tested.
 *
 * TWO CALL SITES TODAY, and both are deliberate: prize settlement — a winner
 * needs a leaderboard row — and `getMyProfile`, because sharing a profile
 * requires having an address and a player who never won had none. Being
 * create-only and idempotent is what makes a second call site safe: neither
 * can overwrite, reassign or release what the other created.
 *
 * THE RESERVATION IS A CREATE-ONLY PAIR, in one transaction:
 *   public_player_ids/{uid}                  -> { publicPlayerId, createdAt }
 *   public_player_id_index/{publicPlayerId}  -> { uid, createdAt }
 * The index document id IS the lock — Firestore guarantees at most one — so
 * uniqueness is structural rather than probabilistic, and `transaction.create`
 * is the only write used. No `set`, no `set(..., {merge:true})`, no `update`,
 * no `delete`: an identity can therefore never be overwritten, reassigned or
 * released, which is exactly what sections 5.2 and 6.5 freeze.
 *
 * WHY THE CANDIDATE IS GENERATED OUTSIDE `runTransaction`. Firestore may re-run
 * the transaction callback on contention. Generating inside would mint a new id
 * on every internal retry, so a losing attempt could leave a different id than
 * the one it read against. The candidate is therefore stable for the whole
 * transaction, and ONLY an explicit `collision` decision — the candidate
 * legitimately belongs to another account — makes the OUTER loop draw fresh
 * entropy. A collided candidate is never retried and never reused.
 *
 * ERRORS PROPAGATE AS `DomainError`, deliberately unlike the callables above:
 * this is an internal primitive with no client on the other side, so there is
 * no `https.HttpsError` boundary to convert at. The eventual callers are a
 * trigger and a callable that will convert at their own edge.
 */
export interface EnsurePublicPlayerIdOptions {
  /**
   * Entropy source, injected only by tests so a collision can be provoked
   * deterministically. Production never passes it and always gets
   * `randomBytes`, following the options-with-defaults convention already used
   * by `scanCollection`.
   */
  readonly generateEntropy?: () => Uint8Array;
}

export const ensurePublicPlayerIdHandler = async (
  uid: unknown,
  options: EnsurePublicPlayerIdOptions = {}
): Promise<{ publicPlayerId: string; created: boolean }> => {
  const normalizedUid = normalizeIdentityUid(uid);
  const generateEntropy =
    options.generateEntropy ??
    (() => randomBytes(PUBLIC_PLAYER_ID_ENTROPY_BYTES));

  const mapRef = db.collection(PUBLIC_PLAYER_ID_COLLECTION).doc(normalizedUid);

  for (
    let attempt = 1;
    attempt <= PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS;
    attempt += 1
  ) {
    // Outside the transaction on purpose — see the note above. Validated before
    // it can ever be used as a document id.
    const candidate = assertPublicPlayerId(
      encodePublicPlayerId(generateEntropy())
    );

    const outcome = await db.runTransaction(async (transaction) => {
      // Every read before any write.
      const mapSnap = await transaction.get(mapRef);
      const mapData = mapSnap.exists ? mapSnap.data() ?? {} : null;

      // WHICH index document is authoritative depends on the map: an existing
      // map must be corroborated by the index of ITS id, not of a fresh
      // candidate. A malformed mapped id falls back to the candidate and is
      // then rejected by the decision as a malformed map.
      const mappedId = mapData === null ? null : mapData.publicPlayerId;
      const indexId = isPublicPlayerId(mappedId) ? mappedId : candidate;
      const indexRef = db
        .collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION)
        .doc(indexId);
      const indexSnap = await transaction.get(indexRef);

      const decision = decidePublicPlayerIdReservation({
        uid: normalizedUid,
        candidate,
        map: mapData === null ? null : { publicPlayerId: mapData.publicPlayerId },
        indexId,
        index: indexSnap.exists
          ? { uid: (indexSnap.data() ?? {}).uid }
          : null,
      });

      if (decision.kind === "fail") {
        throw new DomainError("failed-precondition", decision.message);
      }
      if (decision.kind === "reuse") {
        // Already reserved and consistent: return it with NO write at all.
        return { kind: "reuse" as const, publicPlayerId: decision.publicPlayerId };
      }
      if (decision.kind === "collision") {
        return { kind: "collision" as const };
      }

      const stampedAt = FieldValue.serverTimestamp();

      // create() and nothing else: it fails if the document already exists, so
      // neither half of the pair can ever be silently replaced.
      transaction.create(mapRef, {
        publicPlayerId: decision.publicPlayerId,
        createdAt: stampedAt,
      });
      transaction.create(indexRef, {
        uid: normalizedUid,
        createdAt: stampedAt,
      });

      return { kind: "reserve" as const, publicPlayerId: decision.publicPlayerId };
    });

    if (outcome.kind === "reuse") {
      return { publicPlayerId: outcome.publicPlayerId, created: false };
    }
    if (outcome.kind === "reserve") {
      return { publicPlayerId: outcome.publicPlayerId, created: true };
    }
    // Collision: discard this candidate for good and draw fresh entropy.
  }

  // Budget exhausted. Observable and fail-closed: nothing was reserved, nothing
  // was reused, and no partially written pair can exist, because every attempt
  // either committed both documents or committed none.
  throw new DomainError(
    "internal",
    "Não foi possível reservar um identificador público após " +
      `${PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS} tentativas.`
  );
};

/**
 * A canonical `users/{uid}` reference, reduced to the uid it names.
 *
 * Duck-typed rather than `instanceof DocumentReference` so the same code runs
 * against a snapshot produced by the emulator and one produced by a test. The
 * path is re-derived and compared, so a reference into another collection — or
 * one whose id and path disagree — is rejected instead of silently supplying a
 * uid from the wrong namespace.
 */
function referencedUserId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;

  const { id, path } = value as { id?: unknown; path?: unknown };
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof path !== "string") return null;
  if (path !== `users/${id}`) return null;

  return id;
}

/** True when the value is a usable Firestore document reference. */
function isUsableReference(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;

  const { id, path } = value as { id?: unknown; path?: unknown };
  return typeof id === "string" && id.length > 0 && typeof path === "string";
}

/**
 * Test-only seams. Production passes neither and gets the frozen source
 * configuration and the real identity primitive, following the
 * options-with-defaults convention already used by `ensurePublicPlayerIdHandler`
 * and `scanCollection`.
 *
 * Neither seam is reachable by a client: this handler has no callable surface,
 * and the options are a TypeScript parameter, never a payload field. They are
 * also NOT runtime configuration — nothing reads them from Firestore, the
 * environment or Remote Config.
 */
export interface OnPrizeTransactionCreatedOptions {
  readonly firstActiveSeasonId?: string | null;
  readonly ensureIdentity?: (
    uid: string
  ) => Promise<{ publicPlayerId: string; created: boolean }>;
}

/** Why a delivery produced no ranking write. Returned for tests and logs. */
export type PrizeRankingOutcome =
  | { readonly applied: true; readonly seasonId: string; readonly economy: string }
  | { readonly applied: false; readonly reason: string };

/**
 * Applies one settled prize to its monthly season ranking.
 *
 * WHY A TRIGGER AND NOT A SETTLEMENT CALL. The prize is already committed when
 * this runs, so a ranking failure can never delay, reverse or duplicate a
 * payout — the financial invariant stays the only thing settlement guarantees
 * atomically. Nothing here reads or writes a wallet, a transaction, a
 * tournament, a registration or a result.
 *
 * WHY IT WATCHES EVERY TRANSACTION. Firestore v1 triggers match a document
 * path, not a query, so `transactions/{transactionId}` is the only available
 * selector and the filtering is done here. That is deliberate: the eligibility
 * rules live in one readable place instead of being encoded in a path.
 *
 * INELIGIBLE IS A SILENT NO-OP. A non-prize row, a wrong status, a malformed
 * amount, an unusable timestamp or a broken reference must not throw: throwing
 * would make Firestore retry a delivery that can never succeed. Once an event is
 * ACCEPTED, however, every later failure — identity, corruption, overflow —
 * propagates so the delivery is retried with nothing half-written.
 */
export const onPrizeTransactionCreatedHandler = async (
  snapshot: any,
  options: OnPrizeTransactionCreatedOptions = {}
): Promise<PrizeRankingOutcome> => {
  // ── Front door: everything below is a silent no-op ────────────────────────
  const transactionId = snapshot?.id;
  if (!isPrizeTransactionId(transactionId)) {
    return { applied: false, reason: "not-a-prize-id" };
  }

  const data = (snapshot.data?.() ?? {}) as Record<string, unknown>;

  const economy = classifyPrizeCategory(data.category);
  if (economy === null) {
    return { applied: false, reason: "category-not-ranking-bearing" };
  }

  if (!isCompletedStatus(data.status)) {
    return { applied: false, reason: "status-not-completed" };
  }

  // The ONE conversion from stored reais to centavos, at the boundary.
  const amount = inspectReais(data.amount, { allowZero: true });
  if (!amount.ok) {
    return { applied: false, reason: `amount-${amount.problem}` };
  }

  const prizeAt = toUsableDate(data.timestamp);
  if (prizeAt === null) {
    return { applied: false, reason: "timestamp-unusable" };
  }

  const uid = referencedUserId(data.user_ref);
  if (uid === null) {
    return { applied: false, reason: "user-ref-unusable" };
  }

  if (!isUsableReference(data.tournament_ref)) {
    return { applied: false, reason: "tournament-ref-unusable" };
  }

  const dayKey = businessDayKey(prizeAt, RANKING_TIMEZONE);
  const seasonId = monthOfDayKey(dayKey);

  // ── Activation gate: BEFORE any identity and any transaction ─────────────
  const configured =
    options.firstActiveSeasonId === undefined
      ? FIRST_ACTIVE_SEASON_ID
      : options.firstActiveSeasonId;

  const activation = decideActivation(configured, seasonId);
  if (activation.kind === "inert") {
    return { applied: false, reason: "first-active-season-not-configured" };
  }
  if (activation.kind === "before-first-season") {
    return { applied: false, reason: "before-first-active-season" };
  }

  // ── Accepted. From here, failures propagate and the delivery is retried ──
  const ensureIdentity = options.ensureIdentity ?? ensurePublicPlayerIdHandler;
  const { publicPlayerId } = await ensureIdentity(uid);

  const event: PrizeRankingEvent = {
    transactionId,
    publicPlayerId,
    economy,
    amountCentavos: amount.centavos,
    seasonId,
    dayKey,
    prizeAt,
    // Derived from the CATEGORY, never from the caller: a per-kill payout is
    // money won without being a victory.
    countsAsWin: prizeCountsAsWin(data.category),
  };

  const window = seasonWindow(seasonId);

  const guardRef = db.collection(RANKING_EVENTS_COLLECTION).doc(transactionId);
  const parentRef = db
    .collection(SEASON_RANKINGS_COLLECTION)
    .doc(seasonDocumentId(economy, seasonId));
  const entryRef = parentRef
    .collection(SEASON_ENTRIES_SUBCOLLECTION)
    .doc(publicPlayerId);

  const transactionRef = snapshot.ref;

  await db.runTransaction(async (transaction) => {
    // The guard is read FIRST: a canonical one ends the delivery before any
    // other document is even looked at.
    const guardSnap = await transaction.get(guardRef);
    const storedGuard = guardSnap.exists ? guardSnap.data() ?? {} : null;

    const guardDecision = checkExistingGuard({
      event,
      expectedTransactionRefPath: transactionRef.path,
      stored:
        storedGuard === null
          ? null
          : {
              transactionRefPath: (
                storedGuard.transactionRef as { path?: unknown } | undefined
              )?.path,
              publicPlayerId: storedGuard.publicPlayerId,
              economy: storedGuard.economy,
              amountCentavos: storedGuard.amountCentavos,
              seasonId: storedGuard.seasonId,
              dayKey: storedGuard.dayKey,
              appliedAt: storedGuard.appliedAt,
            },
    });

    if (guardDecision.kind === "replay") {
      // Entry and parent were committed with this guard, atomically. Nothing
      // to repair and nothing to add.
      return;
    }

    // Every remaining read before the first write.
    const entrySnap = await transaction.get(entryRef);
    const parentSnap = await transaction.get(parentRef);

    // THE TRANSITION READS THE CANONICAL TUPLE, NOT THE AUDIT COPIES. The
    // persisted scalars are decoded on the microsecond scale and fed to
    // `decideEntry` in place of the stored numbers, so a corrupted
    // `scoreCentavos`/`winsCount` copy can never influence a settlement. A
    // scalar that does not decode fails closed here, exactly as the read path
    // would treat it.
    const storedEntry = entrySnap.exists ? (entrySnap.data() ?? {}) : null;
    const entryPlan = decideEntry({
      event,
      stored:
        storedEntry === null
          ? null
          : {
              ...storedEntry,
              scoreCentavos: decodeRankScalar(storedEntry.scoreOrder),
              winsCount: decodeRankScalar(storedEntry.winsOrder),
            },
    });

    const parentPlan = decideParent({
      event,
      stored: parentSnap.exists ? (parentSnap.data() ?? {}) : null,
      entryCreated: entryPlan.kind === "create",
      window,
    });

    // ONE server-timestamp sentinel, so every stamp in this commit resolves to
    // the same instant.
    const stampedAt = FieldValue.serverTimestamp();

    // THE ORDERING SCALARS ARE MINTED HERE AND ONLY HERE — the internal write
    // path, from values `decideEntry` has already normalised. `encodeRankScalar`
    // fails closed on anything the ordering could not represent faithfully, so
    // an entry can never reach the collection outside the canonical domain.
    // These Timestamps are ORDINAL SCALARS, never dates.
    const scoreOrder = rankTimestamp(encodeRankScalar(entryPlan.scoreCentavos));
    const winsOrder = rankTimestamp(encodeRankScalar(entryPlan.winsCount));

    if (entryPlan.kind === "create") {
      transaction.set(entryRef, {
        scoreOrder,
        winsOrder,
        publicPlayerId,
        economy,
        seasonId,
        scoreCentavos: entryPlan.scoreCentavos,
        winsCount: entryPlan.winsCount,
        firstPrizeAt: Timestamp.fromDate(entryPlan.firstPrizeAt),
        lastPrizeAt: Timestamp.fromDate(entryPlan.lastPrizeAt),
        updatedAt: stampedAt,
      });
    } else {
      transaction.update(entryRef, {
        scoreOrder,
        winsOrder,
        scoreCentavos: entryPlan.scoreCentavos,
        winsCount: entryPlan.winsCount,
        lastPrizeAt: Timestamp.fromDate(entryPlan.lastPrizeAt),
        updatedAt: stampedAt,
      });
    }

    if (parentPlan.kind === "create") {
      transaction.set(parentRef, {
        economy,
        seasonId,
        timezone: RANKING_TIMEZONE,
        playerCount: parentPlan.playerCount,
        totalScoreCentavos: parentPlan.totalScoreCentavos,
        windowStart: Timestamp.fromDate(parentPlan.windowStart),
        windowEnd: Timestamp.fromDate(parentPlan.windowEnd),
        updatedAt: stampedAt,
      });
    } else {
      transaction.update(parentRef, {
        playerCount: parentPlan.playerCount,
        totalScoreCentavos: parentPlan.totalScoreCentavos,
        updatedAt: stampedAt,
      });
    }

    // create() and nothing else: the guard is written once and can never be
    // overwritten, so its presence always means a completed application.
    transaction.create(guardRef, {
      transactionRef,
      publicPlayerId,
      economy,
      amountCentavos: event.amountCentavos,
      seasonId,
      dayKey,
      appliedAt: stampedAt,
    });
  });

  return { applied: true, seasonId, economy };
};

export const onPrizeTransactionCreated = central.firestore
  .document("transactions/{transactionId}")
  .onCreate(async (snapshot) => {
    await onPrizeTransactionCreatedHandler(snapshot);
  });

/** The entries subcollection of one season, ordered canonically. */
function seasonEntriesQuery(
  economy: RankingEconomy,
  seasonId: string
): CollectionReference {
  return db
    .collection(SEASON_RANKINGS_COLLECTION)
    .doc(seasonDocumentId(economy, seasonId))
    .collection(SEASON_ENTRIES_SUBCOLLECTION);
}

/** A domain ordering scalar, as the Firestore value the queries compare. */
/**
 * The three disjoint counting queries that define "entries ahead of mine".
 *
 * EXTRACTED SO THERE IS ONE DEFINITION. `getMySeasonRanking` tells a player
 * their ordinal, and the season-badge settlement decides whether that ordinal
 * earned a permanent trophy. If the two ever computed "ahead" differently, a
 * player could be shown 3rd and awarded Top 10, and neither number would be
 * provably wrong — the worst kind of disagreement to debug.
 *
 * The rule (§4.3), unchanged: a strictly better score, OR the same score with
 * more wins, OR both equal with a lower document id. Every third-level bound is
 * strict, so the caller's own row falls in none of the three.
 *
 * The queries are returned UNEXECUTED because the two callers run them
 * differently — one inside a read-only transaction, one as plain reads over a
 * season that is already closed and therefore stable.
 */
function aheadQueries(
  entries: FirebaseFirestore.CollectionReference,
  mine: {
    readonly scoreCentavos: number;
    readonly winsCount: number;
    readonly documentId: string;
  }
): FirebaseFirestore.AggregateQuery<
  { count: FirebaseFirestore.AggregateField<number> },
  FirebaseFirestore.DocumentData,
  FirebaseFirestore.DocumentData
>[] {
  const myScore = rankTimestamp(encodeRankScalar(mine.scoreCentavos));
  const myWins = rankTimestamp(encodeRankScalar(mine.winsCount));

  return [
    entries
      .where("scoreOrder", ">", myScore)
      .where("scoreOrder", "<=", MAX_RANK_TS)
      .where("winsOrder", ">=", MIN_RANK_TS)
      .where("winsOrder", "<=", MAX_RANK_TS)
      .orderBy("scoreOrder", "desc")
      .orderBy("winsOrder", "desc")
      .orderBy(FieldPath.documentId(), "asc")
      .count(),
    entries
      .where("scoreOrder", "==", myScore)
      .where("winsOrder", ">", myWins)
      .where("winsOrder", "<=", MAX_RANK_TS)
      .orderBy("winsOrder", "desc")
      .orderBy(FieldPath.documentId(), "asc")
      .count(),
    entries
      .where("scoreOrder", "==", myScore)
      .where("winsOrder", "==", myWins)
      .where(FieldPath.documentId(), "<", mine.documentId)
      .orderBy(FieldPath.documentId(), "asc")
      .count(),
  ];
}

function rankTimestamp(scalar: RankScalar): Timestamp {
  return new Timestamp(scalar.seconds, scalar.nanoseconds);
}

const MIN_RANK_TS = rankTimestamp(MIN_RANK_SCALAR);
const MAX_RANK_TS = rankTimestamp(MAX_RANK_SCALAR);

/**
 * The canonical, structurally-valid slice of a season's entries.
 *
 * INCLUSIVE bounds on BOTH ordering scalars. Validity is expressed by the
 * TYPE plus these bounds, so an entry whose `scoreOrder`/`winsOrder` is absent,
 * of another type, or outside the domain simply is not in this set — while it
 * remains in the physical count, which is what makes the divergence detectable
 * globally, before any page is built. There is no later structural check to
 * reach: that asymmetry was findings B1/B1b.
 *
 * The three orderBy clauses ARE the canonical order of §4.3, and the final
 * component is the document id, which is unique.
 */
function canonicalEntriesQuery(
  economy: RankingEconomy,
  seasonId: string
): Query {
  return seasonEntriesQuery(economy, seasonId)
    .where("scoreOrder", ">=", MIN_RANK_TS)
    .where("scoreOrder", "<=", MAX_RANK_TS)
    .where("winsOrder", ">=", MIN_RANK_TS)
    .where("winsOrder", "<=", MAX_RANK_TS)
    .orderBy("scoreOrder", "desc")
    .orderBy("winsOrder", "desc")
    .orderBy(FieldPath.documentId(), "asc");
}

/** What both callables must agree on before publishing anything. */
interface SeasonIntegrity {
  readonly playerCount: number;
}

/**
 * THE SEASON INVARIANT, proven with aggregates and never a scan.
 *
 * Three numbers must agree: the parent's stored `playerCount`, the PHYSICAL
 * number of documents in the subcollection, and the number that carry a
 * canonical key of the current version. Both callables run this same check on
 * the same snapshot, so neither can publish a season the other would refuse.
 *
 * The physical count is what makes corruption detectable without reading a
 * single document: any entry lacking a key, carrying a key of the wrong TYPE
 * or of another schema version is counted physically but not canonically, so
 * the two diverge and the season fails closed. That covers a partial
 * migration, a residual document, a stale parent, and a parent that is missing
 * while its subcollection is not empty.
 *
 * The message is generic — it names no document, field or value.
 */
function assertSeasonIntegrity(input: {
  readonly parentExists: boolean;
  readonly parentData: Record<string, unknown>;
  readonly physicalCount: number;
  readonly canonicalCount: number;
}): SeasonIntegrity {
  const inconsistent = (): never => {
    throw new DomainError(
      "failed-precondition",
      "Documento de ranking inconsistente."
    );
  };

  if (input.physicalCount !== input.canonicalCount) inconsistent();

  if (!input.parentExists) {
    // A season with no parent may only be answered when its subcollection is
    // provably empty; anything else is corruption, not an empty season.
    if (input.physicalCount !== 0) inconsistent();
    return { playerCount: 0 };
  }

  const stored = input.parentData.playerCount;
  if (
    typeof stored !== "number" ||
    !Number.isSafeInteger(stored) ||
    stored < 0
  ) {
    inconsistent();
  }
  if ((stored as number) !== input.canonicalCount) inconsistent();

  return { playerCount: input.canonicalCount };
}

/**
 * One page of a monthly season leaderboard.
 *
 * ORDER AND POSITION COME FROM ONE PLACE. The query orders by the canonical
 * comparator of design section 4.3 and the position is the cursor's
 * `absoluteOffset` plus the row's index — so page 2 continues page 1's
 * numbering without recomputing anything, and no `position` field is ever
 * stored (section 8.3).
 *
 * PAGING IS CURSOR-ONLY, and the cursor is opaque, server-produced (HMAC) and
 * bound to this season and economy — one minted elsewhere is rejected rather
 * than silently restarted. `startAfter` on the full ordering tuple resumes
 * after a stable KEY instead of a row number, so a page never re-serves the
 * rows the cursor already covered. It does NOT freeze the season: there is no
 * snapshot between pages, and the carried `absoluteOffset` is only the visual
 * numbering continuation. A concurrent prize can still move an entry across
 * the cursor tuple between requests — a row that moved ahead of it is omitted
 * from the rest of the run, one that moved behind it would repeat (out-of-band
 * writes only, since a prize never lowers a key), and visual numbers on later
 * pages can lag the live ordinals `getMySeasonRanking` reports.
 *
 * The response carries only the allowlisted projection: no uid, in any field,
 * and none in the cursor either, because the entry is keyed by `publicPlayerId`.
 */
export interface SeasonLeaderboardOptions {
  /**
   * Cursor signing key, injected only by tests so a signature can be exercised
   * without any real secret existing. Production never passes it and reads
   * `RANKING_CURSOR_HMAC_SECRET` from the environment instead.
   *
   * NOT a payload field: a client can neither supply nor influence it.
   */
  readonly cursorSecret?: string;
  /**
   * Clock override, injected only by tests so the retention window can be
   * exercised deterministically. Production never passes it.
   *
   * NOT a payload field: a client can neither supply nor influence it.
   */
  readonly now?: Date;
}

export const getSeasonLeaderboardHandler = async (
  data: any,
  context: any,
  options: SeasonLeaderboardOptions = {}
): Promise<Record<string, unknown>> => {
  try {
    assertSignedIn(
      context,
      "Você precisa estar logado para ver o ranking."
    );

    assertExactPayload(data ?? {}, ["economy", "seasonId", "limit", "cursor"]);

    const economy = normalizeEconomy((data ?? {}).economy);
    const seasonId = normalizeMonth((data ?? {}).seasonId).key;
    const limit = normalizeLimit((data ?? {}).limit);

    // Retention (§8.4): only the current business month and the 11 before it
    // are served. Checked BEFORE any read, cursor work or signing.
    assertSeasonServable(
      seasonId,
      seasonIdFromInstant(options.now ?? new Date())
    );

    // Environment only. Absent, empty or under 32 bytes fails closed inside the
    // domain — there is no unsigned fallback and no derived default.
    const cursorSecret =
      options.cursorSecret ?? process.env[RANKING_CURSOR_SECRET_ENV];

    const rawCursor = (data ?? {}).cursor;
    const cursor =
      rawCursor === undefined || rawCursor === null
        ? null
        : decodeCursor(rawCursor, { economy, seasonId }, cursorSecret);

    // The CANONICAL set: the typed ordering tuple, so the page and every
    // aggregate below describe provably the same entries.
    const canonical = canonicalEntriesQuery(economy, seasonId);
    const physical = seasonEntriesQuery(economy, seasonId);

    // The cursor carried plain integers; they become ordering scalars only now,
    // after the MAC and every field check have passed. The final component is
    // the document id, which is unique, so `startAfter` resumes after exactly
    // one entry and can neither skip nor repeat a row.
    const query =
      cursor === null
        ? canonical
        : canonical.startAfter(
            rankTimestamp(encodeRankScalar(cursor.afterScoreCentavos)),
            rankTimestamp(encodeRankScalar(cursor.afterWinsCount)),
            cursor.afterDocumentId
          );

    // ── ONE consistent snapshot ─────────────────────────────────────────────
    // Parent, both integrity counts and the page are read through the SAME
    // read-only transaction, so the rows and the playerCount of one response
    // always belong to one state of the season. `readOnly: true` makes a write
    // structurally impossible on this path.
    const snapshot = await db.runTransaction(
      async (transaction) => {
        const parentSnap = await transaction.get(
          db
            .collection(SEASON_RANKINGS_COLLECTION)
            .doc(seasonDocumentId(economy, seasonId))
        );

        // One extra row decides whether another page exists, without a second
        // query.
        const [physicalSnap, canonicalSnap, pageSnap] = await Promise.all([
          transaction.get(physical.count()),
          transaction.get(canonical.count()),
          transaction.get(query.limit(limit + 1)),
        ]);

        const integrity = assertSeasonIntegrity({
          parentExists: parentSnap.exists,
          parentData: parentSnap.data() ?? {},
          physicalCount: physicalSnap.data().count,
          canonicalCount: canonicalSnap.data().count,
        });

        return { docs: pageSnap.docs, playerCount: integrity.playerCount };
      },
      { readOnly: true }
    );

    const page = snapshot.docs.slice(0, limit);
    const hasMore = snapshot.docs.length > limit;

    const startOffset = cursor === null ? 0 : cursor.absoluteOffset;
    const entries = page.map((doc, index) =>
      publicEntry(
        startOffset + index + 1,
        doc.id,
        doc.data() ?? {},
        economy,
        seasonId
      )
    );
    // Built from the PUBLISHED row, which was itself decoded from the canonical
    // scalars — so the cursor can only ever point at a position the ordering
    // actually expresses.
    const last = entries[entries.length - 1];

    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor(
            {
              economy,
              seasonId,
              afterScoreCentavos: last.scoreCentavos,
              afterWinsCount: last.winsCount,
              afterDocumentId: last.publicPlayerId,
              absoluteOffset: startOffset + entries.length,
            },
            cursorSecret
          )
        : null;

    return {
      success: true,
      timezone: RANKING_TIMEZONE,
      amountUnit: "centavos",
      economy,
      seasonId,
      playerCount: snapshot.playerCount,
      entries,
      nextCursor,
    };
  } catch (error) {
    console.error("getSeasonLeaderboard error:", error);
    throw toHttpsError(error);
  }
};

/**
 * DEDICATED builder, never `central`: `FunctionBuilder.prototype.runWith()`
 * MUTATES the builder it is called on and returns `this`, so running it on the
 * shared `central` would silently attach the cursor secret to EVERY export
 * declared after this line (it did — that was the re-audit's HIGH finding).
 * The module-level `region()` factory returns a fresh builder per call, which
 * confines the secret to exactly this one callable. `functionRegions.test.ts`
 * asserts the resulting per-export secret sets on the built artifact.
 */
export const getSeasonLeaderboard = region(REGION_CALLABLES)
  .runWith({ secrets: [RANKING_CURSOR_SECRET_ENV] })
  .https.onCall(getSeasonLeaderboardHandler);

/**
 * The caller's own placement in a monthly season.
 *
 * THE CALLER IS THE TOKEN. There is no uid in the payload — a player can only
 * ever ask about themselves — and the uid is never echoed back: it is resolved
 * to the pseudonym through the server-only identity map, and only the pseudonym
 * appears in the response.
 *
 * THE ORDINAL IS EXACT, not a page scan. Three disjoint counts cover precisely
 * the entries ahead under section 4.3 — a strictly better score, or the same
 * score with more wins, or both equal with a lower `publicPlayerId` — so the
 * answer is identical to the position the paged leaderboard would show, at any
 * season size.
 *
 * A player with no qualifying prize is NOT ranked: `isRanked: false` and
 * `rank: null`, with no document created and no synthetic zero-score row.
 */
export interface MySeasonRankingOptions {
  /**
   * Test-only synchronisation point, awaited after the first transactional
   * read. It exists solely so a concurrency test can mutate a competitor once
   * the snapshot is already fixed, proving the later counts still observe the
   * state the transaction started from.
   *
   * NOT a payload field and not client-reachable.
   */
  readonly afterFirstRead?: () => Promise<void>;
  /**
   * Clock override, injected only by tests so the retention window can be
   * exercised deterministically. Production never passes it.
   *
   * NOT a payload field: a client can neither supply nor influence it.
   */
  readonly now?: Date;
}

export const getMySeasonRankingHandler = async (
  data: any,
  context: any,
  options: MySeasonRankingOptions = {}
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertSignedIn(
      context,
      "Você precisa estar logado para ver sua posição."
    );

    // `uid` is deliberately NOT an accepted key.
    assertExactPayload(data ?? {}, ["economy", "seasonId"]);

    const economy = normalizeEconomy((data ?? {}).economy);
    const seasonId = normalizeMonth((data ?? {}).seasonId).key;

    // Retention (§8.4): only the current business month and the 11 before it
    // are served. Checked BEFORE any read.
    assertSeasonServable(
      seasonId,
      seasonIdFromInstant(options.now ?? new Date())
    );

    const uid = normalizeIdentityUid(callerAuth.uid);

    // Read INSIDE the snapshot below, like everything else this answer rests
    // on. This read never MINTS: an identity is created by settlement, or by
    // the player opening their own profile — never by a leaderboard read.
    //
    // AND HAVING ONE STILL DOES NOT MEAN BEING RANKED. What decides that is
    // the season ENTRY below, which only settlement writes. So a player who
    // opened their profile and never won has an identity and no entry, and
    // reads as unranked — the same answer as before this was ever minted here.
    const identityRef = db.collection(PUBLIC_PLAYER_ID_COLLECTION).doc(uid);

    const entries = seasonEntriesQuery(economy, seasonId);
    const parentRef = db
      .collection(SEASON_RANKINGS_COLLECTION)
      .doc(seasonDocumentId(economy, seasonId));

    // ── ONE consistent snapshot ────────────────────────────────────
    // Parent, the entry, both integrity counts and the ahead-count are read
    // through the SAME read-only transaction, so they share one read
    // timestamp. Issuing them independently let a competitor cross between
    // the counted sets mid-read and be counted twice — or missed — producing
    // an ordinal that matched no state the season was ever actually in.
    //
    // `readOnly: true` is not decoration: Firestore refuses writes inside it,
    // so a read path can never acquire one by accident.
    const canonical = canonicalEntriesQuery(economy, seasonId);

    const snapshot = await db.runTransaction(
      async (transaction) => {
        const parentSnap = await transaction.get(parentRef);
        const identitySnap = await transaction.get(identityRef);

        // ABSENT identity: the caller simply never won — unranked, per
        // contract. PRESENT but malformed: the one document that binds an
        // account to its pseudonym is corrupt, and answering "you are not
        // ranked" would be indistinguishable from the legitimate case while
        // silently hiding an entry that may well exist. That fails closed,
        // with a message that names no uid, path or value.
        const publicPlayerId = identitySnap.exists
          ? (identitySnap.data() ?? {}).publicPlayerId
          : null;

        if (identitySnap.exists && !isPublicPlayerId(publicPlayerId)) {
          throw new DomainError(
            "failed-precondition",
            "Documento de ranking inconsistente."
          );
        }

        const entrySnap = isPublicPlayerId(publicPlayerId)
          ? await transaction.get(entries.doc(publicPlayerId))
          : null;

        // Test-only seam: lets a concurrency test mutate a competitor AFTER
        // the snapshot is fixed but BEFORE the counts run. Never reachable
        // from a client — a handler parameter, not a payload field.
        if (options.afterFirstRead !== undefined) {
          await options.afterFirstRead();
        }

        const [physicalSnap, canonicalSnap] = await Promise.all([
          transaction.get(entries.count()),
          transaction.get(canonical.count()),
        ]);

        // The SAME invariant the leaderboard proves, on the same snapshot, so
        // neither surface can answer for a season the other would refuse.
        const integrity = assertSeasonIntegrity({
          parentExists: parentSnap.exists,
          parentData: parentSnap.data() ?? {},
          physicalCount: physicalSnap.data().count,
          canonicalCount: canonicalSnap.data().count,
        });

        if (entrySnap === null || !entrySnap.exists) {
          return { ranked: false as const, playerCount: integrity.playerCount };
        }

        const mine = publicEntry(
          1,
          entrySnap.id,
          entrySnap.data() ?? {},
          economy,
          seasonId
        );

        // THREE DISJOINT COUNTS covering exactly the entries ahead under §4.3.
        // The QUERIES are built by `aheadQueries` so this handler and the
        // season-badge settlement share one definition of "ahead" — a placement
        // trophy that disagreed with the leaderboard it came from would be the
        // worst possible bug in either.
        const [betterScore, sameScoreMoreWins, sameTupleEarlierId] =
          await Promise.all(
            aheadQueries(entries, {
              scoreCentavos: mine.scoreCentavos,
              winsCount: mine.winsCount,
              documentId: entrySnap.id,
            }).map((query) => transaction.get(query))
          );

        const ahead =
          betterScore.data().count +
          sameScoreMoreWins.data().count +
          sameTupleEarlierId.data().count;

        return {
          ranked: true as const,
          playerCount: integrity.playerCount,
          mine,
          ahead,
        };
      },
      { readOnly: true }
    );

    if (!snapshot.ranked) {
      return {
        success: true,
        timezone: RANKING_TIMEZONE,
        amountUnit: "centavos",
        economy,
        seasonId,
        isRanked: false,
        rank: null,
        entry: null,
        playerCount: snapshot.playerCount,
      };
    }

    return {
      success: true,
      timezone: RANKING_TIMEZONE,
      amountUnit: "centavos",
      economy,
      seasonId,
      isRanked: true,
      rank: rankFromAhead(snapshot.ahead),
      entry: {
        publicPlayerId: snapshot.mine.publicPlayerId,
        label: snapshot.mine.label,
        scoreCentavos: snapshot.mine.scoreCentavos,
        winsCount: snapshot.mine.winsCount,
      },
      playerCount: snapshot.playerCount,
    };
  } catch (error) {
    console.error("getMySeasonRanking error:", error);
    throw toHttpsError(error);
  }
};

export const getMySeasonRanking = central.https.onCall(
  getMySeasonRankingHandler
);

/**
 * A Firestore Timestamp (production), a Date (tests), or null for anything
 * else. A row we cannot date is counted as undated rather than guessed at.
 */
function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (
    value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    try {
      const d = (value as { toDate: () => Date }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * PUBLIC, UNAUTHENTICATED tournament preview — the only server surface a
 * stranger can read, and the only reason the shared link can show anything at
 * all. `firestore.rules` denies anonymous reads of `tournaments`, deliberately;
 * this endpoint does not relax that, it replaces it with a curated projection.
 *
 * WHAT IT CANNOT REACH. It performs exactly ONE read: the tournament document
 * itself. It never touches `tournament_rooms` (room id and password),
 * `registrations`, `wallets`, `transactions`, `users` or `public_player_ids` —
 * so no credential, no uid, no balance and no entry list can appear here even
 * by accident. What it does read is then narrowed again by
 * `projectPublicPreview`, which builds the response key by key.
 *
 * THE REFUSAL IS UNIFORM. A malformed id, an id that matches nothing, and a
 * document that cannot be described faithfully all return the SAME 404. The
 * endpoint therefore never confirms which tournament ids exist, which is what
 * keeps an unauthenticated scan from mapping the collection.
 */
export const publicTournamentPreviewHandler = async (
  req: any,
  res: any
): Promise<void> => {
  // Public and read-only: safe to cache, and never worth indexing.
  res.set("Access-Control-Allow-Origin", "*");
  res.set("X-Robots-Tag", "noindex");
  res.set("Cache-Control", "public, max-age=60, s-maxage=300");

  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.status(204).send("");
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "method-not-allowed" });
    return;
  }

  // An array (`?id=a&id=b`) is not a string, so it is refused here.
  const id = req.query?.id;
  if (!isValidPublicId(id)) {
    res.status(404).json({ error: "not-found" });
    return;
  }

  try {
    const snapshot = await db.collection("tournaments").doc(id).get();
    const preview = projectPublicPreview(
      snapshot.exists ? snapshot.data() ?? null : null
    );

    if (preview === null) {
      res.status(404).json({ error: "not-found" });
      return;
    }

    res.status(200).json(preview);
  } catch (error) {
    // The reason never reaches the caller: it would describe internals to an
    // unauthenticated client.
    console.error("publicTournamentPreview error:", error);
    res.status(500).json({ error: "internal" });
  }
};

export const publicTournamentPreview = central.https.onRequest(
  publicTournamentPreviewHandler
);

// ─────────────────────────────────────────────────────────────────────────────
// Partner referral: attribution and accrual
//
// This section records WHO brought a player and HOW MUCH is owed for it. It
// never pays anybody, and it never touches a wallet, a prize, a registration or
// a tournament. See `domain/partnerReferral.ts` for why paying is impossible at
// this commit and why recording is still urgent.
// ─────────────────────────────────────────────────────────────────────────────

/** The exact payload of `claimReferral`. Any other key is rejected outright. */
const CLAIM_REFERRAL_KEYS = ["code"] as const;

/** What the claim did, as data — so the app can explain the outcome. */
export type ClaimReferralOutcome =
  | { readonly claimed: true; readonly partnerRef: string }
  | {
      readonly claimed: false;
      readonly reason:
        | "already-attributed"
        | "self-referral"
        | "unknown-code"
        | "partner-inactive";
    };

/**
 * Binds the CALLER to the partner behind a referral code.
 *
 * THE CALLER IS THE SUBJECT. There is no uid in the payload — a player can only
 * ever attribute themselves — so a partner cannot enrol accounts they do not
 * control, and one player cannot assign another to a partner.
 *
 * WHY A CALLABLE AND NOT THE SIGN-UP TRIGGER. `onUserCreated` is an auth
 * trigger: it receives only the Firebase Auth record, has no channel for a
 * client payload, and swallows its own transaction failures in a `catch` that
 * merely logs. An attribution written there could not arrive and, worse, could
 * fail invisibly. So the app calls this explicitly after sign-in.
 *
 * CREATE-ONLY, ENFORCED BY A TRANSACTIONAL READ — not by a Firestore
 * precondition. The handler reads `users/{uid}` inside the transaction and
 * refuses when `partner_ref` is already a string, so a concurrent second claim
 * is serialised and reported rather than applied.
 *
 * The limit of that mechanism, stated rather than glossed: it tests for a
 * STRING. A document whose `partner_ref` held some other type — reachable only
 * by an out-of-band Admin SDK or console write, never by this code — would be
 * treated as unattributed and overwritten by a later claim.
 */
export const claimReferralHandler = async (
  data: unknown,
  context: unknown
): Promise<ClaimReferralOutcome> => {
  const auth = assertSignedIn(
    context as any,
    "Entre na sua conta para usar um código de indicação."
  );
  assertExactPayload(data, CLAIM_REFERRAL_KEYS);

  const code = normalizeReferralCode((data as { code?: unknown })?.code);
  const uid = auth.uid;

  const codeRef = db.collection(REFERRAL_CODES_COLLECTION).doc(code);
  const userRef = db.collection("users").doc(uid);

  return db.runTransaction(async (transaction) => {
    // Both reads happen before any write — Firestore requires it, and it also
    // means the decision below sees one consistent snapshot.
    const [codeSnap, userSnap] = await Promise.all([
      transaction.get(codeRef),
      transaction.get(userRef),
    ]);

    if (!codeSnap.exists) {
      return { claimed: false, reason: "unknown-code" } as const;
    }

    const codeData = codeSnap.data() ?? {};
    const partnerRef =
      typeof codeData.partner_ref === "string" ? codeData.partner_ref : null;
    if (!partnerRef) {
      // A code row without a partner is corrupt, not a missing code. It is
      // reported as unknown so a caller learns nothing about internal state.
      return { claimed: false, reason: "unknown-code" } as const;
    }

    const partnerSnap = await transaction.get(
      db.collection(PARTNERS_COLLECTION).doc(partnerRef)
    );
    if (!partnerSnap.exists || partnerSnap.get("active") !== true) {
      return { claimed: false, reason: "partner-inactive" } as const;
    }

    const decision = decideAttribution({
      existingPartnerRef:
        typeof userSnap.get("partner_ref") === "string"
          ? (userSnap.get("partner_ref") as string)
          : null,
      code,
      partnerOwnerUid:
        typeof partnerSnap.get("owner_uid") === "string"
          ? (partnerSnap.get("owner_uid") as string)
          : null,
      claimantUid: uid,
    });

    if (!decision.attributes) {
      return { claimed: false, reason: decision.reason } as const;
    }

    const attributedAt = new Date();

    // `merge: true` so the five fields `onUserCreated` owns are untouched. The
    // expiry is STORED rather than recomputed later: if the window constant
    // ever changes, already-recorded attributions must keep the terms they were
    // recorded under.
    transaction.set(
      userRef,
      {
        partner_ref: partnerRef,
        referral_code: code,
        attributed_at: Timestamp.fromDate(attributedAt),
        attribution_expires_at: Timestamp.fromDate(
          attributionExpiresAt(attributedAt)
        ),
        source: "referral_link",
      },
      { merge: true }
    );

    return { claimed: true, partnerRef } as const;
  });
};

export const claimReferral = central.https.onCall(async (data, context) => {
  try {
    return await claimReferralHandler(data, context);
  } catch (error) {
    throw toHttpsError(error);
  }
});

/** Why a ledger row produced no accrual. Returned for tests and logs. */
export type AccrualOutcome =
  | { readonly accrued: true; readonly commissionCentavos: number }
  | { readonly accrued: false; readonly reason: string };

/**
 * Accrues one partner commission from a settled cash entry fee.
 *
 * FINANCIALLY INERT, exactly like `onPrizeTransactionCreated`. The entry fee is
 * already committed when this runs, so a failure here can never delay, reverse
 * or duplicate a player's registration. Nothing below reads or writes a wallet,
 * a registration, a tournament or a result.
 *
 * BETA CAN NEVER REACH THE ACCRUAL. A beta entry writes `beta_entry_fee`, a
 * different category, so it is refused at the front door — before any read —
 * rather than relying on the economy check further in. Two independent barriers
 * for the one rule that must not break.
 *
 * INELIGIBLE IS A SILENT NO-OP: throwing would make Firestore retry a delivery
 * that can never succeed.
 */
export const onEntryFeeTransactionCreatedHandler = async (
  snapshot: any
): Promise<AccrualOutcome> => {
  const data = snapshot?.data?.();
  if (!data) return { accrued: false, reason: "no-data" };

  // ── Front door ───────────────────────────────────────────────────────────
  if (data.category !== "entry_fee") {
    return { accrued: false, reason: "not-a-cash-entry-fee" };
  }

  const userPath: string | null =
    typeof data.user_ref?.path === "string" ? data.user_ref.path : null;
  const uid = userPath?.startsWith("users/") ? userPath.slice(6) : null;
  if (!uid) return { accrued: false, reason: "no-user-ref" };

  const tournamentPath: string | null =
    typeof data.tournament_ref?.path === "string"
      ? data.tournament_ref.path
      : null;
  const tournamentId = tournamentPath?.startsWith("tournaments/")
    ? tournamentPath.slice(12)
    : null;
  if (!tournamentId) return { accrued: false, reason: "no-tournament-ref" };

  // The entry-fee row is stored as a NEGATIVE amount in reais (a debit), so the
  // magnitude is what the player paid. `allowZero` lets a free tournament reach
  // `decideCommission`, which classifies it as `free-entry` rather than as a
  // malformed amount.
  // O VALOR NÃO É COAGIDO. `Number("100")` e `Number({toString:()=>"100"})`
  // valem 100, e coagir aqui anularia a checagem de tipo do `inspectReais` —
  // que existe exatamente para expor dado corrompido em vez de processá-lo.
  // Só um número tem magnitude; qualquer outra coisa segue adiante como está e
  // é recusada como `not-a-number`.
  const rawAmount = data.amount;
  const inspection = inspectReais(
    typeof rawAmount === "number" ? Math.abs(rawAmount) : rawAmount,
    { allowZero: true }
  );
  if (!inspection.ok) return { accrued: false, reason: "bad-amount" };
  const entryCentavos = inspection.centavos;

  // ── Accepted: from here a failure must propagate so the delivery retries ──
  const userSnap = await db.collection("users").doc(uid).get();
  const partnerRef =
    typeof userSnap.get("partner_ref") === "string"
      ? (userSnap.get("partner_ref") as string)
      : null;
  const toDate = (raw: unknown): Date | null =>
    raw && typeof (raw as { toDate?: unknown }).toDate === "function"
      ? ((raw as { toDate: () => Date }).toDate() as Date)
      : null;

  const attributedAt = toDate(userSnap.get("attributed_at"));
  // Read, not recomputed: the stored value carries the terms the attribution
  // was recorded under, and it must survive a later change to the window.
  const storedExpiresAt = toDate(userSnap.get("attribution_expires_at"));

  let partnerActive = false;
  let partnerOwnerUid: string | null = null;
  if (partnerRef) {
    const partnerSnap = await db
      .collection(PARTNERS_COLLECTION)
      .doc(partnerRef)
      .get();
    partnerActive = partnerSnap.get("active") === true;
    partnerOwnerUid =
      typeof partnerSnap.get("owner_uid") === "string"
        ? (partnerSnap.get("owner_uid") as string)
        : null;
  }

  const decision: CommissionDecision = decideCommission({
    partnerRef,
    attributedAt,
    attributionExpiresAt: storedExpiresAt,
    partnerActive,
    partnerOwnerUid,
    payerUid: uid,
    economy: "cash",
    entryCentavos,
    now: new Date(),
  });

  if (!decision.accrues) {
    return { accrued: false, reason: decision.reason };
  }

  /**
   * Idempotent by construction: the row id is derived from the registration,
   * and `create` fails if a replay already wrote it. One registration can
   * accrue at most one commission, whatever Firestore's at-least-once delivery
   * does.
   */
  const registration = registrationId(uid, tournamentId);
  const accrualRef = db
    .collection("transactions")
    .doc(commissionAccrualId(registration));

  /**
   * The row and the partner's running total move together or not at all.
   *
   * `create` inside the transaction is what makes it idempotent: a replay of the
   * same delivery aborts before the increment, so the total can never drift
   * above the ledger. Integer centavos increment exactly — the caution about
   * `FieldValue.increment()` elsewhere in this file is about FLOAT reais.
   */
  const accrualRow = {
    category: COMMISSION_ACCRUED_CATEGORY,
    status: "accrued",
    partner_ref: decision.partnerRef,
    // Integer CENTAVOS, not reais: this row is an accrued liability, never a
    // wallet movement, so it does not inherit the stored reais representation
    // the five cash fields use.
    amount_centavos: decision.commissionCentavos,
    fee_centavos: decision.feeCentavos,
    entry_centavos: decision.entryCentavos,
    amount_unit: "centavos",
    source_registration_id: registration,
    tournament_ref: db.collection("tournaments").doc(tournamentId),
    created_at: FieldValue.serverTimestamp(),
    // NO user_ref. The partner is owed the money; the player who generated it is
    // identified only through the registration id, which is server-side. A
    // user_ref here would make the row readable by that player under the
    // existing owner-scoped Rules and expose the partner's earnings.
  };

  try {
    await db.runTransaction(async (transaction) => {
      transaction.create(accrualRef, accrualRow);
      transaction.set(
        db.collection(PARTNERS_COLLECTION).doc(decision.partnerRef),
        {
          [PARTNER_TOTAL_FIELD]: FieldValue.increment(
            decision.commissionCentavos
          ),
        },
        { merge: true }
      );
    });
  } catch (error: any) {
    if (error?.code === 6 || error?.code === "already-exists") {
      return { accrued: false, reason: "already-accrued" };
    }
    throw error;
  }

  return { accrued: true, commissionCentavos: decision.commissionCentavos };
};

export const onEntryFeeTransactionCreated = central.firestore
  .document("transactions/{transactionId}")
  .onCreate(async (snapshot) => {
    await onEntryFeeTransactionCreatedHandler(snapshot);
  });

/** The exact payload of `createPartner`. */
const CREATE_PARTNER_KEYS = ["name", "code", "ownerUid"] as const;

/**
 * Registers a partner and reserves their referral code, atomically.
 *
 * ADMIN ONLY. A partner is a commercial relationship, not a self-service
 * signup: issuing a code creates a future liability against the platform's own
 * margin, so it is an act an administrator performs deliberately.
 *
 * THE CODE IS THE LOCK. `referral_codes/{code}` is created inside the
 * transaction, so two admins racing on the same code cannot both win — the
 * second `create` fails rather than silently reassigning a live code to a
 * different partner. Same structural trick as `public_player_id_index`.
 */
export const createPartnerHandler = async (
  data: unknown,
  context: unknown
): Promise<{ readonly partnerRef: string; readonly code: string }> => {
  assertAdmin(
    context as any,
    "Entre na sua conta de administrador.",
    "Apenas administradores podem criar parceiros."
  );
  assertExactPayload(data, CREATE_PARTNER_KEYS);

  const payload = (data ?? {}) as {
    name?: unknown;
    code?: unknown;
    ownerUid?: unknown;
  };

  const code = normalizeReferralCode(payload.code);

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (name.length === 0 || name.length > 120) {
    throw new DomainError(
      "invalid-argument",
      "Informe o nome do parceiro (até 120 caracteres)."
    );
  }

  // The owner is optional: a partner may be a company with no player account.
  // When present it is what makes self-referral detectable later.
  const ownerUid =
    payload.ownerUid === undefined || payload.ownerUid === null
      ? null
      : typeof payload.ownerUid === "string" && payload.ownerUid.length > 0
        ? payload.ownerUid
        : (() => {
            throw new DomainError("invalid-argument", "ownerUid inválido.");
          })();

  const partnerRef = db.collection(PARTNERS_COLLECTION).doc();
  const codeRef = db.collection(REFERRAL_CODES_COLLECTION).doc(code);

  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(codeRef);
    if (existing.exists) {
      throw new DomainError("already-exists", "Esse código já está em uso.");
    }

    transaction.create(partnerRef, {
      name,
      code,
      owner_uid: ownerUid,
      active: true,
      [PARTNER_TOTAL_FIELD]: 0,
      created_at: FieldValue.serverTimestamp(),
    });
    transaction.create(codeRef, {
      partner_ref: partnerRef.id,
      created_at: FieldValue.serverTimestamp(),
    });
  });

  return { partnerRef: partnerRef.id, code };
};

export const createPartner = central.https.onCall(async (data, context) => {
  try {
    return await createPartnerHandler(data, context);
  } catch (error) {
    throw toHttpsError(error);
  }
});

/**
 * Sets the caller's Sparta nickname — the last step of signing up.
 *
 * THIS IS THE CALLABLE `docs/username.md` ASKED FOR. `users/{uid}.username` is
 * written as `""` by the auth trigger and never populated, because the client
 * sets a display name on the Auth profile after the trigger has already run.
 * The name now lives in Firestore, chosen by the player, written by the server.
 *
 * UNIQUENESS IS A RESERVATION, not a lookup. `create` on a document whose id is
 * the folded name means two people typing "spartano" at the same instant cannot
 * both succeed — the second one fails. A read-then-write check would let both
 * through, and the loser would only find out when someone impersonated them.
 *
 * CHANGING A NICK RELEASES THE OLD ONE, in the same transaction that takes the
 * new one. Doing it in two steps would either strand the old name forever or
 * leave a window where the player holds neither.
 */
/**
 * The caller's badges, granting any newly earned ones.
 *
 * READ-AND-GRANT IN ONE CALL, rather than a nightly job. The counts come from
 * aggregate queries that are cheap and always current, so the moment a player
 * opens the screen their badges are correct — no job to fall behind, no
 * "why haven't I got it yet".
 *
 * GRANTING IS IDEMPOTENT: `badgesToAward` subtracts what is already owned, so
 * a screen opened twice writes once. And nothing here can REVOKE — the awards
 * are a high-water mark, so a partner whose referred players deleted their
 * accounts keeps the tier they reached.
 */
export const getMyBadgesHandler = async (
  data: any,
  context: any,
  /**
   * Test-only clock, following the options-with-defaults convention already
   * used by `ensurePublicPlayerIdHandler` and `getMySeasonRanking`. Production
   * never passes it. It exists because season settlement depends on WHICH
   * seasons have closed, and the first ranked season is still in the future —
   * without a seam there would be no way to prove the settlement at all until
   * October 2026.
   */
  options: {
    readonly now?: Date;
    /**
     * Test-only override of `SEASON_BADGES_ACTIVE`. Production never passes it,
     * so the constant decides. It exists so the settlement stays PROVEN while
     * the feature is dark — a mechanism that is only tested when it is on is a
     * mechanism nobody can trust on the day it is switched on.
     */
    readonly seasonBadgesActive?: boolean;
  } = {}
): Promise<Record<string, unknown>> => {
  try {
    const auth = assertSignedIn(
      context as any,
      "Entre na sua conta para ver seus selos."
    );
    assertExactPayload(data ?? {}, []);

    const userRef = db.collection("users").doc(auth.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new DomainError("not-found", "Sua conta não foi encontrada.");
    }
    const userData = userSnap.data() ?? {};

    const partnerSnap = await db
      .collection(PARTNERS_COLLECTION)
      .where("owner_uid", "==", auth.uid)
      .limit(1)
      .get();
    const partnerId = partnerSnap.empty ? null : partnerSnap.docs[0].id;

    const [createdSnap, broughtCount, registeredSnap] = await Promise.all([
      db
        .collection("tournaments")
        .where("creator_uid", "==", auth.uid)
        .count()
        .get(),
      partnerId === null ? Promise.resolve(0) : countQualifiedReferrals(partnerId),
      /**
       * COUNTED, NOT READ FROM THE COUNTER. `users.tournaments_played` was
       * added late and never backfilled, so it reads zero for exactly the
       * accounts the beta badge exists to honour — the ones that were here
       * first. The tiers keep using the counter, because a partner's tier asks
       * this of every player they brought and that would be a query each; this
       * one badge is about the caller alone, so it can afford the truth.
       */
      db
        .collection("registrations")
        .where("user_ref", "==", userRef)
        .count()
        .get(),
    ]);

    const counts = {
      tournamentsCreated: createdSnap.data().count,
      playersBrought: broughtCount,
      tournamentsPlayed: readPlayedCount(userData.tournaments_played),
      isPartner: partnerId !== null,
      betaRegistrations: registeredSnap.data().count,
    };

    const owned: string[] = Array.isArray(userData.badges)
      ? (userData.badges as unknown[]).filter(
          (b): b is string => typeof b === "string"
        )
      : [];

    const placements = await settleSeasonPlacements(
      auth.uid,
      userData.season_badges_through,
      options.now ?? new Date(),
      options.seasonBadgesActive
    );

    const fresh = badgesToAward(counts, owned);
    // Placement trophies are ids the fixed table does not contain, so they are
    // merged here rather than produced by `badgesToAward`. Already-owned ones
    // are filtered out for the same reason granting is idempotent everywhere
    // else: settling a season twice must write nothing the second time.
    const ownedSet = new Set(owned);
    const freshPlacements = placements.earned.filter((id) => !ownedSet.has(id));
    const freshIds = [...fresh.map((b) => b.id), ...freshPlacements];

    if (freshIds.length > 0 || placements.through !== null) {
      /**
       * `badges_unseen` IS WRITTEN IN THE SAME WRITE THAT GRANTS.
       *
       * Granting happens exactly once. If the celebration lived only in this
       * response, an app killed between the grant and the dialog would lose
       * the moment permanently — the next call reports nothing fresh, because
       * there IS nothing fresh: the badge is already owned. Persisting the
       * debt means the celebration waits for the player instead of the player
       * having to be looking at the right screen at the right instant.
       */
      await userRef.set(
        {
          ...(freshIds.length > 0
            ? {
                badges: FieldValue.arrayUnion(...freshIds),
                badges_unseen: FieldValue.arrayUnion(...freshIds),
                badges_updated_at: FieldValue.serverTimestamp(),
              }
            : {}),
          // THE CURSOR MOVES EVEN WHEN NOTHING WAS EARNED. Placing nowhere is
          // the ordinary outcome, and re-checking the same closed season on
          // every read forever would be a growing cost that buys nothing.
          ...(placements.through !== null
            ? { season_badges_through: placements.through }
            : {}),
        },
        { merge: true }
      );
    }

    return {
      badges: [...owned, ...freshIds],
      awarded: freshIds,
      /**
       * Everything still owed a celebration — this call's awards plus anything
       * an earlier call granted and nobody ever acknowledged.
       */
      unseen: pendingCelebrations(userData.badges_unseen, freshIds),
      counts,
    };
  } catch (error) {
    console.error("getMyBadges error:", error);
    throw toHttpsError(error);
  }
};

/**
 * The placement trophies a closed season owes this account.
 *
 * COMPUTED ON READ, NOT ON A SCHEDULE. "You finished third" only becomes a fact
 * when the month ends, and this backend has no scheduler — so the answer is
 * worked out on the first badge read after the season closed. That is the same
 * read-and-grant shape the rest of the engine already has: no job to fall
 * behind, and nothing to re-run if one fails.
 *
 * CASH ONLY. `SEASON_BADGE_ECONOMY` is a constant, not a parameter, so no
 * caller can mint a permanent trophy out of the play-money board.
 *
 * IT USES THE LEADERBOARD'S OWN DEFINITION OF "AHEAD" via `aheadQueries`. A
 * trophy that disagreed with the board it came from would be the worst bug
 * either could have.
 *
 * A SEASON WITH NO ENTRY EARNS NOTHING, silently: not competing is the ordinary
 * case, not an error.
 */
async function settleSeasonPlacements(
  uid: string,
  settledThrough: unknown,
  now: Date,
  active?: boolean
): Promise<{ earned: string[]; through: string | null }> {
  const seasons = seasonsToSettle({ settledThrough, now, active });
  if (seasons.length === 0) return { earned: [], through: null };

  const economy = SEASON_BADGE_ECONOMY as RankingEconomy;
  const identitySnap = await db
    .collection(PUBLIC_PLAYER_ID_COLLECTION)
    .doc(uid)
    .get();
  const storedId = identitySnap.exists
    ? identitySnap.get("publicPlayerId")
    : null;
  const publicPlayerId = isPublicPlayerId(storedId) ? storedId : null;

  const earned: string[] = [];

  for (const seasonId of seasons) {
    // ── The player board ────────────────────────────────────────────────
    if (publicPlayerId !== null) {
      const entries = db
        .collection(SEASON_RANKINGS_COLLECTION)
        .doc(seasonDocumentId(economy, seasonId))
        .collection(SEASON_ENTRIES_SUBCOLLECTION);
      const entrySnap = await entries.doc(publicPlayerId).get();
      if (entrySnap.exists) {
        const mine = publicEntry(
          1,
          entrySnap.id,
          entrySnap.data() ?? {},
          economy,
          seasonId
        );
        const counts = await Promise.all(
          aheadQueries(entries, {
            scoreCentavos: mine.scoreCentavos,
            winsCount: mine.winsCount,
            documentId: entrySnap.id,
          }).map((query) => query.get())
        );
        const ahead = counts.reduce((sum, c) => sum + c.data().count, 0);
        const badge = badgeForPlacement("player", seasonId, ahead + 1);
        if (badge !== null) earned.push(badge);
      }
    }

    // ── The creator board ───────────────────────────────────────────────
    const creatorEntries = db
      .collection(CREATOR_SEASONS_COLLECTION)
      .doc(seasonDocumentId(economy, seasonId))
      .collection(CREATOR_ENTRIES_SUBCOLLECTION);
    const mineSnap = await creatorEntries.doc(uid).get();
    if (mineSnap.exists) {
      const volume = mineSnap.get(CREATOR_VOLUME_FIELD);
      if (typeof volume === "number" && Number.isFinite(volume)) {
        // Two disjoint counts, the same shape as the player board's three:
        // strictly more volume, or the same volume with a lower document id.
        // The creator's own row is in neither, because both bounds are strict.
        const [more, tied] = await Promise.all([
          creatorEntries.where(CREATOR_VOLUME_FIELD, ">", volume).count().get(),
          creatorEntries
            .where(CREATOR_VOLUME_FIELD, "==", volume)
            .where(FieldPath.documentId(), "<", uid)
            .count()
            .get(),
        ]);
        const ahead = more.data().count + tied.data().count;
        const badge = badgeForPlacement("creator", seasonId, ahead + 1);
        if (badge !== null) earned.push(badge);
      }
    }
  }

  return { earned, through: seasons[seasons.length - 1] };
}

// Wrapped rather than passed directly: the handler's third parameter is a
// test-only clock, and the callable runtime has nothing to put there.
export const getMyBadges = central.https.onCall((data, context) =>
  getMyBadgesHandler(data, context)
);

const ACKNOWLEDGE_BADGES_KEYS = ["badge_ids"] as const;

/**
 * Marks badge celebrations as shown.
 *
 * WHY A SEPARATE CALL, and not a flag on `getMyBadges`. Reading badges must
 * stay safe to repeat — the badges card, the collection screen and the shell
 * all watch it — and folding "I showed this" into the read would mean any
 * screen that merely LOOKED at the badges silently spent the celebration.
 * Clearing is its own act, made by the widget that actually displayed it.
 *
 * THE SERVER DECIDES WHAT THE CLIENT'S CLAIM MEANS. `acknowledgeableIds`
 * intersects what was asked with what is genuinely unseen and genuinely a
 * badge, so a payload cannot write junk into a field the public profile's
 * neighbour reads, nor probe the account by watching what changes.
 *
 * FAILURE LEANS TOWARD CELEBRATING TWICE. If this call never lands, the ids
 * stay unseen and the moment repeats on the next read. That is the right way
 * round: a repeated celebration is a small annoyance, a lost one is the whole
 * feature failing silently.
 */
export const acknowledgeBadgesHandler = async (
  data: any,
  context: any
): Promise<{ acknowledged: string[] }> => {
  try {
    const auth = assertSignedIn(
      context as any,
      "Entre na sua conta para ver seus selos."
    );
    assertExactPayload(data, ACKNOWLEDGE_BADGES_KEYS);

    const requested = Array.isArray(data.badge_ids) ? data.badge_ids : [];

    const userRef = db.collection("users").doc(auth.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new DomainError("not-found", "Sua conta não foi encontrada.");
    }

    const unseen = userSnap.get("badges_unseen");
    const clearing = acknowledgeableIds(
      requested,
      Array.isArray(unseen) ? unseen : []
    );

    // NOTHING TO CLEAR IS A SUCCESS. Two devices acknowledging the same
    // celebration is ordinary, and the second one has legitimately nothing
    // left to do — answering with an error would make the app retry forever.
    if (clearing.length > 0) {
      await userRef.update({
        badges_unseen: FieldValue.arrayRemove(...clearing),
      });
    }

    return { acknowledged: clearing };
  } catch (error) {
    console.error("acknowledgeBadges error:", error);
    throw toHttpsError(error);
  }
};

export const acknowledgeBadges = central.https.onCall(
  acknowledgeBadgesHandler
);

// ═══════════════════════════════════════════════════════════════════════
// RANKING DE CRIADORES
// ═══════════════════════════════════════════════════════════════════════

/** What one accrual attempt reports back, for tests and for logs. */
export type CreatorAccrualOutcome =
  | { readonly accrued: true; readonly economy: string; readonly centavos: number }
  | { readonly accrued: false; readonly reason: string };

/**
 * Accrues a creator's volume when someone pays to enter their tournament.
 *
 * A TRIGGER, NOT A WRITE INSIDE `jointournament`. Joining is a money path with
 * its own transaction, and hanging a leaderboard write off it would make a
 * ranking failure able to fail a paid registration. The ledger row is the
 * event; this reacts to it, retries on its own, and can never cost anybody
 * their spot in a tournament.
 *
 * IT ACCRUES WHILE THE BOARD IS CLOSED. The app does not show this ranking
 * yet, and that is exactly why the trigger ships now: the day it opens it
 * opens with real history rather than from zero.
 *
 * THE ECONOMY IS NEVER GUESSED. The category says cash or beta, the tournament
 * says the same, and a disagreement is refused outright — a row in the wrong
 * board is a lie about real money.
 */
export const onEntryFeeCreatorAccrualHandler = async (
  snapshot: any,
  options: { readonly now?: Date } = {}
): Promise<CreatorAccrualOutcome> => {
  const data = snapshot?.data?.();
  if (!data) return { accrued: false, reason: "no-data" };

  // ── Front door: cheap refusals, before any read ────────────────────────
  const tournamentPath: string | null =
    typeof data.tournament_ref?.path === "string"
      ? data.tournament_ref.path
      : null;
  const tournamentId = tournamentPath?.startsWith("tournaments/")
    ? tournamentPath.slice(12)
    : null;
  if (!tournamentId) return { accrued: false, reason: "no-tournament-ref" };

  const userPath: string | null =
    typeof data.user_ref?.path === "string" ? data.user_ref.path : null;
  const payerUid = userPath?.startsWith("users/") ? userPath.slice(6) : null;

  const tournamentSnap = await db
    .collection("tournaments")
    .doc(tournamentId)
    .get();
  if (!tournamentSnap.exists) {
    return { accrued: false, reason: "tournament-missing" };
  }

  const decision = decideCreatorAccrual({
    category: data.category,
    amount: data.amount,
    creatorUid: tournamentSnap.get("creator_uid"),
    tournamentEconomy: tournamentSnap.get("economy_type"),
    payerUid,
  });

  if (!decision.accrue) {
    return { accrued: false, reason: decision.reason };
  }

  // ── Accepted: from here a failure must propagate so delivery retries ───
  //
  // The nickname and the pseudonym are DENORMALIZED onto the entry so reading
  // the board is one ordered query instead of one lookup per row. They are
  // refreshed on every accrual, so a creator who renames themselves is correct
  // again after their next registration — stale for a while, never wrong
  // forever, and the board never pays for it.
  //
  // The pseudonym is READ, never minted. Creating an immutable identity as a
  // side effect of a stranger joining a tournament would mint on behalf of
  // somebody who did nothing; a creator gets one by opening their own profile,
  // and until then the row simply is not tappable.
  const [creatorSnap, identitySnap] = await Promise.all([
    db.collection("users").doc(decision.creatorUid).get(),
    db.collection(PUBLIC_PLAYER_ID_COLLECTION).doc(decision.creatorUid).get(),
  ]);

  const storedId = identitySnap.exists
    ? identitySnap.get("publicPlayerId")
    : null;

  const row = {
    creator_uid: decision.creatorUid,
    nickname:
      typeof creatorSnap.get("username") === "string"
        ? creatorSnap.get("username")
        : "",
    public_player_id: isPublicPlayerId(storedId) ? storedId : null,
    [CREATOR_VOLUME_FIELD]: FieldValue.increment(decision.centavos),
    entries_count: FieldValue.increment(1),
    updated_at: FieldValue.serverTimestamp(),
  };

  // TWO BOARDS FROM ONE EVENT. The all-time board is what the app shows; the
  // seasonal one is what a placement badge is computed from at month end.
  // Deriving one from the other would mean either summing every season on
  // every read, or never being able to say which month a trophy belongs to.
  const seasonId = seasonIdFromInstant(options.now ?? new Date());

  await Promise.all([
    db
      .collection(CREATOR_RANKINGS_COLLECTION)
      .doc(decision.economy)
      .collection(CREATOR_ENTRIES_SUBCOLLECTION)
      .doc(decision.creatorUid)
      .set(row, { merge: true }),
    db
      .collection(CREATOR_SEASONS_COLLECTION)
      .doc(seasonDocumentId(decision.economy as RankingEconomy, seasonId))
      .collection(CREATOR_ENTRIES_SUBCOLLECTION)
      .doc(decision.creatorUid)
      .set(row, { merge: true }),
  ]);

  return {
    accrued: true,
    economy: decision.economy,
    centavos: decision.centavos,
  };
};

export const onEntryFeeCreatorAccrual = central.firestore
  .document("transactions/{transactionId}")
  // Wrapped rather than passed directly: the handler's second parameter is a
  // test-only clock, and Firestore would hand it an EventContext there.
  .onCreate((snapshot) => onEntryFeeCreatorAccrualHandler(snapshot));

const CREATOR_LEADERBOARD_KEYS = ["economy"] as const;

/**
 * The creator leaderboard, one bounded page, ordered by volume.
 *
 * SIGNED-IN ONLY, like every other read that names people. It publishes a
 * nickname next to a money figure, which is not something an anonymous caller
 * should be able to harvest.
 *
 * THE PAGE IS CAPPED because each row needs the creator's tournament count,
 * and that is an aggregate query per creator. Counting rather than storing a
 * counter is deliberate: a maintained counter drifts the first time a write
 * lands half-way, and a leaderboard that quietly disagrees with the tournament
 * list is worse than one that costs a few more reads.
 *
 * ORDERED BY THE SERVER, always. The client renders what it receives, in the
 * order it arrives, and never sorts or renumbers — the same contract the
 * season leaderboard already has.
 */
export const getCreatorLeaderboardHandler = async (
  data: any,
  context: any
): Promise<{ economy: string; amountUnit: string; rows: CreatorRow[] }> => {
  try {
    assertSignedIn(
      context as any,
      "Entre na sua conta para ver o ranking."
    );
    assertExactPayload(data ?? {}, CREATOR_LEADERBOARD_KEYS);

    const economy = parseRequestedEconomyType(data?.economy);

    const page = await db
      .collection(CREATOR_RANKINGS_COLLECTION)
      .doc(economy)
      .collection(CREATOR_ENTRIES_SUBCOLLECTION)
      .orderBy(CREATOR_VOLUME_FIELD, "desc")
      .limit(CREATOR_LEADERBOARD_PAGE_SIZE)
      .get();

    const counts = await Promise.all(
      page.docs.map((doc) =>
        db
          .collection("tournaments")
          .where("creator_uid", "==", String(doc.get("creator_uid") ?? ""))
          .count()
          .get()
          .then((snap) => snap.data().count)
          // A count that fails is reported as zero rather than failing the
          // whole board: one creator's aggregate should not cost everyone the
          // page they asked for.
          .catch(() => 0)
      )
    );

    const rows = page.docs.map((doc, index) =>
      projectCreatorRow({
        position: index + 1,
        nickname: doc.get("nickname"),
        publicPlayerId: doc.get("public_player_id"),
        volumeCentavos: doc.get(CREATOR_VOLUME_FIELD),
        tournamentsCreated: counts[index],
      })
    );

    return { economy, amountUnit: "centavos", rows };
  } catch (error) {
    console.error("getCreatorLeaderboard error:", error);
    throw toHttpsError(error);
  }
};

export const getCreatorLeaderboard = central.https.onCall(
  getCreatorLeaderboardHandler
);

// ═══════════════════════════════════════════════════════════════════════
// PAINEL DO ADMINISTRADOR
// ═══════════════════════════════════════════════════════════════════════

const ADMIN_OVERVIEW_KEYS = [] as const;

/**
 * Everything that moved, and everyone who arrived.
 *
 * ADMIN ONLY, checked on the server. It reports total platform volume and
 * where every user came from — the single most sensitive read in this backend.
 *
 * EXACT, NOT SAMPLED. Every figure comes from a Firestore aggregate — `count()`
 * and `sum()` — which returns the true total without reading documents. A
 * bounded scan would have been cheaper to write and would have quietly stopped
 * being right the month the data outgrew the cap, on a screen whose entire
 * purpose is to be trusted.
 *
 * THE MONEY FIELD IS PER CATEGORY. Wallet rows carry `amount` in reais; the
 * platform's own rows — house funding, house margin, partner commission —
 * carry `amount_centavos` and no `user_ref`. `CATEGORY_SPECS` decides which,
 * and a category absent from it is skipped LOUDLY via `unknownCategories`
 * rather than silently contributing zero.
 *
 * NO COUNTERS, NO TRIGGERS, NO BACKFILL. A maintained counter drifts the first
 * time a write lands half-way, and a panel that disagrees with the ledger is
 * worse than one that costs a few reads. This is opened by one person,
 * occasionally.
 */
export const getAdminOverviewHandler = async (
  data: any,
  context: any,
  options: { readonly now?: Date } = {}
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context as any,
      "Entre na sua conta.",
      "Apenas administradores podem ver o painel."
    );
    assertExactPayload(data ?? {}, ADMIN_OVERVIEW_KEYS);

    const now = options.now ?? new Date();
    const transactions = db.collection("transactions");
    const users = db.collection("users");

    /** One (window, category) aggregate: how many, and how much. */
    const totalFor = async (
      key: WindowKey,
      category: string
    ): Promise<CategoryTotal | null> => {
      const spec = specFor(category);
      if (spec === null) return null;

      const field = spec.shape === "centavos" ? "amount_centavos" : "amount";
      const start = windowStart(key, now);
      let query: FirebaseFirestore.Query = transactions.where(
        "category",
        "==",
        category
      );
      if (start !== null) {
        query = query.where("timestamp", ">=", Timestamp.fromDate(start));
      }

      const snap = await query
        .aggregate({
          count: AggregateField.count(),
          total: AggregateField.sum(field),
        })
        .get();

      return {
        category,
        label: spec.label,
        economy: spec.economy,
        direction: spec.direction,
        count: snap.data().count,
        centavos: aggregateToCentavos(spec.shape, snap.data().total),
      };
    };

    /** How many accounts were created inside a window. */
    const newUsersIn = async (key: WindowKey): Promise<number> => {
      const start = windowStart(key, now);
      let query: FirebaseFirestore.Query = users;
      if (start !== null) {
        query = query.where("created_at", ">=", Timestamp.fromDate(start));
      }
      const snap = await query.count().get();
      return snap.data().count;
    };

    // ── Every window, in parallel ──────────────────────────────────────
    const windows = await Promise.all(
      WINDOW_KEYS.map(async (key) => {
        const [totals, newUsers] = await Promise.all([
          Promise.all(KNOWN_CATEGORIES.map((c) => totalFor(key, c))),
          newUsersIn(key),
        ]);
        const categories = totals.filter(
          (t): t is CategoryTotal => t !== null && t.count > 0
        );
        return {
          window: key,
          newUsers,
          economies: rollUpByEconomy(categories),
          // O que a plataforma de fato reteve, e o que deve por isso.
          profit: splitProfit(categories),
          categories,
        };
      })
    );

    // ── Where players came from ────────────────────────────────────────
    //
    // ATTRIBUTION IS COUNTED PER PARTNER, from `users.partner_ref` — the field
    // `claimReferral` writes and never rewrites. The unattributed count is
    // derived by subtraction rather than queried, because "no partner_ref"
    // cannot be expressed as a Firestore filter without an index on absence.
    const partnersSnap = await db.collection(PARTNERS_COLLECTION).get();
    const partners = await Promise.all(
      partnersSnap.docs.map(async (doc) => {
        const perWindow = await Promise.all(
          WINDOW_KEYS.map(async (key) => {
            const start = windowStart(key, now);
            let query: FirebaseFirestore.Query = users.where(
              "partner_ref",
              "==",
              doc.id
            );
            if (start !== null) {
              query = query.where("created_at", ">=", Timestamp.fromDate(start));
            }
            const snap = await query.count().get();
            return [key, snap.data().count] as const;
          })
        );
        return {
          partnerId: doc.id,
          active: doc.get("active") === true,
          brought: Object.fromEntries(perWindow),
        };
      })
    );

    const attributedTotal = partners.reduce(
      (sum, p) => sum + ((p.brought as Record<string, number>).all ?? 0),
      0
    );
    const totalUsers =
      windows.find((w) => w.window === "all")?.newUsers ?? 0;

    return {
      amountUnit: "centavos",
      generatedAt: now.toISOString(),
      windows,
      origin: {
        totalUsers,
        attributed: attributedTotal,
        /** Everyone with no partner. Derived, because absence is not filterable. */
        direct: Math.max(0, totalUsers - attributedTotal),
        partners,
      },
    };
  } catch (error) {
    console.error("getAdminOverview error:", error);
    throw toHttpsError(error);
  }
};

export const getAdminOverview = central.https.onCall((data, context) =>
  getAdminOverviewHandler(data, context)
);

// ═══════════════════════════════════════════════════════════════════════
// CAMPEONATO DE VÁRIAS PARTIDAS
// ═══════════════════════════════════════════════════════════════════════

const MATCHES_SUBCOLLECTION = "matches";
const DECLARE_MATCH_KEYS = ["tournamentid", "match_number", "entries"] as const;

/** Reads one caller-supplied match line, or refuses it. */
function normalizeMatchEntries(raw: unknown): MatchResult["entries"] {
  if (!Array.isArray(raw)) {
    throw new DomainError("invalid-argument", "A lista da partida é obrigatória.");
  }
  if (raw.length > MAX_PAYOUT_PLAYERS) {
    throw new DomainError("invalid-argument", "Jogadores demais numa partida.");
  }
  const seen = new Set<string>();
  return raw.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new DomainError("invalid-argument", "Item da partida inválido.");
    }
    const item = row as Record<string, unknown>;
    const extra = Object.keys(item).filter(
      (k) => k !== "uid" && k !== "kills" && k !== "placement"
    );
    if (extra.length > 0) {
      // Same posture as assertExactPayload: an unexpected key is a rejection.
      throw new DomainError("invalid-argument", "Item da partida inválido.");
    }
    const uid = normalizeWinnerUid(item.uid);
    /**
     * ONE LINE PER PLAYER PER MATCH, enforced here rather than in the domain.
     * `computeStandings` deliberately SUMS a repeated uid so an operator can
     * correct a typo across reports; accepting two lines for one player in a
     * SINGLE submission would instead double their kills silently.
     */
    if (seen.has(uid)) {
      throw new DomainError(
        "invalid-argument",
        "O mesmo jogador aparece duas vezes nesta partida."
      );
    }
    seen.add(uid);

    const kills = typeof item.kills === "number" ? item.kills : Number.NaN;
    const placement =
      typeof item.placement === "number" ? item.placement : Number.NaN;
    if (!Number.isInteger(kills) || kills < 0 || kills > 1000) {
      throw new DomainError("invalid-argument", "Abates inválidos.");
    }
    if (!Number.isInteger(placement) || placement < 1 || placement > 1000) {
      throw new DomainError("invalid-argument", "Colocação inválida.");
    }
    return { uid, kills, placement };
  });
}

/**
 * Records the result of ONE match.
 *
 * ONE DOCUMENT PER MATCH, keyed by its number, so re-declaring a match
 * REPLACES it. Getting a match wrong is ordinary — a screenshot misread, a
 * player counted twice — and the fix has to be re-sending that match, not
 * unpicking it from a running total. The standings are computed from these
 * documents at settlement, so a correction before settlement simply lands.
 *
 * IT PAYS NOTHING. Reporting and paying are separate acts: a tournament is
 * reported match by match as it happens, and settled once at the end. Folding
 * them together would mean the last match's report also moved money, and a
 * typo in it could not be corrected.
 *
 * ONLY REGISTERED PLAYERS MAY BE REPORTED — the same invariant the payout path
 * enforces, checked here as well so a stranger never even reaches the
 * standings.
 */
export const declareMatchResultHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context as any,
      "Você precisa estar logado.",
      "Apenas admin pode lançar resultados."
    );
    assertExactPayload(data, DECLARE_MATCH_KEYS);

    const tournamentid = String(data.tournamentid || "").trim();
    if (!tournamentid || tournamentid.includes("/")) {
      throw new DomainError("invalid-argument", "Campeonato inválido.");
    }
    const matchNumber = Number(data.match_number);
    const entries = normalizeMatchEntries(data.entries);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);
    const tournamentSnap = await tournamentRef.get();
    if (!tournamentSnap.exists) {
      throw new DomainError("not-found", "Campeonato não encontrado.");
    }
    const tournamentData = tournamentSnap.data() ?? {};

    const matchesCount = Number(tournamentData.matches_count ?? 1);
    if (
      !Number.isInteger(matchNumber) ||
      matchNumber < 1 ||
      matchNumber > matchesCount
    ) {
      throw new DomainError(
        "invalid-argument",
        `Este campeonato tem ${matchesCount} partida(s).`
      );
    }

    const status = String(tournamentData.status || "").trim().toLowerCase();
    if (status === "completed" || status === "cancelled") {
      throw new DomainError(
        "failed-precondition",
        "Este campeonato já foi encerrado."
      );
    }

    // ONLY WHO PAID IN MAY BE REPORTED. Same rule as the payout path, applied
    // one step earlier so an operator typo is caught while it is still cheap.
    const registrations = await db
      .collection("registrations")
      .where("tournament_ref", "==", tournamentRef)
      .get();
    const eligible = new Set<string>();
    for (const doc of registrations.docs) {
      if (String(doc.get("status") || "") !== "registered") continue;
      const uid = uidFromUserRefPath(documentPath(doc.get("user_ref")));
      if (uid !== null) eligible.add(uid);
    }
    const stranger = entries.find((e) => !eligible.has(e.uid));
    if (stranger !== undefined) {
      throw new DomainError(
        "failed-precondition",
        "Um dos jogadores lançados não está inscrito neste campeonato."
      );
    }

    await tournamentRef
      .collection(MATCHES_SUBCOLLECTION)
      .doc(String(matchNumber))
      .set({
        match_number: matchNumber,
        entries,
        reported_at: FieldValue.serverTimestamp(),
      });

    return {
      success: true,
      match_number: matchNumber,
      players: entries.length,
    };
  } catch (error) {
    console.error("declareMatchResult error:", error);
    throw toHttpsError(error);
  }
};

export const declareMatchResult = central.https.onCall(
  declareMatchResultHandler
);

const SETTLE_BY_POINTS_KEYS = ["tournamentid"] as const;

/**
 * Settles a tournament by its final standings.
 *
 * A SECOND SETTLEMENT PATH, like the per-kill one, and for the same reason: the
 * working handlers pay every tournament that already works, and rewriting them
 * to add a format would put those at risk to serve this one. A tournament with
 * a `prize_distribution` belongs here and nowhere else, and this refuses every
 * other kind.
 *
 * IT FITS IN ONE TRANSACTION, unlike the per-kill path. Placement prizes pay a
 * handful of positions rather than every player who scored, so there is no
 * batching problem to solve — the whole settlement is atomic.
 *
 * THE SAME THREE GUARDS AS EVERY OTHER PAYOUT: only registered players of this
 * economy may be paid, the pool is read from the ledger rather than a stored
 * field, and the treasury may never be left negative.
 */
export const settleTournamentByPointsHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context as any,
      "Você precisa estar logado.",
      "Apenas admin pode encerrar campeonatos."
    );
    assertExactPayload(data, SETTLE_BY_POINTS_KEYS);

    const tournamentid = String(data.tournamentid || "").trim();
    if (!tournamentid || tournamentid.includes("/")) {
      throw new DomainError("invalid-argument", "Campeonato inválido.");
    }
    const tournamentRef = db.collection("tournaments").doc(tournamentid);

    const [matchesSnap, registrationsSnap] = await Promise.all([
      tournamentRef.collection(MATCHES_SUBCOLLECTION).get(),
      db
        .collection("registrations")
        .where("tournament_ref", "==", tournamentRef)
        .get(),
    ]);

    const result = await db.runTransaction(async (transaction) => {
      const tournamentSnap = await transaction.get(tournamentRef);
      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Campeonato não encontrado.");
      }
      const tournamentData = tournamentSnap.data() ?? {};

      const rawDistribution = tournamentData.prize_distribution;
      if (!Array.isArray(rawDistribution) || rawDistribution.length === 0) {
        throw new DomainError(
          "failed-precondition",
          "Este campeonato não tem divisão da premiação por colocação."
        );
      }
      const slices: PrizeSlice[] = rawDistribution.map((raw: any) => ({
        position: Number(raw?.position),
        centavos: Number(raw?.amount_centavos),
      }));
      // A FORMA agora; a SOMA logo abaixo, quando a premiação estiver lida.
      if (!checkPrizeSlices(slices).ok) {
        throw new DomainError(
          "failed-precondition",
          "A divisão da premiação deste campeonato é inválida."
        );
      }

      const status = String(tournamentData.status || "").trim().toLowerCase();
      if (status === "completed") {
        throw new DomainError(
          "failed-precondition",
          "Este campeonato já foi encerrado."
        );
      }
      if (status === "cancelled") {
        throw new DomainError(
          "failed-precondition",
          "Este campeonato foi cancelado."
        );
      }

      const economy = resolveTournamentEconomy(tournamentData as any);
      const prize = inspectReais(tournamentData.prize, {
        allowZero: false,
        maxCentavos: MAX_BALANCE_CENTAVOS,
      });
      if (!prize.ok) {
        throw new DomainError(
          "failed-precondition",
          "A premiação configurada no campeonato é inválida."
        );
      }

      /**
       * A SOMA CONFERIDA DE NOVO, contra a premiação gravada.
       *
       * Isto já foi validado na criação, e nem a premiação nem a divisão mudam
       * depois. Refazer a conta aqui é a rede: um documento escrito por um
       * caminho antigo ou por uma mão fora do produto não vai pagar mais do que
       * o campeonato tem, nem deixar dinheiro parado sem regra de destino. O
       * custo é uma soma de no máximo cinquenta inteiros.
       */
      if (!checkPrizeDistribution(slices, prize.centavos).ok) {
        throw new DomainError(
          "failed-precondition",
          "A divisão da premiação não fecha com a premiação do campeonato."
        );
      }

      // ── The standings, from the matches actually reported ───────────────
      const config: PointsConfig = {
        killPoints: Number(tournamentData.kill_points ?? 0),
        placementPoints: Array.isArray(tournamentData.placement_points)
          ? tournamentData.placement_points.map((p: unknown) => Number(p))
          : [],
      };
      const matches: MatchResult[] = matchesSnap.docs.map((doc) => ({
        matchNumber: Number(doc.get("match_number") ?? 0),
        entries: Array.isArray(doc.get("entries")) ? doc.get("entries") : [],
      }));
      if (matches.length === 0) {
        throw new DomainError(
          "failed-precondition",
          "Nenhuma partida foi lançada neste campeonato."
        );
      }

      const standings = computeStandings(config, matches);

      // ── Only who paid in may be paid out ────────────────────────────────
      const pool = poolFromRegistrations(
        registrationsSnap.docs.map((d) => ({
          status: d.get("status"),
          entryFeeSnapshot: d.get("entry_fee_snapshot"),
          uid: uidFromUserRefPath(documentPath(d.get("user_ref"))),
          economyType: d.get("economy_type"),
          tournamentEntryFee: tournamentData.entry_fee,
        })),
        economy
      );
      if (!pool.ok) {
        throw new DomainError(
          "failed-precondition",
          "As inscrições deste campeonato estão inconsistentes."
        );
      }

      const eligible = standings.filter((s) => pool.eligibleUids.has(s.uid));
      const split = splitPrize(prize.centavos, slices, eligible);

      if (split.awards.length === 0) {
        throw new DomainError(
          "failed-precondition",
          "Nenhum jogador inscrito pontuou neste campeonato."
        );
      }

      // ── The treasury may never be left negative ─────────────────────────
      const houseRef = db
        .collection(HOUSE_COLLECTION)
        .doc(houseDocId(economy));
      const houseSnap = await transaction.get(houseRef);
      const funding = decideHouseFunding({
        poolCentavos: pool.centavos,
        paidCentavos: split.paidCentavos,
        houseCentavos: readHouseBalance(houseSnap),
      });
      if (!funding.ok) {
        throw new DomainError(
          "failed-precondition",
          funding.reason === "house-insolvent"
            ? `O caixa não cobre esta premiação. Faltam ${formatCentavos(
                funding.shortfallCentavos,
                economy
              )}.`
            : "Valores inválidos para liquidar este campeonato."
        );
      }

      // ── Read every wallet before writing any ────────────────────────────
      const wallets = await Promise.all(
        split.awards.map((award) =>
          transaction.get(db.collection("wallets").doc(award.uid))
        )
      );

      const stampedAt = Timestamp.now();
      const isBeta = economy === ECONOMY_BETA_CREDIT;

      split.awards.forEach((award, index) => {
        const walletSnap = wallets[index];
        const walletRef = walletSnap.ref;
        const walletData = walletSnap.data() ?? {};
        const userRef = db.collection("users").doc(award.uid);
        const amountReais = centavosToReais(award.centavos);

        const previous = storedReaisToCentavos(
          (isBeta ? walletData.beta_balance : walletData.balance) ?? 0,
          "saldo da carteira"
        );
        const after = previous + award.centavos;

        transaction.set(
          walletRef,
          isBeta
            ? { beta_balance: centavosToReais(after), user_ref: userRef }
            : {
                balance: centavosToReais(after),
                total_won: centavosToReais(
                  storedReaisToCentavos(walletData.total_won ?? 0, "total ganho") +
                    award.centavos
                ),
                user_ref: userRef,
              },
          { merge: true }
        );

        /**
         * DETERMINISTIC ID, so a retry writes the same row instead of a second
         * payment. `create` then makes a replay fail loudly rather than double
         * paying — the same shape every other settlement here uses.
         */
        transaction.create(
          db.collection("transactions").doc(`points_${tournamentid}_${award.uid}`),
          {
            amount: amountReais,
            category: isBeta ? BETA_PRIZE_CATEGORY : CASH_PRIZE_CATEGORY,
            economy_type: economy,
            user_ref: userRef,
            display_name: `${award.position}º lugar`,
            tournament_ref: tournamentRef,
            position: award.position,
            ...(isBeta
              ? {
                  beta_previous_balance: centavosToReais(previous),
                  beta_balance_after: centavosToReais(after),
                }
              : {
                  previous_balance: centavosToReais(previous),
                  balance_after: centavosToReais(after),
                }),
            timestamp: stampedAt,
            status: "completed",
          }
        );
      });

      transaction.set(
        houseRef,
        {
          [HOUSE_BALANCE_FIELD]: funding.houseAfterCentavos,
          economy_type: economy,
          updated_at: stampedAt,
        },
        { merge: true }
      );

      transaction.create(
        db.collection("transactions").doc(`house_${tournamentid}`),
        {
          amount_centavos: funding.marginCentavos,
          amount_unit: "centavos",
          balance_after_centavos: funding.houseAfterCentavos,
          category: houseMarginCategoryFor(economy),
          economy_type: economy,
          pool_centavos: pool.centavos,
          paid_centavos: split.paidCentavos,
          subsidised: funding.subsidised,
          tournament_ref: tournamentRef,
          timestamp: stampedAt,
          status: "completed",
        }
      );

      transaction.update(tournamentRef, {
        status: "completed",
        result: {
          mode: "points",
          economy_type: economy,
          matches_reported: matches.length,
          /**
           * The whole final table is stored, not just who was paid. It is what
           * a player will be shown, and recomputing it later would depend on a
           * scoring config that may since have been edited.
           */
          standings: standings.slice(0, MAX_PAYOUT_PLAYERS).map((s) => ({
            uid: s.uid,
            points: s.points,
            kills: s.kills,
            matches_played: s.matchesPlayed,
          })),
          awards: split.awards.map((a) => ({
            uid: a.uid,
            position: a.position,
            amount: centavosToReais(a.centavos),
          })),
          unclaimed: centavosToReais(split.unclaimedCentavos),
        },
        updated_at: stampedAt,
      });

      return {
        paidCentavos: split.paidCentavos,
        unclaimedCentavos: split.unclaimedCentavos,
        awards: split.awards.length,
      };
    });

    return {
      success: true,
      paid: centavosToReais(result.paidCentavos),
      unclaimed: centavosToReais(result.unclaimedCentavos),
      awards: result.awards,
      message: "Campeonato encerrado e premiação distribuída.",
    };
  } catch (error) {
    console.error("settleTournamentByPoints error:", error);
    throw toHttpsError(error);
  }
};

export const settleTournamentByPoints = central.https.onCall(
  settleTournamentByPointsHandler
);

/**
 * CONFIGURAÇÕES SALVAS DE PONTUAÇÃO.
 *
 * O PROBLEMA QUE ISTO RESOLVE. Quem organiza a mesma liga toda semana digita a
 * mesma tabela toda semana — partidas, pontos por abate, pontos por colocação e
 * a divisão da premiação. Errar um número não é um erro que o criador vê: é um
 * pagamento que outra pessoa descobre. Uma configuração salva é essa tabela,
 * nomeada e guardada uma vez.
 *
 * NO SERVIDOR, NÃO NO APARELHO. A tabela é trabalho de verdade do criador;
 * limpar o navegador não pode perdê-la, e a mesma conta no celular tem que
 * encontrar as mesmas configurações.
 *
 * O NOME É A IDENTIDADE. O id sai do nome, então salvar "Squad 6 partidas" duas
 * vezes SUBSTITUI em vez de deixar duas linhas iguais para o criador distinguir
 * — que é o que um botão de salvar significa em qualquer outro lugar, e de
 * quebra torna o salvamento idempotente: dois toques não criam duas.
 */
const SCORING_PRESETS_COLLECTION = "scoring_presets";
const SCORING_PRESETS_SUBCOLLECTION = "presets";

/** As configurações de UM dono. Nunca recebe uid vindo do payload. */
function presetsOf(uid: string): CollectionReference {
  return db
    .collection(SCORING_PRESETS_COLLECTION)
    .doc(uid)
    .collection(SCORING_PRESETS_SUBCOLLECTION);
}

/**
 * As recusas que vêm DESTE módulo. As outras — pontuação e divisão — são as
 * mesmas de `createTournament` e usam a mesma frase, de propósito: o operador
 * lê o mesmo texto salvando um preset ou criando um campeonato.
 */
const PRESET_OWN_REASONS: ReadonlySet<string> = new Set([
  "bad-name",
  "name-too-short",
  "name-too-long",
  "name-has-no-letters",
  "bad-preset-id",
  "too-many-presets",
]);

function presetRefusalMessage(reason: string): string {
  return PRESET_OWN_REASONS.has(reason)
    ? presetMessage(reason)
    : pointsConfigMessage(reason);
}

/**
 * A projeção de uma configuração — construída chave por chave.
 *
 * `owner_uid` está guardado no documento e NUNCA sai: a resposta é sempre para
 * o próprio dono, que já sabe quem é, e um campo a mais aqui é um uid a mais
 * circulando por nada.
 */
function projectPreset(
  presetId: string,
  data: Record<string, any>
): Record<string, unknown> {
  const distribution = Array.isArray(data.prize_distribution)
    ? data.prize_distribution.map((slice: any) => ({
        position: Number(slice?.position),
        amount_centavos: Number(slice?.amount_centavos),
      }))
    : null;

  return {
    preset_id: presetId,
    name: String(data.name ?? ""),
    matches_count: Number(data.matches_count ?? 1),
    kill_points: Number(data.kill_points ?? 0),
    placement_points: Array.isArray(data.placement_points)
      ? data.placement_points.map((p: unknown) => Number(p))
      : [],
    prize_distribution: distribution,
  };
}

const SAVE_PRESET_KEYS = [
  "name",
  "matches_count",
  "kill_points",
  "placement_points",
  "prize_distribution",
] as const;

/**
 * Salva uma configuração. Cria ou substitui — o id vem do nome.
 *
 * VALIDA COM AS MESMAS FUNÇÕES DA CRIAÇÃO. Uma configuração que salvasse limpa
 * e depois falhasse ao criar o campeonato seria pior do que não ter
 * configuração nenhuma, então não existe uma segunda regra aqui.
 */
export const saveScoringPresetHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para salvar uma configuração.",
      "Apenas admin pode salvar configurações de campeonato."
    );

    assertExactPayload(data, SAVE_PRESET_KEYS);

    const check = checkPreset({
      name: data.name,
      matchesCount: data.matches_count,
      killPoints: data.kill_points,
      placementPoints: data.placement_points,
      prizeDistribution: data.prize_distribution,
    });
    if (!check.ok) {
      throw new DomainError(
        "invalid-argument",
        presetRefusalMessage(String(check.reason))
      );
    }

    const preset = check.preset;
    const ref = presetsOf(callerAuth.uid).doc(preset.presetId);

    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);

      // O TETO SÓ VALE PARA UMA NOVA. Substituir uma que já existe nunca pode
      // esbarrar no limite — seria impossível corrigir a última configuração
      // salva sem antes apagar outra.
      if (!existing.exists) {
        const current = await tx.get(
          presetsOf(callerAuth.uid).limit(MAX_PRESETS_PER_OWNER + 1)
        );
        if (current.size >= MAX_PRESETS_PER_OWNER) {
          throw new DomainError(
            "failed-precondition",
            presetMessage("too-many-presets")
          );
        }
      }

      const body: Record<string, unknown> = {
        owner_uid: callerAuth.uid,
        name: preset.name,
        matches_count: preset.matchesCount,
        kill_points: preset.killPoints,
        placement_points: [...preset.placementPoints],
        // SEMPRE ESCRITO, inclusive como null. Gravar só quando existe deixaria
        // a divisão anterior colada numa configuração que o criador acabou de
        // mudar para "só o campeão".
        prize_distribution:
          preset.prizeDistribution === null
            ? null
            : preset.prizeDistribution.map((slice) => ({
                position: slice.position,
                amount_centavos: slice.centavos,
              })),
        updated_at: FieldValue.serverTimestamp(),
      };
      if (!existing.exists) body.created_at = FieldValue.serverTimestamp();

      tx.set(ref, body, { merge: true });
    });

    return {
      saved: true,
      preset: projectPreset(preset.presetId, {
        name: preset.name,
        matches_count: preset.matchesCount,
        kill_points: preset.killPoints,
        placement_points: preset.placementPoints,
        prize_distribution:
          preset.prizeDistribution === null
            ? null
            : preset.prizeDistribution.map((slice) => ({
                position: slice.position,
                amount_centavos: slice.centavos,
              })),
      }),
    };
  } catch (error) {
    throw toHttpsError(error);
  }
};

export const saveScoringPreset = central.https.onCall(saveScoringPresetHandler);

/**
 * As configurações do próprio criador.
 *
 * ORDENADAS EM CÓDIGO, não pelo Firestore. A ordenação do banco é por bytes, o
 * que joga "Ápice" depois de "Zebra"; com teto de vinte itens, ordenar aqui com
 * as regras do português custa nada e é o que a pessoa espera ler.
 */
export const listScoringPresetsHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para ver suas configurações.",
      "Apenas admin pode ver configurações de campeonato."
    );

    assertExactPayload(data ?? {}, []);

    const snapshot = await presetsOf(callerAuth.uid)
      .limit(MAX_PRESETS_PER_OWNER)
      .get();

    const presets = snapshot.docs
      .map((doc) => projectPreset(doc.id, doc.data() ?? {}))
      .sort((a, b) =>
        String(a.name).localeCompare(String(b.name), "pt-BR", {
          sensitivity: "base",
        })
      );

    return { presets };
  } catch (error) {
    throw toHttpsError(error);
  }
};

export const listScoringPresets = central.https.onCall(
  listScoringPresetsHandler
);

/**
 * Apaga uma configuração.
 *
 * APAGAR O QUE NÃO EXISTE NÃO É ERRO. Um segundo toque, ou um toque num item
 * que outra aba já apagou, chega aqui e o resultado desejado — a configuração
 * não existe mais — já é verdade. Responder erro faria a tela mostrar uma
 * falha para algo que deu certo.
 */
export const deleteScoringPresetHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para apagar uma configuração.",
      "Apenas admin pode apagar configurações de campeonato."
    );

    assertExactPayload(data, ["preset_id"]);

    const idCheck = checkPresetId(data.preset_id);
    if (!idCheck.ok) {
      throw new DomainError("invalid-argument", presetMessage(idCheck.reason));
    }

    const ref = presetsOf(callerAuth.uid).doc(String(data.preset_id));
    const existing = await ref.get();
    if (existing.exists) await ref.delete();

    return { deleted: existing.exists };
  } catch (error) {
    throw toHttpsError(error);
  }
};

export const deleteScoringPreset = central.https.onCall(
  deleteScoringPresetHandler
);

/**
 * How many of a partner's referred players COUNT.
 *
 * Not a raw signup count: a signup costs nothing, and the partner tiers carry
 * prizes. The filter is the registration being complete and the player having
 * played past the floor — five entry fees, which makes the metric cost exactly
 * the money that forging it is trying to win.
 *
 * Filtered in code rather than in the query because "complete" spans two
 * fields and KYC is not a field yet; the referred set is small enough that
 * reading it is cheaper than the composite index the alternative would need.
 */
async function countQualifiedReferrals(partnerId: string): Promise<number> {
  const referred = await db
    .collection("users")
    .where("partner_ref", "==", partnerId)
    .limit(20_000)
    .get();

  let qualified = 0;
  for (const doc of referred.docs) {
    const complete = isRegistrationComplete({
      nickname: doc.get("username"),
      // KYC does not exist in this backend yet. Passing the stored flag means
      // the day it lands this line starts telling the truth without any other
      // change — and until then it reads false, so no tier is awarded on an
      // unverified account.
      kycVerified: doc.get("kyc_verified") === true,
    });
    if (
      referredPlayerCounts({
        tournamentsPlayed: readPlayedCount(doc.get("tournaments_played")),
        registrationComplete: complete,
      })
    ) {
      qualified += 1;
    }
  }
  return qualified;
}

/** A stored play count, or zero. Absent means an account that predates the
 * counter, which has genuinely not been counted — never a reason to throw on
 * a read-only screen. */
function readPlayedCount(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

const PUBLIC_PROFILE_KEYS = ["public_player_id"] as const;

/**
 * A player's public profile, by pseudonym.
 *
 * OPEN TO ANY SIGNED-IN PLAYER, which is the whole point: a profile is a page
 * you send to someone else. Signed-in rather than fully public because an
 * unauthenticated endpoint over a 22-character id is a scraping surface, and
 * requiring an account puts a name on whoever walks the space.
 *
 * THE PSEUDONYM IS THE ADDRESS. The caller never sends a uid and never
 * receives one — `public_player_id_index` resolves the pseudonym server-side,
 * through the Admin SDK, and the uid stays inside this function.
 *
 * THE PROJECTION IS AN ALLOWLIST, built key by key in `projectPublicProfile`.
 * A field added to `users/{uid}` next month is invisible here until somebody
 * deliberately adds it, which is the only version of this that stays safe.
 */
export const getPublicProfileHandler = async (
  data: any,
  context: any
): Promise<PublicProfile> => {
  try {
    assertSignedIn(
      context as any,
      "Entre na sua conta para ver perfis."
    );
    assertExactPayload(data, PUBLIC_PROFILE_KEYS);

    const publicPlayerId = String(data.public_player_id ?? "").trim();
    if (!isPublicPlayerId(publicPlayerId)) {
      throw new DomainError("invalid-argument", "Perfil inválido.");
    }

    const indexSnap = await db
      .collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION)
      .doc(publicPlayerId)
      .get();
    if (!indexSnap.exists) {
      throw new DomainError("not-found", "Perfil não encontrado.");
    }
    const uid = String(indexSnap.get("uid") ?? "");
    if (!uid) {
      throw new DomainError("not-found", "Perfil não encontrado.");
    }

    return await loadPublicProfile(uid, publicPlayerId);
  } catch (error) {
    console.error("getPublicProfile error:", error);
    throw toHttpsError(error);
  }
};

export const getPublicProfile = central.https.onCall(getPublicProfileHandler);

/**
 * Reads one account and projects it. The ONE place a profile is built, so the
 * owner's preview and a stranger's view can never diverge.
 *
 * WHY THAT MATTERS MORE THAN THE DUPLICATION IT SAVES. `getMyProfile` exists so
 * a player can see what they are about to share. If it built its own answer,
 * the preview would be a SECOND opinion about what is public — and the day the
 * two drift, the app shows the owner one thing and hands strangers another.
 * Sharing the loader makes the preview true by construction.
 */
async function loadPublicProfile(
  uid: string,
  publicPlayerId: string
): Promise<PublicProfile> {
  const [userSnap, createdSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("tournaments").where("creator_uid", "==", uid).count().get(),
  ]);
  if (!userSnap.exists) {
    throw new DomainError("not-found", "Perfil não encontrado.");
  }
  const userData = userSnap.data() ?? {};

  return projectPublicProfile({
    publicPlayerId,
    username: userData.username,
    badges: userData.badges,
    tournamentsPlayed: userData.tournaments_played,
    tournamentsCreated: createdSnap.data().count,
    createdAt: userData.created_at ?? userData.createdAt,
  });
}

/**
 * The caller's OWN profile — and the pseudonym that addresses it.
 *
 * WHY THIS EXISTS AT ALL. Sharing a profile requires knowing your own
 * `publicPlayerId`, and until now nothing told a player theirs: the pseudonym
 * was minted by prize settlement and surfaced only to someone already on a
 * leaderboard. So a player who had never won had no address, and no link.
 *
 * THIS IS THEREFORE THE SECOND PLACE AN IDENTITY IS MINTED, deliberately.
 * `ensurePublicPlayerIdHandler` is create-only and idempotent, so minting here
 * cannot overwrite or reassign anything — and the leaderboard is unaffected,
 * because being RANKED depends on having a season ENTRY, which only settlement
 * writes. An identity with no entry reads as unranked, exactly as before.
 *
 * IT RETURNS THE PUBLIC PROJECTION, not the private account. What the owner
 * sees here is byte-for-byte what a stranger sees, because it is the same
 * loader — which is the point: this is a preview of the thing being shared.
 */
export const getMyProfileHandler = async (
  data: any,
  context: any
): Promise<PublicProfile> => {
  try {
    const auth = assertSignedIn(
      context as any,
      "Entre na sua conta para ver seu perfil."
    );
    assertExactPayload(data ?? {}, []);

    // EXISTÊNCIA ANTES DA CUNHAGEM. Uma identidade é create-only e nunca
    // liberada, então cunhar uma para uma conta que não existe deixa um par de
    // documentos órfãos que nada pode limpar depois. A ordem custa uma leitura
    // e é a única que não escreve algo permanente por engano.
    const userSnap = await db.collection("users").doc(auth.uid).get();
    if (!userSnap.exists) {
      throw new DomainError("not-found", "Sua conta não foi encontrada.");
    }

    const { publicPlayerId } = await ensurePublicPlayerIdHandler(auth.uid);

    return await loadPublicProfile(auth.uid, publicPlayerId);
  } catch (error) {
    console.error("getMyProfile error:", error);
    throw toHttpsError(error);
  }
};

export const getMyProfile = central.https.onCall(getMyProfileHandler);

const SET_NICKNAME_KEYS = ["nickname"] as const;

export const setNicknameHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const auth = assertSignedIn(
      context as any,
      "Entre na sua conta para escolher seu nick."
    );
    assertExactPayload(data, SET_NICKNAME_KEYS);

    const { display, normalized } = parseNickname(data.nickname);

    const userRef = db.collection("users").doc(auth.uid);
    const reservationRef = db
      .collection(NICKNAMES_COLLECTION)
      .doc(normalized);

    await db.runTransaction(async (transaction) => {
      const [userSnap, reservationSnap] = await Promise.all([
        transaction.get(userRef),
        transaction.get(reservationRef),
      ]);

      if (!userSnap.exists) {
        throw new DomainError("not-found", "Sua conta não foi encontrada.");
      }

      const previous = String(userSnap.get("username_normalized") ?? "");

      if (reservationSnap.exists) {
        // Already ours: setting the same nick again is a no-op success, not an
        // error — a retried request must not tell the player their own name is
        // taken.
        if (reservationSnap.get("uid") === auth.uid) {
          transaction.update(userRef, { username: display });
          return;
        }
        throw new DomainError(
          "already-exists",
          "Este nick já está em uso."
        );
      }

      transaction.create(reservationRef, {
        uid: auth.uid,
        display,
        created_at: FieldValue.serverTimestamp(),
      });

      if (previous !== "" && previous !== normalized) {
        transaction.delete(
          db.collection(NICKNAMES_COLLECTION).doc(previous)
        );
      }

      transaction.update(userRef, {
        username: display,
        username_normalized: normalized,
        username_set_at: FieldValue.serverTimestamp(),
      });
    });

    return { success: true, nickname: display };
  } catch (error) {
    console.error("setNickname error:", error);
    throw toHttpsError(error);
  }
};

export const setNickname = central.https.onCall(setNicknameHandler);

const APPLY_PARTNER_KEYS = [
  "platform",
  "handle",
  "followers",
  "average_views",
  "expected_players",
  "proposed_code",
] as const;

/**
 * Applies to become a partner.
 *
 * ANY SIGNED-IN PLAYER, and the identity comes from the token — there is no
 * uid in the payload, so an application can only ever be about the person
 * sending it. That is also what fixes the flow it replaces: registering a
 * partner meant an admin typing a Firebase UID nobody knows about themselves.
 *
 * ONE DOCUMENT PER ACCOUNT, keyed by uid. Resubmitting updates the same
 * application instead of queueing duplicates, and an admin's list never shows
 * the same person twice. A DECIDED application is not reopened from here.
 *
 * THIS WRITES NO MONEY AND GRANTS NOTHING. It records a request; only
 * `reviewPartnerApplication` can turn one into a partner.
 */
export const applyForPartnerHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const auth = assertSignedIn(
      context as any,
      "Entre na sua conta para se candidatar."
    );
    assertExactPayload(data, APPLY_PARTNER_KEYS);

    const application = parsePartnerApplication({
      platform: data.platform,
      handle: data.handle,
      followers: data.followers,
      averageViews: data.average_views,
      expectedPlayers: data.expected_players,
      proposedCode: data.proposed_code,
    });

    const ref = db.collection(PARTNER_APPLICATIONS_COLLECTION).doc(auth.uid);

    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.exists
        ? ((snap.get("status") as ApplicationStatus) ?? null)
        : null;

      if (!canApplicantSubmit(current)) {
        throw new DomainError(
          "failed-precondition",
          submitRefusalMessage(current as ApplicationStatus)
        );
      }

      const stampedAt = FieldValue.serverTimestamp();
      transaction.set(
        ref,
        {
          uid: auth.uid,
          platform: application.platform,
          handle: application.handle,
          followers: application.followers,
          average_views: application.averageViews,
          expected_players: application.expectedPlayers,
          proposed_code: application.proposedCode,
          status: "pending",
          submitted_at: stampedAt,
          updated_at: stampedAt,
        },
        { merge: true }
      );
    });

    return { success: true, status: "pending" };
  } catch (error) {
    console.error("applyForPartner error:", error);
    throw toHttpsError(error);
  }
};

export const applyForPartner = central.https.onCall(applyForPartnerHandler);

const REVIEW_APPLICATION_KEYS = ["uid", "approve"] as const;

/**
 * ADMIN-ONLY: decides one application.
 *
 * APPROVING CREATES THE PARTNER, using the code the applicant asked for. The
 * uniqueness of that code is enforced by the same `referral_codes` reservation
 * that `createPartner` uses — two applicants wanting "gamer" cannot both get
 * it, and the second approval fails loudly instead of silently overwriting the
 * first partner's link.
 *
 * REJECTING KEEPS THE APPLICATION, marked. Deleting it would let the same
 * person reapply immediately and would erase why the decision was made.
 */
export const reviewPartnerApplicationHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para avaliar candidaturas.",
      "Apenas admin pode avaliar candidaturas."
    );
    assertExactPayload(data, REVIEW_APPLICATION_KEYS);

    const uid = String(data.uid ?? "").trim();
    if (!uid) {
      throw new DomainError("invalid-argument", "Informe a candidatura.");
    }
    if (typeof data.approve !== "boolean") {
      throw new DomainError(
        "invalid-argument",
        "A decisão precisa ser verdadeira ou falsa."
      );
    }
    const approve = data.approve;

    const applicationRef = db
      .collection(PARTNER_APPLICATIONS_COLLECTION)
      .doc(uid);
    const snap = await applicationRef.get();
    if (!snap.exists) {
      throw new DomainError("not-found", "Candidatura não encontrada.");
    }
    const current = snap.get("status") as ApplicationStatus;
    if (current !== "pending") {
      throw new DomainError(
        "failed-precondition",
        "Esta candidatura já foi avaliada."
      );
    }

    if (!approve) {
      await applicationRef.update({
        status: "rejected",
        reviewed_at: FieldValue.serverTimestamp(),
        reviewed_by: callerAuth.uid,
      });
      return { success: true, status: "rejected" };
    }

    // Reuses the registration path wholesale, so a partner born from an
    // application is byte-identical to one an admin typed in — including the
    // referral-code uniqueness guard.
    const created = await createPartnerHandler(
      {
        name: String(snap.get("handle") ?? "").trim() || uid,
        code: String(snap.get("proposed_code") ?? "").trim(),
        ownerUid: uid,
      },
      context
    );

    await applicationRef.update({
      status: "approved",
      reviewed_at: FieldValue.serverTimestamp(),
      reviewed_by: callerAuth.uid,
    });

    return { success: true, status: "approved", partner: created };
  } catch (error) {
    console.error("reviewPartnerApplication error:", error);
    throw toHttpsError(error);
  }
};

export const reviewPartnerApplication = central.https.onCall(
  reviewPartnerApplicationHandler
);

/** The exact payload of `setPartnerActive`. */
const SET_PARTNER_ACTIVE_KEYS = ["partner_id", "active"] as const;

/**
 * ADMIN-ONLY: turns a partner on or off.
 *
 * WHY THIS HAD TO EXIST. `active` was read in three places — `claimReferral`
 * refuses an inactive partner, the accrual trigger skips one, the earnings
 * screen reports it — and written in exactly one: `createPartner`, always as
 * true. So a partner, once created, could never be switched off. A referral
 * code being abused had no lever at all, in a feature that moves money.
 *
 * REVERSIBLE ON PURPOSE, and not a delete. Deactivating stops NEW attributions
 * and NEW accruals; it does not rewrite what a partner already earned, because
 * that is a settled fact and erasing it would be worse than leaving it. A
 * partner turned off by mistake is turned back on with the same call.
 *
 * The change is stamped with WHO made it. An `active` flag that flips with no
 * trace is a flag nobody can defend later.
 */
export const setPartnerActiveHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para alterar um parceiro.",
      "Apenas admin pode alterar um parceiro."
    );
    assertExactPayload(data, SET_PARTNER_ACTIVE_KEYS);

    const partnerId = String(data.partner_id ?? "").trim();
    if (!partnerId) {
      throw new DomainError("invalid-argument", "Informe o parceiro.");
    }
    // Strict boolean: the string "false" is truthy in JavaScript, and reading
    // it as "activate" would be the exact opposite of what was asked.
    if (typeof data.active !== "boolean") {
      throw new DomainError(
        "invalid-argument",
        "O estado do parceiro precisa ser verdadeiro ou falso."
      );
    }
    const active = data.active;

    const partnerRef = db.collection(PARTNERS_COLLECTION).doc(partnerId);

    const outcome = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(partnerRef);
      if (!snap.exists) {
        throw new DomainError("not-found", "Parceiro não encontrado.");
      }
      const before = snap.get("active") === true;
      if (before === active) {
        // Already in the requested state: success with NO write, so a repeated
        // tap does not churn the timestamp or the audit trail.
        return { changed: false, active };
      }

      transaction.update(partnerRef, {
        active,
        active_changed_at: FieldValue.serverTimestamp(),
        active_changed_by: callerAuth.uid,
      });
      return { changed: true, active };
    });

    return { success: true, ...outcome };
  } catch (error) {
    console.error("setPartnerActive error:", error);
    throw toHttpsError(error);
  }
};

export const setPartnerActive = central.https.onCall(setPartnerActiveHandler);

/** The exact payload of `getPartnerEarnings`. */
const PARTNER_EARNINGS_KEYS = ["limit"] as const;

/**
 * The caller's own partner earnings.
 *
 * THE CALLER IS THE TOKEN. There is no partner id in the payload — a partner
 * can only ever ask about themselves — and the link is `partners.owner_uid`,
 * written by an administrator at registration. A player who owns no partner
 * gets `failed-precondition`, never someone else's numbers.
 *
 * NO PLAYER IS IDENTIFIABLE IN THE RESPONSE. The projection is built key by key
 * and carries amounts and timestamps only. `attributedPlayers` is a COUNT, not
 * a list — a partner learns how many people they brought, never who.
 */
export const getPartnerEarningsHandler = async (
  data: unknown,
  context: unknown
): Promise<PartnerEarningsView> => {
  const auth = assertSignedIn(
    context as any,
    "Entre na sua conta de parceiro."
  );
  // `data ?? {}`, like every other optional-payload read callable here. Its
  // only key has a default, so `httpsCallable(...).call()` with no argument is
  // a legitimate request — and the SDK sends `data: null` for it, which
  // assertExactPayload rejects outright. Requiring an empty object to ask for
  // the default page is a contract nobody would guess.
  assertExactPayload(data ?? {}, PARTNER_EARNINGS_KEYS);
  const limit = normalizeRecentLimit((data as { limit?: unknown })?.limit);

  const owned = await db
    .collection(PARTNERS_COLLECTION)
    .where("owner_uid", "==", auth.uid)
    .limit(1)
    .get();

  if (owned.empty) {
    throw new DomainError(
      "failed-precondition",
      "Esta conta não está vinculada a um parceiro."
    );
  }

  const partner = owned.docs[0];
  const partnerId = partner.id;

  // The earning count is a SEPARATE query with an expiry bound. Counting only
  // by partner_ref would report players whose window closed as if they were
  // still producing commission.
  const now = Timestamp.now();

  const [countSnap, earningSnap, recentSnap] = await Promise.all([
    db.collection("users").where("partner_ref", "==", partnerId).count().get(),
    db
      .collection("users")
      .where("partner_ref", "==", partnerId)
      .where("attribution_expires_at", ">", now)
      .count()
      .get(),
    db
      .collection("transactions")
      .where("partner_ref", "==", partnerId)
      .where("category", "==", COMMISSION_ACCRUED_CATEGORY)
      .orderBy("created_at", "desc")
      .limit(limit)
      .get(),
  ]);

  const recent: PartnerAccrualView[] = [];
  for (const doc of recentSnap.docs) {
    const createdAt = doc.get("created_at");
    const iso =
      createdAt && typeof createdAt.toDate === "function"
        ? (createdAt.toDate() as Date).toISOString()
        : null;
    const view = projectPartnerAccrual(doc.data(), iso);
    if (view) recent.push(view);
  }

  const total = partner.get(PARTNER_TOTAL_FIELD);

  return {
    name: typeof partner.get("name") === "string" ? partner.get("name") : "",
    code: typeof partner.get("code") === "string" ? partner.get("code") : "",
    active: partner.get("active") === true,
    totalAccruedCentavos:
      typeof total === "number" && Number.isInteger(total) && total >= 0
        ? total
        : 0,
    attributedPlayers: countSnap.data().count,
    earningPlayers: earningSnap.data().count,
    // Stated by the backend, not assumed by the screen: there is no payout rail
    // in this codebase, for partners or for players.
    payoutAvailable: false,
    amountUnit: "centavos",
    recent,
  };
};

export const getPartnerEarnings = central.https.onCall(
  async (data, context) => {
    try {
      return await getPartnerEarningsHandler(data, context);
    } catch (error) {
      throw toHttpsError(error);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Per-kill settlement
//
// A SEPARATE callable, not a rewrite of declareTournamentResult. That handler
// is ~300 lines with two economy branches and per-economy replay logic, and it
// pays every tournament that already works. Rewriting it to add a format would
// put the working ones at risk to serve the new one; a second path puts the
// risk entirely on the new format. The tournament decides which applies, and
// each handler refuses the other's tournaments, so there is never a choice.
// ─────────────────────────────────────────────────────────────────────────────

const DECLARE_WITH_KILLS_KEYS = ["tournamentid", "winneruid", "kills"] as const;

/**
 * The uid inside a `users/{uid}` reference path, or null when the path is not
 * one. Null never becomes an eligible payee, so a registration whose
 * `user_ref` is missing or malformed entitles nobody — it fails closed.
 */
function uidFromUserRefPath(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== "users") return null;
  const uid = parts[1].trim();
  return uid === "" ? null : uid;
}

/**
 * The treasury balance a house document holds, in integer centavos.
 *
 * An ABSENT document means an empty treasury, which is the correct reading for
 * a platform that has never settled anything — and it means the house funds no
 * subsidy until it has earned one. A PRESENT but unusable value is NOT read as
 * zero: treating corruption as "empty" would silently forbid every guaranteed
 * prize, which looks like a policy decision rather than the data fault it is.
 */
function readHouseBalance(snap: any): number {
  if (!snap?.exists) return 0;
  const raw = (snap.data() ?? {})[HOUSE_BALANCE_FIELD];
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new DomainError(
      "failed-precondition",
      "O caixa da plataforma está com valor inválido. Contate o suporte."
    );
  }
  return raw;
}

/** An amount in the operator's own words, for a refusal message. */
function formatCentavos(centavos: number, economy: string): string {
  const value = (centavos / 100).toFixed(2).replace(".", ",");
  return economy === ECONOMY_BETA_CREDIT
    ? `${value} Créditos Beta`
    : `R$ ${value}`;
}

/** Reads a caller-supplied kill list into the domain shape, or refuses. */
function normalizeKillReports(raw: unknown): KillReport[] {
  if (!Array.isArray(raw)) {
    throw new DomainError(
      "invalid-argument",
      "A lista de abates é obrigatória."
    );
  }
  return raw.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new DomainError("invalid-argument", "Item de abate inválido.");
    }
    const item = row as Record<string, unknown>;
    const extra = Object.keys(item).filter(
      (k) => k !== "uid" && k !== "kills"
    );
    if (extra.length > 0) {
      // Same posture as assertExactPayload: an unexpected key is a rejection,
      // never something the server quietly ignores.
      throw new DomainError("invalid-argument", "Item de abate inválido.");
    }
    return {
      uid: normalizeWinnerUid(item.uid),
      kills: typeof item.kills === "number" ? item.kills : Number.NaN,
    };
  });
}

/**
 * Settles a tournament that pays per kill.
 *
 * NOTHING MOVES UNLESS EVERYTHING FITS. The payout total is compared against
 * what the registrations actually collected, and a total above the pool refuses
 * the whole declaration — no player is paid, the tournament stays in progress,
 * and the operator sees the refusal immediately. That is almost always a typo.
 *
 * ONE ROW PER PLAYER, CREATED NOT SET. Each payout writes
 * `transactions/prize_{tid}_{uid}` with `create`, so a retry after a partial
 * failure cannot pay anybody twice: the rows already written make the retry
 * fail before it can duplicate a credit. The single-winner path uses `set` on a
 * shared id, which would silently erase an earlier payment.
 */
export const declareTournamentResultWithKillsHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    assertAdmin(
      context,
      "Você precisa estar logado para declarar o resultado.",
      "Apenas admin pode declarar o resultado."
    );
    assertExactPayload(data, DECLARE_WITH_KILLS_KEYS);

    const tournamentid = normalizeTournamentId(data.tournamentid);
    const winneruid = normalizeWinnerUid(data.winneruid);
    const reports = normalizeKillReports(data.kills);

    const tournamentRef = db.collection("tournaments").doc(tournamentid);

    await db.runTransaction(async (transaction) => {
      // ── Every read first: Firestore requires it, and it also means the
      // decision below sees one consistent snapshot.
      const tournamentSnap = await transaction.get(tournamentRef);
      if (!tournamentSnap.exists) {
        throw new DomainError("not-found", "Torneio não encontrado.");
      }
      const tournamentData = tournamentSnap.data() ?? {};

      if (!hasKillPrize(tournamentData)) {
        throw new DomainError(
          "failed-precondition",
          "Este torneio não paga por abate. Use a declaração de resultado comum."
        );
      }

      const economy = resolveTournamentEconomy(tournamentData);
      const isBeta = economy === ECONOMY_BETA_CREDIT;

      const status = String(tournamentData.status || "")
        .trim()
        .toLowerCase();
      const resultExists =
        tournamentData.result !== undefined && tournamentData.result !== null;

      const registrationsSnap = await transaction.get(
        db
          .collection("registrations")
          .where("tournament_ref", "==", tournamentRef)
      );

      // The uid comes from the registration's OWN `user_ref`, never from the
      // caller's payload — the caller is the party whose typo we are guarding
      // against, so its list cannot also be the thing that authorizes payment.
      const pool = poolFromRegistrations(
        registrationsSnap.docs.map((d) => ({
          status: d.get("status"),
          entryFeeSnapshot: d.get("entry_fee_snapshot"),
          uid: uidFromUserRefPath(documentPath(d.get("user_ref"))),
          economyType: d.get("economy_type"),
          tournamentEntryFee: tournamentData.entry_fee,
        })),
        economy
      );
      if (!pool.ok) {
        throw new DomainError(
          "failed-precondition",
          "Não foi possível apurar o total arrecadado deste torneio."
        );
      }

      const placement = inspectReais(tournamentData.prize ?? 0, {
        allowZero: true,
        maxCentavos: MAX_BALANCE_CENTAVOS,
      });
      const killPrize = inspectReais(tournamentData.kill_prize, {
        allowZero: false,
        maxCentavos: MAX_BALANCE_CENTAVOS,
      });
      if (!placement.ok || !killPrize.ok) {
        throw new DomainError(
          "failed-precondition",
          "A premiação configurada no torneio é inválida."
        );
      }

      const decision = decidePayouts({
        winnerUid: winneruid,
        placementCentavos: placement.centavos,
        killPrizeCentavos: killPrize.centavos,
        reports,
        poolCentavos: pool.centavos,
        eligibleUids: pool.eligibleUids,
      });
      assertPayoutDecision(decision);
      if (!decision.ok) return; // unreachable; narrows for TypeScript

      // ── Idempotent replay ──────────────────────────────────────────────
      if (status === "completed") {
        const stored = resultExists
          ? (tournamentData.result as Record<string, unknown>)
          : null;
        const rows = Array.isArray(stored?.payouts)
          ? (stored?.payouts as PersistedPayout[])
          : [];
        const matches = payoutsMatchPersisted(rows, decision.payouts, (r) => {
          const seen = inspectReais(r, {
            allowZero: true,
            maxCentavos: MAX_BALANCE_CENTAVOS,
          });
          return seen.ok ? seen.centavos : null;
        });
        if (!matches) {
          throw new DomainError(
            "failed-precondition",
            "O resultado já declarado diverge do informado agora."
          );
        }
        return; // identical replay: nothing is rewritten, no timestamp moves
      }

      if (status !== "in_progress") {
        throw new DomainError(
          "failed-precondition",
          "O torneio precisa estar em andamento para declarar o resultado."
        );
      }
      if (resultExists) {
        throw new DomainError(
          "failed-precondition",
          "Estado de liquidação inconsistente para este torneio."
        );
      }

      // ── SOLVENCY. The tournament may pay more than it collected; the
      // PLATFORM may not pay more than it has. Read and decided before any
      // wallet is touched, so an unaffordable prize refuses whole.
      const houseRef = db
        .collection(HOUSE_COLLECTION)
        .doc(houseDocId(economy));
      const houseSnap = await transaction.get(houseRef);
      const houseBefore = readHouseBalance(houseSnap);

      const funding = decideHouseFunding({
        poolCentavos: pool.centavos,
        paidCentavos: decision.totalCentavos,
        houseCentavos: houseBefore,
      });
      if (!funding.ok) {
        throw new DomainError(
          "failed-precondition",
          houseFundingMessage(funding, (c) => formatCentavos(c, economy))
        );
      }

      // Wallets are read BEFORE any write, in payout order.
      const walletRefs = decision.payouts.map((p) =>
        db.collection("wallets").doc(p.uid)
      );
      const walletSnaps = await Promise.all(
        walletRefs.map((ref) => transaction.get(ref))
      );

      const stampedAt = FieldValue.serverTimestamp();
      const persisted: Record<string, unknown>[] = [];

      decision.payouts.forEach((payout, i) => {
        const walletSnap = walletSnaps[i];
        if (!walletSnap.exists) {
          throw new DomainError(
            "failed-precondition",
            "Carteira de um dos premiados não foi encontrada."
          );
        }
        const walletData = walletSnap.data() ?? {};
        const userRef = db.collection("users").doc(payout.uid);
        const txRef = db
          .collection("transactions")
          .doc(payoutTransactionId(tournamentid, payout.uid));
        const amountReais = centavosToReais(payout.totalCentavos);

        if (isBeta) {
          const previousBeta = storedReaisToCentavos(
            walletData.beta_balance ?? 0,
            "saldo beta"
          );
          const betaAfter = credit(previousBeta, payout.totalCentavos);

          transaction.update(walletRefs[i], {
            beta_balance: centavosToReais(betaAfter),
          });
          // create(), never set(): a retry after a partial failure must fail
          // here rather than credit the same player a second time.
          transaction.create(txRef, {
            amount: amountReais,
            category: killPrizeCategoryFor(economy),
            economy_type: ECONOMY_BETA_CREDIT,
            user_ref: userRef,
            display_name: "",
            tournament_ref: tournamentRef,
            beta_previous_balance: centavosToReais(previousBeta),
            beta_balance_after: centavosToReais(betaAfter),
            kills: payout.kills,
            timestamp: stampedAt,
            status: "completed",
            external_id: payoutTransactionId(tournamentid, payout.uid),
          });
        } else {
          const previousBalance = storedReaisToCentavos(
            walletData.balance ?? 0,
            "saldo da carteira"
          );
          const previousTotalWon = storedReaisToCentavos(
            walletData.total_won ?? 0,
            "total ganho"
          );
          const balanceAfter = credit(previousBalance, payout.totalCentavos);
          const totalWonAfter = addCentavos(
            previousTotalWon,
            payout.totalCentavos
          );

          transaction.update(walletRefs[i], {
            balance: centavosToReais(balanceAfter),
            total_won: centavosToReais(totalWonAfter),
            updated_at: stampedAt,
          });
          transaction.create(txRef, {
            amount: amountReais,
            category: killPrizeCategoryFor(economy),
            user_ref: userRef,
            display_name: "",
            tournament_ref: tournamentRef,
            previous_balance: centavosToReais(previousBalance),
            balance_after: centavosToReais(balanceAfter),
            kills: payout.kills,
            timestamp: stampedAt,
            status: "completed",
            external_id: payoutTransactionId(tournamentid, payout.uid),
          });
        }

        persisted.push({
          uid: payout.uid,
          user_ref: userRef,
          kills: payout.kills,
          kill_amount: centavosToReais(payout.killCentavos),
          placement_amount: centavosToReais(payout.placementCentavos),
          amount: amountReais,
          transaction_ref: txRef,
        });
      });

      // ── The treasury moves by exactly what this tournament kept or spent.
      // `set` with merge, because the very first settlement of an economy is
      // what brings its house document into existence.
      transaction.set(
        houseRef,
        {
          [HOUSE_BALANCE_FIELD]: funding.houseAfterCentavos,
          economy_type: economy,
          updated_at: stampedAt,
        },
        { merge: true }
      );

      // An audit row for every treasury movement, including the zero ones: a
      // settlement that kept nothing is a fact worth being able to prove, and
      // a gap in the sequence would otherwise be indistinguishable from a
      // settlement that never wrote here at all.
      transaction.create(
        db.collection("transactions").doc(`house_${tournamentid}`),
        {
          amount_centavos: funding.marginCentavos,
          amount_unit: "centavos",
          balance_after_centavos: funding.houseAfterCentavos,
          category: houseMarginCategoryFor(economy),
          economy_type: economy,
          pool_centavos: pool.centavos,
          paid_centavos: decision.totalCentavos,
          subsidised: funding.subsidised,
          tournament_ref: tournamentRef,
          // NO user_ref, on purpose: this is the platform's row, not a
          // player's, and the wallet reconciler only reads rows that carry one.
          timestamp: stampedAt,
          status: "completed",
        }
      );

      transaction.update(tournamentRef, {
        status: "completed",
        result: {
          mode: "per_kill",
          winner_uid: winneruid,
          winner_ref: db.collection("users").doc(winneruid),
          economy_type: economy,
          kill_prize: centavosToReais(killPrize.centavos),
          placement_prize: centavosToReais(placement.centavos),
          /**
           * WHAT THE WINNER RECEIVED — written for the clients that predate
           * per-kill results.
           *
           * The published app reads `result.prize` and knows nothing of
           * `payouts`. Omitting the key made `moneyFromReais(undefined)`
           * return zero, so the gold winner panel told the actual winner
           * "VOCÊ VENCEU — PRÊMIO R$ 0,00" while their wallet had really been
           * credited. Telling someone they won nothing is worse than telling
           * them nothing.
           *
           * The value is the winner's own total, not `total_paid`: `prize` has
           * meant "what this player got" everywhere it has ever been read, and
           * writing the distributed sum here would show one player as having
           * taken the whole pool. Newer clients branch on `mode` first and
           * never reach this key, so it is corrective for old builds and inert
           * for new ones.
           */
          prize: centavosToReais(
            decision.payouts.find((p) => p.uid === winneruid)?.totalCentavos ??
              0
          ),
          pool: centavosToReais(decision.poolCentavos),
          total_paid: centavosToReais(decision.totalCentavos),
          payouts: persisted,
          declared_at: stampedAt,
          paid_at: stampedAt,
        },
        updated_at: stampedAt,
      });
    });

    return { success: true };
  } catch (error) {
    console.error("declareTournamentResultWithKills error:", error);
    throw toHttpsError(error);
  }
};

/**
 * ADMIN-ONLY: adds capital to a treasury.
 *
 * IDEMPOTENT BY `deposit_id`, the same discipline as `grantBetaCredit`: a retry
 * after a timeout must not double the balance, and the caller controls the id
 * so it can retry the SAME intended deposit safely. A replay with different
 * numbers is a divergence and is refused rather than applied.
 */
export const fundHouseHandler = async (
  data: any,
  context: any
): Promise<Record<string, unknown>> => {
  try {
    const callerAuth = assertAdmin(
      context,
      "Você precisa estar logado para aportar no caixa.",
      "Apenas admin pode aportar no caixa."
    );
    assertExactPayload(data, ["economy", "amount", "deposit_id", "note"]);

    const economy = parseRequestedEconomyType(data.economy);
    const amountCentavos = toCentavos(data.amount, {
      field: "valor do aporte",
    });
    const depositId = normalizeGrantId(data.deposit_id);
    const note = normalizeReason(data.note);

    const houseRef = db.collection(HOUSE_COLLECTION).doc(houseDocId(economy));
    const fundingRef = db
      .collection("transactions")
      .doc(houseFundingTransactionId(depositId));

    const walletRef = db.collection("wallets").doc(callerAuth.uid);
    const userRef = db.collection("users").doc(callerAuth.uid);

    const outcome = await db.runTransaction(async (transaction) => {
      const [fundingSnap, houseSnap, walletSnap] = await Promise.all([
        transaction.get(fundingRef),
        transaction.get(houseRef),
        transaction.get(walletRef),
      ]);
      const houseBefore = readHouseBalance(houseSnap);

      if (!walletSnap.exists) {
        throw new DomainError(
          "not-found",
          "Sua carteira não foi encontrada."
        );
      }

      if (fundingSnap.exists) {
        const stored = fundingSnap.data() ?? {};
        // Same deposit, same numbers: success with NO second credit.
        if (
          stored.amount_centavos === amountCentavos &&
          stored.economy_type === economy
        ) {
          return { idempotent: true, balanceCentavos: houseBefore };
        }
        throw new DomainError(
          "failed-precondition",
          "Já existe um aporte diferente com este identificador."
        );
      }

      const decision = decideHouseDeposit({
        amountCentavos,
        houseCentavos: houseBefore,
      });
      if (!decision.ok) {
        throw new DomainError("invalid-argument", decision.message);
      }

      /**
       * THE MONEY COMES OUT OF THE CREATOR'S OWN WALLET.
       *
       * It used to be credited from nothing, which made the treasury a
       * DECLARATION rather than a balance — a number that bounded payouts
       * without anything standing behind it. Debiting the wallet makes the
       * capital real: it existed, it moved, and both sides are in the ledger.
       *
       * A TRANSFER, NOT A DIRECT CHARGE AT SETTLEMENT. Letting settlement
       * reach into the creator's wallet would race with everything else that
       * wallet does — an entry fee or a withdrawal could spend the same money
       * first, and the treasury would be counting funds that were already
       * gone. Moving it once, here, means the treasury holds what it says.
       */
      const walletData = walletSnap.data() ?? {};
      const isBeta = economy === ECONOMY_BETA_CREDIT;

      const previous = storedReaisToCentavos(
        isBeta ? walletData.beta_balance ?? 0 : walletData.balance ?? 0,
        isBeta ? "saldo beta" : "saldo da carteira"
      );
      if (previous < amountCentavos) {
        throw new DomainError(
          "failed-precondition",
          `Saldo insuficiente para o aporte. Você tem ` +
            `${formatCentavos(previous, economy)}.`
        );
      }
      const walletAfter = debit(previous, amountCentavos);

      const stampedAt = FieldValue.serverTimestamp();

      if (isBeta) {
        transaction.update(walletRef, {
          beta_balance: centavosToReais(walletAfter),
        });
      } else {
        // `total_spent` moves with the balance so the audit identity
        // (balance = deposited + won - spent - withdrawn) keeps closing.
        const previousSpent = storedReaisToCentavos(
          walletData.total_spent ?? 0,
          "total gasto"
        );
        transaction.update(walletRef, {
          balance: centavosToReais(walletAfter),
          total_spent: centavosToReais(previousSpent + amountCentavos),
        });
      }

      transaction.set(
        houseRef,
        {
          [HOUSE_BALANCE_FIELD]: decision.houseAfterCentavos,
          economy_type: economy,
          updated_at: stampedAt,
        },
        { merge: true }
      );
      // create(), never set(): a retry that raced past the existence check
      // above must fail here rather than credit the treasury twice.
      //
      // CARRIES user_ref, unlike the settlement's margin row. This one moved a
      // PLAYER's balance, so the wallet reconciler has to see it or the
      // identity would not close.
      transaction.create(fundingRef, {
        amount: centavosToReais(amountCentavos),
        amount_centavos: amountCentavos,
        balance_after_centavos: decision.houseAfterCentavos,
        category: houseFundingCategoryFor(economy),
        economy_type: economy,
        deposit_id: depositId,
        note,
        funded_by: callerAuth.uid,
        user_ref: userRef,
        timestamp: stampedAt,
        status: "completed",
      });

      return { idempotent: false, balanceCentavos: decision.houseAfterCentavos };
    });

    return {
      success: true,
      idempotent: outcome.idempotent,
      balance_centavos: outcome.balanceCentavos,
      economy,
    };
  } catch (error) {
    console.error("fundHouse error:", error);
    throw toHttpsError(error);
  }
};

export const fundHouse = central.https.onCall(fundHouseHandler);

export const declareTournamentResultWithKills = central.https.onCall(
  declareTournamentResultWithKillsHandler
);
