# Phase 01 handoff — the PostgreSQL foundation proof

Phase 00 built the architecture and proved it against an in-memory adapter. Phase 01 existed to
answer one question: **does any of it survive contact with a real database?**

Mostly yes. **Six real defects were found**, all invisible to a 147-test suite that looked
comprehensive. Four were of one species: guarantees that held because a single-threaded fake had
nothing to race against, or because it had no constraints to violate. The other two were worse in
kind — the proof apparatus itself was broken. The PostgreSQL suites never terminated, so no full
`npm test` had ever actually completed, and `npm run verify` had never been green. Every claim in
this document was re-derived from a complete run of the final tree; the numbers below are that
run's, not a reconstruction.

---

## 1. Verdict

**PHASE 01 PARTIALLY READY.** The foundation is proven on PostgreSQL. Two named gaps remain, both
of them control-plane work rather than defects, and neither blocks Phase 02.

|                                |                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proven against real PostgreSQL | migrations, transactions, rollback, row locks, `SKIP LOCKED`, partition exclusivity, ownership CAS, leases, crash recovery, dead letters, transactional outbox, tenant RLS, composite tenant-safe FKs, duplicate ingest, multi-process workers, burst handling, knowledge validity, account isolation |
| Still proven only in memory    | nothing that Phase 00 claimed — every Phase 00 guarantee was re-run on PostgreSQL                                                                                                                                                                                                                     |
| Structurally reviewed only     | the `event_deliveries` retry state machine; `lead_candidates`                                                                                                                                                                                                                                         |
| Not yet proven at all          | the outbox **relay** (no handler exists); `AccountRepository.findBySlug`; anything involving Meta, a real model, or an operator UI                                                                                                                                                                    |

Not production-ready, and deliberately so. There is still no transport in either direction: no
Meta, no live model, no HTTP server.

### The run this document is based on

Every gate below was run to completion on the exact tree being committed — not carried over from an
earlier session, and not inferred from suites that had passed individually.

| Gate       | Command                | Result                                           |
| ---------- | ---------------------- | ------------------------------------------------ |
| Formatting | `npm run format:check` | pass                                             |
| Lint       | `npm run lint`         | pass, 0 errors                                   |
| Types      | `npm run typecheck`    | pass, 0 errors                                   |
| Tests      | `npm test`             | **251 pass, 0 fail, 0 skipped**, exit 0, 147.2 s |
| Demo       | `npm run demo`         | pass, no network                                 |

The 251 are **147 in-memory tests carried unchanged from Phase 00** plus **104 new PostgreSQL
integration tests**. Nothing was skipped: the PostgreSQL suites skip themselves with a stated reason
when no server can be started, and on this run none did.

| PostgreSQL suite                 | Tests |
| -------------------------------- | ----- |
| `JobQueue` contract on Postgres  | 13    |
| durability and failure injection | 12    |
| row-level security               | 11    |
| security posture                 | 11    |
| transactions                     | 11    |
| knowledge validity               | 9     |
| migrations                       | 7     |
| performance sanity               | 7     |
| duplicate ingest and bursts      | 5     |
| multi-process workers            | 5     |
| ownership compare-and-swap       | 5     |
| concurrency (partitions)         | 4     |
| vertical slice                   | 4     |

---

## 2. The PostgreSQL environment used

**PostgreSQL 17.10 on x86_64-windows**, run as a disposable local cluster.

No PostgreSQL, Docker or Podman was installed on the machine. Rather than stop at the
infrastructure boundary, the proof uses `embedded-postgres`, a plain npm devDependency that
unpacks an official PostgreSQL distribution into `node_modules` and runs `postgres.exe` as an
ordinary child process:

- no Windows service, no registry entry, no administrator rights;
- a fresh `initdb` data directory under the OS temp tree per run, removed afterwards;
- a randomly chosen free port, so it cannot collide with anything;
- deleting `node_modules` removes it completely.

