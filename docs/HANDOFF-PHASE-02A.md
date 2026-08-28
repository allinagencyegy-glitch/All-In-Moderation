# Phase 02A handoff — the application that runs

Phase 00 built a library. Phase 01 proved it against a real database. Both were driven entirely by
tests calling functions: `drain()` for the worker, `reap()` for the reaper, `ingest()` with a
string the test had just built. Nothing in the tree ever looped, nothing was ever scheduled,
nothing bound a socket, and nothing had ever been asked to stop.

Phase 02A is where that becomes a process.

---

## 1. Verdict

**PHASE 02A READY.**

Every objective set for this phase is implemented and proven against a real PostgreSQL server, and
both gaps Phase 01 named and refused to fake are closed. Six new risks are recorded in §11 rather
than glossed; none blocks the next phase, and one of them (R-12) is a pre-existing narrow window
this phase made easier to reach and chose to narrow rather than to close badly.

|                            |                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proven, on real PostgreSQL | continuous worker polling, the reaper on a server-side timer, graceful shutdown with lease release, HTTP raw-body ingest, signature verification over the exact bytes, size caps, duplicate idempotency, fast acknowledgement, the outbox relay and its role, health endpoints |
| Proven, in memory as well  | the same behaviours against the in-memory adapter, so a Postgres disagreement is the database and not the test                                                                                                                                                                 |
| Still simulated            | the relay's destination, the language model, every outbound action                                                                                                                                                                                                             |
| Still absent               | Meta transport, real credentials, `event_deliveries` fan-out, an operator UI, any client's business rules                                                                                                                                                                      |
| Live Meta connection       | **NOT AUTHORIZED.** See §10.                                                                                                                                                                                                                                                   |

---

## 2. What was asked, and where it is

| #   | Objective                                             | Where                                                                                       | Proven by                                                                                    |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | A worker process that continuously polls the JobQueue | `src/runtime/worker-loop.ts`, `src/runtime/application.ts`                                  | `runtime shell: the worker loop`, `postgres runtime shell`, `postgres application lifecycle` |
| 2   | The lease reaper on a server-side timer               | `src/runtime/scheduler.ts`, wired in `application.ts`                                       | `runtime shell: the scheduled reaper`, `postgres runtime shell`                              |
| 3   | Graceful shutdown                                     | `worker-loop.stop`, `worker.interrupt`, `JobQueue.releaseLease`, `application.stop`         | `runtime shell: graceful shutdown`, `postgres application lifecycle`                         |
| 4   | A minimal HTTP server                                 | `src/runtime/http/server.ts`                                                                | `http webhook ingest`, `health endpoints`                                                    |
| 5   | The Meta-like webhook endpoint                        | `server.ts`, `raw-body.ts`, `ingest-webhook.verifySubscription`                             | `http webhook ingest` (17 tests), `postgres http ingest`                                     |
| 6   | No real external network calls                        | nothing in `src/` opens an outbound socket                                                  | the demo gate in CI; `OUTBOUND_MODE=LIVE` refused at boot                                    |
| 7   | Locally generated signed payloads                     | `tests/support/harness.ts` signs with `computeMetaSignature`                                | every HTTP suite                                                                             |
| 8   | Duplicate HTTP deliveries stay idempotent             | unchanged domain logic, now reached over HTTP                                               | `is idempotent across duplicate deliveries` (memory and Postgres, the latter concurrent)     |
| 9   | The Phase 01 outbox relay gap, narrowest safe role    | `0007_relay_and_health.sql`, `operations/events/relay.ts`, `createPostgresOutboxRelayStore` | `outbox relay` (8 tests), `postgres outbox relay` (12 tests)                                 |
| 10  | Operational health endpoints                          | `src/operations/health.ts`, `/health/{live,ready,status}`                                   | `health snapshot`, `health endpoints`, `postgres application lifecycle`                      |
| 11  | Existing 251 tests stay green                         | —                                                                                           | the full-suite run in §3                                                                     |
| 12  | Integration tests for all nine named behaviours       | seven new test files, four in memory and three on PostgreSQL                                | §3                                                                                           |
| 13  | CI test floor raised                                  | `.github/workflows/verify.yml`                                                              | `MIN_TESTS: 332`, plus four new required Postgres suite names                                |
| 14  | This document                                         | —                                                                                           | —                                                                                            |

---

## 3. The numbers

```
tests 332   pass 332   fail 0   skipped 0   suites 53   duration 183s
```

