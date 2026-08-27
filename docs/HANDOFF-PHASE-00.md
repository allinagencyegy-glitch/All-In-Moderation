# Phase 00 Handoff

- Status: **Phase 0 closed**
- Date: 2026-08-27
- Scope of this document: what was decided, what was built, what the tests actually prove, what
  they do not, and what Phase 01 should do first.

This document is written to be read by someone who was not in the room. Where a guarantee is
conditional, the condition is stated. Where something is unproven, it says so in those words.

---

## 1. Decisions

The ten ADRs in [`docs/adr/`](adr/) hold the reasoning. The load-bearing ones:

| ADR     | Decision                                                              | Why it constrains everything downstream                              |
| ------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ADR-001 | Modular monolith, one deployable, boundaries enforced by a test       | Adding coupling requires editing an allow-list someone must review   |
| ADR-002 | Shared schema; branded `AccountScope` token + Postgres RLS            | A repository call that forgets tenancy does not compile              |
| ADR-003 | PostgreSQL as system of record, SQL-first, no ORM lazy-loading        | Query cost stays visible; the queue can share the transaction        |
| ADR-004 | **PostgreSQL-backed durable job queue.** No Redis, no Temporal in 0/1 | Makes ingest atomicity structural rather than operational — see §5   |
| ADR-005 | Per-conversation partition exclusivity, sequence numbers, coalescing  | Ordering and burst-collapse fall out of one `NOT EXISTS` predicate   |
| ADR-006 | Persist-first raw event ledger, two-level dedup                       | Interpretation never precedes durability; a bad parser can be re-run |
| ADR-007 | Provider-agnostic `LlmProvider` port, role-based model selection      | Vendor swap is a container edit                                      |
| ADR-008 | Conversation state decomposed into three axes; ownership versioned    | "Human is handling this" is a first-class, contended, versioned fact |
| ADR-009 | Versioned domain events via transactional outbox                      | Downstream outages cannot roll back a customer conversation          |
| ADR-010 | Immutable, versioned Account Packs pinned per moderator run           | Client business content never enters `src/` — enforced by a test     |

### The one decision that shaped the rest

ADR-004. The required ingest sequence is
`verify signature -> persist raw event -> acknowledge 200 -> process later`. For "process later" to
be a guarantee rather than a hope, the promise to process must be created **in the same
transaction** as the raw event row. Every other decision — the outbox, the watermark commit, the
lease model — follows from putting the queue in the same store as the ledger.

---

## 2. ADR-004 in detail (requested explicitly)

### Why PostgreSQL-backed jobs were selected

1. **Atomic enqueue is the whole argument.** With the queue in a different store, ingest is a dual
   write:

   ```
   BEGIN; INSERT raw_event; COMMIT;      <-- crash here
   queue.add(job)                        <-- never runs
   ```

   The event is durable, Meta received its 200, and nothing will ever process it. Nothing detects
   it except a reconciliation sweep that would have to be built anyway. Putting the queue in the
   ledger's database makes this failure mode structurally impossible rather than operationally
   unlikely.

2. **One mechanism covers five requirements.** `run_at` is a durable timer, so SLA checks, retry
   backoff, debounce and follow-ups are the same feature. `lease_expires_at` is crash recovery.
   `partition_key` is per-conversation serialisation. `dedupe_key` is burst coalescing. The claim
   query is one statement.
3. **Zero new infrastructure to run 24/7.** Backup, restore, PITR and monitoring come with the
   database that already has to exist. Queue state is consistent with the domain state it refers to.
4. **It is queryable.** "Which conversations are stuck?" is a `SELECT`, and every operator already
   knows SQL.
5. **It fits in one head.** Roughly 400 lines the team owns and can reason about at 03:00.

### Why BullMQ + Redis was rejected

- **It does not solve the defining problem.** Enqueue cannot join the Postgres transaction, so
  ingest remains a dual write. Fixing that requires an outbox table in Postgres plus a relay
  process — meaning we build the durable-queue machinery _anyway_ and then also operate Redis.
- **Weaker durability for the queue than for the data it refers to.** Redis AOF `everysec` can lose
  the tail, and Redis is usually operated as a cache tier.
- **Per-conversation ordering is not native.** It needs a group/rate-limiter feature or a lock per
  conversation, with weaker guarantees than a single SQL predicate.
