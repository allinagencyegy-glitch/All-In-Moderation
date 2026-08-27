# ADR-004: Durable Asynchronous Workflow and Job System

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

Every inbound customer event is processed asynchronously (ADR-006: persist first, process
second). That processing must survive crashes, retry safely, run scheduled work (SLA timers,
follow-ups, reconciliation), serialise per conversation while parallelising across
conversations, and never lose a unit of work silently.

The stated candidates were BullMQ + Redis, Temporal, or a justified alternative. The evaluation
criteria given were: 24/7 operation, durable timers, retries, crash recovery, event processing,
conversation serialisation, multi-client workloads, operational complexity, and our ability to
maintain it.

### The argument that decides this

Look at the required ingest sequence:

```text
verify signature -> persist raw event -> acknowledge 200 -> process later
```

For "process later" to be guaranteed, the _promise to process_ must be created atomically with
the raw event row. If the queue lives in a different store than the ledger, we have a dual
write:

```text
BEGIN; INSERT raw_event; COMMIT;      <-- crash here
queue.add(job)                        <-- never runs
```

The event is persisted, Meta got its 200, and nothing will ever process it. Nothing detects it
except a reconciliation sweep we would have to build anyway. This is the textbook definition of
a silent failure, and it is the exact thing this platform is required not to have.

There are only two honest ways out:

1. Put the queue in the same transactional store as the ledger, or
2. Keep an outbox table in the ledger and relay it to the external queue.

Option 2 means we build and operate the durable-queue machinery (a table, claiming, retries,
ordering, a relay process) _and then also_ operate Redis. Option 1 is strictly less machinery
for strictly stronger guarantees at our current scale.

## Decision

**A PostgreSQL-backed durable job queue, owned by us, in the same database as the domain data.
No Redis and no Temporal in Phase 0/1.** The queue is used through a `JobQueue` port so the
decision stays reversible.

### Design

Job row (see `db/migrations/0003_operations.sql`):

| Column                            | Purpose                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `id`, `account_id`                | Identity, tenant                                                                  |
| `type`                            | Handler key (e.g. `raw_event.normalize`, `moderator.run`)                         |
| `partition_key`                   | **Serialisation domain.** At most one job per partition runs at a time            |
| `dedupe_key`                      | Nullable; partial-unique among `READY` rows — enables coalescing (see ADR-005)    |
| `payload`                         | `jsonb`, ids only                                                                 |
| `state`                           | `READY` \| `RUNNING` \| `SUCCEEDED` \| `FAILED` \| `DEAD_LETTERED` \| `CANCELLED` |
| `run_at`                          | Durable timer. `READY` jobs are invisible until `run_at <= now()`                 |
| `attempt`, `max_attempts`         | Bounded retry                                                                     |
| `lease_owner`, `lease_expires_at` | Crash recovery                                                                    |
| `first_enqueued_at`               | Coalescing ceiling, so debouncing cannot starve a conversation                    |
| `last_error`, `trace_id`          | Diagnosis                                                                         |

Claim query (the heart of it):

```sql
UPDATE jobs SET state = 'RUNNING', lease_owner = $worker,
                lease_expires_at = now() + $lease, attempt = attempt + 1,
                started_at = now()
WHERE id = (
  SELECT j.id FROM jobs j
  WHERE j.state = 'READY' AND j.run_at <= now()
    AND NOT EXISTS (                       -- partition exclusivity
      SELECT 1 FROM jobs r
      WHERE r.partition_key = j.partition_key
        AND r.state = 'RUNNING' AND r.lease_expires_at > now())
  ORDER BY j.run_at, j.seq
  FOR UPDATE SKIP LOCKED
  LIMIT 1)
RETURNING *;
```

- `FOR UPDATE SKIP LOCKED` gives lock-free horizontal scaling of workers.
- The `NOT EXISTS` clause gives per-conversation ordering _and_ cross-conversation parallelism
  in one predicate. This is the mechanism behind ADR-005.
- `lease_expires_at` gives crash recovery: a reaper returns expired leases to `READY`, and
  because handlers are idempotent, a redelivery is safe.
- `run_at` gives durable timers: SLA checks, retry backoff, debounce, and follow-ups are all the
  same mechanism.
- Enqueue happens inside the caller's transaction, so ingest is atomic. **This is the whole point.**

Retry policy: exponential backoff with full jitter, `min(base * 2^attempt, cap)`, bounded by
`max_attempts`. Terminal (non-retryable) errors skip straight to `DEAD_LETTERED`. Exhaustion
writes a `dead_letters` row _and_ emits an operator-visible domain event; for
`moderator.run` it additionally raises a human handoff so the customer is never abandoned.

Fairness: the claim query orders by `(run_at, seq)`. Per-account fairness (a weighted or
round-robin claim so one busy tenant cannot starve others) is a Phase 1 addition — noted in the
open decisions, not silently assumed.

Wake-up: workers poll on a short interval with jitter. `LISTEN/NOTIFY` on insert is a Phase 1
latency optimisation; polling remains the correctness mechanism, because `NOTIFY` is not durable.

### What this is not

It is not a workflow engine. There are no multi-step, long-lived, resumable workflows with
persisted local variables. Our processes are short chains of independently idempotent jobs, each
of which reads its state from the database rather than from workflow memory. If we later need
genuine long-running orchestration (multi-day nurture sequences with compensation), that is the
revisit trigger for Temporal — see below.

