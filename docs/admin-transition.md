# Admin authorization: the two-stage transition

## Where we are

**Both phases are COMPLETE and verified in production.** Administrator access is
now granted by the `admin: true` custom claim ALONE — in the deployed Cloud
Functions and in the published Firestore Rules. The legacy-UID fallback has been
removed from production.

- **Phase 1 — grant the claim (done).** The `admin: true` custom claim was
  assigned to the administrator account by the guarded `admin:claim` tool and
  **confirmed in a real app ID token** — the in-app diagnostic returned
  `ADMIN: TRUE` after a forced token refresh. (That temporary in-app button has
  since been removed.)
- **Phase 2 — remove the fallback (done in production).** The claim-only code was
  merged to `master`, then rolled out: the seven functions were redeployed and
  `firestore.rules` was republished, all claim-only. See "Stage 2" below for the
  full rollout record.

| Where | Authorization now |
|---|---|
| `functions/src/domain/adminAuth.ts` (deployed) | `isAdmin() = hasAdminClaim()` — claim only, no UID |
| `firestore.rules` (published) | `isAdmin()` claim-only; `isLegacyAdmin()` removed |

The legacy identifier no longer exists in any deployable path. It survives ONLY
inside the local, non-deployable `admin:claim` tool
(`functions/src/adminclaim/target.ts` → `ADMIN_ACCOUNT_UID`), which uses it only
to name which account to grant/verify the claim — **never to authorize**.

## Current authorization

Only `admin === true` as a **boolean** authorizes administrative operations.
Nothing else does: a **UID**, an **email**, or `admin` as the **string** `"true"`
(or any other truthy non-boolean) grants no access. This holds identically in the
Cloud Functions (`=== true`) and the Firestore Rules (`== true`).

## Stage 1 — grant the claim (does not change any behavior)

Stage 1 **only adds** the claim; it keeps the legacy UID fallback exactly as it
is. Nothing about authorization behavior changes — the administrator is simply
authorized by *both* routes afterwards, with the fallback now redundant.

It is performed by a committed but **non-deployable** local tool,
`npm run admin:claim`, run from a trusted machine with Admin SDK credentials.
There is deliberately **no callable** that sets claims: a callable that grants
admin is a privilege-escalation hole, no matter how well it is guarded. The tool
is excluded from the deploy package (`firebase.json` ignores `lib/adminclaim`),
imports no `firebase-functions`, and declares no trigger — it cannot become an
endpoint. Conceptually it performs exactly one write:

```js
// One-off, run locally by the guarded tool. Never deployed.
await admin.auth().setCustomUserClaims(ADMIN_ACCOUNT_UID, {
  ...existingClaims, // every existing claim is preserved
  admin: true,       // normalized to boolean true
});
```

### The guarded tool (`npm run admin:claim`)

Dry-run is the default; it **never writes** without every confirmation. The
target is always `ADMIN_ACCOUNT_UID` from `functions/src/adminclaim/target.ts`
and **can never be passed as an argument** (`--uid`/`--email`/`--id` are refused).
The tool prints only counts and booleans — never a uid, email, token, or claim
value.

- **Dry-run** (read-only; reads Auth, `users/{uid}`, `wallets/{uid}`):

  ```
  npm run admin:claim -- --project sparta-battle
  ```

  It reports the anonymized current state, a deterministic **fingerprint** over
  the target's uid + disabled + existing claims, and the plan (add-claim,
  no-op, or an abort). If `admin` is already exactly `true`, it is a **no-op**.

- **Apply** (performed in phase 1; shown here for reference) requires,
  simultaneously:

  ```
  npm run admin:claim -- --project sparta-battle --apply \
    --confirm-admin-claim-transition \
    --confirmation ADD_ADMIN_CLAIM_KEEP_LEGACY_FALLBACK \
    --expected-fingerprint <hash-from-the-dry-run>
  ```

  Immediately before writing, it **re-reads** the account and **recomputes the
  fingerprint**; any divergence from `--expected-fingerprint` aborts with no
  write. A missing or disabled account, or a missing `users`/`wallets` document,
  also aborts. The only possible write is a single `setCustomUserClaims`; refresh
  tokens are **never** revoked and no Firestore document is written.

### After the claim is assigned

1. **Refresh the token.** The administrator signs out and signs back in, or the
   client calls `user.getIdToken(true)`. Until this happens the claim is not in
   the token and `hasAdminClaim()` stays false — the claim is baked into the ID
   token at sign-in.
