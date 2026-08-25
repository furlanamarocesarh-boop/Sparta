/**
 * The backfill decision — PURE, so every branch is proven without Firebase.
 *
 * WHAT IS BEING BACKFILLED AND WHY IT IS NOT A GUESS. `users/{uid}.created_at`
 * is what the public profile turns into "Desde agosto de 2026". No path in this
 * backend ever wrote it before today, so every account that predates that fix
 * has no start date at all.
 *
 * THE DATE COMES FROM FIREBASE AUTH, not from an artefact. `metadata.creationTime`
 * is the instant the account was created, recorded by Auth itself at the moment
 * it happened. That is the same fact `created_at` is supposed to hold — so this
 * is a TRANSCRIPTION, not an inference. Deriving it instead from a first
 * tournament, a wallet document or a transaction would be publishing a guess as
 * a fact on a page strangers read, which is exactly why it was not done blindly.
 *
 * NEVER OVERWRITES. A document that already has a usable `created_at` is left
 * untouched, always — including the accounts created from today on, whose value
 * came from `serverTimestamp()` inside the auth trigger and is more precise than
 * anything this tool could reconstruct. The only write this tool can produce is
 * filling an ABSENT field.
 */

/** What one account looks like to this decision. */
export interface AccountState {
  /** `metadata.creationTime` from Firebase Auth, verbatim. */
  readonly authCreationTime: unknown;
  /** Whether `users/{uid}` exists at all. */
  readonly userDocumentExists: boolean;
  /** The stored `created_at`, whatever shape it is in. */
  readonly storedCreatedAt: unknown;
}

export type BackfillDecision =
  /** Fill the absent field with [value]. */
  | { readonly kind: "write"; readonly value: Date }
  /** Nothing to do, and why. */
  | { readonly kind: "skip"; readonly reason: SkipReason }
  /** Something is wrong with this account; counted and reported, never written. */
  | { readonly kind: "refuse"; readonly reason: RefuseReason };

export type SkipReason =
  /** Already has a date. The common outcome on a second run. */
  | "already-set"
  /**
   * Authenticated, but with no `users/{uid}`. Creating one here would fabricate
   * an account record out of an Auth entry — a different operation entirely,
   * and not one a backfill is allowed to perform.
   */
  | "no-user-document";

export type RefuseReason =
  /** Auth gave no usable creation time. Without it there is nothing to write. */
  | "unusable-auth-time"
  /**
   * The stored value is present but not a date. Overwriting it would destroy
   * whatever it was; this tool only ever FILLS, so it reports and moves on.
   */
  | "stored-value-not-a-date";

/**
 * The earliest instant this backfill will accept as a creation time.
 *
 * A date before the product existed means the Auth record is corrupt or the
 * string was misparsed, and writing it would put "Desde janeiro de 1970" on a
 * public profile. 2024-01-01 is comfortably before the first real account and
 * comfortably after every epoch-shaped accident.
 */
export const EARLIEST_PLAUSIBLE = Date.UTC(2024, 0, 1);

/**
 * Decides what to do with one account.
 *
 * ORDER MATTERS. "Already set" is checked before the Auth time is even looked
 * at, so a healthy account is never refused because of an unrelated Auth
 * problem — and so the second run of this tool is a pure no-op regardless of
 * what Auth reports.
 */
export function decideBackfill(
  state: AccountState,
  now: Date
): BackfillDecision {
  if (!state.userDocumentExists) {
    return { kind: "skip", reason: "no-user-document" };
  }

  if (state.storedCreatedAt !== undefined && state.storedCreatedAt !== null) {
    return isDateLike(state.storedCreatedAt)
      ? { kind: "skip", reason: "already-set" }
      : { kind: "refuse", reason: "stored-value-not-a-date" };
  }

  const created = parseAuthTime(state.authCreationTime, now);
  if (created === null) {
    return { kind: "refuse", reason: "unusable-auth-time" };
  }

  return { kind: "write", value: created };
}

/**
 * Parses Auth's creation time, rejecting anything implausible.
 *
 * A FUTURE DATE IS REFUSED, not clamped. It means the clock or the record is
 * wrong, and "Desde março de 2031" on a public profile is worse than no line
 * at all — which is exactly what refusing leaves behind.
 */
function parseAuthTime(raw: unknown, now: Date): Date | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  const parsed = new Date(raw);
  const time = parsed.getTime();
  if (Number.isNaN(time)) return null;
  if (time < EARLIEST_PLAUSIBLE) return null;
  if (time > now.getTime()) return null;

  return parsed;
}

/** Whether a stored value is already a usable date, in any shape Firestore uses. */
function isDateLike(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  // Duck-typed so a Firestore Timestamp counts without importing the Admin SDK.
  const candidate = value as { toDate?: () => Date } | null;
  if (candidate && typeof candidate.toDate === "function") {
    try {
      const date = candidate.toDate();
      return date instanceof Date && !Number.isNaN(date.getTime());
    } catch {
      return false;
    }
  }
  return false;
}

/** Running totals, so the report never has to hold one row per account. */
export interface BackfillTally {
  scanned: number;
  written: number;
  alreadySet: number;
  noUserDocument: number;
  unusableAuthTime: number;
  storedValueNotADate: number;
}

export function emptyTally(): BackfillTally {
  return {
    scanned: 0,
    written: 0,
    alreadySet: 0,
    noUserDocument: 0,
    unusableAuthTime: 0,
    storedValueNotADate: 0,
  };
}

/** Folds one decision into the tally. `written` counts INTENT in a dry run. */
export function tally(
  into: BackfillTally,
  decision: BackfillDecision
): BackfillTally {
  into.scanned += 1;
  switch (decision.kind) {
    case "write":
      into.written += 1;
      break;
    case "skip":
      if (decision.reason === "already-set") into.alreadySet += 1;
      else into.noUserDocument += 1;
      break;
    case "refuse":
      if (decision.reason === "unusable-auth-time") into.unusableAuthTime += 1;
      else into.storedValueNotADate += 1;
      break;
  }
  return into;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;

/**
 * The exit code.
 *
 * A REFUSAL IS NOT A FAILURE OF THE RUN. Accounts this tool declines to touch
 * are reported and counted, and the run still succeeded at what it promised:
 * it filled every field it could fill and destroyed nothing. Exiting non-zero
 * over them would make a healthy backfill look broken and invite someone to
 * "fix" it by loosening the refusals.
 */
export function exitCode(tally: BackfillTally): number {
  return tally.scanned >= 0 ? EXIT_OK : EXIT_FAILURE;
}

/** The report. Counts only — never a uid, an e-mail or a date belonging to one. */
export function renderReport(t: BackfillTally, applied: boolean): string {
  const verb = applied ? "gravados" : "a gravar";
  // Uma coluna só, calculada — não espaços contados à mão, que desalinham na
  // primeira vez que um rótulo muda de tamanho.
  const row = (label: string, value: number) =>
    `  ${label.padEnd(31)}${value}`;

  return [
    "",
    applied ? "BACKFILL APLICADO" : "DRY-RUN (nada foi escrito)",
    "",
    row("contas verificadas:", t.scanned),
    row(`created_at ${verb}:`, t.written),
    row("já tinham a data:", t.alreadySet),
    row("sem documento em users:", t.noUserDocument),
    "",
    "  recusadas (nada escrito):",
    row("  data do Auth inutilizável:", t.unusableAuthTime),
    row("  valor gravado não é data:", t.storedValueNotADate),
    "",
  ].join("\n");
}
