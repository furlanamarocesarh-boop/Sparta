# Admin authorization: the two-stage transition

## Where we are

Administrator access is currently granted by **either** of two things:

1. the Firebase Auth custom claim `admin: true` — **the target state**, or
2. the legacy hard-coded UID `Fnj4w17GGeP7XgQ5yF3gXTL1yR42` — **temporary**.

Both are accepted right now, in two places that must always agree:

| Where | What |
|---|---|
| `functions/src/domain/adminAuth.ts` | `LEGACY_ADMIN_UID`, `hasAdminClaim()`, `isAdmin()` |
| `firestore.rules` | `isLegacyAdmin()`, `hasAdminClaim()`, `isAdmin()` |

Before this change the UID was **duplicated inside `testdeposit` and `payprize`**
and again in the rules. Duplicated authorization is how one copy silently drifts
from another; there is now exactly one constant on each side.

## Why the legacy UID is still accepted

Because removing it first would be an outage, not a hardening.

A custom claim is **baked into the ID token at sign-in**. Assigning the claim
server-side does *not* retroactively change a token the administrator is already
holding. So if the UID fallback were deleted before the claim was assigned *and*
the token refreshed, the only administrator would be locked out of `testdeposit`,
`payprize`, and every tournament write — with no way back in through the app.

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
await admin.auth().setCustomUserClaims(LEGACY_ADMIN_UID, {
  ...existingClaims, // every existing claim is preserved
  admin: true,       // normalized to boolean true
});
```

### The guarded tool (`npm run admin:claim`)

Dry-run is the default; it **never writes** without every confirmation. The
target is always `LEGACY_ADMIN_UID` from `functions/src/domain/adminAuth.ts` and
**can never be passed as an argument** (`--uid`/`--email`/`--id` are refused).
The tool prints only counts and booleans — never a uid, email, token, or claim
value.

- **Dry-run** (read-only; reads Auth, `users/{uid}`, `wallets/{uid}`):

  ```
  npm run admin:claim -- --project sparta-battle
  ```

  It reports the anonymized current state, a deterministic **fingerprint** over
  the target's uid + disabled + existing claims, and the plan (add-claim,
  no-op, or an abort). If `admin` is already exactly `true`, it is a **no-op**.

- **Apply** (a future step — do not run yet) requires, simultaneously:

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

## Stage 2 — verify, then remove the fallback

Do **not** start this until stage 1 is confirmed.

1. Confirm the claim alone is sufficient. The cleanest proof: grant the claim to
   a **second, non-legacy** admin account and check that it can run
   `testdeposit`, `payprize`, and a tournament write. That exercises the claim
   path without the UID path masking a failure.
2. Test all admin operations end to end.
3. Only then delete, **in the same change**:
   - `LEGACY_ADMIN_UID` and `isLegacyAdmin()` in `functions/src/domain/adminAuth.ts`
     (leaving `isAdmin()` = `hasAdminClaim()`);
   - `isLegacyAdmin()` and its use in `isAdmin()` in `firestore.rules`.
4. Deploy the functions and publish the rules **together**. If they are deployed
   apart, one side will reject the administrator that the other still accepts.

## Rules that must not be relaxed

- The claim is checked with `== true` (rules) / `=== true` (TypeScript). A truthy
  value such as the **string** `"false"` must never grant admin.
- Wallets stay unwritable from any client, **including an administrator**. Money
  moves only inside the Cloud Functions' transactions, which use the Admin SDK
  and bypass rules entirely. There is a test asserting exactly this.
- No callable may ever assign a custom claim to its own caller.
