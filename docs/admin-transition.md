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

Run this **once**, from a trusted machine, with Admin SDK credentials. It is not
committed as a script and there is deliberately **no callable** that sets claims:
a callable that grants admin is a privilege-escalation hole, no matter how well
it is guarded.

```js
// One-off, run locally. Never deploy this.
await admin.auth().setCustomUserClaims("Fnj4w17GGeP7XgQ5yF3gXTL1yR42", {
  admin: true,
});
```

Then:

1. **Refresh the token.** The administrator signs out and signs back in, or the
   client calls `user.getIdToken(true)`. Until this happens the claim is not in
   the token and `hasAdminClaim()` stays false.
2. **Verify the claim is present**, e.g. `firebase auth:export` or by inspecting
   `request.auth.token.admin` from the client.

Nothing breaks at this point: the administrator is now authorized by *both*
routes, and the fallback is simply redundant.

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