Phase 01 closed at **251**. Phase 02A adds **81**, and the arithmetic below accounts for every
one of them — a count that does not reconcile is a count nobody checked.

| Suite                                 | Tests  | New?                                         |
| ------------------------------------- | ------ | -------------------------------------------- |
| `http webhook ingest`                 | 17     | new                                          |
| `outbox relay`                        | 8      | new                                          |
| `health snapshot`                     | 7      | new                                          |
| `health endpoints`                    | 4      | new                                          |
| `runtime shell: the worker loop`      | 3      | new                                          |
| `runtime shell: graceful shutdown`    | 4      | new                                          |
| `runtime shell: the scheduler`        | 5      | new                                          |
| `runtime shell: the scheduled reaper` | 1      | new                                          |
| `postgres outbox relay`               | 12     | new                                          |
| `postgres http ingest`                | 6      | new                                          |
| `postgres runtime shell`              | 4      | new                                          |
| `postgres application lifecycle`      | 4      | new                                          |
| `JobQueue contract: memory`           | 15     | +2 — `releaseLease`, both directions         |
| `JobQueue contract: postgres`         | 15     | +2 — the same two, unchanged, on the adapter |
| `postgres security posture`           | 13     | +2 — the second SECURITY DEFINER function    |
| **added**                             | **81** |                                              |
| carried from Phase 01                 | 251    | every one still green                        |
| **total**                             | 332    |                                              |

Two of those numbers are worth reading twice. The 15 in **both** `JobQueue contract` rows is the
adapter-agnostic suite running unchanged against the memory and Postgres queues, so
`releaseLease` cannot mean two different things. And `postgres outbox relay` is 12 rather than 6
because half of it asserts what the relay role **cannot** do — visibility without limits is the
easy half of a privilege proof.

### Two defects the new suites found in the existing tree

Neither is in Phase 02A code, and both are recorded because Phase 01 established that a proof
apparatus can be as broken as the thing it proves.

1. **An unbalanced `acquirePostgres`.** The first draft of `tests/postgres/runtime-shell.test.ts`
   acquired the shared cluster in a second `describe` and never released it. Every assertion
   passed and the process then never exited — which reads as a slow test, not a broken one. This
   is R-11 from Phase 01 recurring on its first opportunity; the fix is one `releasePostgres()`
   and the risk stays open.
2. **A latent flake in `a killed connection surfaces as a retryable failure`.** A `pg.Client`
   reports a terminated backend by two routes that race: the pending query rejects, and the
   client emits `error` asynchronously. An `error` event with no listener is fatal in Node, so
   the test failed intermittently for a reason unrelated to its subject. It now captures both and
   asserts they classify identically — which surfaced a real gap: the driver's derived
   `Client has encountered a connection error` message was classified TERMINAL, so whether a lost
   connection was retried depended on which route won the race. `isTransientPgError` now
   recognises it.

Every number above is from one complete run of the final tree, not a reconstruction.

---

## 4. The three things that had to be designed, not just written

### 4.1 Graceful shutdown needed a new queue operation

The naive implementation of "stop claiming, finish the current job" has a defect that only appears
when a handler honours its abort signal. The signal fires, the handler rejects with an ordinary
`Error`, and `retryabilityOf` classifies an unknown error as `TERMINAL` — which is correct, and
which means the worker **dead-letters the job it just interrupted**. A rolling deploy would
dead-letter one conversation per worker and raise a human handoff for each, and it would look like
a spate of unrecoverable failures rather than a deployment.

So `Worker` gained `interrupt()`, and the shutdown outcome is distinguished from a failure in the
one place where the distinction exists — the `catch` block. An interrupted job is _released_:

```
JobQueue.releaseLease(jobId, now) -> boolean
```

`UPDATE jobs SET state='READY', lease_owner=NULL WHERE id=$1 AND state='RUNNING'`. Three decisions
in that one statement:

- **The attempt is not refunded.** It was genuinely spent. Refunding it would let a shutdown loop
  retry a poisonous job forever.
- **`state='RUNNING'` is the guard, and the return value is the point.** A worker whose lease
  already lapsed no longer owns the job; the reaper may have requeued it and a second worker may be
  running it. Releasing then would hand a partition back that someone else is holding. It returns
  `false`, and the contract suite asserts exactly that (test 15).
- **It is in the shared contract suite**, so the memory and Postgres adapters cannot drift.

### 4.2 The forced path deliberately does _less_