## Options considered

| Criterion                            | Postgres queue (chosen)                                                | BullMQ + Redis                                                                                | Temporal                                                                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Atomic enqueue with domain write** | Yes — same transaction                                                 | **No** — dual write, needs an outbox anyway                                                   | No — needs an outbox for the _first_ step; solid afterwards                                                                                  |
| **Durability**                       | Same guarantees as our data (WAL, PITR, backups)                       | Redis persistence is weaker; AOF `everysec` can lose the tail; usually run as a cache tier    | Strong; backed by its own persistence layer                                                                                                  |
| **Durable timers**                   | `run_at` column; unlimited horizon                                     | Delayed jobs supported; large delayed sets are memory-resident                                | Best in class — this is Temporal's core strength                                                                                             |
| **Retries**                          | Ours, explicit                                                         | Built in                                                                                      | Built in, with policies                                                                                                                      |
| **Crash recovery**                   | Lease expiry + reaper                                                  | Stalled-job recovery exists; depends on Redis durability                                      | Excellent — history replay                                                                                                                   |
| **Per-conversation serialisation**   | One `NOT EXISTS` predicate                                             | Needs a group/rate-limiter feature or a lock per conversation; ordering guarantees are weaker | Natural fit (one workflow per conversation), and arguably the strongest reason to consider it                                                |
| **Multi-tenant fairness**            | Must be built (Phase 1)                                                | Needs per-tenant queues (queue explosion) or a plugin                                         | Namespaces and task queues help; still needs design                                                                                          |
| **Operational complexity**           | **Zero new infrastructure**                                            | One more stateful system to run, monitor, back up, secure                                     | Server + history/matching/frontend services + a database, or Temporal Cloud cost; a real platform to learn                                   |
| **Observability**                    | `SELECT` — every operator already knows SQL                            | Bull Board; Redis introspection                                                               | Excellent web UI, best of the three                                                                                                          |
| **Maintainability by this team**     | High — ~400 lines we own and understand                                | High for common cases, opaque at the edges                                                    | Medium — determinism constraints, versioning, and replay semantics are a genuine learning curve and a genuine source of production surprises |
| **Throughput ceiling**               | Thousands of jobs/sec on modest hardware — far beyond messaging volume | Very high                                                                                     | Very high                                                                                                                                    |

Verdicts:

- **BullMQ + Redis — rejected.** It does not solve our defining problem (atomic enqueue), it
  adds a stateful dependency, and it would still require an outbox. We would end up with both
  mechanisms and the failure modes of each. Its ergonomic advantages do not pay for that.
- **Temporal — rejected for now, respected.** It is the right answer to a problem we do not yet
  have: long-running, multi-step, compensating workflows. Today our longest workflow is
  "normalise, then run the moderator, then dispatch" — three idempotent jobs. Adopting Temporal
  now means learning replay determinism, workflow versioning, and a new operational surface in
  exchange for capabilities we would not use, while _still_ needing an outbox at the ingest edge.
  Chesterton's fence in reverse: do not build a fence before there is a field.
- **Postgres queue — chosen.** It is the only option under which the ingest guarantee is
  structural rather than best-effort, and the mechanism (a table, a claim query, a lease) is
  small enough that the whole team can hold it in their heads at 03:00.

## Consequences

### Positive

- Ingest atomicity is a property of the schema, not of operational care.
- The queue is queryable: "which conversations are stuck?" is a `SELECT`.
- Zero new infrastructure to run 24/7. Backup and restore of the queue come free with the
  database backup, and the queue state is consistent with the domain state it refers to.

### Negative / accepted cost

- We own this code, including its bugs. Mitigated by keeping it small and testing it hard
  (lease expiry, partition exclusivity, coalescing, retry exhaustion are all covered).
- Polling burns a small amount of database CPU at idle. Bounded by interval, jitter, and a
  partial index on `(state, run_at)`.
- Queue load and domain load share one database. Monitored; the migration path is a dedicated
  queue database (the port makes this a configuration change) before it is a different product.
- No workflow visualisation UI. Mitigated by operator views over `jobs`, `dead_letters`, and
  `moderator_runs`.

## Enforcement

- `JobQueue` is a port; no domain code constructs SQL or knows the queue is Postgres.
- Handlers must be idempotent; the worker may deliver a job more than once, and the contract
  test suite asserts that repeated delivery of a job produces one outcome.
- `tests/integration/*` cover: partition exclusivity under concurrent workers, lease expiry and
  reclaim, retry with backoff, dead-lettering after exhaustion, and coalescing under bursts.

## Revisit trigger

Adopt **Temporal** when any of these is true:

- We need workflows spanning days with compensation logic (nurture sequences, multi-step
  approvals with timeouts and rollbacks).
- We need human-in-the-loop steps that suspend a workflow for an unbounded period while holding
  meaningful in-flight state.
- More than roughly a third of our job code is spent re-implementing saga/compensation patterns.

Adopt **Redis** when:

- We need sub-second job pickup latency at a volume where database polling is measurably costly,
  _and_ the atomicity problem is already solved by the outbox pattern we would then have to add.

Move the queue to its **own database** when queue write volume measurably affects domain query
latency. This is a configuration change, not a redesign.
