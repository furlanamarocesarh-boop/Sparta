# `username` is always empty — the problem and the proposed fix

## The problem

`users/{uid}.username` is written as `""` and never populated.

1. A player signs up. `createUserWithEmailAndPassword` creates the Auth account.
   It carries **no display name**.
2. The `onUserCreated` auth trigger fires and writes `users/{uid}` with
   `username: ""` hard-coded. At this instant no display name exists anywhere.
3. The mobile client *then* calls `user.updateDisplayName(...)`, which updates
   the **Firebase Auth profile only** — it does not touch Firestore.

So the trigger cannot read the name: it has already run by the time the name
exists. The two steps are inherently racy, and re-ordering them does not fix it
(the trigger is asynchronous and gets no callback from a later profile update).

Today the app therefore shows the **Auth `displayName`**, and the Firestore
`username` field stays empty. Nothing is broken for the player — but any
server-side feature that needs a name (leaderboards, tournament rosters, payout
records) cannot rely on `users/{uid}.username`.

## What we deliberately did NOT do

**We did not open a client write path to `users/{uid}`.**

It is tempting to let the client write its own `username` and be done. That would
require relaxing `firestore.rules` to allow user-owned writes to the `users`
collection, and it is not safe:

- **No uniqueness.** Two players could take the same username; Firestore rules
  cannot enforce a global uniqueness constraint by themselves.
- **No validation the client cannot bypass.** Length, charset, profanity, and
  impersonation checks written in rules are limited and easy to get wrong.
- **Field-level leakage.** A rule permissive enough to accept `username` is one
  mistake away from also accepting `player_id`, `pix_key`, or a field added
  later. The current rule — `allow create, update, delete: if false` — has no
  such failure mode.

A weak write path here would be a permanent hole in exchange for a cosmetic
field. So `username` stays empty until it can be done properly.

## Proposed design (NOT implemented in this phase)

### Option A — authenticated callable (recommended)

```
setUsername({ username })
```

- Requires `request.auth`; writes only for `request.auth.uid`. A caller can never
  name someone else.
- Validates server-side: trimmed length 3–20, allowed charset, reserved-word and
  profanity list.
- Writes **only** the `username` field of `users/{uid}`. Never touches
  `player_id`, `pix_key`, balances, or anything admin-controlled.
- Firestore rules stay exactly as they are: clients still cannot write `users`.

### Uniqueness, if it is required

Uniqueness needs a **reservation document**, because a "check then write" is a
race — two players can both pass the check before either writes.

```
usernames/{lowercased_username}  ->  { uid, created_at }
```

Inside one transaction: read `usernames/{name}`; if it exists and belongs to
someone else, fail with `already-exists`; otherwise create it, delete the
caller's previous reservation, and set `users/{uid}.username`. The document id
*is* the lock — Firestore guarantees at most one.

That collection must be **admin-write-only** in the rules (created solely by the
callable), and reads should be denied so it cannot be used to enumerate players.

### Deciding

Uniqueness is a product decision, not a technical one. `player_id` (`PLR-######`)
already provides a unique handle, so `username` may well be allowed to collide,
like a display name. **Confirm this before building the reservation machinery** —
it is a lot of complexity to add speculatively.

## Scope note

Phase 2.5B changed **nothing** about `username`. `onUserCreated` still writes
`username: ""`, exactly as deployed. This document exists so the gap is recorded
rather than quietly forgotten.