Past the shutdown grace period the handler is still running, having ignored its abort signal. The
tempting move is to release its lease anyway — the partition frees, the deploy finishes, everyone
is happy. It is also wrong: that handler may yet commit, and a second worker claiming the same
conversation is two writers on one conversation, which is the failure this platform is built to
prevent.

So the forced path leaves the lease alone, logs
`worker loop shutdown forced; lease left to expire` at `error`, and lets the reaper recover it. It
is slower and it is strictly safe, and the asymmetry is asserted by two tests that differ only in
whether the handler respects its signal.

### 4.3 The relay needed a role, and the role needed limits

Phase 01's diagnosis was exact: `EventOutbox.markRelayed` carries no `AccountScope`, so under RLS
it matches zero rows, the watermark never moves, and the relay redelivers forever. It named the two
acceptable fixes — a relay role, or a scoped signature — and threw `NotImplementedError` rather
than pick one badly.

`app_relay` is the answer, built on the shape 0005 established for `app_worker`:

| Role           | Sees                       | Granted                                                                   | Used by                   |
| -------------- | -------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| `app_migrator` | everything (`BYPASSRLS`)   | schema ownership                                                          | migrations; never traffic |
| `app_runtime`  | one tenant at a time       | `SELECT/INSERT/UPDATE` on tenant tables, minus append-only columns        | every repository          |
| `app_worker`   | the queue, across tenants  | `jobs` and `dead_letters` only                                            | claim, fail, reap, health |
| `app_relay`    | the outbox, across tenants | `SELECT` on `domain_event_outbox`; `UPDATE (relayed_at)` and nothing else | the relay                 |

Column-level `UPDATE` is the part worth pausing on. `GRANT UPDATE ON domain_event_outbox` would
also permit rewriting `data`, `type` and `account_id` — a relay bug could change what a consumer
receives on its way out of the platform. `GRANT UPDATE (relayed_at)` cannot. Six tests connect as
the relay login role and assert the boundary directly: it is not superuser, it does not
`BYPASSRLS`, it gets `42501` on `data`/`type`/`account_id`/`subject_id`, on `INSERT` and `DELETE`,
on eight other tables, and on the health function it was never granted.

**Delivery semantics.** At least once, never at most once: delivery happens _before_ the watermark
moves, so a crash between them costs a duplicate rather than the event. `markRelayed` returns a
boolean because two relays racing on one row must produce exactly one "first delivery" and one
"already done" — `relayed_at IS NULL` in the `UPDATE` is the arbiter, and a Postgres test races two
of them to prove it. A failed delivery **halts that account's stream for the round** and leaves
everything behind it pending; other accounts continue. Skipping ahead would deliver
`conversation.started` after the events describing what happened inside it.

---

## 5. The HTTP edge

The endpoint is thin by construction — it translates a URL into a webhook id, a query string into a
verification request, bytes into an ingest request, and a domain outcome into a status code. It
makes no decisions. Four properties are the reason the file exists.

### 5.1 Raw bytes, and the one place fidelity could still be lost

Nothing parses the body before verification; that much is the well-known half. The subtle half is
the `Buffer -> string` conversion the ingest port takes: `toString('utf8')` replaces invalid
sequences with U+FFFD, so a body that is not valid UTF-8 would silently become _different_ bytes
and the signature check would fail for a reason nobody could diagnose from either end.

`decodeExactUtf8` re-encodes and compares. Either the string is byte-identical to what arrived — in
which case it _is_ the raw bytes and the HMAC means what it says — or the request is refused `400
MALFORMED_BODY`. Two tests: one posts a body containing `0xff` and expects the refusal, one posts
multi-byte UTF-8 (`héllo 🌍 ünïcode — a/b`) through a real socket and asserts the signature still
verifies. The second is the one that would catch a body parser being introduced later.

### 5.2 A cap enforced while reading

A limit checked after the body is in memory is not a limit. Three bounds, in order:

1. **Declared length.** `Content-Length` over the cap is refused before a byte of payload is read.
2. **A streaming counter.** Past the cap, accumulation _stops_ and the stream is drained and
   discarded — memory stays flat while a cooperative sender still gets a clean `413` rather than a
   connection reset it cannot log.
3. **A hard ceiling at 4× the cap**, which destroys the socket. Above that the sender is not
   cooperative and politeness is a denial-of-service vector.

`server.requestTimeout` is the fourth bound, on time rather than bytes. Tested at all three: a
declared oversize, a chunked oversize with no declared length at all, and a body sitting exactly on
the cap (off-by-one on a size limit is the classic version of this bug, in both directions).