- **Multi-tenant fairness pushes toward queue explosion** (a queue per tenant) or a plugin.
- Verdict: it adds a stateful dependency and its failure modes, without removing ours.

### Why Temporal was rejected/deferred

- **It is the right answer to a problem we do not have yet.** Temporal's core strength is
  long-running, multi-step, resumable workflows with compensation. Our longest process today is
  "normalise → run the moderator → dispatch": three independently idempotent jobs, each of which
  re-reads its state from the database rather than holding it in workflow memory.
- **It still needs an outbox at the ingest edge**, so it does not remove the dual write either.
- **The learning curve is real and it lands in production.** Replay determinism, workflow
  versioning and history semantics are a genuine source of production surprises.
- **A server plus history/matching/frontend services, or Temporal Cloud cost.** A whole platform to
  operate for capabilities we would not use.
- Rejected **for now, and respected** — not dismissed. ADR-004 records it as the better answer to a
  future shape of the problem.

### The threshold at which to reconsider

Adopt **Temporal** when any one of these becomes true:

- Workflows must span days with compensation logic — multi-day nurture sequences, multi-step
  approvals with timeouts and rollbacks.
- Human-in-the-loop steps must suspend a workflow for an unbounded period **while holding
  meaningful in-flight state** (state we cannot simply re-read from the database).
- More than roughly **a third of job code** is spent re-implementing saga/compensation patterns.

Adopt **Redis/BullMQ** when **both** hold:

- Sub-second job pickup latency is required at a volume where database polling is _measurably_
  costly, **and**
- The atomicity problem is already solved by an outbox we have had to add for another reason.

Move the queue to its **own database** when queue write volume measurably affects domain query
latency. The `JobQueue` port makes this a configuration change, not a redesign.

**Assessment today:** none of these thresholds is close. The revisit trigger is a measurement, not
a date — re-read this section when job code volume or workflow duration changes shape, not on a
calendar.

---

## 3. Implementation

### Shape

```
src/platform/     errors, ids, clock, logger, schema, result, LLM port   (depends on nothing)
src/core/         account, tenancy scope, channel vocabulary
src/policy/       action vocabulary, authority matrix, action gate
src/knowledge/    Account Packs, knowledge entries, Knowledge Gate
src/operations/   jobs (queue port, worker, reaper, dead-letter sink), outbox, audit, transactions
src/moderation/   conversation domain + application services (ingest, normalize, run, takeover, escalate)
src/integrations/ Meta parser + signature verifier, mock LLM, CRM contract
src/adapters/     in-memory database, repositories, job queue
src/runtime/      config, composition root, demo
db/migrations/    0001 core · 0002 moderation · 0003 operations · 0004 knowledge  (23 tables)
```

### Mechanisms that carry the safety claims

- **Persist first, process second.** Signature verify → ledger insert → 200 → job. The ingest module
  cannot import the LLM port or the knowledge module; an architecture test enforces this, so nobody
  can "just classify it quickly" inside the HTTP handler and turn Meta's webhook timeout into our
  model's timeout.
- **Atomic enqueue.** The job row commits with the raw event row.
- **Partition exclusivity.** At most one job per `partition_key` runs at a time. Partition keys are
  tenant-prefixed (`acct:<id>:conv:<id>`) so they cannot collide across accounts.
- **Leases, not locks.** An expired lease returns the job to `READY` with its attempt count intact.
  A handler's `AbortSignal` is wired to the lease deadline, so a handler cannot outlive its claim.
- **Bounded retry, always.** Exponential backoff with full jitter; terminal errors skip retry
  entirely. Exhaustion writes a `dead_letters` row **and** raises a human handoff for moderator work.
- **Ownership is versioned and writes are compare-and-swap.** See §6 — this changed during Phase 0
  closure.
- **The Knowledge Gate runs twice.** Before the model (only approved, in-validity, in-scope entries
  are ever visible) and after it (citation containment plus re-validation, because a price can
  expire mid-run). Neither pass asks the model how confident it feels.
- **Closed action vocabulary + authority matrix.** The model is only offered actions the account's
  matrix permits, and its choice is gated again in code. A denial falls back to asking a human, and
  the fallback is gated too — it is not privileged.
- **Every early exit is a recorded state with a reason.** `SKIPPED`, `SUPERSEDED`, `DEAD_LETTERED`
  all carry their reason. "The AI did nothing" is never silent.