That satisfies "a clearly disposable local PostgreSQL environment" without installing an operating
system service. One cluster serves the whole test process — reference-counted across suites with a
short linger so back-to-back suites share it, and stopped when the last suite releases it. `initdb`
costs roughly 20 seconds, once per run. (Tying that teardown to `process.on('beforeExit')` instead
is what caused finding #5; see §16.)

**To run the proof yourself:** `npm install && npm test`. Nothing else is required.

If the platform-specific binary package is ever unavailable, every PostgreSQL suite skips with a
stated reason rather than failing — a skipped suite is honest, a red one would look like a code
defect, and a silently-passing one would be a lie.

---

## 3. Postgres adapter architecture

```
src/adapters/postgres/
  client.ts        pool, transaction runner, tenant context, timeouts, shutdown
  errors.ts        SQLSTATE -> platform error translation (the retry decision, made once)
  migrator.ts      deterministic, checksummed, exactly-once migrations
  repositories.ts  every repository port
  job-queue.ts     the durable queue (ADR-004/005)
  index.ts         the persistence bundle
```

### Two pools, two roles

This is the structural decision of the phase, and it was forced by the ports themselves.

`JobQueue.claim()` takes no `AccountScope` — by design, because a worker asks "what is there to
do?" across every account. Under an RLS policy keyed on `app.account_id`, that query returns
nothing. The fix is a second role rather than a weaker policy:

| Role           | Sees                      | Granted                                                            | Used by                               |
| -------------- | ------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| `app_migrator` | everything (`BYPASSRLS`)  | schema ownership                                                   | migrations only; never serves traffic |
| `app_runtime`  | one tenant at a time      | `SELECT/INSERT/UPDATE` on tenant tables, minus append-only columns | every repository                      |
| `app_worker`   | the queue, across tenants | `jobs` and `dead_letters` **only**                                 | `claim`, `fail`, `reap`, dead letters |

`app_worker` is deliberately **not** `BYPASSRLS`. It gets a permissive policy scoped `TO
app_worker` on those two tables, so its _grants_ still stop there: a worker bug cannot read a
conversation even by accident. A test asserts exactly this — the worker role gets `42501` on
`conversations`, `messages`, `raw_inbound_events` and `knowledge_entries`.

### Tenant context

Every scoped repository call runs inside a transaction that issues
`SELECT set_config('app.account_id', $1, true)` — the `true` making it `SET LOCAL`, so it reverts
on COMMIT or ROLLBACK. That is what makes it safe on a pooled connection, and there is a test with
a pool of exactly one connection proving the context does not survive into the next borrower.

There is no ambient tenant state. A unit of work is _pinned_ to the first account that speaks for
it; a second account inside the same transaction raises `TenantViolationError` rather than quietly
switching context halfway through a commit.

Calls made outside an explicit transaction open a short implicit one. That is not a convenience:
`SET LOCAL` is meaningless outside a transaction, so a bare pooled query would run under whatever
context the previous borrower left behind.

### Enqueue runs on the runtime pool

`enqueue` uses the tenant pool so it joins the caller's transaction. An enqueue on the worker pool
would open its own connection and its own transaction, and a crash between the two would lose
exactly the event ADR-004 promises never to lose.

---

## 4. Migration result

A ~150-line runner, no framework (ADR-003).

| Property               | How                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Deterministic order    | files sort by a required `NNNN_lower_snake.sql` prefix; duplicate versions are a hard error |
| Exactly once           | the migration and its history row commit in one transaction                                 |
| No silent drift        | every applied file's sha256 is stored; editing an applied migration fails loudly            |
| No partial application | the whole run is one transaction under one advisory lock                                    |
| Safe to repeat         | a second run applies nothing and says so                                                    |

The runner strips each file's own `BEGIN;`/`COMMIT;` so it can put the DDL and the history row in
_one_ transaction. The match is anchored to column zero, so the `BEGIN` inside a `DO $$ ... $$`
block — which carries no semicolon and is always indented — is never mistaken for transaction
control. There is a test for exactly that.

**Proven:** fresh database → migrate → full schema; migrate again → nothing applied, and the
`information_schema` snapshot is byte-identical; a deliberately broken migration leaves neither a
table nor a history row.

### Two new migrations

**`0005_runtime_roles.sql`** — three things running the DDL for real revealed:

1. **`bigserial` needs a sequence grant.** `jobs.seq` is a `bigserial`, so `INSERT INTO jobs`
   fails with "permission denied for sequence jobs_seq_seq" under any non-owner role. Migrations
   0001–0004 grant on tables only. Invisible until a non-superuser inserts a job — which is to say,
   invisible until production.
2. **`app_worker`**, for the reason above.
3. **`app_resolve_webhook_connection()`** — ingest must resolve tenancy _before_ it has tenancy.
   `findByPublicWebhookId` is unscoped by design (ADR-006): the opaque id in the URL is what
   establishes which account a request belongs to. Under RLS it returned nothing, which would have
   broken every inbound webhook.

   The fix is the narrowest hole possible: one `SECURITY DEFINER` function taking an unguessable id
   and returning two identifiers — no `credentials_ref`, no `settings`, no payload — with
   `search_path` pinned. The caller then re-reads the full connection row _inside_ the tenant
   context those ids establish, so the row itself is never read outside RLS.

**`0006_deferred_conversation_fk.sql`** — see §16.

---

## 5. RLS proof

Run as `app_runtime_login`: a non-superuser, non-`BYPASSRLS` role. The first test asserts that,
because an isolation suite run as `postgres` passes whether the policies exist or not — worse than
having no suite, since it manufactures confidence.

The queries attack the tables directly and deliberately omit the `account_id` predicate, which is
exactly what a bug would do. Testing through the repositories would only prove the repositories are
careful.

| Claim                                                           | Result                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A reads A                                                       | ✅                                                                                            |
| A cannot read B — 13 tenant tables, no predicate                | ✅ 0 foreign rows on every one                                                                |
| B cannot read A                                                 | ✅ symmetric, not a fixture artefact                                                          |
| A cannot UPDATE B's conversation, naming its primary key        | ✅ 0 rows, and the row is verifiably untouched                                                |
| A cannot DELETE B's rows                                        | ✅ `42501` — no DELETE grant at all                                                           |
| A cannot INSERT a row carrying B's `account_id`                 | ✅ `42501` from the policy's `WITH CHECK` half                                                |
| A cannot reference a B row through a composite FK               | ✅ `23503` twice — immediately on `moderator_runs`, at `COMMIT` on the deferred `messages` FK |
| A connection with no context set                                | ✅ sees nothing; `app_current_account_id()` returns NULL and every policy fails closed        |
| Every table with an `account_id` has RLS **enabled and FORCEd** | ✅ 21 tables                                                                                  |

**The suite is not vacuous.** One test drops `conversations_tenant_isolation`, asserts that account
A immediately sees B's conversation, and restores it. If that test ever fails, every assertion
above is meaningless.

---

## 6. Transaction proof

- A failure mid-transaction rolls back a write the test has already _observed_ inside that
  transaction — so the rollback is doing the work, not a check that skipped it.
- **Ingest atomicity:** breaking `enqueue` after the ledger insert leaves zero ledger rows and zero
  jobs. This is ADR-004's entire argument, as an observation.
- **Outbox atomicity:** failing `outbox.append` during conversation creation leaves the
  conversation uncreated. Allowed outcomes are both or neither; "state committed, nobody told" is
  impossible.
- **Retryable relay:** re-reading pending events repeatedly changes no domain state — delivery
  state is separate from the mutation it describes.
- **No context leakage:** with `maxConnections: 1`, a scoped transaction followed by an unscoped
  one on the _same physical socket_ shows no inherited `app.account_id`.
- **No cross-tenant transaction:** two accounts in one unit of work raises `TenantViolationError`
  and the whole attempt rolls back.
- **Query timeout:** `SET LOCAL statement_timeout` cancels a `pg_sleep(5)` at 250 ms as a
  `TIMEOUT`, not a hang.
- **Bounded pool:** six concurrent units over a pool of two never exceed two connections; after
  `close()`, further work fails with `DATABASE_CLOSED` rather than resurrecting the pool.
- **No secrets in logs:** the role password appears in no log record, on success or failure.

---

## 7. Job queue proof

**The Phase 00 `JobQueue` contract suite runs against the Postgres adapter unchanged.** All 13
assertions pass: partition exclusivity, `run_at` invisibility, `(run_at, seq)` ordering, coalescing,
the anti-starvation ceiling, READY-only coalescing, lease expiry preserving the attempt count,
expired leases not blocking a partition, dead-lettering on exhaustion, type filtering, state counts.

The suite needed exactly one change — the factory may now return a Promise, because a real database
cannot be rebuilt synchronously. Every behavioural assertion is untouched, which is what makes a
pass here mean something: the two adapters agree about what the words mean.

Time is a **parameter**, never `now()`. Every predicate compares against a caller-supplied
timestamp, which is what lets the contract drive lease expiry and debounce ceilings with a
`TestClock` instead of `setTimeout`.

### The write skew (finding #1, the important one)

The reference claim query in `0003_operations.sql` guards partition exclusivity with

```sql
AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.partition_key = j.partition_key
                  AND r.state = 'RUNNING' AND r.lease_expires_at > now())
```

Under `READ COMMITTED` that check runs against a snapshot taken before any concurrent claimer
commits. **Two workers can each pick a different READY job in the same partition and both conclude
the partition is free.** `FOR UPDATE SKIP LOCKED` does not help: it locks the rows being claimed,
and those are different rows.

This is textbook write skew, and it is _structurally invisible_ to a single-threaded in-memory
adapter — the exact class of bug Phase 01 exists to find. Two workers answering one conversation at
once is two replies to one customer.

The fix is a transaction-scoped advisory lock keyed on the partition, evaluated as part of the
candidate predicate:

```sql
AND pg_try_advisory_xact_lock($ns, hashtext(j.partition_key))
```

`try_`, not blocking, so a contended partition is _skipped_ rather than queued behind — preserving
the lock-free scaling the design wanted from `SKIP LOCKED`. `hashtext` collisions between unrelated
partitions are possible and harmless: two conversations occasionally serialise, which costs a little
throughput and breaks nothing.

Both advisory-lock arguments are `int4`. The namespace constant was initially chosen above 2³¹ and
PostgreSQL rejected it — worth knowing, since the migrator's single-argument lock takes a `bigint`
and looks superficially similar.

#### The lock alone was not enough (found in the closing adversarial review)

Putting the lock **inside** the candidate predicate of a single `UPDATE` narrows the window but does
not close it. A statement's snapshot is fixed when the statement begins. A rival claimer that
commits _after_ our snapshot is taken and _before_ our `pg_try_advisory_xact_lock` call is therefore
invisible to us **and** no longer holds the lock — it was released at that commit. We take the lock,
evaluate `NOT EXISTS` against the stale snapshot, see an idle partition, and claim. Two live leases,
one conversation. Microseconds wide, and exactly the shape of bug that survives a green suite.

The decisive check has to be a **later statement**, under the lock, with a newer snapshot. `claim`
is now three statements in one transaction:

1. pick a candidate and take its partition lock (`FOR UPDATE SKIP LOCKED`, `pg_try_advisory_xact_lock`);
2. **re-check the partition for a live lease** — a new statement, so a new snapshot. Any rival that
   claimed here must have held this same lock, so by the time we hold it that transaction has ended;
   if it committed, we see its row;
3. update the chosen row.

If step 2 says busy, the partition is added to a per-call exclusion list and the loop tries another
candidate, bounded at four probes. That bound only ever costs anything during a real race — in the
steady state `NOT EXISTS` filters busy partitions server-side and a claim makes exactly one probe.
Reporting "queue empty" after losing a race would be worse than a slow claim: it stops a drain loop.

The cost is one extra round trip: claim p50 moved from 4.4 ms to 7.0 ms at a queue depth of 600.
That is the honest price of the guarantee, and it is paid once per job, not once per message.

A note on how this was found, because it matters for how much the rest of this document is worth:
**no test caught it.** The multi-worker, multi-process and sustained-contention suites all pass
against the two-statement version _and_ the three-statement one. It was found by reading the
isolation semantics, and it is not reproducible on demand from outside the database — you cannot
pause a statement between its snapshot and a function call in its own predicate. That is a real
limit on what this phase's concurrency proofs can establish: they can find races that are wide
enough to hit, and they cannot certify the absence of races that are narrow.

---

## 8. Conversation CAS proof

`saveIfUnchanged` is one statement:

```sql
UPDATE conversations SET ... WHERE id = $1 AND account_id = $2 AND ownership_version = $18
```

`account_id` is in the predicate _as well as_ in RLS. Belt and braces: a policy that is ever
loosened must not silently turn this into a cross-tenant write.

- The same expected version cannot win twice.
- **A losing CAS writes nothing** — not even the columns that did not conflict. Asserted on
  `locale` and `last_processed_inbound_seq`, because a partial write there would corrupt the
  watermark and silently skip a customer message.
- **Takeover during generation:** the operator's claim survives, ownership stays `HUMAN_OWNED`, no
  outbound action is created, the watermark does not advance (so the operator still sees the
  unanswered message), and the run records why it did nothing.
- **Two operators at once:** one winner, one explicit failure, never a silent overwrite. The
  ownership version sequence is gapless and strictly increasing, and the conversation row agrees
  with its own history.

Every placeholder in the CAS statement is referenced. PostgreSQL infers a parameter's type from its
use, so passing one the statement never mentions fails with `42P18` "could not determine data type"
— an error that reads like a constraint violation and is nothing of the kind. That cost an hour.

### Finding #2: the conflict that arrived by the wrong door

`UNIQUE (account_id, conversation_id, version)` on the ownership ledger can fire **before** the
commit-time CAS does. A human takeover landing while a moderator run is preparing its own ownership
transition collides there first.

In memory, `appendOwnershipTransition` pushes to an array with no uniqueness, so this ordering never
arises and the CAS always got to speak first. Under PostgreSQL the run saw a generic constraint
violation, `run-moderator`'s `catch` did not recognise it, the job dead-lettered, and **the run was
left stranded in `RUNNING` with no terminal state and no reason recorded** — a conversation
abandoned by exactly the mechanism meant to protect it.

The fix is to say what the constraint means: a duplicate version _is_ a concurrency conflict, so the
adapter raises `ConcurrencyConflictError` and the existing supersede path handles it. No domain
change; a translation that was missing.

---

## 9. Deduplication proof

Against real PostgreSQL, with each "delivery" on its own connection pool:

| Scenario                                 | Result                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 2 concurrent identical deliveries        | 1 `ACCEPTED`, 1 `DUPLICATE`; one ledger row, one message, one conversation, one moderator run, one outbound action |
| 10 concurrent identical deliveries       | 1 `ACCEPTED`, 9 `DUPLICATE`; **2 jobs total**, not 20                                                              |
| Same message id, two different envelopes | 2 ledger rows (both deliveries recorded), **1 message** — level-2 dedupe, F-02                                     |
| Redelivery after full processing         | byte-identical counts before and after; a redelivered webhook is a non-event                                       |

The database constraints participate: `insertIfNew` is a real `ON CONFLICT ... DO NOTHING
RETURNING`, never a `SELECT` followed by an `INSERT`. The loser is _told_ it is a duplicate rather
than handed an error, which is what keeps F-01 a normal, non-alerting outcome.

`findOrCreate` for channel identities is a single `INSERT ... ON CONFLICT DO UPDATE`, so two
concurrent first messages from one person cannot create two identities and therefore cannot create
two conversations for one thread.

---

## 10. Burst handling proof

Three messages arriving 400 ms apart, on PostgreSQL:

- **3** raw inbound events persisted — no event discarded because it was coalesced for reasoning;
- **3** messages retained, `seq` 1/2/3, gapless and ordered;
- **1** `moderator.run` job — the burst coalesced onto one scheduled run;
- **1** moderator run, **1** outbound action;
- watermark advanced to 3: the single run answered all three.

And the mirror case: a message arriving while a run is `RUNNING` produces a **new** `READY` job
behind it (`['RUNNING', 'READY']`), rather than being coalesced into the running job and lost. The
partial unique index covers `state = 'READY'` only, and that is why.

---

## 11. Crash and reaper proof

| Scenario                                   | Result                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Worker dies holding a job, attempts remain | lease lapses → `READY`, `attempt` preserved so a crash loop still exhausts its retries, no dead letter    |
| Worker dies, no attempts left              | `DEAD_LETTERED` **+** a `dead_letters` row **+** a `REQUESTED` handoff **+** conversation `PENDING_HUMAN` |
| No terminal orphan                         | zero rows match "`DEAD_LETTERED` with no dead-letter row"                                                 |
| Two reapers concurrently (same process)    | exactly one recovers it; recorded once                                                                    |
| Two reaper **processes** concurrently      | exactly one recovers it; recorded once                                                                    |
| Reaper run three times                     | **one** handoff — the operator queue is not flooded by a timer                                            |

`reapExpiredLeases` is one statement with two outcomes chosen per row, wrapped in a CTE with `FOR
UPDATE SKIP LOCKED`. Two statements would leave a window in which a job counted as neither requeued
nor dead-lettered, and a concurrent reaper could act on it in between.

A dead letter is a **snapshot**, not a join back to `jobs`: deleting the job row leaves the dead
letter readable and replayable, which is what retention requires.

---

## 12. Dead-letter proof

Covered above, plus:

- an unregistered job type (`outbound.dispatch`, deliberately absent in Phase 0) dead-letters with
  `NO_HANDLER` rather than vanishing;
- a repeatedly failing handler is retried with bounded backoff, then dead-lettered **and** escalated
  to a human — the customer is handed to a person, not dropped;
- an archived account fails the job terminally with `ACCOUNT_ARCHIVED` and sends nothing on behalf
  of that client.

---

## 13. Outbox atomicity proof

See §6. Both directions are asserted: the state change cannot commit without its event, and the
event cannot exist without the state change. A failing publisher also leaves the watermark
unmoved, so the message is still pending and nothing was silently skipped.

**Not proven: the relay itself.** `outbox.relay` has no registered handler in Phase 0, and
`EventOutbox.markRelayed(eventId)` takes no scope — so under RLS it would match zero rows and the
relay would loop forever, redelivering. The Postgres adapter therefore **throws
`NotImplementedError`** rather than silently succeeding. See §19.

---

## 14. Multi-worker proof

Real OS processes, forked with `spawn`, each with its own pool and its own memory.

| Scenario                                     | Result                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2 processes, 20 jobs, 20 partitions          | all 20 processed, none twice, both processes did work, final state `{SUCCEEDED: 20}`                                                                         |
| 3 processes, 12 jobs, **1 partition**        | `maxConcurrentInPartition <= 1` for every process; 12 claims, no duplicates                                                                                  |
| A process dies holding a job                 | job stays `RUNNING` with the dead worker's lease; after the lease lapses in real time, a separate reaper process requeues it and a third process picks it up |
| 2 reaper processes, 1 expired terminal lease | exactly one recovers it; exactly one dead-letter row                                                                                                         |

The concurrency observation is taken **from the database** by each process independently
(`count(*) FROM jobs WHERE partition_key = $1 AND state = 'RUNNING' AND lease_expires_at > now()`),
not from a counter in either process. Neither worker can see the other's memory; both can see the
same rows.

---

## 15. Failure injection results

| Injected fault                             | Visible                    | Durable                       | Bounded                  | Recovered or escalated                                                    |
| ------------------------------------------ | -------------------------- | ----------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Transaction error mid-commit               | ✅                         | rolled back whole             | ✅                       | retried                                                                   |
| Connection killed (`pg_terminate_backend`) | ✅                         | —                             | ✅                       | classified **transient**, so a failover does not dead-letter healthy work |
| Worker exception, repeated                 | ✅                         | `last_error` on the job       | ✅ `max_attempts`        | dead letter + handoff                                                     |
| Process termination after claim            | ✅                         | lease visible in the row      | ✅                       | reaper requeues                                                           |
| Duplicate delivery                         | ✅ reported as `DUPLICATE` | ledger row                    | n/a                      | non-event                                                                 |
| CAS conflict                               | ✅                         | run recorded `SUPERSEDED`     | n/a                      | no outbound, watermark held                                               |
| Dead-letter threshold                      | ✅                         | `dead_letters` row            | ✅                       | handoff raised                                                            |
| Invalid account scope (archived)           | ✅                         | `ACCOUNT_ARCHIVED` on the job | ✅ terminal, not retried | operator-visible                                                          |
| Outbox publisher failure                   | ✅                         | nothing half-committed        | ✅                       | retried; watermark unmoved                                                |
| No registered handler                      | ✅                         | `NO_HANDLER`                  | n/a                      | dead letter                                                               |

**No silent failure was found.** Every injected fault ended as a durable, queryable fact.

The retry classification lives in one place (`errors.ts`) rather than at each call site. Getting it
wrong in either direction is expensive: retrying a constraint violation burns budget and delays the
human who needs to look at it; _not_ retrying a deadlock turns a routine lock interleaving into a
dead-lettered conversation.

---

## 16. Finding #3 — write ordering versus foreign keys

`normalizeItem` inserts the message **before** saving the conversation. The ordering is deliberate:

```ts
const inserted = await deps.messages.insertIfNew(scope, message);
if (!inserted.inserted) return { duplicate: true, ... };   // conversation untouched
await deps.conversations.save(scope, { ...conversation, nextSeq: seq + 1, ... });
```

The rule it encodes is "a duplicate delivery must not mutate the conversation" — and in particular
must not leave an empty conversation behind for a message that already exists elsewhere (F-02). The
in-memory adapter has no foreign keys, so the ordering was free there. PostgreSQL rejected the
insert immediately, the whole normalize transaction rolled back, and **the job dead-lettered on the
very first message.**

Two ways out. Reorder the writes — trading a domain rule for SQL convenience and leaving an empty
conversation on the duplicate path. Or say what is actually true: the message and its conversation
are one atomic fact, and the constraint should hold at COMMIT rather than between two statements.
`0006` takes the second, declaring **only** that one foreign key `DEFERRABLE INITIALLY DEFERRED`.

The guarantee is not weakened — an orphaned message still aborts the transaction. What changes is
_when_ the error surfaces, which costs some diagnosability: a genuine ordering bug elsewhere now
reports at commit rather than at the offending statement. That is the price, and it is named here
rather than buried.

### Finding #4 — the adapter mangled the platform's own errors

`translatePgError` duck-typed on `.code`, and `AppError` also carries a string `code`. Every domain
error raised inside a transaction was therefore rewritten as a generic
`DATABASE_CONSTRAINT_VIOLATION` — turning a retryable, meaningful `ConcurrencyConflictError` into a
terminal, useless one. Caught early because a migration checksum test asserted on an error code.

### Finding #5 — the test process never exited, so the proof never ran

The most consequential defect in the phase, and it was in the apparatus rather than the product.

`embedded-postgres` starts the server with a plain `spawn` and piped stdio, and never `unref`s it.
That child handle keeps Node's event loop alive for as long as the server runs, so
`process.on('beforeExit')` — where cluster shutdown was registered — **never fires**. Every
PostgreSQL suite finished its assertions and then hung forever: no summary line, no exit code, no
result. A full `npm test` was killed after **88 minutes** having completed every test and reported
none of them.

This is worth stating plainly because of what it implies about the earlier session's evidence.
Suites had been observed passing individually, but a run that never terminates has no exit status,
and "the last thing printed was green" is not the same claim as "the suite passed". **Until this
was fixed, no complete run of this repository had ever been observed.**

The fix moves cluster lifetime onto the reference count that already existed, with a 750 ms linger
so that back-to-back suites still share one cluster and still pay `initdb` only once. `beforeExit`
remains as a backstop for abnormal paths. A single suite now exits in 23 seconds; the full suite in
under three minutes.

### Finding #6 — `npm run verify` had never been green

On the tree as inherited: three TypeScript errors in the new PostgreSQL tests (a mock-provider
script kind that does not exist, and two unbranded `UserId`s), five ESLint errors, and 19 files
failing `prettier --check`. All were in Phase 01 code. They are trivial individually; collectively
they say the gate had not been run end to end, which is the same lesson as finding #5.

One of those failures was substantive rather than cosmetic. The RLS suite's composite-FK test
asserted an immediate `23503`, and migration `0006` had since made that exact constraint
`DEFERRABLE INITIALLY DEFERRED` — so the insert now succeeds and the transaction is refused at
`COMMIT` instead. The test was failing against a guarantee that had genuinely moved. It now proves
both halves: immediate rejection on `moderator_runs`, commit-time rejection on `messages`, and that
nothing is left behind either way.

---

## 17. Performance sanity findings

Not a benchmark. A smoke alarm for design mistakes.

Measured on this machine with **600 queued jobs across 10 accounts and 600 partitions**:

| Measurement                       | Result                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Claim latency                     | **p50 6.7 ms, p95 8.0 ms**                                                        |
| Claim plan over `jobs`            | `Index Scan` + `Index Only Scan`, using `jobs_ready_idx` — **no sequential scan** |
| Reaper sweep plan                 | index scan via `jobs_running_partition_idx` — no sequential scan                  |
| `countByState` over 600 rows      | 3 ms                                                                              |
| 4 concurrent cross-account claims | 4 won, 173 ms                                                                     |
| Enqueue throughput                | 600 jobs in 2.1 s (single connection, one round trip each)                        |

Claim latency was p50 4.4 ms before the three-statement rewrite in §7. The extra ~2.3 ms buys the
partition-exclusivity guarantee; it is quoted here rather than quietly absorbed. The explained plan
is the candidate scan the adapter actually issues, exclusion array included — explaining a
simplified stand-in would prove a query nobody runs is fast.

All twelve indexes the hot paths depend on exist and are used. A sequential scan on the claim path
would mean claim latency grows with the size of the _whole_ queue, so one busy account slows every
other one down — that is the specific catastrophe this section exists to rule out.

Two notes for later:

- The planner chose `jobs_running_partition_idx` for the reaper sweep rather than the
  purpose-built `jobs_lease_expiry_idx`. Both are correct; the latter may be redundant.
- The advisory lock in the claim predicate is evaluated per candidate row. At 600 jobs this is
  invisible. At a queue depth where many candidates are skipped before one is claimable, it is
  worth re-measuring.
- `claim` now takes three round trips inside one transaction. On a local socket that is noise; over
  a network with real latency it is three times the network cost of a claim, and a busy worker
  claims constantly. Worth measuring before the first deployment where the database is not on the
  same host.

**Not measured:** anything at production scale, sustained load, connection-pool behaviour under
saturation over time, or vacuum/bloat on a queue table with high churn. A queue table is a
high-churn table and will need autovacuum attention; nothing here proves it will not.

---

## 18. Security findings

| Reviewed                   | Result                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| RLS bypass                 | only `app_migrator` has `BYPASSRLS`, and it does not serve traffic. `app_worker` uses a role-targeted policy plus narrow grants instead       |
| Role privileges            | runtime cannot `CREATE`/`DROP`/`ALTER`, and specifically cannot `DISABLE ROW LEVEL SECURITY` on itself                                        |
| Append-only enforcement    | runtime cannot `DELETE` from `messages`, `audit_events`, `conversation_ownership_transitions`, `raw_inbound_events`, or `domain_event_outbox` |
| Ledger immutability        | runtime cannot rewrite `payload` or `signature_valid`; only the four granted lifecycle columns                                                |
| `SET LOCAL` context        | transaction-scoped, proven not to leak across a pooled connection                                                                             |
| SQL injection              | every statement is parameterised. A hostile message body and a hostile account id are both stored/bound verbatim and never executed           |
| PII logging                | a customer message body appears in no log record                                                                                              |
| Error content              | database errors carry SQLSTATE and constraint name, never the statement or its parameters — parameters routinely contain customer content     |
| Secret handling            | no secret column exists; connections carry a `secret://` reference resolved through the `SecretResolver` port                                 |
| `SECURITY DEFINER` surface | exactly one function, returning two identifiers, with `search_path` pinned. Asserted by a test that enumerates every `prosecdef` function     |
| Role separation            | `app_runtime`, `app_worker` and their login roles are all non-superuser and non-`BYPASSRLS`                                                   |

### Recommended role model

```
app_migrator   BYPASSRLS, owns the schema.  Used by the migration job only. Never by a running app.
app_runtime    NOLOGIN parent. SELECT/INSERT/UPDATE on tenant tables, minus append-only columns.
               Always inside SET LOCAL app.account_id. Grants the login role its membership.
app_worker     NOLOGIN parent. jobs + dead_letters only. Cross-tenant queue visibility by policy,
               not by BYPASSRLS, so its blast radius stops at the queue.
<test roles>   Separate LOGIN roles per pool, members of the above. Never superuser — an RLS suite
               run as superuser proves nothing.
```

The runtime application role does **not** need schema-owner privileges, and the tests demonstrate it
by migrating as one role and running as another.

---

## 19. What remains in-memory only, and what remains unproven

**In-memory only:** the `SecretResolver` (by design — secrets are resolved by reference, and moving
them into a table for testing convenience would model the one thing ADR-002 says never to store),
and the mock LLM provider.

**Unproven, and named rather than glossed:**

1. **The outbox relay.** No handler, and `markRelayed` cannot work under RLS with its current
   signature. The Postgres adapter throws `NotImplementedError` rather than silently succeeding.
   Needs either a relay role (as `app_worker` is to the queue) or a scoped signature.
2. **`AccountRepository.findBySlug`.** Resolving a slug means asking "which tenant is this?" before
   a tenant context exists. A slug is guessable, unlike a webhook id, so it wants a control-plane
   role rather than another hole in the runtime's policy. No caller in `src/`; throws.
3. **`event_deliveries`** — the per-subscription retry state machine has a schema and no code.
4. **`lead_candidates`** — schema only.
5. **Production scale.** 600 jobs is not 600,000. Vacuum, bloat and long-term pool behaviour are
   untested.
6. **Failover and replication.** A killed backend is classified correctly; a promoted replica,
   split-brain, or connection storm is not tested.
7. **Everything downstream of the boundary:** Meta transport, a real model, an operator UI, a real
   CRM. Intentionally absent.
8. **The absence of narrow races.** The concurrency suites establish that no race wide enough to
   observe was observed across pools, processes and sustained contention. They cannot establish that
   none exists: the write skew in §7 was still present after the first fix, passed every one of
   them, and was found by reading isolation semantics instead. Treat "proven" in this document as
   "proven to the resolution of a test that can actually run".

### One divergence between the adapters, recorded deliberately

`KnowledgeGapRepository.record` behaves differently in the two adapters. The schema models a gap as
a **counter** — `UNIQUE (account_id, question_shape, locale)` plus an `occurrences` column — and the
Postgres adapter upserts and increments. The in-memory adapter appends to a list.

The schema is right: a backlog that lists the same unanswered question three hundred times is
unusable; one that ranks it by frequency is a work queue. The in-memory adapter is the approximation
here, and `KnowledgeGapRecord` has no `occurrences` field to expose the difference. Left as-is
because changing it would alter Phase 00 behaviour for no Phase 01 benefit — but it is a real
divergence and it is written down.

---

## 20. Open risks

| #    | Risk                                                                                                                                                                                                               | Why it matters                                                                                                  | Mitigation now                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| R-1  | **The reaper still has no scheduler.** It is wired, tested and proven across processes, but nothing calls it on a timer.                                                                                           | Crash recovery that nobody triggers is crash recovery that does not happen.                                     | Carried from Phase 00. First item of Phase 02.                                                                   |
| R-2  | Advisory-lock hash collisions serialise unrelated conversations.                                                                                                                                                   | Throughput only, never correctness.                                                                             | Measured as negligible at current scale; re-measure under load.                                                  |
| R-3  | The deferred FK moves an ordering error from statement time to commit time.                                                                                                                                        | Diagnosability, not safety.                                                                                     | Exactly one constraint is deferred; every other FK still fails fast.                                             |
| R-4  | `app_worker` has cross-tenant queue visibility.                                                                                                                                                                    | A worker bug could read another tenant's _job payloads_ (ids and keys, no message content).                     | Grants stop at two tables; asserted by test.                                                                     |
| R-5  | Queue-table churn will need autovacuum tuning.                                                                                                                                                                     | A bloated `jobs` table degrades the claim path.                                                                 | Not yet observed; needs load testing.                                                                            |
| R-6  | The moderator's supersede path runs _after_ its transaction rolls back, in a second transaction.                                                                                                                   | A crash between the two leaves a run in `RUNNING`.                                                              | The reaper recovers the job; the stale run row is cosmetic but should be swept.                                  |
| R-7  | No connection-level retry. A transient error propagates to the worker's retry loop.                                                                                                                                | Correct, but coarse: a one-off deadlock costs a full backoff cycle.                                             | Acceptable; revisit if deadlocks show up in practice.                                                            |
| R-8  | `statement_timeout` is global per transaction, not per query class.                                                                                                                                                | A legitimately slow analytical query would be cancelled.                                                        | No such query exists yet.                                                                                        |
| R-9  | Test suite runtime is ~2.5 minutes, dominated by PostgreSQL startup and per-test truncation.                                                                                                                       | A suite slow enough to skip is a suite that stops being run.                                                    | One cluster per process; cached admin connections. Watch it.                                                     |
| R-10 | **Narrow races cannot be certified by this suite.** The residual write skew in §7 was found by reading isolation semantics, not by a failing test, and it is not reproducible on demand from outside the database. | Every concurrency claim in this document means "no race wide enough to hit was observed", not "no race exists". | Reasoned review of every predicate that mixes a snapshot with a lock. Repeat it whenever the claim path changes. |
| R-11 | Cluster teardown depends on suites balancing `acquirePostgres` / `releasePostgres`.                                                                                                                                | An unbalanced suite leaves the run hanging again, which reads as a slow test rather than a broken one.          | `beforeExit` backstop; the balance is checkable in one grep. Consider `--test-global-setup`.                     |

---

## 21. Required follow-up

1. **Run `npm run verify` in CI, with a hard timeout.** Findings #5 and #6 both reduce to the same
   thing: a gate nobody ran end to end. A timeout is the part that matters — the failure mode here
   was a hang, and a hang looks like a slow build, not a red one.
2. **Schedule the reaper.** (R-1, carried from Phase 00.)
3. Give the outbox relay a role and a handler, or scope `markRelayed`.
4. Decide the control-plane role, which unblocks `findBySlug` and operator login.
5. Sweep runs left in `RUNNING` past a threshold (R-6).
6. Load-test the queue at a realistic depth; tune autovacuum; re-measure the three-round-trip claim
   against a non-local database (R-2, R-5, §17).
7. Consider dropping the possibly-redundant `jobs_lease_expiry_idx` after confirming the planner's
   choice under load.

---

## 22. Exact Phase 02 recommendation

**Phase 02 = the operational shell. Still no Meta, still no live model.**

In order:

1. **A process that runs.** `APP_ROLE=worker` polls with the configured interval, and the reaper
   runs on a timer. This closes R-1, the oldest open risk in the project, and it is small.
2. **An HTTP ingest endpoint.** The webhook path is fully built and fully unproven over HTTP:
   body-size limits, the raw-body requirement for signature verification, and the fast-`200`
   contract. No Meta credentials — a local client posting signed bodies is enough.
3. **The outbox relay**, with its own role, closing the second gap in §19.
4. **Operational visibility.** Queue depth, dead-letter count, oldest unprocessed event, handoffs
   past SLA. All of these are already queries; they need somewhere to go.
5. **Graceful shutdown.** A worker that receives `SIGTERM` should stop claiming, finish its current
   job, and release its lease rather than let it expire.

Only after that does the transport question become the interesting one.

---

## 23. Is live Meta authorized?

**No.**

Nothing changed here in Phase 01. `OUTBOUND_MODE=LIVE` is still refused at boot, `outbound.dispatch`
still has no registered handler, no credentials exist, and no code path in this repository opens a
socket to anything but a local PostgreSQL server on a random port.

Authorising live Meta requires, at minimum: the operational shell above, an approved Account Pack
for the client in question, a reviewed escalation path with a human actually watching it, and an
explicit decision by someone accountable for what the AI says to that client's customers. None of
those is a Phase 01 deliverable.