### 5.3 Fast acknowledgement, asserted structurally

"Fast" is asserted twice, and the second assertion is the load-bearing one. There is a duration
budget — generous, so it does not flake on a loaded runner, tight enough that anything awaiting a
model would blow through it. And there is the structural claim: at the moment the client had its
`200`, the ledger row is durable and `RECEIVED`, the normalize job exists and is `READY` with
`attempt: 0`, and there is no conversation, no message and no model call. Persist first, process
second, observed rather than asserted about.

### 5.4 The subscription handshake

`GET` on the same URL answers the provider's verification challenge, and it is architecturally
appropriate: it involves no outbound call, it is the handshake that must exist before deliveries
can begin, and it is fully testable locally. It lives in the ingest _service_, not in the HTTP
layer, because resolving which tenant an opaque webhook id belongs to is a domain question.

Three deliberate properties: the token is compared in constant time; a connection with **no
configured token refuses** rather than accepting anything, so "unconfigured" is never a skeleton
key; and nothing is persisted, because a handshake is not an inbound event and writing a ledger row
for every unauthenticated `GET` would hand an anonymous caller a write.

This required one port change: `SecretResolver` now returns `{ appSecret, verifyToken? }`. They are
separate secrets with different blast radii — the verify token travels in a query string, which is
a place an app secret must never appear.

### 5.5 An invalid signature still answers 200

Carried unchanged from ADR-006, and worth restating because it looks wrong at a glance. The event
is stored for forensics — a misconfigured secret and a genuine spoof are indistinguishable without
evidence — and never normalised. A `4xx` would make the provider redeliver a body we will never
accept, and would tell a prober which secret it guessed wrong. A test asserts the row exists, is
`REJECTED`, and produced **no job**.

---

## 6. Health

Five things, one document, and two rules about what may be in it.

| Endpoint         | Answers                    | Touches the database |
| ---------------- | -------------------------- | -------------------- |
| `/health/live`   | is this process running?   | **no**               |
| `/health/ready`  | should it receive traffic? | yes                  |
| `/health/status` | the full snapshot          | yes                  |

`/health/status` reports process identity and uptime, database reachability and latency, queue
depth by state, the dead-letter count, the oldest unprocessed inbound event and its age, and the
oldest unrelayed domain event and its age — plus a `reasons` list explaining any status that is not
`OK`.

**Liveness must not depend on the database.** A probe that fails during a failover gets every
healthy process restarted, which turns a degradation into an outage. A test asserts liveness makes
zero probe calls.

**Degraded still serves.** A dead letter is a reason to page someone, not a reason to remove the
only process capable of working through the backlog. `/health/ready` returns `503` only when the
store is unreachable or the process is shutting down.

**Aggregates only, never rows.** A health endpoint is the least-authenticated surface in the
system. "Oldest unprocessed inbound event" is a genuinely cross-tenant question, and rather than
grant anyone a cross-tenant read of `raw_inbound_events`, migration 0007 adds one `SECURITY
DEFINER` function returning a count and a timestamp. There is no row to leak because the function
never selects one. `search_path` is pinned, as in 0005. `EXECUTE` is granted to `app_worker` alone
— and a test asserts `app_relay` gets `42501` on it.

`REJECTED` events are excluded from the backlog on purpose: a bad signature is not a backlog, and
counting it as one would make a spoofing attempt look like an outage.

---

## 7. The scheduler, and why it is not `setInterval`

Four properties, each of which is a way the obvious implementation breaks a real service:

- **Ticks never overlap.** `setInterval` fires on a wall clock regardless of whether the previous
  tick finished. Two reapers racing on one expired lease is exactly what `SKIP LOCKED` exists to
  survive — surviving it is not a reason to cause it. The next tick is armed _after_ the previous
  one settles, and the guard covers `runNow()` too, since an operator invoking a task by hand at
  the moment the schedule fires is the overlap that is easiest to cause and hardest to see.
- **A failing tick cannot kill the process.** An async callback passed to `setInterval` that
  rejects becomes an unhandled rejection, which is fatal in Node by default. A test asserts the
  schedule survives two consecutive failures and keeps ticking.
- **`stop()` waits.** The caller is about to close the pools the tick is using.
- **The timer is unref'd.** A background timer must not be the reason a process refuses to exit —
  which is the shape of the Phase 01 defect that made a finished test run hang forever.