### Changes made during this closure pass

Four material changes, all in scope for Phase 0:

1. **Lease-expiry dead letters were invisible.** `reapExpiredLeases` moved a job with no attempts
   left to `DEAD_LETTERED`, but nothing wrote a `dead_letters` row and nothing raised a handoff —
   the row was terminal, so no retry would ever revisit it, and the customer waited on a queue that
   had quietly ended. This is the exact failure class the platform exists to eliminate, reached by
   the crash path instead of the failure path.
   - Added `src/operations/jobs/dead-letter-sink.ts` (one sink, used by both paths) and
     `src/operations/jobs/reaper.ts`, wired as `container.reaper`.
2. **The reaper was never wired into the runtime at all.** It existed only as a port method called
   directly by tests. Now it is a component on the container. **It still has no scheduler** — see
   §7, open risk R-2.
3. **A human takeover could be silently overwritten.** The moderator's staleness guard re-reads the
   conversation _before_ the commit transaction opens, then the commit wrote back that snapshot with
   a blind `save()`. A takeover committing in that window was overwritten: ownership reverted to
   `AI_OWNED` and the reply was recorded. `takeover.ts` documented the guarantee that the code did
   not implement.
   - Added `ConversationRepository.saveIfUnchanged(...)` (compare-and-swap on `ownership_version`,
     mapping to `UPDATE ... WHERE id = $1 AND ownership_version = $2`), used by the moderator commit
     and by takeover acquisition. A lost CAS aborts the transaction, so the outbound action, the
     handoff and the watermark roll back together and the run records itself `SUPERSEDED`.
4. **Repository-wide formatting drift.** `npm run verify` failed on 71 files. Formatting applied;
   a broken markdown table in ADR-004 (unescaped pipes in the `state` row) was repaired.

Also completed: `README.md` and `.env.example`, both of which were absent.

---

## 4. What the tests prove

**147 tests, 26 suites, all passing on the final tree.**

