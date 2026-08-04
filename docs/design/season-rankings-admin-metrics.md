# Season Rankings and Administrative Metrics — implementation contract

**Status:** design only. No production code, tests, Rules, indexes, dependencies or Firebase
configuration are changed by this document.

**Design base:** `dcc0d4da6c3c68af677ef4a9bc9ae4d6be922269` (`master`, equal to cached
`origin/master`). The earlier settlement baseline `04b4623b0cdc5e97d7ed8b27e6534ef48284804a`
remains an ancestor of this base.

**Phase:** contract freeze 1. Session 3 (partners) and any implementation session must treat
sections 1–9 as frozen unless central coordination amends them.

---

## 0. What already exists (audited, not assumed)

Every statement below was read from the tree at the design base. File references are clickable.

| Concern | Where it lives today |
|---|---|
| Definitive prize settlement | [functions/src/domain/settlement.ts](../../functions/src/domain/settlement.ts), [functions/src/index.ts:735-1041](../../functions/src/index.ts#L735-L1041) |
| Money units and arithmetic | [functions/src/domain/money.ts](../../functions/src/domain/money.ts) |
| Two-economy separation | [functions/src/domain/economy.ts](../../functions/src/domain/economy.ts) |
| Entry-fee refunds / cancellation | [functions/src/domain/cancellation.ts](../../functions/src/domain/cancellation.ts) |
| Beta credit grants | [functions/src/domain/betaCredit.ts](../../functions/src/domain/betaCredit.ts) |
| Business calendar / day keys | [functions/src/domain/playerActivity.ts](../../functions/src/domain/playerActivity.ts) |
| Engagement statistics (read-only) | [functions/src/domain/engagementStats.ts](../../functions/src/domain/engagementStats.ts) |
| Admin authorization | [functions/src/domain/adminAuth.ts](../../functions/src/domain/adminAuth.ts) |
| Wallet reconciliation invariants | [functions/src/audit/reconcile.ts](../../functions/src/audit/reconcile.ts) |
| Rules | [firestore.rules](../../firestore.rules) |
| Indexes | [firestore.indexes.json](../../firestore.indexes.json) |

### 0.1 Deployed function inventory

All callables are v1 `functions.region(...).https.onCall`, region `us-central1`
([functions/src/index.ts:118-122](../../functions/src/index.ts#L118-L122)). `onUserCreated` is an
auth trigger in `us-east1`.

`onUserCreated`, `testdeposit`, `requestwithdrawal`, `jointournament`, `createTournament`,
`createtournament`, `setTournamentRoom`, `getTournamentRoom`, `startTournament`,
`declareTournamentResult`, `payprize` (alias of `declareTournamentResultHandler`),
`cancelTournament`, `grantBetaCredit`, `recordDailyAppOpen`, `getPlayerEngagementStats`.

**There is not a single Firestore document trigger in the codebase today.** Every write path is a
callable or the one auth trigger. Introducing an `onDocumentCreated` trigger is therefore a *new
architectural pattern* for this repository, not a reuse of an existing one — see section 8.

### 0.2 Canonical document schemas

```text
users/{uid}                     { email, username: "", player_id: "PLR-######",
                                  pix_key: "", whatsapp: "" }
wallets/{uid}                   { balance, total_deposited, total_won, total_spent,
                                  total_withdrawn, beta_balance, user_ref }
transactions/{txId}             { amount, category, user_ref, display_name, tournament_ref,
                                  previous_balance, balance_after, timestamp, status,
                                  external_id, economy_type? ,
                                  beta_previous_balance?, beta_balance_after? }
registrations/{uid}_{tid}       { user_ref, tournament_ref, entry_fee, status: "registered",
                                  economy_type, entry_fee_snapshot, transaction_ref, created_at }
tournaments/{tid}               { status, prize, entry_fee, economy_type, locked_economy_type,
                                  result?, updated_at, ... }
tournaments/{tid}.result        { placement: 1, winner_uid, winner_ref, registration_ref,
                                  prize, transaction_ref, declared_at, paid_at, economy_type? }
withdrawals/{externalId}        { amount, user_ref, status: "pending", pix_key_snapshot,
                                  transaction_ref, provider, provider_status, pix_tx_id,
                                  error_message, requested_at, paid_at, failed_at }
player_activity/{uid}_{day}     { uid, user_ref, activity_day, timezone, first_opened_at,
                                  created_at, client_day,
                                  client_timezone_offset_minutes }     (non-financial)
```

Document-id provenance differs by writer and matters for idempotent aggregation: `prize`,
`entry_refund`/`beta_refund` and `beta_grant` rows use **server-derived deterministic** ids, while
`entry_fee`/`beta_entry_fee` rows use a **caller-supplied `externalid`**
([functions/src/index.ts:450-451](../../functions/src/index.ts#L450-L451)) and `deposit` rows accept
a caller-supplied id verbatim. The ranking pipeline depends only on the deterministic `prize_{tid}`
id; the admin metric pipeline aggregates entry-fee rows by document and so inherits whatever
uniqueness `jointournament` enforces — a duplicate-entry check is included in 10.9 rather than
assumed away.

Money is stored as **reais** (a `number`); all internal arithmetic is **integer centavos**
([functions/src/domain/money.ts:1-19](../../functions/src/domain/money.ts#L1-L19)). References are
stored as real Firestore `DocumentReference` objects (`user_ref`, `tournament_ref`), not string ids.

Two wallet-field caveats that make wallet totals unsuitable as a metric source:

* `total_spent` is a **net** figure — `cancelTournament` subtracts refunds from it — while
  `total_deposited`, `total_won` and `total_withdrawn` are gross lifetime sums. Mixing them in one
  report would silently compare net against gross.
* `total_withdrawn` is charged at **request** time, not payout time, because the wallet is debited
  when the withdrawal row is created.

Transaction documents have **no single schema**: six writers emit overlapping shapes. Common to all
categories are `amount`, `category`, `user_ref`, `display_name`, `tournament_ref`, `timestamp`,
`status`, `external_id`. Cash rows add `previous_balance`/`balance_after`; beta rows add
`beta_previous_balance`/`beta_balance_after` and `economy_type`. The cash `prize`, `deposit` and
`withdrawal` rows carry **no** `economy_type` at all, which is why **`category` is the only universal
discriminator** and why this design keys everything off it.

Transaction `status` has exactly two values across the whole codebase: `"completed"` and `"pending"`
(the latter only on `withdrawal` rows, permanently — see 10.7).

### 0.3 The canonical ledger category table

From [functions/src/domain/engagementStats.ts:80-90](../../functions/src/domain/engagementStats.ts#L80-L90),
cross-confirmed by [functions/src/audit/reconcile.ts:50-91](../../functions/src/audit/reconcile.ts#L50-L91):

| category | written by | economy | role | affects prize ranking |
|---|---|---|---|---|
| `entry_fee` | `jointournament` (cash) | cash | entry | no |
| `prize` | `declareTournamentResult` (cash) | cash | prize | **yes — cash ranking** |
| `entry_refund` | `cancelTournament` (cash) | cash | refund | no |
| `beta_entry_fee` | `jointournament` (beta) | beta | entry | no |
| `beta_prize` | `declareTournamentResult` (beta) | beta | prize | **yes — beta ranking only** |
| `beta_refund` | `cancelTournament` (beta) | beta | refund | no |
| `deposit` | `testdeposit` | — | excluded | no |
| `withdrawal` | `requestwithdrawal` | — | excluded | no |
| `beta_grant` | `grantBetaCredit` | — | excluded | no |

`admin_correction` is named in the source comments as a one-off bookkeeping row that **no deployed
handler writes**. It is excluded today by the unknown-category policy. Section 2 makes its treatment
explicit rather than leaving it to that default.

### 0.4 The canonical business calendar

`ACTIVITY_TIMEZONE = "America/Sao_Paulo"`
([functions/src/domain/playerActivity.ts:33](../../functions/src/domain/playerActivity.ts#L33)),
re-exported as `STATS_TIMEZONE`
([functions/src/domain/engagementStats.ts:26](../../functions/src/domain/engagementStats.ts#L26)).

The source states this explicitly:

> The repository defined NO tournament/accounting timezone before this module … so this is the first
> explicit convention rather than an override of one. Every future day-bucketed feature should reuse
> this constant.

**There is no timezone conflict.** The operator's instruction (São Paulo calendar boundaries) and the
repository's canonical constant agree. This design reuses `ACTIVITY_TIMEZONE` and `businessDayKey`
rather than defining a second convention. `businessDayKey` uses `Intl.DateTimeFormat` with the IANA
zone, so a future reintroduction of Brazilian DST is handled correctly.

---

## 1. The authoritative event that credits ranking value

**The authoritative record is the prize transaction document, not the tournament result and not any
engagement aggregate.**

```text
transactions/prize_{tournamentid}
```

Written by `declareTournamentResultHandler`
([functions/src/index.ts:1006-1017](../../functions/src/index.ts#L1006-L1017) cash;
[functions/src/index.ts:950-962](../../functions/src/index.ts#L950-L962) beta) via
`transaction.set(prizeTxRef, …)` **inside** the single `db.runTransaction` that also credits the
wallet and moves the tournament to `completed`.

The document id is deterministic — `prizeTransactionId(tid) === "prize_" + tid`
([functions/src/domain/settlement.ts:100-102](../../functions/src/domain/settlement.ts#L100-L102)) —
so there is **exactly one prize row per tournament**, and `placement` is always `1`. There is one
winner per tournament in the current model.

A row qualifies as ranking-bearing when **all** hold:

* it lives at `transactions/prize_{tournamentid}`;
* `status === "completed"`;
* `category === "prize"` (cash ranking) or `category === "beta_prize"` (beta ranking);
* `amount` passes `inspectReais(amount, { allowZero: true })`;
* `user_ref` and `tournament_ref` are resolvable DocumentReferences.

Rationale for choosing the transaction row over `tournaments/{tid}.result`: the transaction is the
immutable ledger record that the wallet credit is reconciled against
([functions/src/audit/reconcile.ts:24-46](../../functions/src/audit/reconcile.ts#L24-L46)), it is the
object the replay guard compares field-by-field, and it is the only artifact that carries `status`.
The tournament result is a denormalized mirror of it.

**Dating rule.** A prize row carries `timestamp` and **no** `created_at` — the
`d.timestamp ?? d.created_at` fallback in `getPlayerEngagementStats` is dead for this category
([functions/src/index.ts:2197](../../functions/src/index.ts#L2197)). Season bucketing therefore reads
`timestamp` only, and a row without a usable `timestamp` is excluded and counted (section 15.5),
never assigned to a guessed season.

**Schema constraint — the ranking must add no field to the prize transaction.** The cash prize
document's key set is locked by an emulator assertion
(`assert.deepEqual(Object.keys(tx).sort(), [...])` in
[functions/test/rules/tournamentResult.handlers.test.ts](../../functions/test/rules/tournamentResult.handlers.test.ts)),
covering exactly `amount`, `balance_after`, `category`, `display_name`, `external_id`,
`previous_balance`, `status`, `timestamp`, `tournament_ref`, `user_ref`. Stamping a ranking marker
onto the prize row would break that test and the settlement replay contract. All ranking state lives
in the new collections of section 6.

**Single-winner assumption.** `prize_{tournamentid}` contains no winner uid and `placement` is
hardcoded to `1` ([functions/src/index.ts:1023](../../functions/src/index.ts#L1023)), so exactly one
paid winner per tournament is structurally enforced today. The ranking design does not depend on this
— the guard document is keyed by transaction id, which stays unique — but the duplicate-prize
detector in 10.9 does. If multi-placement payouts are ever introduced, the id derivation changes and
section 10.9 must be amended. Listed in section 19.

---

## 2. Eligibility rules for paid, refunded, reversed, cancelled and corrected prizes

### 2.1 Paid

A cash prize counts toward the **cash** season ranking when it satisfies section 1. A beta prize
counts toward the **beta** season ranking and **never** toward the cash ranking.

**The two economies are never summed.** This is a frozen repository contract
([functions/src/domain/engagementStats.ts:16-18](../../functions/src/domain/engagementStats.ts#L16-L18)):

> THE TWO ECONOMIES ARE NEVER SUMMED. … The repository's frozen contract forbids adding them … there
> is no field that could hold one.

Consequently the season aggregate carries two independent totals in two separate documents, and
**no field exists that could hold a combined value**. See section 6.

### 2.2 Refunded

`entry_refund` and `beta_refund` are written **only** by `cancelTournament`, and they refund **entry
fees only** — never prizes
([functions/src/domain/cancellation.ts:28-33](../../functions/src/domain/cancellation.ts#L28-L33)).
They have no effect on prize ranking value. They are excluded from ranking by category.

### 2.3 Reversed

**No deployed code path reverses a credited prize.** `cancelTournament` can only act on a tournament
in the canonical pre-start state
([functions/src/domain/cancellation.ts:14-17](../../functions/src/domain/cancellation.ts#L14-L17)):

> only a tournament in the canonical pre-start state (`status: "open"`, with NO persisted settlement
> evidence) can be cancelled; `cancelled` is TERMINAL: no join, no start, no result, no prize, no room

A tournament that has settled is `completed`, which is not `open`, so it can never be cancelled.
The guard is stronger than a status check: settlement evidence blocks cancellation **even if the
status was tampered back to `"open"`**, failing with
`"O torneio possui liquidação registrada e não pode ser cancelado."`
([functions/src/index.ts:1449-1459](../../functions/src/index.ts#L1449-L1459)).

Therefore **a credited prize is final and irreversible under the current backend.** The ranking may
rely on this: once counted, a prize never needs to be decremented by any deployed path.

There is likewise no reversal, correction, void, adjustment or re-declaration callable anywhere. A
replayed `declareTournamentResult` with the same winner is a no-op; with a different winner it is
`failed-precondition` and leaves the wallet, transaction and tournament byte-identical. The only
remediation available today is an out-of-band Admin SDK write that leaves no ledger entry — which the
reconciliation sweep would surface as drift (section 14.2).

If a reversal capability is ever introduced, it MUST be a new compensating ledger category, and this
document must be amended before that ships. Silent mutation of an existing `prize` row would break
both the ranking and the wallet reconciliation identity.

### 2.4 Cancelled

A cancelled tournament never produced a prize transaction, so it contributes nothing. No special
handling is required beyond section 2.3.

### 2.5 Corrected

`admin_correction` is written by no handler today. The ranking pipeline MUST classify categories with
an explicit allowlist (`prize`, `beta_prize`) rather than a denylist, so any future correction
category is excluded by construction until this contract is amended. This mirrors the existing
unknown-category policy
([functions/src/domain/engagementStats.ts:98-106](../../functions/src/domain/engagementStats.ts#L98-L106)),
which the repository already treats as the safe direction.

**Rule:** a category that is not exactly `prize` or `beta_prize` never moves a ranking total, and a
row whose `status` is not exactly `"completed"` never moves a ranking total.

---

## 3. Season identifiers and São Paulo boundary handling

A prize is assigned to a season by the business day of its **settlement instant**, resolved once:

```ts
const dayKey    = businessDayKey(prizeTx.timestamp.toDate(), ACTIVITY_TIMEZONE); // YYYY-MM-DD
const monthlyId = dayKey.slice(0, 7);                                            // YYYY-MM
const annualId  = dayKey.slice(0, 4);                                            // YYYY
```

* **Monthly season id:** `YYYY-MM` — e.g. `2026-08`.
* **Annual season id:** `YYYY` — e.g. `2026`.

Boundaries are calendar boundaries in `America/Sao_Paulo`: a month begins at `00:00:00.000` local on
day 01 and ends at `23:59:59.999` local on the last day. The same rule applies to the year. A prize
settled at `2026-08-01T00:30:00-03:00` belongs to `2026-08`; the same instant expressed as
`2026-08-01T03:30:00Z` must not be bucketed to July by a naive UTC slice.

**The timestamp used is `transactions/prize_{tid}.timestamp`**, which is the resolved server
timestamp written inside the settlement transaction. `declared_at` and `paid_at` on the tournament
result are the same sentinel resolved to the same instant
([functions/src/index.ts:930-932](../../functions/src/index.ts#L930-L932)), so they agree by
construction; the transaction field is authoritative because it lives on the authoritative record.

`monthOfDayKey` already exists for the `YYYY-MM` slice
([functions/src/domain/engagementStats.ts:152-154](../../functions/src/domain/engagementStats.ts#L152-L154))
and must be reused rather than reimplemented. A `yearOfDayKey` helper is new.

Season id validation reuses the existing strictness of `normalizeMonth`
([functions/src/domain/engagementStats.ts:132-149](../../functions/src/domain/engagementStats.ts#L132-L149)):
`^\d{4}-\d{2}$`, month 01–12, year within `MIN_YEAR = 2020` … `MAX_YEAR = 2100`. The annual validator
applies the same year band.

---

## 4. Deterministic ordering and tie-breaking

Leaderboard order is fully determined by the following comparator, applied in sequence. Every level
is a stored field so the order is reproducible by any reader and stable across rebuilds.

1. `total_prize_centavos` — **descending**. Integer centavos, never reais, never a float.
2. `wins` — descending. Number of qualifying prize rows in the season.
3. `last_prize_at` — **ascending** (earlier wins the tie). The player who reached the total first
   ranks higher.
4. `uid` — ascending lexicographic. A total, deterministic terminal tie-break.

Level 4 guarantees a strict total order: no two entries can compare equal, because `uid` is unique.

Ranks are **dense within the emitted page** and computed by the server from the sorted array; `rank`
is stored on the aggregate entry so all readers agree. Players with `total_prize_centavos === 0` are
**not** materialized into the leaderboard at all — a season entry exists only once a player has been
credited at least one qualifying prize.

Amounts are compared in centavos because reais are IEEE-754 doubles; comparing reais would make the
order depend on representation noise. `inspectReais` supplies the exact centavos at ingest.

---

## 5. Public leaderboard fields and privacy exclusions

### 5.1 Emitted fields

```jsonc
{
  "rank": 1,
  "uid": "…",                    // see 5.3 — pending central decision
  "player_id": "PLR-123456",     // pseudonymous handle
  "display_name": "",            // denormalized snapshot, see 5.3
  "total_prize_centavos": 125000,
  "wins": 3,
  "last_prize_at": "2026-08-03T18:22:11.000Z"
}
```

### 5.2 Hard exclusions

Never present on any public leaderboard document or callable response:

* `email`, `pix_key`, `whatsapp` (all PII on `users/{uid}`);
* `pix_key_snapshot` (on `withdrawals`);
* every wallet field: `balance`, `total_deposited`, `total_won`, `total_spent`,
  `total_withdrawn`, `beta_balance`;
* deposits, withdrawals and their states;
* entry fees paid, net position, or any figure from which a balance could be derived;
* any transaction id, `external_id`, or ledger row.

`total_prize_centavos` is a gross sum of prizes won. It is not a balance and cannot be inverted into
one, because entry fees, deposits and withdrawals are all excluded from it.

### 5.3 The display-name problem — **blocking decision required**

`users/{uid}.username` is written as `""` by `onUserCreated` and **is never populated**
([functions/src/index.ts:193-199](../../functions/src/index.ts#L193-L199)). This is a known, recorded
gap; [docs/username.md](../username.md) names this exact use case:

> any server-side feature that needs a name (leaderboards, tournament rosters, payout records) cannot
> rely on `users/{uid}.username`.

Compounding this, `firestore.rules` allows reading `users/{uid}` only to the owner or an admin
([firestore.rules:62-68](../../firestore.rules#L62-L68)), so a public leaderboard **cannot** join
against `users` at read time. Any public name must be **denormalized into the aggregate at write
time** by the backend (Admin SDK, which bypasses Rules).

Available identifiers, and why each is insufficient on its own:

| Candidate | Problem |
|---|---|
| `users.username` | Always `""`. Nothing to show. |
| Auth `displayName` | Lives in Firebase Auth, not Firestore. Not readable inside a Firestore trigger without an extra `auth().getUser()` call, and it is user-controlled and unvalidated (impersonation risk on a public surface). |
| `users.player_id` | Present and pseudonymous, but **not guaranteed unique**: `generatePlayerId()` is `PLR-` plus `Math.floor(100000 + Math.random() * 900000)` ([functions/src/index.ts:170-173](../../functions/src/index.ts#L170-L173)) — a 900 000-value space with no reservation, so collisions become likely in the low thousands of users. |
| `uid` | Exposing raw Auth uids publicly is an enumeration surface and is not human-readable. |

**Recommendation:** ship the leaderboard with `player_id` as the visible handle and `display_name`
as an empty-string-tolerant denormalized field, and treat the real fix as the `setUsername` callable
already proposed in [docs/username.md](../username.md) (Option A). Do **not** publish Auth
`displayName` on a public surface until server-side validation, profanity and impersonation checks
exist.

This is listed again in section 19 as requiring central approval.

---

## 6. Aggregate documents, collection paths and document ids

All new collections are backend-written only. Ids are deterministic so every write is idempotent by
construction — the same discipline the repository already applies to
`transactions/prize_{tid}`, `registrations/{uid}_{tid}` and `player_activity/{uid}_{day}`.

### 6.1 Season leaderboard entries

```text
season_rankings/{seasonDocId}/entries/{uid}
```

where `seasonDocId` is:

```text
cash_month_2026-08     cash_year_2026
beta_month_2026-08     beta_year_2026
```

The economy is part of the season document id. This makes it **structurally impossible** to write a
combined cash+beta total: the two live in different documents and no code path reads both into one
field.

Entry document:

```jsonc
{
  "uid": "…",
  "user_ref": "<DocumentReference users/{uid}>",
  "player_id": "PLR-123456",
  "display_name": "",
  "economy": "cash",              // "cash" | "beta_credit"
  "season_kind": "month",         // "month" | "year"
  "season_id": "2026-08",
  "total_prize_centavos": 125000,
  "wins": 3,
  "first_prize_at": "<Timestamp>",
  "last_prize_at": "<Timestamp>",
  "rank": 1,                      // materialized by the ranking pass, see 8.3
  "updated_at": "<Timestamp>"
}
```

### 6.2 Season parent document

```text
season_rankings/{seasonDocId}
```

```jsonc
{
  "economy": "cash",
  "season_kind": "month",
  "season_id": "2026-08",
  "timezone": "America/Sao_Paulo",
  "player_count": 42,
  "total_prize_centavos": 980000,
  "ranked_through": "<Timestamp>",   // last time ranks were materialized
  "rebuild_generation": 3,           // bumped by a full rebuild, see 7.3
  "updated_at": "<Timestamp>"
}
```

### 6.3 Idempotency markers

```text
ranking_events/{transactionId}
```

Document id is the **prize transaction id** — `prize_{tournamentid}` — which is already
deterministic and unique per tournament. Contents:

```jsonc
{
  "transaction_ref": "<DocumentReference transactions/prize_{tid}>",
  "uid": "…",
  "economy": "cash",
  "amount_centavos": 50000,
  "month_season_id": "2026-08",
  "year_season_id": "2026",
  "day_key": "2026-08-03",
  "applied_at": "<Timestamp>",
  "rebuild_generation": 3
}
```

This document is created **in the same Firestore transaction** as the two season-entry increments.
Its existence is the guard: if it exists, the event has already been applied and the handler returns
without writing. See section 7.

### 6.4 Admin metric daily buckets

```text
admin_metrics_daily/{dayKey}
```

`dayKey` is `YYYY-MM-DD` in `America/Sao_Paulo`, produced by `businessDayKey`. One document per
business day, holding every additive counter needed to answer the rolling windows in section 10 by
summation. Shape is specified in section 10.4.

### 6.5 Names deliberately avoided

The new design must not reuse any existing name. Already taken: collections `users`, `wallets`,
`transactions`, `withdrawals`, `registrations`, `tournaments`, `tournament_rooms`, `player_activity`;
callables listed in 0.1; and the transaction categories in 0.3. The proposed names
`season_rankings`, `ranking_events` and `admin_metrics_daily` collide with nothing at the design base.

---

## 7. Idempotent update, rebuild and backfill

### 7.1 The idempotency contract

Firestore triggers are **at-least-once**. Every ranking mutation therefore runs inside a
`db.runTransaction` that:

1. reads `ranking_events/{prizeTxId}`;
2. if it exists → return without writing (idempotent replay, no increment);
3. otherwise reads both season entry documents (monthly and annual);
4. writes both entries with values **computed from the read values in centavos**, and creates
   `ranking_events/{prizeTxId}`.

`FieldValue.increment()` is **forbidden** for money. The repository already established this rule and
its reason ([functions/src/index.ts:372-376](../../functions/src/index.ts#L372-L376)):

> Computed from the value read inside this transaction rather than `FieldValue.increment()`:
> `increment()` adds floats, which drift.

`total_prize_centavos` is an integer, so `increment()` would be numerically safe there — but the
read-compute-write form is required anyway because the guard document and the totals must commit
atomically, and because `wins`/`first_prize_at`/`last_prize_at` need the prior values regardless.

`addCentavos` must be used for the sum. Note its ceiling: `MAX_BALANCE_CENTAVOS = 1_000_000_000`
(R$ 10 000 000,00) ([functions/src/domain/money.ts:25](../../functions/src/domain/money.ts#L25)).
A season-wide total could plausibly exceed that ceiling even though no individual wallet does — see
section 15.4.

### 7.2 Ordering and the monthly/annual pair

Both the monthly and the annual entry are updated in the **same** transaction as the guard document.
They can never diverge: either all three writes commit or none does.

### 7.3 Rebuild and backfill

A rebuild is required because prize history predates this feature. The procedure follows the existing
audit CLI template ([functions/src/audit/cli.ts](../../functions/src/audit/cli.ts)) — an offline,
admin-run, dry-run-by-default tool, **not** a callable:

1. Bump `rebuild_generation` on the target season parent documents.
2. Page over `transactions` filtered by `category in ["prize","beta_prize"]` and
   `timestamp` within the season window, ordered by `timestamp`, using cursor pagination
   (`startAfter`) with a bounded page size. Requires the composite indexes in section 13.
3. For each row, recompute the season ids from `businessDayKey(timestamp)` and apply the section-7.1
   transaction. Rows whose `ranking_events/{txId}` already carries the **current**
   `rebuild_generation` are skipped; rows carrying an older generation are re-applied into freshly
   zeroed entries.
4. Materialize `rank` for each season by reading entries ordered by the section-4 comparator and
   writing `rank` in batches.
5. Write a reconciliation report (section 14).

A full rebuild writes into freshly zeroed season entries rather than adjusting in place, so a rebuild
is **convergent**: running it twice produces the same result as running it once.

Backfill is safe to run against live data because it only ever writes to the three new collections.
It never touches `transactions`, `wallets`, `tournaments` or `registrations`.

---

## 8. Where updates happen — settlement, trigger, or pipeline

**Decision: a dedicated Firestore `onDocumentCreated` trigger on `transactions/{transactionId}`,
plus an offline rebuild tool. Ranking is NOT written inside the settlement transaction.**

### 8.1 Why not inside the settlement transaction

`declareTournamentResultHandler` is a frozen, exactly-specified contract. `decideCompletedReplay`
compares the persisted result and transaction field-by-field and fails closed on **any** divergence
([functions/src/domain/settlement.ts:278-332](../../functions/src/domain/settlement.ts#L278-L332)).
Adding ranking writes to that transaction would:

* enlarge the settlement transaction's read/write set with documents that have nothing to do with
  paying the winner, so a contended season document could cause a settlement retry or failure —
  **a ranking problem must never be able to block a payout**;
* couple a non-financial aggregate to the financial invariant the audit tooling reconciles;
* require re-freezing a contract that the repository documents as frozen.

The financial invariant `balance == total_deposited + total_won - total_spent - total_withdrawn`
([functions/src/audit/reconcile.ts:42-46](../../functions/src/audit/reconcile.ts#L42-L46)) must
remain the only thing settlement guarantees atomically.

### 8.2 Why a trigger rather than a scheduled pipeline

A scheduled pipeline would make the leaderboard lag by the schedule interval and would require
scanning `transactions` on every run. The trigger reacts to exactly one new document, applies a
bounded three-document transaction, and is idempotent by section 7.1. A scheduled job is still
required, but only as a **reconciliation sweep** (section 14), not as the primary path.

### 8.3 Rank materialization

`rank` cannot be maintained incrementally without contention across the whole season. It is
materialized by a scheduled pass (default: every 15 minutes, and immediately after a rebuild) that
reads entries ordered by the section-4 comparator and writes `rank` in bounded batches. Between
passes, `rank` may be stale while the totals are current; the callable in section 9 therefore
computes order from the totals it reads and treats stored `rank` as a hint, so a client never sees a
contradictory ordering.

### 8.4 Cost of the new pattern

This introduces the repository's first Firestore document trigger. That is a deliberate,
documented departure and should be called out in review: it adds a new deployment surface, a new
failure mode (trigger retries), and a new emulator requirement in tests
(`firebase emulators:exec --only firestore,functions`).

---

## 9. Public leaderboard callable contracts

Two callables, both `central.https.onCall`, matching the existing handler/export split
(`export const xHandler = async (data, context) => {…}` then
`export const x = central.https.onCall(xHandler)`).

### 9.1 `getSeasonLeaderboard`

```ts
// request — exact payload, enforced by assertExactPayload
{
  economy: "cash" | "beta_credit",
  seasonKind: "month" | "year",
  seasonId: string,        // "YYYY-MM" for month, "YYYY" for year
  limit?: number,          // 1..100, default 50
  cursor?: string | null   // opaque, from a previous response
}

// response
{
  success: true,
  timezone: "America/Sao_Paulo",
  amountUnit: "centavos",
  economy: "cash",
  seasonKind: "month",
  seasonId: "2026-08",
  playerCount: 42,
  entries: [
    { rank, uid, player_id, display_name, total_prize_centavos, wins, last_prize_at }
  ],
  nextCursor: string | null,
  rankedThrough: string | null   // ISO instant; null before the first ranking pass
}
```

Authorization: `assertSignedIn`. The leaderboard is public **to authenticated users**, matching
`tournaments`, the only currently readable collection
([firestore.rules:137-139](../../firestore.rules#L137-L139)). It is not exposed to unauthenticated
callers, which avoids an unauthenticated enumeration surface.

`limit` is hard-capped at **100** server-side regardless of what the client sends. There is no
"return everything" mode.

### 9.2 `getMySeasonRanking`

```ts
// request
{ economy: "cash" | "beta_credit", seasonKind: "month" | "year", seasonId: string }

// response
{
  success: true, timezone, amountUnit: "centavos",
  economy, seasonKind, seasonId,
  entry: { rank, total_prize_centavos, wins, last_prize_at } | null,
  playerCount: 42
}
```

Authorization: `assertSignedIn`. The uid comes **exclusively from the verified token** and is never
accepted in the payload — the same rule `getPlayerEngagementStats` already enforces
([functions/src/index.ts:2167-2170](../../functions/src/index.ts#L2167-L2170)). This lets a player
see their own placement without paging the whole leaderboard.

### 9.3 Shared conventions

Both reuse `assertExactPayload` so any unexpected key is `invalid-argument`, both disclose
`timezone` and `amountUnit` exactly as `getPlayerEngagementStats` does, and both return pt-BR error
messages via `toHttpsError`.

---

## 10. Admin-only metrics

### 10.1 The prohibition this design satisfies

Administrative metrics must never be computed by letting the client read the whole `transactions`
collection. Under current Rules a client **cannot** do so anyway — `transactions` read requires
`isOwnerByUserRef() || isAdmin()` ([firestore.rules:80-86](../../firestore.rules#L80-L86)) — but an
admin-claimed account *could*, and a Flutter admin screen that paged the collection would be exactly
the prohibited design. This contract forecloses it: metrics come from pre-aggregated daily buckets
read by a single admin-only callable, and the client is never given a query surface over
`transactions`.

### 10.2 Rolling window definitions

Windows are **exact rolling windows anchored at the request instant `now`**, not calendar buckets:

| Filter | Definition |
|---|---|
| `24h` | `(now - 24 hours, now]` |
| `7d` | `(now - 7 × 24 hours, now]` |
| `30d` | `(now - 30 × 24 hours, now]` |
| `365d` | `(now - 365 × 24 hours, now]` |
| `all` | `(beginning of time, now]` |

**Boundary rule:** windows are half-open — exclusive at the older edge, inclusive at `now`. A row
whose `timestamp` equals exactly `now - 24h` is **outside** the 24h window.

**Granularity caveat, stated explicitly rather than hidden:** the daily buckets of section 6.4 have
one-day granularity in `America/Sao_Paulo`. A rolling window whose edge falls mid-day cannot be
answered exactly from day buckets alone. Two options, and the recommendation:

* **(A) Day-aligned approximation.** Sum whole buckets from `businessDayKey(now - N days)` through
  `businessDayKey(now)`. Cheap and always O(N) document reads. The reported window is then
  day-aligned, not instant-aligned.
* **(B) Exact.** Sum whole buckets for the interior and run two bounded, indexed range queries over
  `transactions` for the two partial edge days.

**Recommendation: (B) for `24h`, `7d` and `30d`; (A) for `365d` and `all`.** The edge queries are
bounded by one business day of transactions, which is small, while a 365-day exact window would need
365 bucket reads plus edges and gains nothing material. Every response states which mode produced it
via `windowMode: "exact" | "day_aligned"`, so a dashboard never implies precision it does not have.

### 10.3 Metric definitions and data sources

All amounts in **integer centavos**. Cash and beta are reported in separate blocks and never summed.

| # | Metric | Exact definition | Source |
|---|---|---|---|
| 1 | Transaction count | Number of `transactions` rows with `status === "completed"` in window, per category | `admin_metrics_daily.count_by_category` |
| 2 | Transaction volume | Σ `amount` in centavos over the same rows, per category | `admin_metrics_daily.sum_centavos_by_category` |
| 3 | Average transaction size | `sum_centavos / count`, integer-divided, per category. Undefined (`null`) when `count === 0` | derived from 1 and 2 |
| 4 | Median transaction size | 50th percentile of `amount`. **Not derivable from sums** — see 10.5 | `admin_metrics_daily.histogram_by_category` |
| 5 | Entry fees | Σ `amount` where `category === "entry_fee"` (cash) / `beta_entry_fee` (beta), `status === "completed"` | bucket |
| 6 | Prizes distributed | Σ `amount` where `category === "prize"` (cash) / `beta_prize` (beta), `status === "completed"` | bucket |
| 7 | Gross Sparta fee | **NOT COMPUTABLE — see 10.6** | — |
| 8 | Partner commission | **NOT COMPUTABLE — Session 3, see 10.6 and 18** | — |
| 9 | Net Sparta revenue | **NOT COMPUTABLE — depends on 7 and 8** | — |
| 10 | Withdrawal states | Count and Σ `amount` of `withdrawals` grouped by `status`. **Today `status` is only ever `"pending"` — see 10.7** | `admin_metrics_daily.withdrawals_by_status` |
| 11 | New users | Count of `users` documents created in window. **NO timestamp field exists on `users` — see 10.8** | blocked |
| 12 | Partner-attributed users | **NOT COMPUTABLE — Session 3** | — |
| 13 | Conversion by partner | **NOT COMPUTABLE — Session 3** | — |
| 14 | Highest-volume tournaments | Top N tournaments by Σ `entry_fee` amount in window, and separately by `prize` amount | `admin_metrics_daily.tournament_volume` (capped map, see 10.4) |
| 15 | Suspicious or duplicate events | See 10.9 | derived + reconciliation sweep |

### 10.4 `admin_metrics_daily/{dayKey}` shape

```jsonc
{
  "day_key": "2026-08-03",
  "timezone": "America/Sao_Paulo",
  "count_by_category":       { "entry_fee": 120, "prize": 8, "withdrawal": 3, "deposit": 15, … },
  "sum_centavos_by_category":{ "entry_fee": 600000, "prize": 400000, … },
  "histogram_by_category":   { "entry_fee": { "0": 0, "1": 12, … }, … },   // see 10.5
  "withdrawals_by_status":   { "pending": { "count": 3, "sum_centavos": 15000 } },
  "tournament_volume":       { "<tid>": { "entry_centavos": 50000, "prize_centavos": 40000,
                                          "registrations": 10 } },        // capped, see below
  "new_users":               null,                                        // see 10.8
  "registrations":           37,
  "generation": 1,
  "updated_at": "<Timestamp>"
}
```

`tournament_volume` is a map keyed by tournament id. A Firestore document is capped at ~1 MiB, so
this map is bounded to the **top 200 tournaments by entry volume for that day**; the bucket records
`tournament_volume_truncated: true` and `tournament_volume_dropped: <n>` when the cap bites. Silent
truncation is forbidden — a dashboard must be able to tell that it is seeing a capped list.

### 10.5 Median — the honest approach

A median cannot be reconstructed from daily sums and counts. Options considered:

* store every amount → unbounded document growth, rejected;
* exact median by scanning `transactions` in the window → the prohibited full-collection read;
* **fixed-bucket histogram → chosen.**

Each daily bucket stores a histogram of `amount` per category using **logarithmic centavo buckets**:
bucket `i` covers `[2^i, 2^(i+1))` centavos, for `i` in `0..30` (1 centavo up to ~R$ 10 737 418).
Bucket `0` additionally absorbs `amount === 0`.

Histograms are additive, so a window median is computed by summing the per-day histograms and walking
to the 50 % cumulative count. The result is reported as an **interval**, not a false point value:

```jsonc
"median_centavos": { "lowerBound": 4096, "upperBound": 8191, "approximate": true }
```

Any consumer wanting a single number takes the lower bound and must display it as approximate. If
central coordination requires an exact median, that is an offline reconciliation-report figure
(section 14), not a live dashboard figure.

### 10.6 Fee and commission metrics — **not computable at this base**

There is **no fee, commission, rake, or revenue-split concept anywhere in the backend.** An
exhaustive search for `partner`, `affiliate`, `referr`, `commission`, `attribut`, `sponsor`,
`coupon`, `promo`, `rake` and `revenue` across `functions/src`, `functions/test`, `firestore.rules`,
`firestore.indexes.json` and `docs/` returns **no functional match** — the only hits are the word
"decommissioned" in [docs/admin-transition.md](../admin-transition.md) and unrelated prose.

Concretely, settlement credits the winner the tournament's **full** `prize` and takes nothing:
`prizeCentavos` comes straight from `tournaments/{tid}.prize` and the entire amount is credited
([functions/src/index.ts:920-1017](../../functions/src/index.ts#L920-L1017)). Entry fees go to the
platform implicitly — there is no house account, no fee ledger row, and no split.

Therefore **gross Sparta fee, partner commission and net Sparta revenue cannot be defined, let alone
computed, at this design base.** This contract does not invent them. Any definition would be a
product decision with financial consequences and must come from central coordination plus Session 3.

An arithmetic *proxy* is available and should be labelled as such if a dashboard needs a placeholder:

```text
implied_gross_margin_centavos = Σ entry_fee − Σ prize      (cash only, per window)
```

This is **not** "Sparta fee". It is the difference between what players paid in and what was paid
out, it ignores payment-processor costs and any future partner split, and it must never be presented
as revenue. Recommendation: do not ship it as a named revenue metric until section 19 item 3 is
resolved.

### 10.7 Withdrawal states

`requestwithdrawal` writes `withdrawals/{externalId}` with `status: "pending"` and debits the wallet
immediately ([functions/src/index.ts:370-408](../../functions/src/index.ts#L370-L408)). The
`provider`, `provider_status`, `pix_tx_id`, `paid_at` and `failed_at` fields are written as `null`
and reserved for a future PIX integration.

**No deployed function ever transitions a withdrawal out of `pending`.** The audit module states this
directly ([functions/src/audit/reconcile.ts:30-35](../../functions/src/audit/reconcile.ts#L30-L35)):

> No function anywhere completes, reverses or refunds a withdrawal. So a "pending" withdrawal is
> ALREADY paid for by the wallet.

The metric is therefore defined over the observed status set, which is `{"pending"}` today. The
aggregate must key by whatever `status` string it observes rather than a hardcoded enum, so that
`paid` and `failed` appear automatically when the PIX integration lands. The dashboard must not
display "pending" as "awaiting payment from the player's balance" — the balance is already debited.

### 10.8 New users — **blocked, no timestamp exists**

`onUserCreated` writes exactly `{ email, username, player_id, pix_key, whatsapp }`
([functions/src/index.ts:193-199](../../functions/src/index.ts#L193-L199)). There is **no
`created_at`** on `users/{uid}`, and Firestore cannot query by document creation time.

Firebase Auth's `metadata.creationTime` exists but is not queryable from Firestore and would require
paging the entire Auth user list — the Auth-side equivalent of the prohibited full-collection scan.

Options:

* **(A)** Add `created_at: FieldValue.serverTimestamp()` to `onUserCreated`. One-line change,
  but it is a **source-code change to a financial-adjacent trigger** and is therefore out of scope
  for this phase. New users are counted only from the deploy date forward; history is not
  reconstructable from Firestore.
* **(B)** Derive a proxy from the first `player_activity` document per uid. Only covers users who
  opened the app after `player_activity` shipped, and conflates signup with first open.
* **(C)** One-off Auth export to seed historical `created_at`, then (A) going forward.

**Recommendation: (A) for the forward path plus (C) for history**, both scheduled as implementation
work in a later session. Until then the bucket stores `new_users: null` and the callable reports the
metric as `unavailable` with a reason string — never `0`, which would read as "nobody signed up".

### 10.9 Suspicious or duplicate events

Detected by the reconciliation sweep (section 14) and surfaced as counts, never as raw rows:

* a `transactions` row whose `category` is not in the canonical table of 0.3 (`unknownCategory`);
* a row whose `amount` fails `inspectReais` (`malformedAmount`);
* a row with no usable `timestamp` (`undated`);
* a `prize` row whose id is not `prize_{tournamentid}` — indicates a legacy or hand-written prize;
* more than one prize row referencing the same `tournament_ref`;
* a `tournaments/{tid}.result` with no corresponding transaction, or vice versa (partial settlement);
* a wallet violating `balance == total_deposited + total_won − total_spent − total_withdrawn`;
* a beta wallet violating `beta_balance == grants + prizes + refunds − entry_spend`;
* a `registrations` row whose `transaction_ref` does not resolve or whose `entry_fee_snapshot`
  disagrees with the referenced ledger row;
* more than one `entry_fee` row for the same `(user_ref, tournament_ref)` pair — entry-fee ledger
  ids are caller-supplied rather than deterministic, so duplicate entry rows are not structurally
  excluded the way duplicate prize rows are;
* a non-prize row occupying the deterministic prize namespace — a document whose id matches
  `prize_*` but whose `category` is not `prize`/`beta_prize`. This is reachable today because
  `testdeposit` accepts a caller-supplied `externalid` and uses it verbatim as the document id
  without the length/`/` validation every other identifier receives
  ([functions/src/index.ts:159-168](../../functions/src/index.ts#L159-L168)). It is admin-gated and
  hardcodes `category: "deposit"`, so it **cannot** forge a ranking-bearing row — the allowlist in
  section 2.5 rejects it — but a namespace collision would make a real settlement fail with
  `already-exists`, so it is worth surfacing.

The last several are exactly what
[functions/src/audit/reconcile.ts](../../functions/src/audit/reconcile.ts) already computes; the
metric surfaces its counts rather than reimplementing the checks.

### 10.10 `getAdminMetrics` callable contract

```ts
// request
{
  window: "24h" | "7d" | "30d" | "365d" | "all",
  economy?: "cash" | "beta_credit" | "both",   // default "both"
  includeTournaments?: boolean,                 // default false — the expensive block
  tournamentLimit?: number                      // 1..50, default 10
}

// response (abridged)
{
  success: true,
  timezone: "America/Sao_Paulo",
  amountUnit: "centavos",
  window: "7d",
  windowMode: "exact",
  windowStart: "<ISO>", windowEnd: "<ISO>",
  cash: {
    transactionCount: { entry_fee: 120, prize: 8, … },
    transactionVolumeCentavos: { … },
    averageCentavos: { … },
    medianCentavos: { lowerBound, upperBound, approximate: true },
    entryFeesCentavos, prizesDistributedCentavos,
    impliedGrossMarginCentavos,          // labelled, NOT revenue — see 10.6
    grossSpartaFeeCentavos: null,        // unavailable
    partnerCommissionCentavos: null,     // unavailable
    netSpartaRevenueCentavos: null       // unavailable
  },
  betaCredit: { … same shape … },
  withdrawals: { pending: { count, sumCentavos } },
  newUsers: null,
  partnerAttributedUsers: null,
  conversionByPartner: null,
  topTournaments: [ { tournamentId, entryCentavos, prizeCentavos, registrations } ],
  topTournamentsTruncated: false,
  suspicious: { unknownCategory: 0, malformedAmount: 0, undated: 0,
                duplicatePrize: 0, partialSettlement: 0, walletDrift: 0 },
  unavailable: [
    { metric: "grossSpartaFee",    reason: "no fee or revenue-split model exists at this base" },
    { metric: "partnerCommission", reason: "no partner model; pending Session 3" },
    { metric: "netSpartaRevenue",  reason: "depends on grossSpartaFee and partnerCommission" },
    { metric: "newUsers",          reason: "users/{uid} has no created_at field" },
    { metric: "partnerAttributedUsers", reason: "no attribution model; pending Session 3" },
    { metric: "conversionByPartner",    reason: "no attribution model; pending Session 3" }
  ]
}
```

Every unavailable metric is `null` **and** carries an explicit reason. Nothing is reported as `0`
when the truth is "we cannot know".

---

## 11. Metric definitions and data sources — summary

Consolidated in the table at 10.3, with per-metric detail in 10.4–10.9. Two rules govern all of them:

1. **Every figure traces to an immutable ledger row or an aggregate derived from one.** No metric is
   derived from an engagement aggregate, a wallet total, or a client-supplied value.
2. **Cash and beta are never summed**, in any metric, at any window.

---

## 12. Admin authorization, response limits and leak protection

### 12.1 Authorization

`getAdminMetrics` calls `assertAdmin(context, unauthenticatedMessage, permissionDeniedMessage)`
([functions/src/domain/adminAuth.ts:54-70](../../functions/src/domain/adminAuth.ts#L54-L70)) as its
**first statement**, before payload parsing, before any read. Authorization is the Firebase Auth
custom claim `admin: true` and nothing else — strict `=== true`, so `"true"`, `1` or a truthy object
never grant access.

Error ordering is deliberate and matches the deployed convention: not signed in →
`unauthenticated`; signed in without the claim → `permission-denied`. These are distinguishable,
which reveals only whether the caller is authenticated — information the caller already possesses.

### 12.2 Response limits

* `getSeasonLeaderboard`: `limit` clamped to `[1, 100]`, default 50; cursor-based paging only.
* `getMySeasonRanking`: single entry, no paging surface.
* `getAdminMetrics`: `tournamentLimit` clamped to `[1, 50]`, default 10; the tournament block is
  opt-in via `includeTournaments`.
* Every callable uses `assertExactPayload`, so an unexpected key is `invalid-argument` rather than a
  silently ignored field
  ([functions/src/domain/settlement.ts:41-56](../../functions/src/domain/settlement.ts#L41-L56)).
* No callable accepts a raw query, filter, field list, ordering, or collection name from the client.

### 12.3 Leak protection

* `getAdminMetrics` returns **only aggregates**. It never returns a transaction id, a uid, a
  `pix_key`, an `external_id`, or any row-level document. `topTournaments` returns tournament ids —
  which every signed-in user can already read ([firestore.rules:137-139](../../firestore.rules#L137-L139)) —
  and never uids.
* The public leaderboard callables never read `users` at request time; they return only the
  denormalized fields listed in 5.1.
* Suspicious-event metrics are **counts only**. Investigating a specific flagged row is an offline
  audit-CLI operation, not a callable response.
* Because the aggregate collections are backend-written and Rules-denied to clients (section 13),
  an admin-claimed client cannot bypass these limits by reading the aggregates directly.

---

## 13. Required Firestore Rules and indexes

### 13.1 Rules

`firestore.rules` ends with a catch-all deny
([firestore.rules:181-183](../../firestore.rules#L181-L183)), so the three new collections are
**already denied** to every client without any change. The design deliberately keeps them that way:
all three are read through callables (Admin SDK, which bypasses Rules).

Explicit match blocks are still recommended so the posture is stated rather than inherited:

```javascript
// SEASON RANKINGS — written only by the ranking trigger / rebuild tool.
// Read through getSeasonLeaderboard / getMySeasonRanking, never directly, so the
// server controls paging, field selection and the privacy exclusions.
match /season_rankings/{seasonId} {
  allow read, write: if false;
  match /entries/{uid} {
    allow read, write: if false;
  }
}

// RANKING IDEMPOTENCY MARKERS — internal bookkeeping, never client-visible.
match /ranking_events/{transactionId} {
  allow read, write: if false;
}

// ADMIN METRIC BUCKETS — admin data, read only through getAdminMetrics so the
// response limits and the unavailable-metric disclosures always apply.
match /admin_metrics_daily/{dayKey} {
  allow read, write: if false;
}
```

Note `read: if false` even for admins: the metrics callable is the only sanctioned surface, which
prevents a Flutter admin screen from paging buckets directly and reconstructing a per-day ledger.
This is what makes the section-10.1 prohibition structural rather than advisory.

### 13.2 Indexes

`firestore.indexes.json` is guarded by
[functions/test/unit/firestoreIndexes.test.ts](../../functions/test/unit/firestoreIndexes.test.ts).
That test uses `.find()` for the legacy-ledger composite and asserts no duplicate **equivalent**
index for the exact field triple `["category","user_ref","tournament_ref"]`. **Adding new indexes for
other field combinations does not break it.** The existing index must be preserved verbatim.

Required additions (for the rebuild/backfill of section 7.3 and the exact edge queries of 10.2):

```jsonc
// prize rows for a season window, in settlement order
{ "collectionGroup": "transactions", "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "category",  "order": "ASCENDING" },
              { "fieldPath": "status",    "order": "ASCENDING" },
              { "fieldPath": "timestamp", "order": "ASCENDING" } ] }

// leaderboard ordering within a season
{ "collectionGroup": "entries", "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "total_prize_centavos", "order": "DESCENDING" },
              { "fieldPath": "wins",                 "order": "DESCENDING" },
              { "fieldPath": "last_prize_at",        "order": "ASCENDING" },
              { "fieldPath": "uid",                  "order": "ASCENDING" } ] }

// withdrawals by state within a window
{ "collectionGroup": "withdrawals", "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "status",       "order": "ASCENDING" },
              { "fieldPath": "requested_at", "order": "ASCENDING" } ] }
```

The `entries` index is `COLLECTION` scope, matched under each season document. If cross-season
queries are ever needed it must become `COLLECTION_GROUP`; that is not required by this contract.

New index objects must follow the existing file conventions — `collectionGroup`, `queryScope`,
`fields[].fieldPath`, `fields[].order` — and `fieldOverrides` must remain an array, which the guard
test asserts. Note that the existing file also uses a `density: "SPARSE_ALL"` key on three entries;
new indexes should omit it unless a sparse index is specifically wanted.

**Pre-existing index observation (not introduced by this design).** `firestore.indexes.json` declares
two `wallets` composite indexes over `user_id` + `updated` and `user_ref` + `updated`. Neither
`user_id` nor `updated` is written or read anywhere in `functions/src` — the wallet document has
`user_ref` and, on exactly one code path, `updated_at`. These indexes are either serving a client
query the backend does not know about or are dead. This design neither relies on nor removes them;
it is recorded so a future index cleanup is a deliberate decision rather than an accident.

**Indexes are not deployed in this phase.** They are versioned for a later
`firebase deploy --only firestore:indexes`, exactly as the existing composite index was.

---

## 14. Backfill, reconciliation and correction

### 14.1 Backfill

Section 7.3. Offline CLI, dry-run by default, follows the
[functions/src/audit/cli.ts](../../functions/src/audit/cli.ts) template, writes only to the three new
collections.

### 14.2 Reconciliation sweep

A scheduled job (daily, off-peak in `America/Sao_Paulo`) that:

1. recomputes each open season's totals from `transactions` by paged query;
2. compares against the stored aggregates;
3. writes a drift report and emits the section-10.9 suspicious-event counts;
4. **reports drift; it does not silently repair it.**

This mirrors the existing reconciliation posture, which classifies and reports rather than mutating.

### 14.3 Correction

Correcting a ranking aggregate is a **rebuild of the affected season**, not an in-place edit:
bump `rebuild_generation`, zero the entries, re-apply from the ledger. This keeps the aggregate a
pure function of the immutable ledger, so no correction can introduce a value that the ledger does
not support.

Correcting the **ledger** is out of scope for this contract and remains an audit-CLI concern. If a
compensating financial category is ever introduced, section 2.5 must be amended first.

---

## 15. Failure handling and financial invariants

### 15.1 Ranking must never block money

The ranking trigger runs after the settlement transaction has committed. A trigger failure, retry, or
permanent error can delay or omit a leaderboard entry; it can never delay, reverse, or duplicate a
payout. This is the primary reason for the section-8 decision.

### 15.2 Invariants preserved

The design writes to no existing collection, so both audited identities are untouched:

```text
balance      == total_deposited + total_won − total_spent − total_withdrawn
beta_balance == beta_grants + beta_prizes + beta_refunds − beta_entry_spend
```

### 15.3 Ranking-specific invariants

For every season document:

```text
entries[*].total_prize_centavos  == Σ amounts of qualifying prize rows for that uid and season
entries[*].wins                  == count of those rows
season.total_prize_centavos      == Σ entries[*].total_prize_centavos
season.player_count              == count of entries
```

and globally:

```text
Σ monthly totals of a year == the annual total for the same economy and year
```

The reconciliation sweep asserts all of these.

### 15.4 The aggregate overflow ceiling — **a real constraint**

`addCentavos` throws `failed-precondition` when a sum exceeds `MAX_BALANCE_CENTAVOS = 1_000_000_000`
centavos (R$ 10 000 000,00)
([functions/src/domain/money.ts:212-223](../../functions/src/domain/money.ts#L212-L223)). That bound
was chosen for a **single wallet**. A season-wide or annual platform total can plausibly exceed it
while no individual wallet does.

A per-player season total is very unlikely to breach it. The **season parent**
`total_prize_centavos` and the admin `sum_centavos_by_category` realistically can.

Resolution — required before implementation:

* per-player entry totals: use `addCentavos` unchanged;
* season-parent and admin-bucket totals: use a distinct helper with a higher explicit ceiling
  (proposed `MAX_AGGREGATE_CENTAVOS = 1_000_000_000_000`, R$ 10 000 000 000,00, still far inside
  `Number.MAX_SAFE_INTEGER` at 9.007e15), defined alongside the existing constants and unit-tested
  for the overflow boundary.

Reusing `addCentavos` for platform-wide sums would make the metrics callable start throwing once the
platform crosses R$ 10 M cumulative — a latent production failure. Flagged in section 19.

### 15.5 Failure modes

| Failure | Handling |
|---|---|
| Trigger retried after partial write | Impossible — guard doc and both entries commit in one transaction |
| Trigger never fires (missed event) | Reconciliation sweep detects drift; rebuild repairs |
| Malformed `amount` on a prize row | Row excluded, counted in `malformedAmount`, never guessed |
| Missing/unparseable `timestamp` | Row excluded, counted in `undated` — it cannot be assigned a season |
| Season document contention | Bounded: one prize row per tournament; retries are safe by 7.1 |
| Aggregate overflow | `failed-precondition` surfaced to the sweep, never a silent wrap — see 15.4 |
| Rank pass interrupted | `rank` stale, totals correct; callable orders by totals regardless |

---

## 16. Test matrices

Tiers follow [functions/package.json](../../functions/package.json): `npm test` (unit, `node:test`
over `lib-test/test/unit/*.test.js`), `npm run test:rules` (Firestore emulator,
`--test-concurrency=1`), `npm run test:e2e` (auth + firestore + functions emulators). Emulator project
id is `demo-sparta-battle`.

### 16.1 Unit — `functions/test/unit/seasonRanking.test.ts`

| Case | Expectation |
|---|---|
| Season id from an instant just after local midnight | Bucketed to the new São Paulo day, not UTC |
| Season id at `2026-08-01T02:00:00Z` | `2026-07` (still July 31 in São Paulo) |
| Season id at `2026-08-01T04:00:00Z` | `2026-08` |
| Annual boundary `2026-12-31T23:59:59-03:00` vs `+1s` | `2026` then `2027` |
| Category `prize` | Eligible, cash economy |
| Category `beta_prize` | Eligible, beta economy, never cash |
| Categories `entry_fee`/`entry_refund`/`deposit`/`withdrawal`/`beta_grant`/`beta_refund`/`beta_entry_fee` | All ineligible |
| Unknown category `admin_correction` | Ineligible (allowlist) |
| `status !== "completed"` | Ineligible |
| `amount` malformed / negative / >2 decimals / NaN | Excluded and counted |
| Tie: equal totals, different wins | Higher wins first |
| Tie: equal totals and wins, different `last_prize_at` | Earlier first |
| Tie: all equal | Lower `uid` first — strict total order |
| Comparator | Antisymmetric and transitive over a generated set |
| `addCentavos` at the aggregate ceiling | Throws; aggregate helper does not — 15.4 |

### 16.2 Unit — `functions/test/unit/adminMetrics.test.ts`

| Case | Expectation |
|---|---|
| Window edges half-open | `now − 24h` exactly is excluded; `now` included |
| Average with `count === 0` | `null`, never `0` and never a division by zero |
| Histogram median, odd/even counts | Correct bucket interval |
| Histogram additivity | Σ of day histograms == histogram of the union |
| Median when all rows in one bucket | `lowerBound`/`upperBound` are that bucket |
| Cash and beta blocks | Never summed; no combined field exists |
| Unavailable metrics | `null` plus a reason string; never `0` |
| `tournament_volume` beyond cap | `truncated: true` and a dropped count |
| `windowMode` | `"exact"` for 24h/7d/30d, `"day_aligned"` for 365d/all |

### 16.3 Handler — `functions/test/rules/seasonRanking.handlers.test.ts`

| Case | Expectation |
|---|---|
| Trigger applies a prize once | Both season entries and the guard doc created |
| Trigger replayed with same tx id | No increment; totals unchanged |
| Two distinct prizes, same uid, same season | Totals and `wins` accumulate exactly |
| Prize spanning a month boundary | Correct monthly bucket; both land in the same annual bucket |
| Non-prize transaction created | Trigger writes nothing |
| Malformed prize row | Trigger writes nothing and records the exclusion |
| Guard doc present but entries missing | Treated as applied — reported as drift, not silently re-applied |
| `getSeasonLeaderboard` `limit` 1000 | Clamped to 100 |
| `getSeasonLeaderboard` unexpected key | `invalid-argument` |
| `getMySeasonRanking` with `uid` in payload | `invalid-argument` — uid comes only from the token |
| `getMySeasonRanking` for a player with no prizes | `entry: null`, not a synthesized zero row |

### 16.4 Negative authorization — `functions/test/rules/adminMetrics.auth.test.ts`

| Case | Expectation |
|---|---|
| `getAdminMetrics` unauthenticated | `unauthenticated` |
| `getAdminMetrics` signed in, no claim | `permission-denied` |
| `admin: "true"` (string) | `permission-denied` — strict `=== true` |
| `admin: 1` | `permission-denied` |
| `admin: false` / claim absent | `permission-denied` |
| `admin: true` | Succeeds |
| Auth check precedes payload parsing | A malformed payload from a non-admin still yields `permission-denied`, not `invalid-argument` |
| `getSeasonLeaderboard` unauthenticated | `unauthenticated` |

### 16.5 Rules — `functions/test/rules/seasonRanking.rules.test.ts`

| Case | Expectation |
|---|---|
| Client reads `season_rankings/{id}` | Denied |
| Client reads `season_rankings/{id}/entries/{uid}` — own uid | Denied |
| Admin client reads any of the above | Denied — callable is the only surface |
| Client reads `ranking_events/{txId}` | Denied |
| Client or admin reads `admin_metrics_daily/{day}` | Denied |
| Any client write to any of the three | Denied |
| Existing collections | Postures unchanged from the current suite |

### 16.6 E2E — `functions/test/e2e/seasonRankingFlow.e2e.test.ts`

Full emulator flow: create tournament → join → start → `declareTournamentResult` → assert the prize
transaction, then assert both season entries, the guard document, and the admin bucket; replay
`declareTournamentResult` and assert no double count; run the rebuild tool and assert convergence to
identical totals.

### 16.7 Index guard

`functions/test/unit/firestoreIndexes.test.ts` must continue to pass unchanged after the section-13.2
additions. A new assertion should cover each added index.

---

## 17. Expected source files for later implementation

| File | Contents |
|---|---|
| `functions/src/domain/seasonRanking.ts` | Pure rules: season id derivation, eligibility allowlist, comparator, aggregate arithmetic. No Admin SDK, no `firebase-functions` — matches the existing domain-layer convention. |
| `functions/src/domain/adminMetrics.ts` | Pure rules: window boundaries, histogram bucketing, median interval, average, unavailable-metric declarations. |
| `functions/src/domain/aggregateMoney.ts` | `MAX_AGGREGATE_CENTAVOS` and the aggregate-safe add — section 15.4. Alternatively an addition to `money.ts`; keeping it separate avoids touching a frozen financial module. |
| `functions/src/index.ts` | New exports only: `onPrizeTransactionCreated`, `getSeasonLeaderboard`, `getMySeasonRanking`, `getAdminMetrics`, each with its `…Handler` counterpart, pinned to `REGION_CALLABLES`. Existing exports untouched. |
| `functions/src/ranking/rebuild.ts` + `functions/src/ranking/cli.ts` | Offline backfill/rebuild, dry-run by default. |
| `firestore.rules` | The three match blocks of 13.1. |
| `firestore.indexes.json` | The three index objects of 13.2. |
| `firebase.json` | Add `lib/ranking` to the functions `ignore` list, matching `lib/audit` and `lib/adminclaim`, so the CLI is not deployed. |
| Tests | The six files of section 16. |

[functions/test/unit/functionRegions.test.ts](../../functions/test/unit/functionRegions.test.ts)
pins regions by asserting `__trigger.regions` against an **explicit hardcoded list** of the fourteen
current callables. It does **not** discover exports automatically, so a new callable that forgets
`.region(...)` would silently deploy to the SDK default `us-central1` and the test would still pass.
Every new export in section 17 must therefore be added to that list explicitly — this is a required
step, not a nicety.

---

## 18. Partner-session handoff

Session 3 owns the partner/attribution model. **Nothing about partners exists at this design base** —
sections 10.6 and 0.3 establish that there is no partner entity, no attribution field, no commission
category, and no revenue split anywhere in the backend.

Six admin metrics are blocked on Session 3: partner commission, net Sparta revenue,
partner-attributed users, conversion by partner, and — indirectly — gross Sparta fee and any
credible revenue figure.

### 18.1 Entities Session 3 must define

| Requirement | Detail this contract needs |
|---|---|
| Partner entity | Collection path, document id scheme, and whether a partner is a user, an organization, or both |
| Partner identity on a user | The exact field on `users/{uid}` carrying attribution (proposed `partner_ref`), set once at signup and immutable thereafter |
| Attribution timestamp | When attribution occurred, as a server timestamp — required to bucket "partner-attributed users" into a window |
| Attribution provenance | How attribution is captured (referral code, deep link, invite) and whether it can be changed or reassigned |

### 18.2 Events Session 3 must emit

| Event | Required fields |
|---|---|
| Partner attribution assigned | `uid`, `partner_ref`, `attributed_at` (server timestamp), `source`, `idempotency_key` |
| Commission accrued | `partner_ref`, `tournament_ref`, `transaction_ref` of the originating ledger row, `commission_centavos`, `economy_type`, `accrued_at`, deterministic document id |
| Commission settled/paid | `partner_ref`, `period`, `amount_centavos`, `settled_at`, deterministic document id |

Every commission event must be an **immutable ledger row with a deterministic id**, exactly like
`transactions/prize_{tid}`, so the metrics pipeline can apply it idempotently through the same
guard-document mechanism as section 7.1.

### 18.3 Fields Session 3 must add to the fee model

For gross Sparta fee and net revenue to become computable, settlement or entry must record the split
explicitly at the moment money moves:

* `gross_fee_centavos` — what Sparta retained from the entry pool;
* `partner_commission_centavos` — what is owed to a partner for that event;
* `net_revenue_centavos` — `gross_fee − partner_commission`;
* the `partner_ref` the commission is attributed to;
* `economy_type`, since a beta-credit tournament must never produce cash revenue.

**These must be written as ledger rows, not computed after the fact from tournament configuration.**
A tournament's fee configuration can change; the ledger cannot. Computing historical revenue from
current configuration would produce a figure that silently changes when configuration changes.

### 18.4 Constraints Session 3 must respect

1. Cash and beta remain unsummed. A beta tournament must not produce cash commission.
2. Commission rows must use **new categories** and must not reuse `prize`, `entry_fee` or any
   existing category — doing so would corrupt the ranking, the wallet identity, and the reconciler.
3. Any new category must be added to the canonical table in
   [functions/src/domain/engagementStats.ts](../../functions/src/domain/engagementStats.ts) and to
   `KNOWN_CATEGORIES` in [functions/src/audit/reconcile.ts](../../functions/src/audit/reconcile.ts),
   or it will be silently excluded from every existing aggregate.
4. Partner identity must never reach the public leaderboard.
5. Attribution must be idempotent — a user is attributed to at most one partner, once.

### 18.5 What Session 3 can rely on from this session

* The season aggregate schema and the guard-document idempotency pattern (sections 6, 7).
* The daily admin bucket, which has room for partner-keyed sub-maps under the same cap-and-disclose
  rule as `tournament_volume` (10.4).
* `getAdminMetrics` already returns `partnerCommission`, `netSpartaRevenue`,
  `partnerAttributedUsers` and `conversionByPartner` as `null` with reasons; Session 3 fills them in
  without changing the response shape.

---

## 19. Unresolved conflicts and decisions requiring central approval

| # | Decision | Why it cannot be settled here | Recommendation |
|---|---|---|---|
| 1 | **Public display name.** `users.username` is permanently `""`; `player_id` is not collision-free; Auth `displayName` is unvalidated and not in Firestore; `users` is not publicly readable. | Product + safety decision (impersonation, profanity, uniqueness), not a technical one. Recorded as open in [docs/username.md](../username.md). | Ship with `player_id`; prioritize the `setUsername` callable (username.md Option A) before any public launch. |
| 2 | **Separate cash and beta leaderboards.** The frozen contract forbids summing the two economies, so a single combined ranking is impossible. | Changes what players see. Alternative — cash-only public ranking with beta hidden — is equally consistent with the constraint. | Two leaderboards, economy in the season document id. Confirm whether beta should be public at all during closed beta. |
| 3 | **Fee / commission / revenue metrics are undefined at this base.** No fee, rake, house account or split exists; settlement pays the winner the full prize. | Defining them creates financial semantics with real consequences. | Report as `unavailable` with reasons. Do **not** ship `impliedGrossMargin` as a revenue metric. Resolve jointly with Session 3. |
| 4 | **New-user counting is impossible today** — `users/{uid}` has no `created_at` and Firestore cannot query by creation time. | Fixing it edits `onUserCreated`, a financial-adjacent trigger, which is out of scope this phase. | Approve adding `created_at` in an implementation session, plus a one-off Auth export for history. Report `null` until then. |
| 5 | **Aggregate overflow ceiling.** `addCentavos` caps at R$ 10 M, sized for one wallet; platform-wide season and metric totals can exceed it and would throw. | Introduces a new money constant, which touches the frozen money contract. | Approve `MAX_AGGREGATE_CENTAVOS` in a separate module (17), leaving `money.ts` untouched. |
| 6 | **First Firestore document trigger in the repository.** | New deployment surface, new failure mode, new emulator requirement. | Approve — the alternative couples ranking to payout (8.1). |
| 7 | **Median is approximate** (bucket interval, not a point value). | Exactness requires either unbounded storage or the prohibited full scan. | Approve the histogram interval; exact medians only in offline reconciliation reports. |
| 8 | **Rolling windows are day-aligned for 365d and all-time.** | Exactness at those widths costs far more than it informs. | Approve, with `windowMode` disclosed in every response. |
| 9 | **Withdrawal states are a single-valued enum today** (`pending` only); nothing transitions them. | Depends on the unbuilt PIX integration. | Key the aggregate dynamically by observed status so new states appear automatically. |
| 10 | **Leaderboard visibility.** Proposed as authenticated-only, matching `tournaments`. | "Public" could mean unauthenticated. | Authenticated-only, to avoid an unauthenticated enumeration surface. |
| 11 | **Single winner per tournament is structural** (`prize_{tid}` carries no uid; `placement: 1` hardcoded). If 2nd/3rd-place payouts are ever added, the prize-id derivation changes. | Product decision about prize structure. | Confirm single-winner is the permanent contract. If not, section 10.9's duplicate-prize detector and the `prize_*` id assumption must be amended before that ships. |
| 12 | **Pre-existing test debt: `functions/test/unit/invariants.test.ts` encodes the retired prize-id scheme** `prize_{winneruid}_{tournamentid}` via a locally redeclared helper, so it passes while asserting a contract the code no longer implements. | Found during this audit; not caused by and not fixed by this design. | Fix in an implementation session — the ranking test matrix must import `prizeTransactionId` from source, never redeclare it. |

---

## Existing engagement-statistics reconciliation

### R.1 The central finding

**The player engagement statistics backend persists no aggregate at all.** It is a pure read-time
computation over the ledger. From
[functions/src/domain/engagementStats.ts:10-13](../../functions/src/domain/engagementStats.ts#L10-L13):

> WHAT THIS COMPUTES: the player's TOURNAMENT net result, derived read-only from canonical ledger
> rows. It never writes, never changes a balance, and is NOT a source of truth — the wallet and the
> ledger remain authoritative. There is deliberately no persisted aggregate for a client to tamper
> with.

This single fact resolves most of the reconciliation risk this session was asked to investigate:

* there is **no existing aggregate document** that season rankings could accidentally reuse or
  corrupt;
* there is **no existing write handler** that could double-count against a new financial aggregator,
  because there is no existing aggregation *write* at all;
* the engagement callable and the ranking pipeline read the **same** authoritative ledger, so they
  cannot disagree about what happened — only about what they choose to count.

`player_activity` **is** persisted, but it is explicitly non-financial
([functions/src/domain/playerActivity.ts:11-13](../../functions/src/domain/playerActivity.ts#L11-L13)):
it carries no amount and never touches wallets, transactions, registrations or tournaments.

### R.2 Mapping table

| Existing collection/document/callable | Current authoritative event | Current metric definition | Authorization boundary | Rules / indexes | Overlap with proposed work | Decision | Justification | Compatibility / migration risk |
|---|---|---|---|---|---|---|---|---|
| `getPlayerEngagementStats` (callable) | Definitive ledger rows in `transactions`, filtered `user_ref == caller` | Per-economy **net** result (prizes + refunds − entries) in centavos: `dailyNet`, `currentWeekNet`, `currentMonthNet`, `lifetimeNet`, plus exclusion counters | `assertSignedIn`; uid from token only, never payload | No Rules block needed (callable uses Admin SDK); single-field `user_ref` index only, no composite | Partial — same source ledger, but **net** per player vs **gross prizes** across players | **keep-separate** | It computes a *net* figure including entry fees and refunds, and is scoped to one player. A ranking needs *gross prize* totals across all players. Reusing it would either leak other players' net positions or redefine ranking value to something the approved rules forbid. | None — untouched. New callables are additive. |
| `engagementStats.ts` `CATEGORY_TABLE` | — (pure classification) | Canonical category → economy/role/sign mapping | n/a | n/a | **Direct and valuable** | **reuse** | It is the single canonical enumeration of every category any handler writes, already unit-tested. The ranking allowlist must be derived from it so a new category can never be silently mis-bucketed. | Additive only. Any new category (Session 3) must be added here — see 18.4.3. |
| `engagementStats.ts` `normalizeMonth`, `monthOfDayKey`, `daysInMonth` | — (pure) | `YYYY-MM` validation and slicing | n/a | n/a | Direct | **reuse** | Monthly season ids are exactly `YYYY-MM` with the same validity band (2020–2100). Reimplementing would risk divergent validation. | None. A new `yearOfDayKey` is additive. |
| `engagementStats.ts` `aggregateLedger` | Ledger rows | Net totals with skip counters | n/a | n/a | Conceptual only | **keep-separate** | Signature is per-player and month-scoped, and it nets entries against prizes. Ranking needs a different reduction. The *exclusion-counter discipline* is copied, not the function. | None. |
| `playerActivity.ts` `ACTIVITY_TIMEZONE`, `businessDayKey` | Server clock | São Paulo business day resolution via `Intl` + IANA zone | n/a | n/a | Direct | **reuse** | The source designates it the repository convention for every future day-bucketed feature. Season and window bucketing must use it or boundaries will disagree. | None. Critical that it is reused, not copied. |
| `player_activity/{uid}_{day}` (collection) | `recordDailyAppOpen` callable | One doc per player per business day; app was opened | Owner or admin read; no client write ([firestore.rules:175-178](../../firestore.rules#L175-L178)) | Explicit match block; no composite index | None — non-financial | **keep-separate** | Records app opens, carries no amount, and is explicitly not financial. It can never back a prize ranking. | None. |
| `recordDailyAppOpen` (callable) | Client call, server-stamped day | Idempotent per-day marker via deterministic doc id | `assertSignedIn`; uid from token | n/a | None | **keep-separate** | Non-financial. | None. |
| `wallets/{uid}.total_won` | `declareTournamentResult` (cash), inside the settlement transaction | Lifetime cash prize accumulator, in reais | Owner or admin read; no client write ([firestore.rules:71-77](../../firestore.rules#L71-L77)) | Existing wallet indexes | **Overlaps conceptually with lifetime prize ranking** | **keep-separate** | It is lifetime-only with no season dimension, it is stored in reais (float), it is a wallet field bound by the reconciliation identity, and it is private. Reading it for a public ranking would expose a wallet field and could not answer a monthly question. | None — must not be read by ranking. |
| `audit/reconcile.ts` invariants | Ledger + wallets | Cash and beta balance identities | Offline CLI | Not deployed (`lib/audit` ignored) | Template for the ranking sweep | **extend** | The reconciliation *pattern* (classify, report, never silently repair) is adopted for ranking. The financial invariants themselves are unchanged and must keep passing. | Additive: a new ranking sweep, not a change to wallet reconciliation. |
| `firestore.indexes.json` legacy composite | `cancelTournament` legacy refund query | `category + user_ref + tournament_ref` | n/a | Guarded by a unit test | Must be preserved | **keep-separate** | The guard test asserts its presence and no duplicate equivalent. New indexes use different field combinations. | Low — the test uses `.find()`, so additions pass. Must not be reordered away or duplicated. |

### R.3 Which engagement aggregates remain non-financial

* `player_activity/{uid}_{day}` — app-open records only. Stays non-financial permanently; nothing in
  this design writes an amount to it.
* `admin_metrics_daily.registrations` — a count of registration events, deliberately a **count**, not
  a money figure.

### R.4 Which proposed aggregates must use settlement / immutable transaction events

All of them. Specifically:

* `season_rankings/*/entries/*.total_prize_centavos` and `.wins` — from
  `transactions/prize_{tid}` only;
* `admin_metrics_daily.sum_centavos_by_category`, `.count_by_category`, `.histogram_by_category` —
  from `transactions` rows only;
* `admin_metrics_daily.withdrawals_by_status` — from `withdrawals` documents, which are written in
  the same transaction as their ledger row;
* `admin_metrics_daily.tournament_volume` — from `transactions` grouped by `tournament_ref`.

**No proposed aggregate reads an engagement statistic, a wallet total, or a client-supplied value.**
The binding constraint from central coordination — that existing engagement statistics must not
become authoritative for prize rankings merely because they exist — is satisfied structurally: the
ranking pipeline has no code path that reads `getPlayerEngagementStats` or any engagement output.

### R.5 How double counting is prevented

| Risk | Prevention |
|---|---|
| Existing engagement handler and new financial aggregator both count a prize | **Cannot occur.** The engagement path performs no aggregate write — it computes at read time and persists nothing. There is no second writer to collide with. |
| Ranking trigger fires twice for one prize (at-least-once delivery) | `ranking_events/{prize_tid}` guard document, created in the same transaction as the increments (7.1). |
| Backfill re-applies an already-counted prize | Same guard document, plus `rebuild_generation` to distinguish a legitimate rebuild from a replay (7.3). |
| Backfill running while the live trigger is active | Both take the same guard document in a transaction; the loser is a no-op. |
| A prize counted in both monthly and annual totals | Intended, not double counting — they are different aggregates. The invariant `Σ months == year` (15.3) asserts consistency. |
| Two prize rows for one tournament | Structurally impossible: the id is `prize_{tournamentid}`. If one is ever found, it is a suspicious event (10.9). |
| Cash and beta both counted into one total | Structurally impossible: separate season documents, no combined field exists (6.1). |
| `player_activity` mistaken for a financial signal | Excluded by design; it carries no amount. |

### R.6 Which dashboard metrics current statistics can supply unchanged

| Metric | Reusable as-is? | Why |
|---|---|---|
| Transaction count / volume | No | Engagement computes per-player nets, not platform counts. Needs the new buckets. |
| Average / median size | No | No per-row distribution is retained anywhere today. |
| Entry fees | No — but the **category definition** is reused verbatim | `entry_fee` / `beta_entry_fee` classification comes from `CATEGORY_TABLE`. |
| Prizes distributed | No — category definition reused | Same. |
| Gross fee / commission / net revenue | No | No such concept exists (10.6). |
| Withdrawal states | Partially | `withdrawals.status` is read directly; `reconcile.ts` already reads withdrawal statuses for the wallet identity. |
| New users | No | No creation timestamp exists (10.8). |
| Partner metrics | No | No partner model exists. |
| Highest-volume tournaments | No | No per-tournament aggregate exists today. |
| Suspicious / duplicate events | **Yes, substantially** | `audit/reconcile.ts` already classifies unknown categories, malformed amounts and wallet drift. The metric surfaces its counts. |
| Player activity days | Yes, unchanged | `player_activity` already answers it, per-player. |

No existing metric's **meaning** is changed by this design. Where a definition is reused
(`CATEGORY_TABLE`, `businessDayKey`, `normalizeMonth`), it is reused verbatim rather than
reinterpreted.

### R.7 Names the new design must avoid

Collections: `users`, `wallets`, `transactions`, `withdrawals`, `registrations`, `tournaments`,
`tournament_rooms`, `player_activity`.

Callables and exports: `onUserCreated`, `testdeposit`, `requestwithdrawal`, `jointournament`,
`createTournament`, `createtournament`, `setTournamentRoom`, `getTournamentRoom`, `startTournament`,
`declareTournamentResult`, `payprize`, `cancelTournament`, `grantBetaCredit`, `recordDailyAppOpen`,
`getPlayerEngagementStats`, and every `…Handler` counterpart.

Transaction categories: `entry_fee`, `prize`, `entry_refund`, `beta_entry_fee`, `beta_prize`,
`beta_refund`, `deposit`, `withdrawal`, `beta_grant`, and the reserved-but-unwritten
`admin_correction`.

Wallet fields: `balance`, `total_deposited`, `total_won`, `total_spent`, `total_withdrawn`,
`beta_balance`.

Document-id prefixes: `prize_` (settlement), `withdrawal_` (withdrawal external ids),
`{uid}_{tournamentid}` (registrations), `{uid}_{YYYY-MM-DD}` (activity).

Constants: `ACTIVITY_TIMEZONE`, `STATS_TIMEZONE`, `MAX_CENTAVOS`, `MAX_BALANCE_CENTAVOS`,
`ECONOMY_CASH`, `ECONOMY_BETA_CREDIT`, `COMPLETED_STATUS`, `STATUS_OPEN`, `STATUS_IN_PROGRESS`,
`STATUS_COMPLETED`, `STATUS_CANCELLED`, `REGISTRATION_CONFIRMED`.

The proposed names `season_rankings`, `ranking_events`, `admin_metrics_daily`,
`onPrizeTransactionCreated`, `getSeasonLeaderboard`, `getMySeasonRanking`, `getAdminMetrics`,
`MAX_AGGREGATE_CENTAVOS` collide with nothing at this base.

### R.8 Compatibility expectations for existing Flutter consumers

* `getPlayerEngagementStats` is **unchanged** — same request shape, same response keys, same
  `amountUnit: "centavos"`, same `timezone`. No client change is required by this design.
* `recordDailyAppOpen` is unchanged.
* No existing collection, field, category, document id, callable name or region changes. There is no
  data migration and no client-visible breaking change.
* New callables are purely additive; a client that does not call them is unaffected.
* Clients must treat `null` metric values in `getAdminMetrics` as "unavailable", never as zero, and
  should render the accompanying `unavailable[].reason`.
* Clients must treat `medianCentavos` as an interval and `windowMode` as meaningful.

### R.9 Registration statistics vs prize rankings vs partner attribution

These are three distinct layers over the same ledger, and this contract keeps them distinct:

* **Registration statistics** answer *participation*: how many players joined, what they paid in
  entry fees. Source: `registrations` documents and `entry_fee`/`beta_entry_fee` ledger rows.
  Registration is **not** evidence of winning and never contributes ranking value. `registrations`
  carries `created_at`, so it is the one signup-adjacent event with a usable timestamp today.
* **Prize rankings** answer *achievement*: gross prizes credited by definitive settlement. Source:
  `transactions/prize_{tid}` exclusively. A player who registers for a hundred tournaments and wins
  none has a season total of zero and is not materialized at all (section 4).
* **Partner attribution** answers *provenance*: which partner a user came from and what commission
  their activity generated. **No source exists today.** It will attach to the *user* (attribution)
  and to *commission ledger rows* (revenue), never to prize rows.

The critical relationship: partner metrics will join to **registrations and commission rows**, not to
prize rankings. A partner's value is measured by the players they bring and the fees those players
generate — not by whether those players win. Attributing prize value to a partner would let a single
lucky winner distort partner performance and would create pressure to expose ranking data on an
admin-commercial surface. Prize rankings stay a public, achievement-only view; partner metrics stay
an admin-only, commercial view; the two must not be joined in either direction.
