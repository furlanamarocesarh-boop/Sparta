import { computeFingerprint, DocumentStamp } from "../reset/fingerprint.js";

/**
 * Orphan-account detection — pure, no Firebase, no Admin SDK.
 *
 * An "orphan" is a Firebase Auth account with no footprint in Firestore:
 *   - no users/{uid};
 *   - no wallets/{uid};
 *   - no transactions / withdrawals / registrations referencing it.
 *
 * Exactly one account must match. Zero means nothing to do; more than one means
 * the situation is not what we believe and must be reviewed, never guessed at.
 *
 * Everything the CLI hands in is already reduced to booleans and counts — no
 * e-mail, no provider data, no metadata blob — so this layer literally has
 * nothing personal to leak.
 */

/** One Auth account, reduced to what detection needs. */
export interface AuthAccount {
  readonly uid: string;
  /** ISO string of creation time. Goes into the fingerprint, never printed. */
  readonly createdAt: string;
  /**
   * ISO string of last sign-in, or "" if never. In the fingerprint so that a
   * login between the dry run and the apply changes the hash and aborts.
   */
  readonly lastSignInAt: string;
}

/** The complete snapshot detection reasons over. */
export interface AuthSnapshot {
  readonly accounts: readonly AuthAccount[];
  /** UIDs that have a users/{uid} document. */
  readonly userUids: ReadonlySet<string>;
  /** UIDs that have a wallets/{uid} document. */
  readonly walletUids: ReadonlySet<string>;
  /**
   * UIDs referenced by ANY financial document (transactions / withdrawals /
   * registrations), by the `user_ref` path pointing at users/{uid}.
   */
  readonly financiallyReferencedUids: ReadonlySet<string>;
  /** Firestore document stamps, for the fingerprint. */
  readonly firestoreStamps: readonly DocumentStamp[];
}

/** True when this account has no Firestore footprint at all. */
export function isOrphan(account: AuthAccount, snapshot: AuthSnapshot): boolean {
  if (snapshot.userUids.has(account.uid)) return false;
  if (snapshot.walletUids.has(account.uid)) return false;
  if (snapshot.financiallyReferencedUids.has(account.uid)) return false;
  return true;
}

/** The UIDs of every orphan. Internal only — never rendered. */
export function findOrphans(snapshot: AuthSnapshot): AuthAccount[] {
  return snapshot.accounts.filter((account) => isOrphan(account, snapshot));
}

export interface AuthCounts {
  readonly authAccounts: number;
  readonly users: number;
  readonly wallets: number;
  readonly orphans: number;
}

export function countSnapshot(snapshot: AuthSnapshot): AuthCounts {
  return {
    authAccounts: snapshot.accounts.length,
    users: snapshot.userUids.size,
    wallets: snapshot.walletUids.size,
    orphans: findOrphans(snapshot).length,
  };
}

/**
 * The fingerprint's input: EVERY Auth account (uid + created + last-sign-in) and
 * every Firestore stamp. Auth accounts are folded in as synthetic `auth/{uid}`
 * lines carrying their timestamps, so a login (which moves `lastSignInAt`) or a
 * new/removed account changes the hash — exactly the drift the apply must catch.
 *
 * The uid appears only inside the hash input; the digest that comes out reveals
 * nothing.
 */
export function fingerprintStamps(snapshot: AuthSnapshot): DocumentStamp[] {
  const authStamps: DocumentStamp[] = snapshot.accounts.map((account) => ({
    path: `auth/${account.uid}`,
    updateTime: `${account.createdAt}|${account.lastSignInAt}`,
  }));

  return [...authStamps, ...snapshot.firestoreStamps];
}

export function computeAuthFingerprint(snapshot: AuthSnapshot): string {
  return computeFingerprint(fingerprintStamps(snapshot));
}