| Suite          | Count | What it establishes                                                                                                                            |
| -------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`         | 83    | State machines reject illegal transitions; schema validation; action gate; knowledge expiry; Meta parsing                                      |
| `integration`  | 44    | The end-to-end properties below, through the composition root                                                                                  |
| `architecture` | 7     | The module graph is acyclic and obeyed; no DB/HTTP driver in domain code; ingest cannot reach the LLM; no client identifier anywhere in `src/` |
| `contract`     | 13    | The `JobQueue` contract every adapter must satisfy — the suite Phase 1's Postgres adapter must pass unchanged                                  |

Concretely proven:

- **F-01/F-02 — deduplication.** An identical webhook redelivery yields one ledger row, one message,
  one reply. The same message inside a re-batched envelope does not create a second message.
- **F-03 — ordering.** A late message still receives the next sequence number, so it can never fall
  below the watermark and be skipped.
- **F-04/F-21 — bursts.** Three messages in seconds produce exactly one run and one reply; debounce
  cannot starve a continuously typing customer (the ceiling is anchored to the first enqueue).
- **F-05/F-06/F-07 — model failure.** Malformed output is repaired exactly once; output still invalid
  after repair fails the run rather than being coerced; a persistently failing model exhausts its
  bounded retries, dead-letters, and asks a human; an invented knowledge citation is denied and
  escalated, never sent; an intent outside the account taxonomy is treated as a hallucination.
- **F-08 — knowledge validity.** An expired entry is never offered to the model, and a cited entry
  that expires mid-run fails re-validation.
- **F-11/F-12 — crash and concurrency.** An expired lease is reclaimed and redelivery is a safe
  no-op; two workers never process one conversation concurrently; different conversations run in
  parallel, including within one account.
- **F-13/F-14 — human/AI ownership.** Takeover _before_ a run (AI never speaks, no model call),
  _during_ generation (run superseded), and — new in this pass — _after the staleness guard but
  before the commit_ (caught by the compare-and-swap). An operator sending a message performs an
  implicit takeover. A queued outbound action is cancelled on takeover.
- **F-19 — tenancy.** Cross-account reads raise `TenantViolationError` rather than returning data.
- **F-20 — unbounded retry.** Attempt counts survive lease reclamation, so a crash loop still
  exhausts and dead-letters rather than spinning forever.
- **Atomicity.** A failure between persisting the event and enqueueing the job rolls both back. A
  moderator run's decision, outbound action and watermark move together or not at all.
- **Dead letters are visible.** Both routes to a dead letter — worker exhaustion and lease expiry —
  record a `dead_letters` row and raise a human handoff, idempotently.

The new ownership and reaper tests were verified to be non-vacuous: with the compare-and-swap
neutered, three of them fail; restored, they pass.

---

## 5. What the tests do NOT prove

This section matters more than the previous one. Read it before trusting any green tick.

1. **Nothing has been executed against PostgreSQL.** Every test runs against the in-memory adapter.
   See §6.
2. **The in-memory adapter is not a database.** It is single-threaded and its transaction is
   snapshot-and-restore. It therefore cannot exhibit: real lock contention, deadlocks, serialisation
   failures, `SKIP LOCKED` behaviour under load, connection-pool exhaustion, or a partial commit.
   The concurrency tests prove the _logic_ is correct given the contract; they do not prove
   PostgreSQL honours the contract as written.
3. **True simultaneity is never tested.** JavaScript's single thread means "concurrent" in these
   tests means interleaved at `await` points. The compare-and-swap and partition-exclusivity tests
   demonstrate the mechanism catches a stale write; they do not demonstrate behaviour under genuine
   parallel execution across processes.
4. **No LLM has been called.** The provider is a deterministic mock. Nothing here says anything
   about real model latency, real refusal rates, real schema-adherence rates, real token cost, or
   whether the prompt produces good answers. Prompt _quality_ is entirely unmeasured.
5. **No network I/O of any kind occurred.** No Meta webhook has ever been received, no signature
   from Meta has been verified against a real payload, no message has been sent. The Meta parser is
   tested against synthetic envelopes shaped from the documented format, not against captured
   traffic.
6. **Outbound dispatch does not exist.** `outbound.dispatch` is deliberately _not_ registered as a
   job handler — registering a stub that "succeeds" would make the pipeline look healthy while
   nothing reached a customer. Everything is recorded `SIMULATED`.
7. **Retrieval quality is unmeasured.** The retriever is deterministic tag/intent matching (open
   decision D1). It will miss paraphrases. It misses them _loudly_ — as recorded knowledge gaps —
   but recall has never been evaluated because there is no real content corpus.
8. **No load, soak, or failure-injection testing.** No sustained 24/7 run, no memory-growth
   observation, no chaos testing, no measurement of queue depth under burst.
9. **No security review, no penetration testing, no dependency audit.**
10. **The reaper has no scheduler.** Its logic is tested; nothing runs it on a timer yet, because
    Phase 0 has no long-running process. See risk R-2.
11. **Migrations have never been applied, rolled back, or re-applied.** There is no down-migration
    and no migration runner.

---

## 6. PostgreSQL verification status

### POSTGRES RUNTIME VERIFICATION = NOT YET PROVEN

No PostgreSQL server, no Docker daemon, no `initdb`/`psql` binary, and no `pg` driver package are
available in this environment. A disposable local database could not be stood up without
introducing external dependencies, so **no migration has been executed and no SQL has been run.**

### What _was_ verified — structurally, by parsing the DDL

- 4 migration files, 23 tables, 52 unique/primary-key constraints.
- Parentheses balanced; every file terminates its final statement.
- Every `REFERENCES` target table exists.
- Every foreign-key source and target column is declared.
- Every foreign key resolves to a matching `UNIQUE`/`PRIMARY KEY` on the target — including the
  composite `(account_id, id)` keys that carry tenancy through the FK graph.
- No forward references: no table is referenced before it is created, in file order.
- Every index references a declared table and declared columns.
- **Row-level security covers all 21 tenant-scoped tables** (applied via `DO` blocks with
  `FORCE ROW LEVEL SECURITY` and a `USING (account_id = app_current_account_id())` policy). The only
  tables without `account_id` are `accounts` and `users`, which is correct.
- Append-only enforcement is coherent: `REVOKE UPDATE, DELETE` on the ledger tables, narrowed by
  column-level `GRANT UPDATE (...)` for the columns that legitimately change (raw event lifecycle
  state; message redaction). All granted columns exist. This was checked specifically because a
  blanket `REVOKE UPDATE` on `raw_inbound_events` would have broken normalisation on first contact
  with a real database — the column-level grant is present and correct.
- `conversations.ownership_version integer NOT NULL DEFAULT 0` exists, so the new compare-and-swap
  maps directly onto `UPDATE ... WHERE id = $1 AND ownership_version = $2` with no schema change.

### What structural verification cannot tell you

Whether PostgreSQL accepts the syntax; whether the `CHECK` constraints behave as intended on real
data; whether the partial unique index on `(partition_key, dedupe_key) WHERE state = 'READY'`
enforces coalescing as expected; whether the claim query's `FOR UPDATE SKIP LOCKED` performs;
whether the RLS policies actually isolate under a non-superuser role; whether any index is used.

**Treat every SQL claim in this repository as a design, not as a tested artefact.**

---

## 7. Open risks

| Id  | Risk                                                                                                                                  | Severity | Mitigation / status                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| R-1 | The Postgres adapter does not exist; all guarantees rest on an in-memory stand-in                                                     | High     | The contract suite is written to run unchanged against it. First Phase 1 task.                 |
| R-2 | **The reaper has no scheduler.** Nothing calls it periodically, so in a deployed system an expired lease would never be reclaimed     | High     | Logic and wiring are done and tested. Needs a timer in the Phase 1 worker loop.                |
| R-3 | No per-account fairness in the claim query — it orders by `(run_at, seq)` globally, so one busy tenant can delay others               | Medium   | Acknowledged in ADR-004, not silently assumed. Needs weighted/round-robin claim.               |
| R-4 | Retrieval recall is unmeasured (D1); the model may be denied knowledge that exists                                                    | Medium   | Fails loudly as a knowledge gap rather than as a wrong answer. Needs real content to evaluate. |
| R-5 | Knowledge re-validation uses the timestamp taken at evaluation, not at commit — a sub-second expiry window remains                    | Low      | Accepted by design. Would need re-validation inside the commit transaction to close entirely.  |
| R-6 | Prompt quality entirely unvalidated                                                                                                   | Medium   | Structural safety does not depend on it; answer quality does.                                  |
| R-7 | No migration runner, no down-migrations, no re-apply path                                                                             | Medium   | Needed before any environment holds data worth keeping.                                        |
| R-8 | The composition root builds one process; there is no HTTP server, so webhook delivery is untested end to end including transport      | High     | By design for Phase 0. Phase 1 scope.                                                          |
| R-9 | Outbound dispatch and its idempotency key (`conversation:run:ordinal`) are designed but never exercised; the unique index is unproven | Medium   | Deliberately unimplemented rather than stubbed. The first real send is a genuine unknown.      |

---

## 8. Deferred decisions

Carried forward from the architecture review, unchanged by this phase:

| Id  | Decision                                                       | Why deferred                                    | Needed by                         |
| --- | -------------------------------------------------------------- | ----------------------------------------------- | --------------------------------- |
| D1  | Retrieval strategy: deterministic lookup vs. embeddings        | Requires real client content to evaluate recall | Phase 2                           |
| D2  | Whether AI shadow mode during human ownership is on by default | Product/legal call; affects cost                | Phase 2                           |
| D3  | Message retention and PII redaction windows per account        | Legal input required                            | Phase 1 (schema already supports) |
| D4  | Operator UI stack                                              | No operator workflows validated yet             | Phase 2                           |
| D5  | Rate-limit budgets per Meta connection                         | Requires real traffic shape                     | Phase 1                           |
| D6  | Multi-region / DR posture, RPO and RTO targets                 | Business input                                  | Phase 3                           |
| D7  | Auto-return of ownership from human to AI after inactivity     | Risky default; needs operator trust first       | Phase 2                           |
| D8  | Human approval queue for `REQUIRES_APPROVAL` actions           | Depends on operator UI                          | Phase 2                           |
| D9  | Cost accounting and per-account LLM budget enforcement         | Needs live usage data                           | Phase 2                           |

Added by this phase:

| Id  | Decision                                                                      | Why deferred                                    | Needed by |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------- | --------- |
| D10 | Reaper scheduling: dedicated timer vs. a job type that re-enqueues itself     | Belongs with the Phase 1 worker loop            | Phase 1   |
| D11 | Per-account fairness algorithm for the claim query (weighted vs. round-robin) | Needs real multi-tenant traffic shape to choose | Phase 1   |

---

## 9. Dental Hub research dependencies

**No Dental Hub business rules exist anywhere in this repository, and that is enforced, not merely
intended.** `tests/architecture/module-boundaries.test.ts` fails if a client-specific identifier
appears anywhere in `src/`. All client content belongs in an Account Pack (ADR-010).

Before any Dental Hub-specific work can begin, the following must be researched and supplied — none
of it is a code task:

1. **Intent taxonomy.** The actual set of intents the practice sees, with which ones require
   knowledge to answer. Drives `requiresKnowledge` and hallucination detection.
2. **Knowledge corpus.** Real approved answers — treatments, pricing, availability — with validity
   windows and an owner who can approve them. Required to evaluate D1 (retrieval recall) and to
   populate the pack.
3. **Authority matrix.** Which actions the AI may take autonomously on a DM versus a public comment.
   The framework exists; the client's risk appetite does not.
4. **Escalation policy.** What triggers a human handoff, the SLA, and the target queue.
5. **Brand voice and prohibitions.** Tone, and the explicit `mustNotSay` list.
6. **Medical/clinical boundary.** _This is the highest-risk unknown._ Where does answering a
   question stop and giving clinical advice begin? Needs a clinician's and probably a regulator's
   input, not an engineer's judgement. The action gate can enforce whatever line is drawn, but it
   cannot draw it.
7. **Regulatory constraints.** Health-data handling, consent, and record-retention obligations in
   the operating jurisdiction — feeds D3.
8. **Meta asset inventory.** Which Pages/Instagram accounts, who owns them, and who can authorise
   the app connection.
9. **Operator roster and working hours.** Determines what "24/7 AI with human escalation" actually
   means when nobody is on shift at 03:00.

---

## 10. Is live Meta integration authorised?

**No.**

- No authorisation has been given, and none is assumed.
- `OUTBOUND_MODE=LIVE` is **refused at boot** with `OUTBOUND_LIVE_NOT_AUTHORIZED`. A config flag is
  deliberately not the only thing standing between a test environment and a real customer's inbox.
- `outbound.dispatch` is intentionally **not** registered as a job handler.
- No Meta credentials exist in this repository or its configuration.
- No network call is made from any code path.

Connecting live Meta requires, in order: an explicit written authorisation, real credentials held
through the `SecretResolver` port, the transport itself, a rate-limit budget (D5), and a tested
rollback. None of these exists today.

---

## 11. Recommendation for Phase 01

**Phase 01 should be: prove the foundation against real PostgreSQL. Nothing else.**

The single largest risk in this repository is that every guarantee rests on an in-memory
stand-in. Adding features on top of an unverified persistence layer compounds that risk; verifying
it retires most of §5 at once.

Recommended order:

1. **Stand up a disposable PostgreSQL** (Docker Compose or equivalent) and a migration runner. Apply
   `0001`–`0004`. This alone will surface syntax and constraint problems that structural
   verification cannot.
2. **Write the Postgres `JobQueue` adapter and run `tests/contract/job-queue-contract.ts` against it
   unchanged.** The suite was written for exactly this moment. Do not modify a contract test to make
   an adapter pass — if it fails, the adapter is wrong or the contract was wrong, and either is a
   finding.
3. **Write the Postgres repositories**, including `saveIfUnchanged` as
   `UPDATE ... WHERE id = $1 AND ownership_version = $2` returning the row count.
4. **Verify RLS actually isolates** by connecting as the non-superuser `app_runtime` role and
   attempting a cross-tenant read. This is the test that proves ADR-002 layer 2 rather than assuming
   it.
5. **Prove concurrency for real:** multiple worker _processes_ against one database, asserting
   partition exclusivity and compare-and-swap behaviour under genuine parallelism. This is the step
   the in-memory adapter can never provide.
6. **Add the worker loop and schedule the reaper** (risk R-2, decision D10).
7. **Re-run the whole suite against Postgres** and update §6 of this document with the result.

Explicitly **not** Phase 01: live Meta, a real LLM provider, the operator UI, Dental Hub content, or
outbound dispatch. Each depends on a verified persistence layer, and each would otherwise be built
on an assumption.

The honest summary of where this stands: the design is coherent, the safety properties are
mechanised rather than aspirational, and the tests that exist are meaningful and non-vacuous — but
they all run against a fake, and until they run against Postgres the foundation is _argued_, not
_proven_.