The reaper and the relay both run on the **worker** role, not the web role. A web process is one
signal away from being replaced during a deploy; attaching crash recovery to the shortest-lived
role in the system is how "the reaper runs" becomes "the reaper ran until the last deploy".

**The relay runs on a timer rather than as a queued job.** `outbox.relay` exists in `JOB_TYPES`,
but a job row carries an `account_id` and the relay's first question is "which accounts have
pending events?" — a per-tenant job cannot ask it. The job type remains unregistered and nothing
enqueues it.

---

## 8. Shutdown order, and why it is exactly this

1. **Flag first.** `/health/ready` answers `503` the instant a signal arrives, so a load balancer
   stops sending work while the process is still perfectly capable of finishing what it has.
2. **Listener.** Stop accepting, let in-flight requests finish. Each is a durable write that is
   nearly done; killing it makes the provider redeliver. Idle keep-alive sockets are closed
   explicitly — otherwise `server.close()` waits forever on connections with no request on them.
3. **Timers**, waiting for any tick in progress.
4. **Workers**, stop claiming, then finish or release.
5. **Pools last.** Everything above needs the database right up to the moment it finishes.

Reversing any two produces a specific, familiar bug: closing pools first turns a clean shutdown
into a burst of connection errors that read like data loss. A Postgres test asserts the whole
sequence, including that `queue.countByState()` fails with `DATABASE_CLOSED` afterwards — which is
what makes "pools last" an observation rather than a claim.

A second signal exits immediately. A shutdown that ignores one is indistinguishable from a hung
process.

---

## 9. What remains simulated, precisely

**The relay's destination.** The mechanism is real — read across tenants, deliver, move the
watermark once, retry what failed, halt a tenant behind its own failure. The far end is
`createSimulatedRelayTarget`, which records and logs and reaches no network. It is the exact
analogue of a SIMULATED outbound action, and it exists for the same reason: a stub that pretended
to deliver would make the pipeline look healthy while no consumer had ever been contacted. When
`event_deliveries` fan-out is built it implements `RelayTarget` and nothing else in that file
changes.

**The language model.** Unchanged from Phase 00: a deterministic mock.

**Every outbound action.** No transport exists. `OUTBOUND_MODE=LIVE` is refused at boot, and CI
asserts the refusal.

**Webhook secrets in the environment.** `WEBHOOK_SECRETS` is a JSON blob read by `main.ts` because
no secret manager is integrated. The _port_ is what matters — `SecretResolver` is unchanged in
shape, and swapping in a real resolver is one line in one file. It is a stop-gap and it is written
down as one.

**Still unproven, carried from Phase 01 §19:** `AccountRepository.findBySlug` (still throws; needs
the control-plane role decision), `event_deliveries` (schema only), `lead_candidates` (schema
only), production scale, failover and replication, and the absence of narrow races.

---

## 10. Is live Meta connection authorized?

**No.**

Phase 02A proves the inbound edge against locally signed payloads. That is a real proof of the
_receiver_, and it is not a proof of anything on the other side of the boundary. Before a live
connection is reasonable, all of the following have to be true, and none of them is true today:

1. **An outbound transport exists**, with its own idempotency, rate limiting and retry budget.
   Right now `outbound.dispatch` has no registered handler — deliberately, because a stub that
   "succeeded" would make the pipeline look healthy while nothing reached a customer.
2. **`OUTBOUND_MODE=LIVE` stops being refused at boot**, which is a deliberate, reviewed change
   to `config.ts` and not a configuration value.
3. **Real credentials are resolved through a real secret manager**, not through
   `WEBHOOK_SECRETS`.
4. **A verify token is configured per connection.** The handshake refuses connections without one,
   so this is enforced rather than remembered.
5. **The relay has a real destination**, or is explicitly left disabled — a live system quietly
   marking events relayed to nowhere is worse than one that is visibly behind.
6. **Someone has decided what happens on the first real dead letter.** The escalation path exists
   and is tested; nobody has been told they are on it.

Phase 02B is the outbound transport. It should be as suspicious of itself as this phase was: the
inbound edge can be wrong and cost a redelivery, whereas the outbound edge can be wrong and cost a
customer a message they never should have received.

---

## 11. Open risks

