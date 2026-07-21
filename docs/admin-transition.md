# Admin authorization: the two-stage transition

## Where we are

**Phase 1 is COMPLETE.** The `admin: true` custom claim was assigned to the
administrator account by the guarded tool and **confirmed in a real app ID
token** — the in-app diagnostic returned `ADMIN: TRUE` after a forced token
refresh. (That temporary in-app button has since been removed.)

**Phase 2 is prepared IN CODE, but NOT in production.** On this branch the
deployable authorization has been reduced to the claim alone:

| Where | Deployable code (this branch) | Production right now |
|---|---|---|
| `functions/src/domain/adminAuth.ts` | `hasAdminClaim()`, `isAdmin() = hasAdminClaim()` — no UID | still runs the **deployed** build, which **accepts the legacy UID** |
| `firestore.rules` | claim-only `isAdmin()`; `isLegacyAdmin()` deleted | the **published** rules **still accept the legacy UID** |

The legacy identifier no longer exists in any deployable path. It survives ONLY
inside the local, non-deployable `admin:claim` tool
(`functions/src/adminclaim/target.ts` → `ADMIN_ACCOUNT_UID`), which uses it only
to name which account to grant/verify the claim — **never to authorize**.

## Why production still accepts the legacy UID

Because removing it from production first would be an outage, not a hardening.

A custom claim is **baked into the ID token at sign-in**. Assigning the claim
server-side does *not* retroactively change a token the administrator is already
holding. So if the UID fallback were removed from production before the claim was
live and the token refreshed, the only administrator could be locked out of
`testdeposit`, `payprize`, and every tournament write — with no way back in
through the app.

Phase 1 has now removed that risk (the claim is live and confirmed), but the
code change of phase 2 only takes effect in production once the claim-only
functions are **deployed** and the claim-only rules are **published** — together
(see the coordinated rollout below). Until that authorized rollout, production
keeps both routes.

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

## Stage 2 — remove the fallback (code-complete; production PENDING)

**The code change is done on branch `feature/remove-legacy-admin-fallback`:**

- `functions/src/domain/adminAuth.ts` — `LEGACY_ADMIN_UID` and `isLegacyAdmin()`
  are gone; `isAdmin()` is now exactly `hasAdminClaim()`.
- `firestore.rules` — `isLegacyAdmin()` and the UID literal are gone; `isAdmin()`
  is claim-only.
- The historical UID moved to `functions/src/adminclaim/target.ts`
  (`ADMIN_ACCOUNT_UID`), used only by the non-deployable tool.
- Unit + rules tests assert the new contract; a structural test asserts no
  deployable path carries the fallback.

**This has NOT been applied to production.** No deploy and no rules publish were
done. Production still authorizes by both the claim and the legacy UID.

### Coordinated rollout (requires explicit, separate authorization)

Functions and rules **must go out together** — if one side drops the UID while
the other still grants it, they disagree about who is admin.

1. Pre-flight: re-confirm the admin's token carries `admin: true` (the in-app
   check, or `admin:claim` dry-run showing the claim present). This is what makes
   dropping the UID safe.
2. Deploy the six callables + `onUserCreated` (claim-only functions),
   individually, per the selective plan in the runbook — never a broad deploy.
3. Publish `firestore.rules` (claim-only) in the **same** rollout window.
4. Verify with a real admin token: `testdeposit`, `payprize`, a tournament
   write, and an admin read all succeed **via the claim**; a non-admin is denied.

### Rollback

The pre-change state is recoverable because it is fully in git history (the
commit before this branch keeps both routes). If, after the coordinated rollout,
the admin cannot perform an admin action:

1. **Fastest mitigation, no deploy:** ensure the claim is present (`admin:claim`
   dry-run) and refresh the admin's token — the claim path should authorize.
2. **If the claim path is genuinely broken:** re-deploy the previous
   (fallback-bearing) functions build **and** re-publish the previous rules
   **together** from the prior commit, restoring the legacy-UID acceptance. Do
   not roll back only one side.
3. Never fix a lockout by weakening rules ad hoc; roll back to the known-good
   pair instead.

Do not mark phase 2 complete until the coordinated rollout has been authorized,
executed, and verified in production.

## Rules that must not be relaxed

- The claim is checked with `== true` (rules) / `=== true` (TypeScript). A truthy
  value such as the **string** `"false"` must never grant admin.
- Wallets stay unwritable from any client, **including an administrator**. Money
  moves only inside the Cloud Functions' transactions, which use the Admin SDK
  and bypass rules entirely. There is a test asserting exactly this.
- No callable may ever assign a custom claim to its own caller.
