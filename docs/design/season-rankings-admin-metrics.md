# Season Rankings and Administrative Metrics — implementation contract

**Status:** design only. No production code, tests, Rules, indexes, dependencies or Firebase
configuration are changed by this document.

**Design base:** `dcc0d4da6c3c68af677ef4a9bc9ae4d6be922269` (`master`, equal to cached
`origin/master`). The earlier settlement baseline `04b4623b0cdc5e97d7ed8b27e6534ef48284804a`
remains an ancestor of this base.

**Phase:** contract freeze — **finalized**. Central coordination has closed all twelve previously
open decisions; section 19 maps each one to its resolution. **This document contains no open
decisions.** What remains before code can be written is listed as prerequisites in section 20, with
the fail-closed behaviour that applies while each is missing.

Every section is frozen. Session 3 (partners) and any implementation session must treat this contract
as binding unless central coordination amends it in writing.

**Superseded by this finalization** — recorded so no reader relies on a withdrawn rule:

| Withdrawn | Replaced by |
|---|---|
| Annual seasons (`cash_year_2026`, `season_kind`, `yearOfDayKey`, `Σ months == year`) | Calendar-month seasons only, `seasonId` = `YYYY-MM` (§3.1) |
| `player_id` as the public handle | Server-generated `publicPlayerId` (§5) |
| `last_prize_at` and `uid` as comparator levels | Three-level order ending in `publicPlayerId` (§4.3) |
| Stored/materialized `rank` | Position derived at read time (§8.3) |
| Rolling `24h/7d/30d/365d/all` windows and `windowMode` | Bounded `fromDay`/`toDay` range, ≤ 31 days (§10.2) |
| Rebuild/backfill machinery and `rebuild_generation` | No backfill; append-only from activation (§3.4, §7.3) |
| `impliedGrossMargin` revenue proxy | Explicit unavailability with enum reasons (§10.6) |
| `MAX_AGGREGATE_CENTAVOS = 1_000_000_000_000` | `Number.MAX_SAFE_INTEGER` (§15.4) |

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