| #    | Risk                                                                                                                                                                                             | Why it matters                                                                                                                                                          | Mitigation now                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-12 | `JobQueue.complete` guards on `state='RUNNING'` but not on `lease_owner`. A handler orphaned by a forced shutdown could mark a job SUCCEEDED after a _different_ worker reclaimed and re-ran it. | A conversation could record a success it did not have. Requires a handler that ignores its abort signal for a full grace period _and_ a reclaim inside the same window. | Pre-existing and shared with plain lease expiry. The forced path deliberately does not release the lease, which narrows but does not close it. Fix is a `lease_owner` predicate and a `workerId` argument — a contract change, deferred. |
| R-13 | The relay's simulated target always succeeds, so the retry path is only proven with an injected failure.                                                                                         | The failure _handling_ is tested; the failure _modes_ of a real consumer are not.                                                                                       | Named. The first real target must bring its own timeout, retry budget and circuit breaker.                                                                                                                                               |
| R-14 | `WEBHOOK_SECRETS` puts secrets in an environment variable.                                                                                                                                       | An environment dump is a secret dump.                                                                                                                                   | Explicitly a stop-gap; the port is unchanged and a real resolver is a one-file swap.                                                                                                                                                     |
| R-15 | A single relay instance. Two processes would both relay, and the `relayed_at IS NULL` guard makes that safe but wasteful — both call the target, one loses the watermark race.                   | Duplicate deliveries to a consumer under horizontal scaling.                                                                                                            | Correct today (consumers must be idempotent). Add `FOR UPDATE SKIP LOCKED` to `listPending` before running more than one worker process.                                                                                                 |
| R-16 | Health status thresholds are global, not per tenant.                                                                                                                                             | One badly-behaved account's backlog degrades the whole process's reported status.                                                                                       | Acceptable at current scale; per-account operator views are a control-plane concern.                                                                                                                                                     |
| R-17 | Suite runtime grew with the new Postgres suites.                                                                                                                                                 | A suite slow enough to skip is a suite that stops being run (R-9, carried).                                                                                             | Still one cluster per process; the CI job ceiling remains 15 minutes with a 10-minute step ceiling.                                                                                                                                      |

Carried unchanged from Phase 01 and still open: R-2 (advisory-lock collisions), R-3 (deferred FK
diagnosability), R-4 (`app_worker` cross-tenant queue visibility), R-5 (queue-table churn and
autovacuum), R-6 (runs left `RUNNING` after a supersede), R-7 (no connection-level retry), R-8
(global `statement_timeout`), R-10 (narrow races cannot be certified), R-11 (suite acquire/release
balance — and Phase 02A found exactly this while writing the new Postgres suite: an unbalanced
`acquirePostgres` left the run hanging after every assertion had passed, which reads as a slow test
rather than a broken one).

**R-1 is closed.** The reaper runs on a timer. It was the oldest open risk in the project.

---

## 12. Required follow-up

1. **Decide R-12.** Adding `workerId` to `complete`/`fail` closes the last double-write window in
   the queue. It is a contract change and belongs in a phase that is touching the queue anyway.
2. **`FOR UPDATE SKIP LOCKED` in `listPending`** before more than one process runs the relay (R-15).
3. **A real secret resolver** (R-14).
4. **Decide the control-plane role**, which unblocks `findBySlug` and operator login. Carried from
   Phase 01 §21.4 and still the prerequisite for any operator surface.
5. **Sweep runs left in `RUNNING`** past a threshold (R-6, carried).
6. **Load-test the queue and the endpoint together.** The webhook path is now a real socket, so
   "how many deliveries per second before the cap and the pool interact badly?" is finally a
   question that can be asked.

---

## 13. Exact Phase 02B recommendation

**Phase 02B = the outbound transport. Still no real model.**

In order:

1. **`outbound.dispatch`, with a real handler and a provider port.** It has to be idempotent
   against the `idempotency_key` already on every `outbound_actions` row, rate-limited per
   connection, and must treat a timeout as _unknown_ rather than failed — a resend after an
   ambiguous timeout is a customer receiving the same message twice.
2. **The `LIVE` gate.** `OUTBOUND_MODE=LIVE` becomes possible, guarded per account rather than per
   process, so a single account can be enabled without arming every tenant at once.
3. **A shadow mode.** Run the full pipeline live-inbound, and record what _would_ have been sent
   without sending it. The container already carries `shadowModeEnabled: false`; nothing reads it
   yet.
4. **`event_deliveries` fan-out**, giving the relay a real target and closing R-13.

Only after those does connecting a real Meta app become a question about configuration rather than
a question about whether the system is ready.

---

**PHASE 02A READY**