2. **Verify `admin === true` in the token WITHOUT printing the token.** Inspect
   `request.auth.token.admin` from the client (e.g. assert it in the app), or use
   `firebase auth:export`. Never log or paste the raw ID token.

Nothing breaks at this point: the administrator is authorized by *both* routes,
and the fallback is simply redundant.

### What is deliberately NOT part of stage 1

- **Publishing `firestore.rules` is a separate step.** The rules already accept
  the claim; granting it does not require re-publishing them, and this stage does
  not.
- **Removing the legacy UID happens only in a future phase (stage 2)**, and only
  after the claim has been tested for real — see below. Stage 1 never touches the
  fallback in either `adminAuth.ts` or `firestore.rules`.

## Stage 2 — remove the fallback (COMPLETE in production)

The claim-only code (branch `feature/remove-legacy-admin-fallback`, merged to
`master`) removed the fallback from every deployable path:

- `functions/src/domain/adminAuth.ts` — `LEGACY_ADMIN_UID` and `isLegacyAdmin()`
  removed; `isAdmin()` is exactly `hasAdminClaim()`.
- `firestore.rules` — `isLegacyAdmin()` and the UID literal removed; `isAdmin()`
  is claim-only.
- The historical UID moved to `functions/src/adminclaim/target.ts`
  (`ADMIN_ACCOUNT_UID`), used only by the non-deployable tool.

### Rollout performed (selective, coordinated)

Doing phase 1 first — the claim live and confirmed — is what made dropping the
UID safe: the admin was already authorized by the claim before either side
stopped honoring the UID, so there was no lockout window.

- **Pre-flight:** an `admin:claim` dry-run confirmed `admin=true` (boolean) with a
  no-op plan immediately before the rollout.
- **Seven functions updated individually** (never a broad deploy):
  - six callables in **us-central1**: `testdeposit`, `requestwithdrawal`,
    `jointournament`, `payprize`, `createTournament`, `createtournament`;
  - **`onUserCreated` in us-east1**, last.
- After **each** function: `functions:list` + read-only data audit (exit 0).
- **`firestore.rules` (claim-only) published separately** (`--only
  firestore:rules`) in the **same** rollout window — compiled and released
  successfully.
- **No callable was invoked during the rollout.**

### Verification

- `functions:list` showed **exactly 7 functions** in their expected regions
  (six callables in us-central1, `onUserCreated` in us-east1).
- Read-only data audit: **exit 0** — **0 wallets with problems**, **5 tournaments
  both-matching**, no document altered.
- Final `admin:claim` dry-run: **`admin=true` (boolean)**, plan **no-op**.
- Supporting local tests: **184/184 unit** and **24/24 emulator rules** (claim
  accepted regardless of uid; the legacy uid without the claim is denied; a
  truthy-non-boolean claim is denied).

### Still pending — behavioral smoke

A manual end-to-end smoke in the app is still recommended: signed in as the real
admin, an administrative action (e.g. create/edit a tournament) should succeed;
an ordinary account should be denied. This was **not** part of the rollout — no
callable was invoked from here.

### Rollback

The pre-change state is fully in git history (the commit before the claim-only
branch keeps both routes). If the admin cannot perform an admin action:

1. **Fastest mitigation, no deploy:** confirm the claim is present (`admin:claim`
   dry-run) and refresh the admin's token — the claim path should authorize.
2. **If the claim path is genuinely broken:** restore **both** sides together —
   re-deploy the previous (fallback-bearing) functions build **and** re-publish
   the previous rules — from the prior history. **Never roll back only one side.**
3. Never fix a lockout by weakening rules ad hoc; restore the known-good pair.

## Separate future maintenance

Tracked apart from this transition, not part of it:

- **Migrate off Node.js 20 before 2026-10-30** — it is deprecated and will be
  decommissioned then; after that date a deploy requires a newer runtime.
- **Update `firebase-functions` / `firebase-admin`** — the deploy warns both are
  outdated.
- **Address the remaining dependency advisories** (the runtime baseline of 1 low
  + 10 moderate) in dedicated dependency-maintenance work.

## Rules that must not be relaxed

- The claim is checked with `== true` (rules) / `=== true` (TypeScript). A truthy
  value such as the **string** `"false"` must never grant admin.
- Wallets stay unwritable from any client, **including an administrator**. Money
  moves only inside the Cloud Functions' transactions, which use the Admin SDK
  and bypass rules entirely. There is a test asserting exactly this.
- No callable may ever assign a custom claim to its own caller.