**Single-winner assumption — FROZEN. Resolves open decision 11 (see section 19).**
`prize_{tournamentid}` contains no winner uid and `placement` is hardcoded to `1`
([functions/src/index.ts:1023](../../functions/src/index.ts#L1023)), so exactly one paid winner per
tournament is structurally enforced today, and **this document does not change settlement**. The
ranking does not depend on the assumption — its guard is keyed by transaction id, which stays unique
either way — but the duplicate-prize detector in 10.9 does. **If multi-placement payouts are ever
introduced, the prize-id derivation changes and this contract must be amended before that ships.**

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

## 3. Season identifiers, São Paulo boundaries and first activation

**FROZEN.** Season boundaries were already canonical and were never one of the twelve open
decisions; first activation and the no-backfill policy are newly frozen here. The economy-scoped
season document id contributes to the resolution of decision 2 (see section 19).

### 3.1 A season is a complete calendar month

* A season is a **complete calendar month**. There is no other season kind.
* Canonical timezone: **`America/Sao_Paulo`**.
* Canonical `seasonId`: **`YYYY-MM`** — e.g. `2026-08`.
* Start: the first day of the month at `00:00:00` in the canonical timezone, **inclusive**.
* End: the first day of the **following** month at `00:00:00` in the canonical timezone,
  **exclusive**.
* The device or player timezone is **never** used, for any purpose, anywhere in this contract.

The half-open `[start, nextStart)` interval is deliberate: it has no `23:59:59.999` rounding edge and
no gap or overlap between consecutive seasons, so every instant belongs to exactly one season.

**Supersession — annual seasons are removed.** An earlier revision of this document specified both a
monthly and an annual season (`cash_year_2026` and a `yearOfDayKey` helper). Central coordination has
since frozen seasons as complete calendar months with the single canonical id `YYYY-MM`, with
retention expressed in monthly seasons (section 8.4) and a leaderboard API keyed by `seasonId` alone.
**Annual seasons, the `season_kind` discriminator, the `yearOfDayKey` helper and the
`Σ months == year` invariant are therefore withdrawn from this contract.** This is a material change
from the original brief, which had required monthly *and* annual seasons; it is recorded here rather
than applied silently. Nothing in the backend depended on the annual aggregate — it was never
implemented — so the withdrawal has no migration cost.

### 3.2 Deriving a prize's season

The season of a prize is derived **exclusively** from the canonical timestamp of its completed prize
transaction:

```ts
const dayKey   = businessDayKey(prizeTx.timestamp.toDate(), ACTIVITY_TIMEZONE); // YYYY-MM-DD
const seasonId = monthOfDayKey(dayKey);                                         // YYYY-MM
```

Reuse the canonical helpers — `ACTIVITY_TIMEZONE`, `businessDayKey`, `normalizeMonth` and
`monthOfDayKey` — and **create no competing interpretation** of a day, month or timezone.

A prize settled at `2026-08-01T00:30:00-03:00` belongs to `2026-08`; the same instant expressed as
`2026-08-01T03:30:00Z` must not be bucketed to July by a naive UTC slice.

**The timestamp used is `transactions/prize_{tid}.timestamp`**, the resolved server timestamp written
inside the settlement transaction. `declared_at` and `paid_at` on the tournament result are the same
sentinel resolved to the same instant
([functions/src/index.ts:930-932](../../functions/src/index.ts#L930-L932)), so they agree by
construction; the transaction field is authoritative because it lives on the authoritative record.

**Forbidden season sources.** The season is never derived from the tournament date, the registration
date, the account creation date, the trigger execution time, or any client-supplied value. Trigger
delay never changes an event's season (section 8.4).

`seasonId` validation reuses the existing strictness of `normalizeMonth`
([functions/src/domain/engagementStats.ts:132-149](../../functions/src/domain/engagementStats.ts#L132-L149)):
`^\d{4}-\d{2}$`, month 01–12, year within `MIN_YEAR = 2020` … `MAX_YEAR = 2100`.

### 3.3 First activation — `firstActiveSeasonId`

* The first season is the **first complete calendar month that begins after the future
  implementation has been approved and deployed**.
* A partial season is **never** started mid-month.
* Deployment may happen earlier, but **processing stays inert until the configured start**.
* `firstActiveSeasonId` must be an **explicit backend configuration value**, validated before
  activation. It is not derived, not inferred from deploy time, and not defaulted.
* **No concrete month is invented here.** The selection *algorithm* above is frozen; only the
  resulting value is deferred.

**Fail-closed while unset.** Until `firstActiveSeasonId` is configured and validated, the ranking
trigger performs **no** aggregate write. An absent or malformed value is a configuration error that
disables processing — it is never treated as "start immediately" and never as `2020-01`. An event
whose `seasonId` sorts before `firstActiveSeasonId` is ignored and recorded as out-of-scope, not as a
failure.

That the concrete month is chosen later does **not** reopen this rule. The algorithm and the
no-backfill policy below are frozen now.

### 3.4 No backfill — frozen

* There will be **no backfill of prizes settled before the first season begins**.
* Transactions before the activation boundary stay permanently outside the rankings.
* **Historical seasons are never reconstructed.**
* Reconciliation must never be used to pull pre-activation events into a ranking (section 14.2).

This document therefore makes **no claim that historical rankings will ever be rebuilt.**

---

## 4. Score, ordering, tie-breaking and position

**FROZEN.** Resolves open decision 2 — cash and beta rank independently (see section 19).

### 4.1 What the score is

`scoreCentavos` is the **gross total effectively credited in completed prizes of that economy during
the season**, in integer centavos.

Explicitly **not** part of the score:

* entry fees paid;
* net spend or net result;
* wallet balance;
* the tournament's *advertised* prize (only the amount actually credited counts);
* any client-supplied value.

`wallets.total_won` stays lifetime-only and private and is **never** a source for a monthly ranking.
`getPlayerEngagementStats` stays independent and is **never** a ranking source (section R.2).

### 4.2 Entry contract

Every season entry distinguishes at least:

| Field | Meaning |
|---|---|
| `scoreCentavos` | Gross completed prize total for the economy and season, integer centavos |
| `winsCount` | Number of qualifying completed prize events in the season |
| `publicPlayerId` | Server-generated pseudonymous identity (section 5) |
| `economy` | `"cash"` or `"beta_credit"` |
| `seasonId` | `YYYY-MM` |
| server-side timestamps | `firstPrizeAt`, `lastPrizeAt`, `updatedAt` — for audit only, never for ordering |

### 4.3 Canonical order

Exactly three levels, applied in sequence:

1. **`scoreCentavos` descending**
2. **`winsCount` descending**
3. **`publicPlayerId` ascending**, binary/canonical comparison

Frozen properties:

* the order is **totally deterministic**;
* **no tie-break by UID** — the UID is not present in the entry at all;
* **no tie-break by trigger processing time** — `lastPrizeAt` is stored for audit but is **not** a
  comparator level, so a delayed trigger can never change anyone's position;
* **no per-read randomness**;
* cash and beta are ordered **independently**.

Level 3 yields a strict total order because `publicPlayerId` is unique and immutable (section 5).

**The final tie-break is technical and neutral.** Ordering by `publicPlayerId` is a deterministic
disambiguation, not an additional reward: the identifier is random, unguessable and unrelated to
merit, tenure or activity, so no player can seek or be disadvantaged by it in any meaningful way.

Amounts are compared in centavos because reais are IEEE-754 doubles; comparing reais would make the
order depend on representation noise. `inspectReais` supplies the exact centavos at ingest.

### 4.5 Canonical key `rankKey` — amended

**FROZEN, added by the canonical-entry-invariants correction.** The order of section 4.3 is not
expressed to Firestore as three separate fields. Each entry stores one string that *is* the order:

```
rankKey = "v1|" + complement(scoreCentavos) + "|" + complement(winsCount) + "|" + <document id>
complement(n) = String(MAX_SAFE_INTEGER - n).padStart(16, "0")
```

* **One predictable type.** Ordering on the three raw fields could not express structural validity:
  Firestore drops a document from an `orderBy` only when the field is **absent**, while a field
  present with the **wrong type** still sorts. A corrupt entry therefore entered the aggregates
  while the page that had to render it failed — the two surfaces disagreed. A query over the
  half-open range `["v1|0", "v1|:")` admits only strings of this version whose first numeric
  position is numeric; every other type and version falls outside.
* **The ordering is preserved exactly.** A single ASCENDING sort of `rankKey` reproduces
  `scoreCentavos DESC, winsCount DESC, publicPlayerId ASC`, proven against the comparator over a
  generated set.
* **Identity is the document id.** The last component is the entry's document id, which is the
  authoritative `publicPlayerId`. Document ids are unique, so `rankKey` is unique: the final
  comparator identifies exactly one entry and `startAfter` is never ambiguous.
* **Minted only by the write path**, from values `decideEntry` has already normalised. It is never
  derived from client input and never computed at read time.
* **Single source of truth.** `scoreCentavos`, `winsCount` and `publicPlayerId` remain on the
  document as audit copies and are **not read** by either callable: every published value is
  decoded from `rankKey`, and the key's id component must equal the document id or the entry fails
  closed. They can no longer move a rank, a page or a response.

### 4.4 Position

* Positions are **exact ordinals**: 1, 2, 3, 4 …
* **There are no shared positions.** Two entries with the same `scoreCentavos` and the same
  `winsCount` are still ordered — and therefore numbered — by `publicPlayerId`.
* There is no dense-rank, no competition-rank and no gap semantics, because ties cannot survive
  level 3.
* Positions are computed from the canonical order of section 4.3 and nothing else.
* Cash and beta compute positions independently.

Players with no qualifying prize are **not materialized at all** — a season entry exists only once a
player has been credited at least one qualifying completed prize. There is never a synthesized
zero-score row (section 6.2).

---

## 5. Public pseudonymous identity and privacy exclusions

**FROZEN.** Resolves open decision 1 (see section 19).

### 5.1 Why a new identity was required

Every identifier already present in the backend was rejected:

| Candidate | Why rejected |
|---|---|
| `uid` | Raw Auth uid is an enumeration surface and is internal. |
| `users.player_id` | `PLR-` + `Math.floor(100000 + Math.random() * 900000)` ([functions/src/index.ts:170-173](../../functions/src/index.ts#L170-L173)) — a 900 000-value space with no reservation, so collisions arrive in the low thousands of users. It is also predictable in shape. |
| `users.username` | Permanently `""` ([functions/src/index.ts:193-199](../../functions/src/index.ts#L193-L199)); [docs/username.md](../username.md) records the gap. |
| Auth `displayName` | Not in Firestore, user-controlled, unvalidated — impersonation risk on a public surface. |
| e-mail, phone | PII. Never public. |
| any internal predictable id | Enumerable. |

`firestore.rules` also allows reading `users/{uid}` only to the owner or an admin
([firestore.rules:62-68](../../firestore.rules#L62-L68)), so a public leaderboard could never join
against `users` at read time regardless.

### 5.2 The frozen MVP identity — `publicPlayerId`

A pseudonymous identity created **exclusively by the server**:

* **16 cryptographically random bytes**;
* encoded **base64url without padding**;
* **exactly 22 characters**, matching `[A-Za-z0-9_-]{22}`;
* collision-checked, **create-only**;
* **immutable** once assigned;
* **not derived** from the UID;
* **not derived** from `player_id`, e-mail, phone or any name;
* **never reused** by another account;
* **stable across seasons**.

Randomness — not derivation — is what makes it safe: a derived identifier (even hashed) would let
anyone holding a UID confirm a player's presence on the leaderboard.

### 5.3 Visual label for the MVP

* The label is the literal `Jogador ` followed by the **first eight characters** of the
  `publicPlayerId` — e.g. `Jogador A7fQ2_kB`.
* The **full `publicPlayerId` remains the technical identity of the row** and the ordering key; the
  eight-character label is presentation only and is never used for identity, ordering or lookup.
* **No player-customisable public name is implemented in this phase.** The `setUsername` proposal in
  [docs/username.md](../username.md) remains a separate, later workstream and is not a prerequisite
  for this contract.

The truncated label may collide visually between two players. That is accepted for the MVP because
the label carries no authority: ordering, paging cursors and `getMySeasonRanking` all use the full
22-character value.

### 5.4 Storage and projection

* The **UID ↔ `publicPlayerId` association is private and server-only**.
* **No Firestore Rule grants any client read access to the association**, in either direction.
* Endpoints project **only** allowlisted public fields.
* **The UID never appears** in a leaderboard response, in a cursor, in public logs, or in any
  response metadata.
* `getMySeasonRanking` identifies the caller from the **authenticated context** and does **not**
  return the UID.

### 5.5 Emitted public fields

```jsonc
{
  "position": 1,
  "publicPlayerId": "A7fQ2_kB9xLm3NpQr5TzUw",
  "label": "Jogador A7fQ2_kB",
  "scoreCentavos": 125000,
  "winsCount": 3,
  "economy": "cash",
  "seasonId": "2026-08"
}
```

### 5.6 Hard exclusions

Never present on any leaderboard document or callable response:

* **the UID**, in any field, cursor, log or metadata;
* `email`, `pix_key`, `whatsapp` (PII on `users/{uid}`);
* `pix_key_snapshot` (on `withdrawals`);
* `player_id` and `username` (superseded by `publicPlayerId`);
* every wallet field: `balance`, `total_deposited`, `total_won`, `total_spent`,
  `total_withdrawn`, `beta_balance`;
* deposits, withdrawals and their states;
* entry fees paid, net position, or any figure from which a balance could be derived;
* any transaction id, `external_id`, or ledger row;
* room credentials, in any form.

`scoreCentavos` is a gross sum of prizes won. It is not a balance and cannot be inverted into one,
because entry fees, deposits and withdrawals are all excluded from it.

### 5.7 Implementation gate

**Implementation of the ranking may not begin until this identity contract is in scope and covered
by Firestore Rules and tests.** The leaderboard cannot ship against `player_id` as an interim
measure — doing so would publish a colliding, predictable identifier and would then require a
migration of every historical entry. Recorded in section 20.

---

## 6. Aggregate documents, collection paths and document ids

All new collections are backend-written only. Ids are deterministic so every write is idempotent by
construction — the same discipline the repository already applies to
`transactions/prize_{tid}`, `registrations/{uid}_{tid}` and `player_activity/{uid}_{day}`.

### 6.1 Season leaderboard entries

```text
season_rankings/{economy}_{seasonId}/entries/{publicPlayerId}
```

Season document ids — monthly only:

```text
cash_2026-08      beta_credit_2026-08
```

Two structural guarantees follow from the id:

* **The economy is part of the season document id**, so writing a combined cash+beta total is
  impossible: the two live in different documents and no code path reads both into one field.
* **The entry is keyed by `publicPlayerId`, not by UID.** The UID therefore cannot leak through a
  document path, a cursor, or a Rules-level path match.

Entry document:

```jsonc
{
  "publicPlayerId": "A7fQ2_kB9xLm3NpQr5TzUw",
  "economy": "cash",              // "cash" | "beta_credit"
  "seasonId": "2026-08",
  "scoreCentavos": 125000,
  "winsCount": 3,
  "firstPrizeAt": "<Timestamp>",  // audit only — never a comparator level
  "lastPrizeAt": "<Timestamp>",   // audit only — never a comparator level
  "updatedAt": "<Timestamp>"
}
```

There is deliberately **no `uid`, no `user_ref`, no `player_id`, no `display_name` and no stored
`position`**. Position is derived from the canonical order at read time (section 8.3), so it can
never go stale or contradict the totals.

### 6.2 Season parent document

```text
season_rankings/{economy}_{seasonId}
```

```jsonc
{
  "economy": "cash",
  "seasonId": "2026-08",
  "timezone": "America/Sao_Paulo",
  "playerCount": 42,
  "totalScoreCentavos": 980000,
  "windowStart": "<Timestamp>",   // first day of the month, 00:00:00 canonical, inclusive
  "windowEnd": "<Timestamp>",     // first day of next month, 00:00:00 canonical, exclusive
  "updatedAt": "<Timestamp>"
}
```

`playerCount` counts materialized entries only; a player with no qualifying prize is not counted,
because no entry exists (section 4.4).

### 6.3 Idempotency markers

```text
ranking_events/{transactionId}
```

Document id is the **prize transaction id** — `prize_{tournamentid}` — which is already
deterministic and unique per tournament. Contents:

```jsonc
{
  "transactionRef": "<DocumentReference transactions/prize_{tid}>",
  "publicPlayerId": "A7fQ2_kB9xLm3NpQr5TzUw",
  "economy": "cash",
  "amountCentavos": 50000,
  "seasonId": "2026-08",
  "dayKey": "2026-08-03",
  "appliedAt": "<Timestamp>"
}
```

This document is created **in the same Firestore transaction** as the season-entry and
season-parent updates. Its existence is the guard: if it exists, the event has already been applied
and the handler returns without writing. See section 7.

The guard stores `publicPlayerId` rather than the UID, so even this internal collection cannot
become a UID-disclosure path if its Rules were ever relaxed by mistake.

**One guard per economy is impossible to confuse:** the guard id is the transaction id, and a
transaction belongs to exactly one economy by category (`prize` → cash, `beta_prize` → beta), so a
cash event can never consume a beta guard or vice versa.

### 6.4 Admin metric daily buckets

```text
admin_metrics_daily/{dayKey}
```

`dayKey` is `YYYY-MM-DD` in `America/Sao_Paulo`, produced by `businessDayKey`. One document per
business day, holding every additive counter needed to answer a bounded date range (section 10.2) by
summation. Shape is specified in section 10.4.

### 6.5 Public identity map

```text
public_player_ids/{uid}
```

```jsonc
{
  "publicPlayerId": "A7fQ2_kB9xLm3NpQr5TzUw",
  "createdAt": "<Timestamp>"
}
```

This is the **private, server-only** UID → `publicPlayerId` association required by section 5.4. It
is keyed by UID and **created once, never updated and never deleted** — which is what makes
`publicPlayerId` immutable and non-reusable.

A **reverse uniqueness guard** is required so a generated id can never be assigned twice:

```text
public_player_id_index/{publicPlayerId}   ->   { uid, createdAt }
```

The document id *is* the lock — Firestore guarantees at most one — so the collision check of section
5.2 is a create-only write inside the same transaction that writes `public_player_ids/{uid}`. This is
the reservation pattern [docs/username.md](../username.md) already describes for usernames. A
collision retries with fresh entropy; with 16 random bytes a collision is vanishingly improbable, but
the guard makes create-only correctness structural rather than probabilistic.

**Both collections are Rules-denied in both directions** (section 13.1), so the pseudonym can never
be resolved back to an account by any client, and no client can forge or reassign an identity.

Neither is read at leaderboard request time: the entry already stores `publicPlayerId`, so serving a
page requires no identity lookup. The map is consulted only when the ranking trigger needs the prize
winner's `publicPlayerId`, and by `getMySeasonRanking` to resolve the authenticated caller.

### 6.6 Names deliberately avoided

The new design must not reuse any existing name. Already taken: collections `users`, `wallets`,
`transactions`, `withdrawals`, `registrations`, `tournaments`, `tournament_rooms`, `player_activity`;
callables listed in 0.1; and the transaction categories in 0.3. The proposed names
`season_rankings`, `ranking_events`, `admin_metrics_daily`, `public_player_ids` and
`public_player_id_index` collide with nothing at the design base.

---

## 7. Processing and idempotency

**FROZEN.** Resolves open decision 6 (see section 19).

### 7.1 The idempotency contract

Firestore triggers are **at-least-once**; this is expected, not exceptional. Every ranking mutation
runs inside one `db.runTransaction` that:

1. reads `ranking_events/{prizeTxId}`;
2. if it exists → returns without writing (idempotent replay, **no** second increment);
3. otherwise reads the season entry and the season parent;
4. writes the entry and the parent with values **computed from the read values in centavos**, and
   creates `ranking_events/{prizeTxId}`.

**The guard and the aggregate update commit atomically in the same Firestore transaction.** There is
no state in which an event is marked processed while its aggregate failed, and no partial write.

`FieldValue.increment()` is **forbidden** for money. The repository established this rule and its
reason ([functions/src/index.ts:372-376](../../functions/src/index.ts#L372-L376)):

> Computed from the value read inside this transaction rather than `FieldValue.increment()`:
> `increment()` adds floats, which drift.

`scoreCentavos` is an integer, so `increment()` would be numerically safe — but the read-compute-write
form is required anyway because the guard and the totals must commit atomically, and because
`winsCount`, `firstPrizeAt` and `lastPrizeAt` need the prior values regardless.

Addition uses the **aggregate-domain** helper of section 15.4, not the wallet helper.

### 7.2 Eligibility and fail-closed rules — frozen

* An **ineligible event creates no ranking entry** — no zero-score placeholder, no empty document.
* An **unknown category is fail-closed**: only `prize` and `beta_prize` are ever counted
  (section 2.5). Anything else is ignored and recorded.
* An event whose `seasonId` precedes `firstActiveSeasonId` is ignored as out-of-scope (section 3.3).
* **Cash and beta never share a guard or an aggregate.** The economy is fixed by the transaction
  category and is part of the season document id (section 6.1).
* A **processing error must be observable and retryable.** The guard is not written, so the retry
  re-applies cleanly.
* **An event is never marked processed if its aggregate write failed** — they are the same
  transaction, so this is structural rather than a discipline.
* **No concurrent trigger is created for the same source.** Exactly one trigger consumes
  `transactions/{transactionId}`.
* **A financial transaction is never modified by the ranking.** The ranking is strictly a reader of
  the ledger.

### 7.3 No rebuild, no backfill

**There is no backfill and no historical rebuild** (section 3.4). Prizes settled before
`firstActiveSeasonId` are permanently out of scope, so the `rebuild_generation` machinery an earlier
revision of this document proposed is **withdrawn** — there is nothing to rebuild.

Consequently:

* no rebuild CLI is contracted;
* no `rebuild_generation` field exists on any document;
* reconciliation is **read-only** and never writes ranking state (section 14);
* any future repair must be explicitly administrative, auditable and idempotent, and is **not**
  authorized by this document.

Ranking state is therefore append-only from activation forward, driven exclusively by the trigger.

---

## 8. Where updates happen, position derivation, closure and retention

**Decision: a dedicated Firestore `onDocumentCreated` trigger on `transactions/{transactionId}`,
fired after the prize transaction is created. Ranking is NOT written inside the settlement
transaction.**

**FROZEN.** Resolves open decision 6 (see section 19).

Frozen properties, restated because they are load-bearing:

* the trigger runs **after** the prize transaction has been created;
* **ranking never participates in the financial settlement transaction**;
* **a ranking failure never undoes, blocks or delays a prize.**

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
required, but only as a **read-only reconciliation sweep** (section 14), never as a writer.

### 8.3 Position is derived, never stored

**No `position`/`rank` field is persisted on any entry.** The earlier proposal of a scheduled
rank-materialization pass is **withdrawn**: a stored rank is stale between passes and can contradict
the totals it is supposed to describe, which section 4.4's exact-ordinal requirement forbids.

Position is derived at read time from the canonical order of section 4.3:

* `getSeasonLeaderboard` numbers entries from the cursor's absolute offset as it walks the canonical
  order, so page 2 continues the numbering of page 1 without recomputation;
* `getMySeasonRanking` computes the exact ordinal by counting entries ahead (section 9.2).

Because both paths use the same canonical order over the same stored fields, they cannot disagree.

### 8.4 Season closure, history and retention

**FROZEN.** Retention was not one of the twelve open decisions — it is newly frozen here.

Closure:

* a season closes when its canonical interval ends (section 3.1);
* a new prize belongs to the month of **its own canonical timestamp**, always;
* **trigger delay never changes an event's season** — a prize settled at `2026-08-31T23:59:00-03:00`
  whose trigger runs in September still belongs to `2026-08`;
* a closed season's view **never receives economic activity from another month**;
* a legitimate correction may only reflect authoritative transactions that **already belonged to that
  season**;
* **no manual score correction**, **no position editing**, **no silent removal of a winner.**

Retention for the MVP:

* the **current season plus the 11 preceding monthly seasons** stay available — a rolling window of
  **up to 12 seasons**;
* older seasons fall outside the player-facing API;
* a later physical-deletion or anonymisation policy must be decided **with privacy review** before
  implementation;
* **no automatic deletion is implemented now** — seasons beyond the window are simply not served.

The document carried no prior retention rule, and no stricter legal retention requirement is recorded
anywhere in the repository at this base, so the 12-season window is adopted as-is. Retention is
**not** silently widened: if a stricter rule is later found, the stricter rule wins.

### 8.5 Cost of the new pattern

This introduces the repository's first Firestore document trigger. That is a deliberate,
documented departure and should be called out in review: it adds a new deployment surface, a new
failure mode (trigger retries), and a new emulator requirement in tests
(`firebase emulators:exec --only firestore,functions`).

---

## 9. Public leaderboard callable contracts

Two callables, both `central.https.onCall`, matching the existing handler/export split
(`export const xHandler = async (data, context) => {…}` then
`export const x = central.https.onCall(xHandler)`).

**FROZEN.** Resolves open decision 10 (see section 19).

### 9.1 `getSeasonLeaderboard`

```ts
// request — exact payload, enforced by assertExactPayload
{
  economy: "cash" | "beta_credit",
  seasonId: string,        // "YYYY-MM", validated by normalizeMonth
  limit?: number,          // 1..100, default 50
  cursor?: string | null   // opaque, server-produced
}

// response
{
  success: true,
  timezone: "America/Sao_Paulo",
  amountUnit: "centavos",
  economy: "cash",
  seasonId: "2026-08",
  playerCount: 42,
  entries: [
    {
      position: 1,
      publicPlayerId: "A7fQ2_kB9xLm3NpQr5TzUw",
      label: "Jogador A7fQ2_kB",
      scoreCentavos: 125000,
      winsCount: 3,
      economy: "cash",
      seasonId: "2026-08"
    }
  ],
  nextCursor: string | null
}
```

Frozen rules:

* **Authentication is mandatory** (`assertSignedIn`). The leaderboard is visible to authenticated
  users only, matching `tournaments`, the only currently client-readable collection
  ([firestore.rules:137-139](../../firestore.rules#L137-L139)). This avoids an unauthenticated
  enumeration surface.
* **Strict payload** via `assertExactPayload` — any unexpected key is `invalid-argument`.
* `economy` and `seasonId` are **validated**; an unknown economy or malformed `seasonId` is
  `invalid-argument`, never a silent empty page.
* Default page **50**, maximum **100**, clamped server-side regardless of what the client sends.
  There is no "return everything" mode.
* **Cursor pagination only. Offset is never used** — offset paging renumbers rows when a concurrent
  write lands mid-page.
* The cursor is **opaque and server-produced**, and is **bound to the season, the economy and the
  ordering tuple** it was issued for.
* A cursor that is **invalid, tampered with, or replayed against a different ranking** (different
  season or economy) **is rejected** with `invalid-argument`. It is never silently reinterpreted.
* **No response contains a UID** — not in an entry, not in the cursor, not in metadata.

Each entry carries **only** the allowlisted public projection above: position, `publicPlayerId`,
pseudonymous label, `scoreCentavos`, `winsCount`, economy, season.

The cursor (**version 2**) encodes the canonical key `rankKey` of the last row plus the absolute
offset of the next row, so page 2 continues page 1's numbering without recomputation. Since
`rankKey` ends in the entry's document id, which is the `publicPlayerId` and carries no UID, the
cursor cannot leak identity.

**Amended — canonical entry invariants.** The cursor previously carried the tuple
`(scoreCentavos, winsCount, publicPlayerId)`. That tuple was **not unique**: two documents could
carry the same stored `publicPlayerId`, which made `startAfter` ambiguous and could skip or repeat a
row across pages. It now carries the single `rankKey` (section 4.5), which ends in the document id
and is therefore unique by construction, so `startAfter(rankKey)` resumes after exactly one entry.
The HMAC, the season/economy binding, the visual-only role of the absolute offset, the generic
public messages and the absence of any snapshot guarantee between pages are all unchanged. No
version-1 cursor exists in production — the feature is not deployed — so no compatibility window is
owed.

### 9.2 `getMySeasonRanking`

```ts
// request — exact payload
{ economy: "cash" | "beta_credit", seasonId: string }

// response — ranked
{
  success: true, timezone: "America/Sao_Paulo", amountUnit: "centavos",
  economy: "cash", seasonId: "2026-08",
  isRanked: true,
  rank: 7,
  entry: {
    publicPlayerId: "A7fQ2_kB9xLm3NpQr5TzUw",
    label: "Jogador A7fQ2_kB",
    scoreCentavos: 42000,
    winsCount: 1
  },
  playerCount: 42
}

// response — not ranked
{
  success: true, timezone, amountUnit: "centavos",
  economy, seasonId,
  isRanked: false,
  rank: null,
  entry: null,
  playerCount: 42
}
```

Frozen rules:

* **Authentication is mandatory.** The caller is identified **from the authenticated context**; the
  payload has no uid field, mirroring `getPlayerEngagementStats`
  ([functions/src/index.ts:2167-2170](../../functions/src/index.ts#L2167-L2170)).
* With no eligible prize, the response is **`isRanked: false` and `rank: null`**.
* **No fictitious zero-score entry is created or returned** — not in the response and not in
  Firestore.
* **The UID is never returned.**
* The position uses the **same canonical order** as the leaderboard (section 4.3).

**Exact-position strategy (approved).** Given the caller's entry `(s, w, p)`:

```text
ahead = count(entries where scoreCentavos > s)
      + count(entries where scoreCentavos = s and winsCount > w)
      + count(entries where scoreCentavos = s and winsCount = w and publicPlayerId < p)

rank  = ahead + 1
```

The three counts are disjoint and together cover exactly the entries that precede the caller under
section 4.3, so `rank` is the exact ordinal — never an estimate and never a shared position. Each
count is an aggregation query over the season's `entries` subcollection; the conceptual indexes are
recorded in section 13.2. **`firestore.indexes.json` is not modified in this phase.**

**Amended — canonical entry invariants.** With the canonical key of section 4.5 the ordering is a
single totally-ordered string, so the three counts collapse into one range whose meaning is
identical and whose disjointness is structural rather than argued:

```text
ahead = count(entries where rankKey >= RANK_KEY_MIN and rankKey < myRankKey)
rank  = ahead + 1
```

`rankKey` is the canonical order, so every key strictly below the caller's precedes them, and the
caller's own row is excluded because the upper bound is strict. The formula `rank = ahead + 1` and
the exact-ordinal guarantee are unchanged; only the decomposition is simpler.

**Season integrity, proven with aggregates and never a scan.** Before either callable publishes
anything, three numbers read in the **same read-only transaction** must agree:

```text
parent.playerCount  ==  count(all entries)  ==  count(canonical entries)
```

The physical count is what makes corruption detectable without reading documents: an entry with no
key, a key of the wrong type, or a key of another version is counted physically but not
canonically, so the two diverge. That single invariant covers a partial migration, a residual
document, a stale parent, a duplicated pseudonym, and a parent that is missing while its
subcollection is not empty. On any mismatch **both** callables fail closed with
`failed-precondition` and one generic public message that names no document, field or value.
This **supersedes** the earlier allowance that a stored `playerCount` could differ from the real
count and still be served.

| Parent | Physical / canonical entries | Both callables |
| --- | --- | --- |
| absent | 0 / 0 | empty leaderboard, unranked, `playerCount: 0` |
| absent | any positive | fail closed |
| valid | counts equal | normal response |
| valid | counts differ | fail closed |
| malformed `playerCount` | any | fail closed |

### 9.3 Shared conventions

Both reuse `assertExactPayload`, both disclose `timezone` and `amountUnit` exactly as
`getPlayerEngagementStats` does, and both return pt-BR messages via `toHttpsError`. Neither accepts a
raw query, filter, ordering, field list or collection name from the client.

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

### 10.2 Date-range window — bounded and day-aligned

**FROZEN.** Resolves open decision 8 (see section 19).

`getAdminMetrics` takes an explicit **date range of whole business days**, not a rolling window
anchored at the request instant:

* `fromDay` and `toDay` are `YYYY-MM-DD` keys interpreted in **`America/Sao_Paulo`**;
* the range is **inclusive on both ends** and covers whole business days;
* the range covers **at most 31 days per call**; a longer range is `invalid-argument`;
* the default range is the one already documented for the dashboard's landing view (last 7 whole
  business days, ending on the current business day).

**Supersession — rolling windows are withdrawn.** The earlier revision defined rolling
`24h / 7d / 30d / 365d / all` windows anchored at `now`, with an `exact` vs `day_aligned`
`windowMode` disclosure. Central coordination has since frozen a bounded date range in the canonical
timezone, so:

* the **mid-day boundary problem disappears entirely** — every window edge is a business-day
  boundary, which is exactly the granularity `admin_metrics_daily` stores, so **every figure is exact
  with respect to its stated range**;
* `windowMode` is **removed**: there is no longer an approximate window mode to disclose;
* `365d` and `all-time` are **no longer answerable in a single call**. A caller needing a longer
  horizon composes consecutive ≤31-day ranges client-side. The metric *definitions* are unchanged;
  only the per-call span is bounded.

The 31-day cap is what makes the endpoint's cost predictable: at most 31 bucket documents are read
per call, whatever the platform's volume.

**Half-open internally.** A day bucket covers `[dayStart, nextDayStart)` in the canonical timezone,
so summing consecutive buckets neither double-counts nor skips a boundary instant.

### 10.3 Metric definitions and data sources

All amounts in **integer centavos**. Cash and beta are reported in separate blocks and never summed.

| # | Metric | Exact definition | Source | Status |
|---|---|---|---|---|
| 1 | Transaction count | Number of `transactions` rows with `status === "completed"` in range, per category | `admin_metrics_daily.count_by_category` | available |
| 2 | Transaction volume | Σ `amount` in centavos over the same rows, per category | `admin_metrics_daily.sum_centavos_by_category` | available |
| 3 | Average transaction size | `sum_centavos / count`, integer-divided, per category. `null` when `count === 0` | derived from 1 and 2 | available |
| 4 | Median transaction size | 50th percentile of `amount`, reported as a bounded interval — see 10.5 | `admin_metrics_daily.histogram_by_category` | available |
| 5 | Entry fees | Σ `amount` where `category === "entry_fee"` (cash) / `beta_entry_fee` (beta), `status === "completed"` | bucket | available |
| 6 | Prizes distributed | Σ `amount` where `category === "prize"` (cash) / `beta_prize` (beta), `status === "completed"` | bucket | available |
| 7 | Gross Sparta fee | Fee recognised by the platform | none — see 10.6 | `LEDGER_NOT_IMPLEMENTED` |
| 8 | Partner commission | Commission owed to a partner | none — see 10.6, 18 | `SOURCE_NOT_IMPLEMENTED` |
| 9 | Net Sparta revenue | Recognised platform revenue net of commission | none — see 10.6 | `REVENUE_RECOGNITION_NOT_DEFINED` |
| 10 | Organizer revenue | Revenue, wallet, release and withdrawal for organizers | out of scope — see 10.6 | `ORGANIZER_FINANCE_OUT_OF_SCOPE` |
| 11 | Withdrawal states | Count and Σ `amount` of `withdrawals` grouped by observed `status` — see 10.7 | `admin_metrics_daily.withdrawals_by_status` | available |
| 12 | New users | Count of accounts created in range | none — see 10.8 | `CANONICAL_CREATED_AT_UNAVAILABLE` |
| 13 | Partner-attributed users | Users attributed to a partner | none — Session 3 | `SOURCE_NOT_IMPLEMENTED` |
| 14 | Conversion by partner | Attributed users converting to paid entry | none — Session 3 | `SOURCE_NOT_IMPLEMENTED` |
| 15 | Highest-volume tournaments | Top N tournaments by Σ `entry_fee`, and separately by `prize` | `admin_metrics_daily.tournament_volume` (capped, 10.4) | available |
| 16 | Suspicious or duplicate events | See 10.9 | derived + read-only reconciliation | available |

Metrics 7–10 and 12–14 return `value: null`, `available: false` and a stable
`unavailableReason` enum (section 10.11). **Zero is never used to mean "we do not know".**

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
  "updated_at": "<Timestamp>"
}
```

`tournament_volume` is a map keyed by tournament id. A Firestore document is capped at ~1 MiB, so
this map is bounded to the **top 200 tournaments by entry volume for that day**; the bucket records
`tournament_volume_truncated: true` and `tournament_volume_dropped: <n>` when the cap bites. Silent
truncation is forbidden — a dashboard must be able to tell that it is seeing a capped list.

Every counter above is **recomputable by the reconciler from the authoritative ledger** (section
14.2). The bucket is a cache of the ledger, never a substitute for it.

### 10.5 Median — bounded interval, exactly disclosed

**FROZEN.** Resolves open decision 7 (see section 19).

A median cannot be reconstructed from sums and counts. Options considered:

* store every amount → unbounded document growth, rejected;
* exact median by scanning the whole `transactions` collection → the prohibited full-collection read;
* **fixed-bucket histogram → chosen.**

Each daily bucket stores a histogram of `amount` per category using **logarithmic centavo buckets**:
bucket `i` covers `[2^i, 2^(i+1))` centavos, for `i` in `0..30` (1 centavo up to ~R$ 10 737 418).
Bucket `0` additionally absorbs `amount === 0`.

Histograms are **exactly additive**, so summing the per-day histograms across the range and walking
to the 50 % cumulative count yields the bucket that provably contains the median. The result is
reported as an **interval**, never as a fabricated point value:

```jsonc
"medianCentavos": { "lowerBound": 4096, "upperBound": 8191, "exactBucket": true }
```

**This does not violate the "no metric estimated from approximate fields" principle.** The histogram
is built from **exact** amounts via `inspectReais`, and the reported interval is a **proven bound**,
not an estimate: the true median is guaranteed to lie within `[lowerBound, upperBound]`. What is
disclosed is *resolution*, not uncertainty about the data. A consumer must render it as an interval;
collapsing it to a single number and presenting that as "the median" is forbidden.

If an exact point median is ever required, it is an offline reconciliation-report figure computed
from the ledger (section 14.2) — never a live dashboard figure.

### 10.6 Fee, commission, revenue and organizers — **unavailable, by decision**

**FROZEN.** Resolves open decision 3 (see section 19).

#### 10.6.1 Approved product rates (recorded, not computable)

Central coordination and Session 3 have approved these **product** decisions. They are recorded here
for compatibility only — **none of them is a licence to compute a metric at this base**:

| Parameter | Value | Meaning |
|---|---|---|
| `sparta_fee_bps` | `750` | 7,5 % of the **cash** entry fee |
| — | — | The fee is **included in the entry fee**; the player is never charged extra |
| — | — | **Beta and free tournaments generate no such fee** |
| `partner_commission_bps` | `4000` | The future default share **of Sparta's fee** taken by a partner |
| — | — | Equivalent to 3 % of an attributed entry, once the full ledger exists |

Partners/influencers are one category; **organizers are a different category**, and organizer
revenue, wallet, release and withdrawal are **outside this module** entirely.

#### 10.6.2 Why the metrics are still unavailable

There is **no fee, commission, rake, or revenue-split concept anywhere in the backend at
`dcc0d4d`.** An exhaustive search for `partner`, `affiliate`, `referr`, `commission`, `attribut`,
`sponsor`, `coupon`, `promo`, `rake` and `revenue` across `functions/src`, `functions/test`,
`firestore.rules`, `firestore.indexes.json` and `docs/` returns **no functional match** — the only
hits are the word "decommissioned" in [docs/admin-transition.md](../admin-transition.md) and
unrelated prose.

Concretely, settlement credits the winner the tournament's **full** `prize` and takes nothing:
`prizeCentavos` comes straight from `tournaments/{tid}.prize` and the entire amount is credited
([functions/src/index.ts:920-1017](../../functions/src/index.ts#L920-L1017)). Entry fees reach the
platform implicitly — there is **no house account, no fee ledger row, and no split**.

#### 10.6.3 Explicitly forbidden inferences

* **Do not** infer revenue by multiplying entry fees by 7,5 %.
* **Do not** infer commission by multiplying a theoretical fee by 40 %.
* **Do not** treat a future snapshot as recognised revenue.
* **Do not** use a wallet balance or a prize as a stand-in for a platform ledger.
* **Do not** ship an "implied gross margin" (`Σ entry_fee − Σ prize`) as a named revenue metric. An
  earlier revision of this document offered that arithmetic proxy as an optional labelled
  placeholder; it is **withdrawn**, because a dashboard figure that looks like revenue will be read
  as revenue.

A rate that is approved as **product policy** is not the same as a **recognised accounting figure**.
Multiplying a rate by a volume produces a projection, not revenue: it ignores refunds, cancellations,
payment-processor costs, attribution state and revenue-recognition timing — none of which exists in
the backend yet.

#### 10.6.4 Frozen outcome for this version

| Metric | Value | `unavailableReason` |
|---|---|---|
| Gross Sparta fee | `null` | `LEDGER_NOT_IMPLEMENTED` |
| Partner commission | `null` | `SOURCE_NOT_IMPLEMENTED` |
| Platform (net Sparta) revenue | `null` | `REVENUE_RECOGNITION_NOT_DEFINED` |
| Organizer revenue | `null` | `ORGANIZER_FINANCE_OUT_OF_SCOPE` |

**Even after the base fee is integrated**, commission and revenue become available only once their
own canonical sources **and** the refund/recognition policies are integrated. Shipping the fee ledger
does not automatically unlock metrics 8, 9 and 10.

#### 10.6.5 Not implemented by this module

This document does not implement, and does not authorize: the base fee, attribution, a partner
ledger, any new financial category, commission, a house wallet, organizers, or organizer wallet and
withdrawal.

### 10.7 Withdrawal states

**FROZEN.** Resolves open decision 9 (see section 19).

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

### 10.8 New users — **unavailable, by decision**

**FROZEN.** Resolves open decision 4 (see section 19).

`onUserCreated` writes exactly `{ email, username, player_id, pix_key, whatsapp }`
([functions/src/index.ts:193-199](../../functions/src/index.ts#L193-L199)). There is **no
`created_at`** on `users/{uid}`, and Firestore cannot query by document creation time.

Frozen findings:

* the current backend has **no complete, reliable server-side `created_at`** for all users;
* the Auth creation date **must not be inferred by scanning** the Auth user list — that is the
  Auth-side equivalent of the prohibited full-collection read;
* **first activity, first registration and first transaction are not account creation** and must not
  be substituted for it;
* **document ids must never be interpreted as dates**;
* therefore **`new_users` is `null` / unavailable**, with reason
  **`CANONICAL_CREATED_AT_UNAVAILABLE`**.

Future contract, when it is authorized (not by this document):

* `users.created_at` written **exclusively by the server**;
* the timestamp is **immutable**;
* the **client can never set or modify it**;
* an explicit **completeness date** is recorded;
* **only days after that completeness date may report `new_users`**; earlier days stay unavailable,
  because a partially populated field would silently understate signups;
* **no backfill of legacy users is invented** — an absent value is reported as unavailable, never as
  a reconstructed guess.

`created_at` is **not implemented in this documentation workstream.** Until it exists and its
completeness date passes, the bucket stores `new_users: null` and the callable reports the metric as
unavailable — never `0`, which would read as "nobody signed up".

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
// request — exact payload
{
  fromDay: string,                              // "YYYY-MM-DD", canonical timezone
  toDay: string,                                // "YYYY-MM-DD", inclusive, ≤ 31 days from fromDay
  economy?: "cash" | "beta_credit" | "both",    // default "both"
  includeTournaments?: boolean,                 // default false — the expensive block
  tournamentLimit?: number                      // 1..50, default 10
}

// response (abridged)
{
  success: true,
  timezone: "America/Sao_Paulo",
  amountUnit: "centavos",
  fromDay: "2026-08-01",
  toDay: "2026-08-07",
  dayCount: 7,
  cash: {
    transactionCount: { entry_fee: 120, prize: 8, … },
    transactionVolumeCentavos: { … },
    averageCentavos: { … },
    medianCentavos: { lowerBound: 4096, upperBound: 8191, exactBucket: true },
    entryFeesCentavos, prizesDistributedCentavos,
    grossSpartaFeeCentavos:    { value: null, available: false,
                                 unavailableReason: "LEDGER_NOT_IMPLEMENTED" },
    partnerCommissionCentavos: { value: null, available: false,
                                 unavailableReason: "SOURCE_NOT_IMPLEMENTED" },
    netSpartaRevenueCentavos:  { value: null, available: false,
                                 unavailableReason: "REVENUE_RECOGNITION_NOT_DEFINED" },
    organizerRevenueCentavos:  { value: null, available: false,
                                 unavailableReason: "ORGANIZER_FINANCE_OUT_OF_SCOPE" }
  },
  betaCredit: { … same shape; fee/commission/revenue are structurally absent, not merely null … },
  withdrawals: { pending: { count: 3, sumCentavos: 15000 } },
  newUsers:               { value: null, available: false,
                            unavailableReason: "CANONICAL_CREATED_AT_UNAVAILABLE" },
  partnerAttributedUsers: { value: null, available: false,
                            unavailableReason: "SOURCE_NOT_IMPLEMENTED" },
  conversionByPartner:    { value: null, available: false,
                            unavailableReason: "SOURCE_NOT_IMPLEMENTED" },
  topTournaments: [ { tournamentId, entryCentavos, prizeCentavos, registrations } ],
  topTournamentsTruncated: false,
  suspicious: { unknownCategory: 0, malformedAmount: 0, undated: 0,
                duplicatePrize: 0, duplicateEntryFee: 0, prizeNamespaceCollision: 0,
                partialSettlement: 0, walletDrift: 0 }
}
```

Every unavailable metric carries `value: null`, `available: false` and a stable
`unavailableReason`. **Nothing is reported as `0` when the truth is "we do not know".**

Beta blocks never carry a fee, commission or revenue figure at all — not even a `null` one — because
beta and free tournaments generate no fee by product decision (10.6.1). Structural absence is
stronger than a null: there is no field a future change could accidentally populate.

### 10.11 `unavailableReason` enum — stable and documented

| Value | Meaning |
|---|---|
| `SOURCE_NOT_IMPLEMENTED` | The upstream data source (e.g. partner attribution) does not exist yet |
| `LEDGER_NOT_IMPLEMENTED` | The event exists conceptually but no immutable ledger records it |
| `REVENUE_RECOGNITION_NOT_DEFINED` | Sources may exist, but the recognition/refund policy that makes the figure meaningful is undefined |
| `ORGANIZER_FINANCE_OUT_OF_SCOPE` | Deliberately outside this module |
| `CANONICAL_CREATED_AT_UNAVAILABLE` | No complete, server-authoritative creation timestamp exists |

The enum is **stable**: values are added, never renamed or repurposed, so a dashboard can branch on
them safely.

---

## 11. Metric definitions and data sources — summary

Consolidated in the table at 10.3, with per-metric detail in 10.4–10.11. The governing rules:

1. **Every figure traces to an immutable ledger row or an aggregate derived from one.** No metric is
   derived from an engagement aggregate, a wallet total, or a client-supplied value.
2. **Cash and beta are never summed**, in any metric, over any range.
3. **All monetary values are integer centavos.**
4. **No metric is estimated from approximate fields.** Where resolution is bounded (the median), the
   bound is disclosed explicitly and is provable, not estimated (10.5).
5. **Absence of a canonical source means explicit unavailability, never zero.**
6. **The aggregates never replace the ledger** — the reconciler must be able to recompute every
   bucket from the authoritative sources (14.2).
7. **No administrative aggregate participates in a financial transaction.**
8. `admin_metrics_daily/{dayKey}` is keyed in **`America/Sao_Paulo`**.

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

* `getSeasonLeaderboard`: `limit` clamped to `[1, 100]`, default 50; **cursor-based paging only, never
  offset**; cursor bound to season + economy + ordering tuple and rejected otherwise (9.1).
* `getMySeasonRanking`: single entry, no paging surface.
* `getAdminMetrics`: range clamped to **31 days**; `tournamentLimit` clamped to `[1, 50]`, default 10;
  the tournament block is opt-in via `includeTournaments`.
* Every callable uses `assertExactPayload`, so an unexpected key is `invalid-argument` rather than a
  silently ignored field
  ([functions/src/domain/settlement.ts:41-56](../../functions/src/domain/settlement.ts#L41-L56)).
* No callable accepts a raw query, filter, field list, ordering, or collection name from the client.

### 12.3 Leak protection

* `getAdminMetrics` returns **only allowlisted administrative aggregates**. It never returns raw
  player data, a UID, a participant list, an individual wallet, a room credential, a transaction id,
  a `pix_key`, or any row-level document. `topTournaments` returns tournament ids — which every
  signed-in user can already read
  ([firestore.rules:137-139](../../firestore.rules#L137-L139)) — and never UIDs.
* **No leaderboard surface exposes a UID**, in any field, cursor, log or metadata (5.4, 5.6).
* The public leaderboard callables never read `users` at request time; entries carry only the
  allowlisted projection of 5.5.
* Suspicious-event metrics are **counts only**. Investigating a specific flagged row is an offline
  audit operation, not a callable response.
* Because the aggregate collections are backend-written and Rules-denied to clients (section 13),
  an admin-claimed client cannot bypass these limits by reading the aggregates directly.
* **No partner telemetry, no behavioural profiling, and no new analytics purpose is authorized.** The
  existing LGPD basis for Crashlytics does **not** cover partner attribution or any new analytics;
  that remains a separate workstream.

---

## 13. Required Firestore Rules and indexes

### 13.1 Rules

`firestore.rules` ends with a catch-all deny
([firestore.rules:181-183](../../firestore.rules#L181-L183)), so the five new collections are
**already denied** to every client without any change. The design deliberately keeps them that way:
all five are backend-only, reached through callables (Admin SDK, which bypasses Rules).

Explicit match blocks are still recommended so the posture is stated rather than inherited:

```javascript
// SEASON RANKINGS — written only by the ranking trigger, via the Admin SDK.
// Read through getSeasonLeaderboard / getMySeasonRanking, never directly, so the
// server controls paging, field selection and the privacy exclusions.
match /season_rankings/{seasonDocId} {
  allow read, write: if false;
  match /entries/{publicPlayerId} {
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

// PUBLIC IDENTITY MAP — the UID -> publicPlayerId association, and its reverse
// uniqueness guard. Server-only in BOTH directions: no client may read either,
// so the pseudonym can never be resolved back to an account and the id space
// cannot be enumerated; no client may write either, so an identity can never be
// forged, reassigned or reused.
match /public_player_ids/{uid} {
  allow read, write: if false;
}

match /public_player_id_index/{publicPlayerId} {
  allow read, write: if false;
}
```

Note `read: if false` **even for admins**: the callables are the only sanctioned surfaces, which
prevents a Flutter admin screen from paging buckets directly and reconstructing a per-day ledger.
This is what makes the section-10.1 prohibition structural rather than advisory.

Frozen security posture:

* clients **never write** ranking entries, ranking events or admin metrics;
* clients **never choose** score, position, economy, `seasonId` or public identity — every one of
  these is server-derived;
* **the Admin SDK is the only writer**;
* the leaderboard is served **only** as an allowlisted projection;
* administrative metrics **require the `admin: true` claim**;
* **room data never participates** in any ranking or metric;
* **an individual wallet is never exposed**.

### 13.2 Indexes

`firestore.indexes.json` is guarded by
[functions/test/unit/firestoreIndexes.test.ts](../../functions/test/unit/firestoreIndexes.test.ts).
That test uses `.find()` for the legacy-ledger composite and asserts no duplicate **equivalent**
index for the exact field triple `["category","user_ref","tournament_ref"]`. **Adding new indexes for
other field combinations does not break it.** The existing index must be preserved verbatim.

**Conceptually required additions, recorded but NOT applied in this phase** (section 22 forbids
touching `firestore.indexes.json` here):

```jsonc
// leaderboard ordering within a season — the canonical comparator of 4.3
{ "collectionGroup": "entries", "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "scoreCentavos",  "order": "DESCENDING" },
              { "fieldPath": "winsCount",      "order": "DESCENDING" },
              { "fieldPath": "publicPlayerId", "order": "ASCENDING" } ] }

// exact-position counting for getMySeasonRanking (9.2) is served by the same
// index: each of the three disjoint counts is a prefix range over this tuple.
//
// AMENDED — canonical entry invariants. With the canonical key of 4.5 every
// leaderboard and ranking query is a range plus an orderBy on the SINGLE field
// `rankKey`, which Firestore serves from the automatic single-field index. No
// composite index is required by the corrected implementation, and none was
// added. The `entries` composite above is retained as declared — it is
// harmless, still asserted by firestoreIndexes.test.ts, and not yet deployed —
// but it is no longer what serves the queries.

// ledger verification for the read-only reconciler (14.2)
{ "collectionGroup": "transactions", "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "category",  "order": "ASCENDING" },
              { "fieldPath": "status",    "order": "ASCENDING" },
              { "fieldPath": "timestamp", "order": "ASCENDING" } ] }

// withdrawals by state within a date range
{ "collectionGroup": "withdrawals", "queryScope": "COLLECTION",
  "fields": [ { "fieldPath": "status",       "order": "ASCENDING" },
              { "fieldPath": "requested_at", "order": "ASCENDING" } ] }
```

The `entries` index is `COLLECTION` scope, matched under each season document. If cross-season
queries are ever needed it must become `COLLECTION_GROUP`; that is not required by this contract.

The leaderboard index matches the comparator exactly and in the same order, so a single indexed scan
serves both paging and the position counts — no client-side sorting and no in-memory reordering.

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

## 14. Reconciliation and correction

**FROZEN.** No backfill, no repair, no correction callable is authorized by this document.

### 14.1 No backfill

There is none — see sections 3.4 and 7.3. Prizes settled before `firstActiveSeasonId` stay
permanently outside the rankings, and **historical seasons are never reconstructed.**

### 14.2 Read-only reconciliation

Extends the existing audit pattern
([functions/src/audit/reconcile.ts](../../functions/src/audit/reconcile.ts),
[functions/src/audit/cli.ts](../../functions/src/audit/cli.ts)), whose posture is already
classify-and-report rather than mutate.

* **Default mode is read-only / dry-run.**
* It compares three things: the **authoritative ledger**, the **guards** (`ranking_events`) and the
  **aggregates** (`season_rankings`, `admin_metrics_daily`).
* It reports, at minimum:

| Finding | Meaning |
|---|---|
| `missingEvent` | An eligible prize row with no guard and no aggregate contribution |
| `duplicateEffect` | An aggregate that reflects the same event more than once |
| `wrongEconomy` | An event applied to the other economy's aggregate |
| `wrongSeason` | An event applied to a season other than its canonical timestamp's |
| `amountMismatch` | The aggregate total disagrees with the ledger sum |

* **Any future repair must be explicitly administrative, auditable and idempotent** — and is not
  contracted here.
* **Reconciliation must never be used to pull in events from before the first season** (3.4). A
  pre-activation prize is not a `missingEvent`; it is out of scope and is reported as such, if at all.

Closed seasons remain reconcilable against the canonical source indefinitely. A legitimate
correction can **never invent an event** and can **never alter the financial ledger**.

### 14.3 Correction

There is no automatic correction path. If a drift is confirmed, the response is an explicitly
administrative, audited, idempotent action authorized separately — not a silent rewrite, and not a
rebuild, which section 7.3 withdrew.

Correcting the **ledger** is out of scope for this contract and remains an audit concern. If a
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
entries[*].scoreCentavos    == Σ amounts of qualifying prize rows for that player and season
entries[*].winsCount        == count of those rows
season.totalScoreCentavos   == Σ entries[*].scoreCentavos
season.playerCount          == count of entries
```

There is no cross-season invariant, because annual seasons were withdrawn (section 3.1).

Read-only reconciliation asserts all of these (section 14.2).

### 15.4 Two distinct monetary limits — wallet vs aggregate

**FROZEN.** Resolves open decision 5 (see section 19).

These are **different domains and must never share a helper**:

| Domain | Limit | Applies to |
|---|---|---|
| **Individual wallet / single operation** | `MAX_CENTAVOS = 100_000_000` (R$ 1 000 000,00) per amount; `MAX_BALANCE_CENTAVOS = 1_000_000_000` (R$ 10 000 000,00) per balance ([functions/src/domain/money.ts:22-25](../../functions/src/domain/money.ts#L22-L25)) | One player's wallet, one transaction amount |
| **Platform statistical aggregate** | **`MAX_AGGREGATE_CENTAVOS = Number.MAX_SAFE_INTEGER` = 9 007 199 254 740 991 centavos** | Season totals, admin bucket sums, any cross-player figure |

**The wallet cap must never be reused for a platform aggregate.** `addCentavos` throws
`failed-precondition` above R$ 10 M
([functions/src/domain/money.ts:212-223](../../functions/src/domain/money.ts#L212-L223)); that bound
was sized for **one wallet**. Reusing it for platform-wide sums would make the metrics callable start
throwing once cumulative volume crossed R$ 10 M — a latent production failure with no relation to any
real limit.

Frozen rules for the aggregate domain:

* only **safe, finite, non-negative integers**;
* **addition, subtraction and conversion are always checked**;
* **no operation may exceed `Number.MAX_SAFE_INTEGER`**;
* **no floating point** is used to convert reais to centavos — conversion goes through the exact
  integer path (`inspectReais`), never `value * 100` on a double;
* **no silent rounding**;
* **no saturation or clamping** at the limit;
* **no wraparound**;
* **overflow fails observably and prevents the incorrect write** — the aggregate is left untouched
  and the failure is surfaced to reconciliation, never swallowed.

Individual amounts remain subject to their own existing financial limits; the aggregate domain
governs only the sums.

**Helpers are not modified in this phase** — section 17 records where the new domain should live so
`money.ts` stays untouched.

### 15.5 Failure modes

| Failure | Handling |
|---|---|
| Trigger retried after partial write | Impossible — guard and aggregates commit in one transaction |
| Trigger never fires (missed event) | Read-only reconciliation reports `missingEvent`; repair is a separate authorized action |
| Malformed `amount` on a prize row | Row excluded, counted in `malformedAmount`, never guessed |
| Missing/unparseable `timestamp` | Row excluded, counted in `undated` — it cannot be assigned a season |
| Event before `firstActiveSeasonId` | Ignored as out-of-scope; not a failure and not a `missingEvent` |
| `firstActiveSeasonId` unset or malformed | Fail-closed: no aggregate write at all (3.3) |
| Season document contention | Bounded: one prize row per tournament; retries are safe by 7.1 |
| Aggregate overflow | Observable failure, write prevented, no clamp and no wrap — see 15.4 |
| Trigger delayed past month end | Event still lands in its own canonical season (8.4) |

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
| Month boundary `2026-08-31T23:59:59-03:00` vs `+1s` | `2026-08` then `2026-09` |
| Season interval | Half-open `[monthStart, nextMonthStart)` — no gap, no overlap |
| Category `prize` | Eligible, cash economy |
| Category `beta_prize` | Eligible, beta economy, never cash |
| Categories `entry_fee`/`entry_refund`/`deposit`/`withdrawal`/`beta_grant`/`beta_refund`/`beta_entry_fee` | All ineligible |
| Unknown category `admin_correction` | Ineligible (allowlist, fail-closed) |
| `status !== "completed"` | Ineligible |
| `amount` malformed / negative / >2 decimals / NaN | Excluded and counted |
| Event before `firstActiveSeasonId` | Ignored as out-of-scope |
| `firstActiveSeasonId` unset or malformed | Fail-closed: no write at all |
| Tie: equal scores, different wins | Higher `winsCount` first |
| Tie: equal scores and wins | Lower `publicPlayerId` first — strict total order |
| Comparator | Antisymmetric and transitive over a generated set; no UID and no timestamp level |
| Positions | Exact ordinals 1,2,3,4 — no shared positions, no gaps |
| Wallet cap vs aggregate cap | `addCentavos` throws above R$ 10 M; aggregate helper does not — 15.4 |
| Aggregate at `Number.MAX_SAFE_INTEGER` | Overflow fails observably; no clamp, no wrap, write prevented |

### 16.2 Unit — `functions/test/unit/publicPlayerId.test.ts`

| Case | Expectation |
|---|---|
| Generated id | Exactly 22 chars matching `[A-Za-z0-9_-]{22}` |
| Entropy | 16 random bytes, base64url, no padding |
| Derivation | Not a function of uid, `player_id`, e-mail, phone or name |
| Collision on create | Retried; never overwrites an existing mapping |
| Immutability | A second assignment for the same uid is rejected |
| Reuse | A released id is never reassigned to another account |
| Label | `Jogador ` + first 8 chars; full id still used for identity and ordering |

### 16.3 Unit — `functions/test/unit/adminMetrics.test.ts`

| Case | Expectation |
|---|---|
| Day bucket interval | Half-open `[dayStart, nextDayStart)` in São Paulo |
| Range of 31 days | Accepted |
| Range of 32 days | `invalid-argument` |
| `toDay` before `fromDay` | `invalid-argument` |
| Average with `count === 0` | `null`, never `0` and never a division by zero |
| Histogram median, odd/even counts | Correct bucket interval |
| Histogram additivity | Σ of day histograms == histogram of the union |
| Median when all rows in one bucket | `lowerBound`/`upperBound` are that bucket |
| Cash and beta blocks | Never summed; no combined field exists |
| Beta block | Carries no fee/commission/revenue field at all |
| Unavailable metrics | `value: null`, `available: false`, enum reason; never `0` |
| `unavailableReason` values | Exactly the enum of 10.11 |
| `tournament_volume` beyond cap | `truncated: true` and a dropped count |

### 16.4 Handler — `functions/test/rules/seasonRanking.handlers.test.ts`

| Case | Expectation |
|---|---|
| Trigger applies a prize once | Season entry, season parent and guard created in one transaction |
| Trigger replayed with same tx id | No increment; totals byte-identical |
| Two distinct prizes, same player, same season | `scoreCentavos` and `winsCount` accumulate exactly |
| Prizes in different months | Land in their own monthly seasons |
| Trigger running after month end | Event still lands in its own canonical season |
| Cash and beta prizes for the same player | Separate season documents; never combined |
| Non-prize transaction created | Trigger writes nothing |
| Malformed prize row | Trigger writes nothing and records the exclusion |
| Aggregate write fails | Guard is NOT written; the event stays retryable |
| `getSeasonLeaderboard` `limit` 1000 | Clamped to 100 |
| `getSeasonLeaderboard` unexpected key | `invalid-argument` |
| Cursor from another season or economy | Rejected with `invalid-argument` |
| Tampered/opaque-cursor corruption | Rejected, never silently reinterpreted |
| Any leaderboard response | Contains no UID, anywhere, including the cursor |
| `getMySeasonRanking` with `uid` in payload | `invalid-argument` — caller comes only from context |
| `getMySeasonRanking` for a player with no prizes | `isRanked: false`, `rank: null`, `entry: null`; no document created |
| `getMySeasonRanking` rank | Matches the player's position in the paged leaderboard exactly |

### 16.5 Negative authorization — `functions/test/rules/adminMetrics.auth.test.ts`

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
| `getMySeasonRanking` unauthenticated | `unauthenticated` |

### 16.6 Rules — `functions/test/rules/seasonRanking.rules.test.ts`

| Case | Expectation |
|---|---|
| Client reads `season_rankings/{seasonDocId}` | Denied |
| Client reads `season_rankings/{id}/entries/{publicPlayerId}` | Denied |
| Admin client reads any of the above | Denied — callable is the only surface |
| Client reads `ranking_events/{txId}` | Denied |
| Client or admin reads `admin_metrics_daily/{day}` | Denied |
| Client or admin reads `public_player_ids/{uid}` | Denied |
| Client or admin reads `public_player_id_index/{publicPlayerId}` | Denied — the pseudonym can never be resolved back to a uid |
| Any client write to any of the five | Denied |
| Existing collections | Postures unchanged from the current suite |

### 16.7 E2E — `functions/test/e2e/seasonRankingFlow.e2e.test.ts`

Full emulator flow: create tournament → join → start → `declareTournamentResult` → assert the prize
transaction, then assert the season entry, the season parent, the guard document and the admin
bucket; replay `declareTournamentResult` and assert no double count; page the leaderboard and assert
positions are exact ordinals with no UID in any payload; assert `getMySeasonRanking` agrees with the
paged position.

### 16.8 Index guard

`functions/test/unit/firestoreIndexes.test.ts` must continue to pass unchanged. When the section-13.2
indexes are eventually applied (a later phase), a new assertion should cover each added index.

---

## 17. Expected source files for later implementation

| File | Contents |
|---|---|
| `functions/src/domain/seasonRanking.ts` | Pure rules: season id derivation, eligibility allowlist, comparator, position arithmetic. No Admin SDK, no `firebase-functions` — matches the existing domain-layer convention. |
| `functions/src/domain/publicPlayerId.ts` | Pure rules: 22-char base64url format, validation, label derivation. Generation itself needs `crypto`, so it lives in the handler layer. |
| `functions/src/domain/adminMetrics.ts` | Pure rules: date-range boundaries and the 31-day cap, histogram bucketing, median interval, average, `unavailableReason` enum. |
| `functions/src/domain/aggregateMoney.ts` | `MAX_AGGREGATE_CENTAVOS` and the aggregate-safe checked add — section 15.4. **Deliberately a separate module**, so the frozen `money.ts` wallet contract is not touched. |
| `functions/src/index.ts` | New exports only: `onPrizeTransactionCreated`, `getSeasonLeaderboard`, `getMySeasonRanking`, `getAdminMetrics`, each with its `…Handler` counterpart, pinned to `REGION_CALLABLES`. Existing exports untouched. |
| `firestore.rules` | The five match blocks of 13.1. |
| `firestore.indexes.json` | The index objects of 13.2 — **not in this phase**. |
| Tests | The seven new files of section 16 (16.1–16.7). 16.8 adds assertions to the existing `firestoreIndexes.test.ts` rather than a new file. |

**No rebuild or backfill CLI appears in this table.** Section 7.3 withdrew it; there is nothing to
rebuild. Consequently no `lib/ranking` entry is needed in `firebase.json`'s deploy-ignore list.

[functions/test/unit/functionRegions.test.ts](../../functions/test/unit/functionRegions.test.ts)
guards the deployment surface. It **discovers the deployable exports dynamically** — every export
carrying a `__trigger` — and compares that discovered set against a **closed authorized surface**
held in a single manifest, which maps each Function name to the one region it must declare.

Consequences for the new exports in this section:

* **A new Function never passes silently.** An unlisted deployable export fails the surface
  assertion even though its `__trigger` is perfectly valid.
* Each new export must be **explicitly authorized by adding one entry to that manifest**, with its
  expected region. This is a required step, not a nicety — it is what keeps a new deploy target a
  deliberate decision rather than a side effect of writing code.
* Once that single entry exists, **both its presence and its region are verified automatically**.
* **Forgetting `.region(...)` fails**, because the manifest's expected region is asserted against
  `__trigger.regions` and an implicit region does not match it.
* The name does **not** need repeating across several lists — the manifest is the only place a
  Function's authorized name and region are declared.

---

## 18. Partner-session handoff

Session 3 owns the partner/attribution model. **Nothing about partners exists at this design base** —
sections 10.6 and 0.3 establish that there is no partner entity, no attribution field, no commission
category, and no revenue split anywhere in the backend.

Six admin metrics are blocked on Session 3: partner commission, net Sparta revenue,
partner-attributed users, conversion by partner, and — indirectly — gross Sparta fee and any
credible revenue figure.

**Approved rates, recorded for compatibility (see 10.6.1).** `sparta_fee_bps = 750` (7,5 % of the
cash entry, included in the entry, never charged on top; beta and free generate none) and
`partner_commission_bps = 4000` (40 % of Sparta's fee, ≈ 3 % of an attributed entry). **These are
product policy, not computable metrics** — section 10.6.3 forbids deriving any figure from them until
the corresponding ledgers exist. Organizers are a separate category and are out of scope for this
module entirely.

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
* `getAdminMetrics` already returns `partnerCommissionCentavos`, `netSpartaRevenueCentavos`,
  `partnerAttributedUsers` and `conversionByPartner` as `value: null, available: false` with enum
  reasons; Session 3 fills them in **without changing the response shape**.

---

## 19. Resolution of the twelve previously open decisions

**There are no open decisions in this document.** All twelve are closed below — each either decided
outright or frozen as an approved fail-closed behaviour. Anything still needed before code can be
written is a **prerequisite**, not an open decision, and is listed in section 20.

| # | Original decision (as previously stated) | Resolution | Where frozen |
|---|---|---|---|
| 1 | **Public display name** — `username` permanently `""`, `player_id` not collision-free, Auth `displayName` unvalidated, `users` not publicly readable | **DECIDED.** Server-generated pseudonymous `publicPlayerId`: 16 random bytes, base64url unpadded, exactly 22 chars, collision-checked, create-only, immutable, never reused, not derived from uid/`player_id`/e-mail/phone/name. Public label is `Jogador ` + first 8 chars. No customisable public name in this phase. The earlier "ship with `player_id`" recommendation is **withdrawn**. | §5 |
| 2 | **Separate cash and beta leaderboards**, and whether beta should be public | **DECIDED.** Cash and beta are separate rankings, never summed, converted or compared; positions computed independently; economy is part of the season document id. Both are served to authenticated users via the same callable, selected by the required `economy` parameter. | §3.1, §4, §6.1, §9.1 |
| 3 | **Fee / commission / revenue undefined at this base** | **DECIDED — unavailable by decision.** Rates are recorded as product policy (`sparta_fee_bps = 750`, `partner_commission_bps = 4000`), but gross fee, partner commission, net revenue and organizer revenue all return `value: null, available: false` with enum reasons. Inferring revenue from rate × volume is forbidden. The `impliedGrossMargin` proxy is **withdrawn**. | §10.6 |
| 4 | **New-user counting impossible** — no `created_at` on `users` | **DECIDED — fail-closed.** `new_users` is `null` / unavailable with `CANONICAL_CREATED_AT_UNAVAILABLE`. Auth scanning, first-activity proxies and document-id-as-date are all forbidden. The future `created_at` contract (server-only, immutable, with a completeness date, no legacy backfill) is frozen but **not implemented here**. | §10.8 |
| 5 | **Aggregate overflow ceiling** — wallet cap reused for platform sums | **DECIDED.** Two distinct domains. Wallet/operation limits unchanged; platform aggregates use `MAX_AGGREGATE_CENTAVOS = Number.MAX_SAFE_INTEGER` (9 007 199 254 740 991) in a **separate module**, with checked arithmetic, no float conversion, no silent rounding, no clamp, no wrap, and observable overflow that prevents the write. | §15.4 |
| 6 | **First Firestore document trigger in the repository** | **APPROVED.** Trigger fires after the prize transaction is created; ranking never joins the settlement transaction; a ranking failure never undoes, blocks or delays a prize; at-least-once delivery is expected and handled by the `ranking_events/{txId}` guard committed atomically with the aggregates. | §7, §8 |
| 7 | **Median is approximate** | **DECIDED.** Median is reported as a **provable bounded interval** `{lowerBound, upperBound, exactBucket: true}` from exactly-additive histograms of exact amounts — disclosed resolution, not an estimate from approximate fields. Collapsing it to a single number and calling it "the median" is forbidden. Exact point medians only in offline reconciliation. | §10.5 |
| 8 | **Rolling windows day-aligned for 365d and all-time** | **DECIDED — superseded.** Rolling windows are withdrawn. `getAdminMetrics` takes an explicit `fromDay`/`toDay` range of whole business days in the canonical timezone, capped at **31 days per call**. Every figure is therefore exact for its stated range and `windowMode` is removed. 365d/all-time are composed from consecutive calls. | §10.2 |
| 9 | **Withdrawal states single-valued** (`pending` only) | **DECIDED — fail-closed.** The aggregate keys **dynamically by observed `status`**, never a hardcoded enum, so `paid`/`failed` appear automatically when the PIX integration lands. No status bucket is fabricated, and `pending` must not be rendered as "awaiting debit" — the wallet is already debited. | §10.7 |
| 10 | **Leaderboard visibility** | **DECIDED.** Authentication is mandatory on both leaderboard callables, matching `tournaments`, the only client-readable collection. No unauthenticated surface, so no unauthenticated enumeration. | §9.1, §9.2 |
| 11 | **Single winner per tournament is structural** | **DECIDED — frozen as-is.** `prize_{tournamentid}` and `placement: 1` remain the contract; settlement is not changed by this document. The ranking depends only on the deterministic transaction id, so it is unaffected either way. **If multi-placement payouts are ever introduced, the prize-id derivation changes and this contract must be amended first** — specifically the duplicate-prize detector (§10.9) and the `prize_*` namespace assumption. | §1, §10.9, §14 |
| 12 | **Pre-existing test debt in `invariants.test.ts`** | **CLOSED — not a product decision.** It is a recorded defect in an existing test that redeclares the retired `prize_{winneruid}_{tid}` helper locally instead of importing `prizeTransactionId`. Nothing about this contract depends on it. It is reclassified as an **implementation prerequisite** (§20), to be fixed when tests are authorized. It is not carried forward as an open decision. | §20 |

No decision was deferred, renamed, or replaced by a new open item.

---

## 20. Implementation prerequisites

These are **not open decisions** — every behaviour above is frozen. These are the concrete things
that must exist before ranking code can be written, and the fail-closed behaviour that applies while
each is missing.

| # | Prerequisite | Fail-closed behaviour until it exists |
|---|---|---|
| 1 | **`firstActiveSeasonId` configured and validated** in the backend (§3.3) | Ranking processing is inert: no aggregate write at all. Absent/malformed is a configuration error, never "start now" and never a default month. |
| 2 | **`publicPlayerId` implemented**, with generation, collision handling, immutability, Rules and tests (§5) | Ranking cannot ship. The leaderboard must not fall back to `player_id` or any existing identifier. |
| 3 | **Base 7,5 % fee integrated separately** as an immutable ledger, outside this module (§10.6) | Fee/commission/revenue metrics stay `null` with their enum reasons. |
| 4 | **`users.created_at`** server-written, immutable, with a completeness date (§10.8) | `new_users` stays `null` with `CANONICAL_CREATED_AT_UNAVAILABLE`; days before the completeness date stay unavailable permanently. |
| 5 | **`MAX_AGGREGATE_CENTAVOS` module** created separately from `money.ts` (§15.4) | Aggregates must not be written using the wallet helper. |
| 6 | **Firestore Rules** for the five new collections (§13.1) | The catch-all deny already blocks them, but the posture must be explicit before launch. |
| 7 | **Indexes** of §13.2 applied and deployed | Leaderboard paging and exact-position counting are not servable. |
| 8 | **Fix `functions/test/unit/invariants.test.ts`** to import `prizeTransactionId` instead of redeclaring it — **resolves open decision 12**, reclassified from decision to defect (§19) | Pre-existing defect, unrelated to this contract; new ranking tests must never redeclare a source helper. |
| 9 | **Privacy review of the retention policy** before any physical deletion or anonymisation (§8.4) | Nothing is deleted; seasons beyond the 12-month window are simply not served. |

---

## 21. Recommended sequence

1. Central review and sign-off of this frozen contract.
2. Complete and integrate the **base 7,5 % fee** separately.
3. Define the first `firstActiveSeasonId`.
4. Implement the **pseudonymous public identity**.
5. Implement the **ranking trigger, guard and entries**.
6. Implement the **callables and indexes**.
7. Implement **admin metrics for available sources only**.
8. Implement **Rules**.
9. Implement the **read-only (dry-run) reconciler**.
10. Run tests for idempotency, concurrency, economy separation, pagination, position, overflow and
    security.
11. Only then evaluate **production activation**.
12. **Attribution, commission and organizers remain later workstreams.**

---

## 22. Scope of this document

This update **does not authorize**: a trigger, a callable, a collection, an index, a Rule, a test, a
backfill, a repair, a migration, a fee, a commission, attribution, organizers, a settlement change, a
ledger change, or a deploy.

It **freezes the contract for central review** and nothing more. No source, Rules, indexes, tests,
dependencies or Firebase configuration were modified.

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
| `engagementStats.ts` `normalizeMonth`, `monthOfDayKey`, `daysInMonth` | — (pure) | `YYYY-MM` validation and slicing | n/a | n/a | Direct | **reuse** | Season ids are exactly `YYYY-MM` with the same validity band (2020–2100). Reimplementing would risk divergent validation. | None — reused verbatim, no new date helper is introduced. |
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

* `season_rankings/*/entries/*.scoreCentavos` and `.winsCount` — from
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
| Backfill re-applies an already-counted prize | **Cannot occur — there is no backfill** (3.4, 7.3). Ranking state is append-only from activation forward. |
| Reconciliation double-counting an event | **Cannot occur** — reconciliation is read-only and never writes ranking state (14.2). |
| Pre-activation prize pulled in later | Excluded by `firstActiveSeasonId` and explicitly forbidden in reconciliation (3.4, 14.2). |
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

The proposed names `season_rankings`, `ranking_events`, `admin_metrics_daily`, `public_player_ids`,
`public_player_id_index`, `onPrizeTransactionCreated`, `getSeasonLeaderboard`, `getMySeasonRanking`,
`getAdminMetrics`, `MAX_AGGREGATE_CENTAVOS` and `publicPlayerId` collide with nothing at this base.

Note that `player_id` (the existing `PLR-######` field on `users`) and `publicPlayerId` are
**different things** and must never be conflated: the former stays an internal, collision-prone
handle; the latter is the public pseudonymous identity of section 5.

### R.8 Compatibility expectations for existing Flutter consumers

* `getPlayerEngagementStats` is **unchanged** — same request shape, same response keys, same
  `amountUnit: "centavos"`, same `timezone`. No client change is required by this design.
* `recordDailyAppOpen` is unchanged.
* No existing collection, field, category, document id, callable name or region changes. There is no
  data migration and no client-visible breaking change.
* New callables are purely additive; a client that does not call them is unaffected.
* Clients must treat a metric's `value: null` / `available: false` as "unavailable", never as zero,
  and should branch on the stable `unavailableReason` enum (10.11).
* Clients must treat `medianCentavos` as an **interval**, never collapsing it to a single number
  presented as "the median" (10.5).
* Clients must compose ranges longer than 31 days from consecutive `getAdminMetrics` calls (10.2).
* The leaderboard exposes **no UID**; a client that needs to identify "me" in a page compares
  `publicPlayerId` against the value returned by `getMySeasonRanking` (5.4, 9.2).

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
