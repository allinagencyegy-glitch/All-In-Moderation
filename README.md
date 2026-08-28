# All In Moderation

A multi-client, 24/7 AI moderation platform for social messaging. Three phases are complete: the
domain model and its safety mechanisms (Phase 00), those mechanisms proven against real PostgreSQL
(Phase 01), and the continuously-running application that hosts them (Phase 02A).

The whole thing exists to make one claim defensible before any real traffic exists:

> A customer message is never lost, never answered twice, never answered by the AI while a human
> is holding the conversation, and never answered from knowledge the account has not approved.

Everything here is in service of that sentence.

**Still no network.** There is no Meta transport, no real language model and no outbound delivery.
`OUTBOUND_MODE=LIVE` is refused at boot, and the webhook endpoint is exercised with locally signed
payloads.

## What is built, and what is not

| Built and proven                                                        | Deliberately absent                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Domain model, state machines, invariants                                | Live Meta transport — outbound is `SIMULATE` only                          |
| Durable job queue on PostgreSQL: leases, partition exclusivity, DLQ     | Real LLM provider — a deterministic mock stands in                         |
| Tenancy: branded scope tokens, per-row assertions, enforced RLS         | Operator UI                                                                |
| Knowledge Gate, Account Packs, policy/authority matrix                  | A real destination for relayed domain events                               |
| Ownership model with compare-and-swap concurrency control               | `event_deliveries` per-subscription fan-out (schema only)                  |
| **A process that runs**: poll loops, timers, graceful shutdown          | Outbound delivery of any kind                                              |
| **An HTTP webhook endpoint**: raw-body signatures, size cap, fast `200` | Any client's business rules — those live in Account Packs, never in `src/` |
| **The outbox relay**, on its own least-privileged database role         |                                                                            |
| **Health endpoints**: process, database, queue depth, DLQ, inbound lag  |                                                                            |

## Quick start

```bash
npm install
npm run demo      # end-to-end vertical slice, no network, no database
npm run verify    # format:check + lint + typecheck + the whole test suite
```

Requires Node.js >= 24 (TypeScript runs natively; there is no build step). The PostgreSQL suites
start a disposable embedded cluster themselves, so no local database is needed.

## Running the application

```bash
export PG_RUNTIME_URL=postgres://app_runtime_login:...@localhost:5432/all_in_moderation
export PG_WORKER_URL=postgres://app_worker_login:...@localhost:5432/all_in_moderation
export PG_RELAY_URL=postgres://app_relay_login:...@localhost:5432/all_in_moderation
npm start
```

Three URLs, three roles, no fallback — collapsing them would quietly merge three privilege
boundaries into one, so the process refuses to start rather than guess. `APP_ROLE` selects what
this process does: `web` (the listener), `worker` (poll loops, the reaper timer, the relay timer)
or `all`.

| Endpoint             | Method | What it does                                                       |
| -------------------- | ------ | ------------------------------------------------------------------ |
| `/webhooks/meta/:id` | `GET`  | Subscription handshake; echoes `hub.challenge` on a matching token |
| `/webhooks/meta/:id` | `POST` | Raw-body ingest: verify, persist, enqueue, acknowledge             |
| `/health/live`       | `GET`  | Liveness. Never touches the database                               |
| `/health/ready`      | `GET`  | Readiness. `503` while shutting down or while the store is down    |
| `/health/status`     | `GET`  | Queue depth, dead letters, inbound lag, outbox lag, uptime         |

`SIGTERM`/`SIGINT` drains: readiness flips to `503`, the listener closes, timers stop, workers
finish or hand their leases back, and the pools close last. A second signal exits immediately.

## The demo

`npm run demo` walks one conversation through the whole pipeline and prints what happened at each
step. It is the fastest way to see the design working:

1. Three webhooks arrive within seconds; a duplicate redelivery is recognised and dropped.
2. The burst **coalesces onto one moderator run** — three messages, one reply.
3. The model is shown a current price and _not_ an expired promotion.
4. The policy gate authorises the action; the decision, the outbound action and the watermark
   commit in one transaction.
5. A human takes over, the customer writes again, and the AI stays silent — the operator sees the
   unanswered message.

## Commands

| Command             | What it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm start`         | The application: HTTP listener, workers, timers         |
| `npm run demo`      | End-to-end vertical slice with narration                |
| `npm test`          | Every suite (unit, integration, architecture, contract) |
| `npm run typecheck` | `tsc --noEmit` under a strict config                    |
| `npm run lint`      | ESLint (type-aware)                                     |
| `npm run format`    | Prettier, write                                         |
| `npm run verify`    | Everything above, in the order CI should run it         |

Run one suite at a time with, for example:

```bash
node --test --experimental-test-isolation=none "tests/integration/**/*.test.ts"
```

## Layout

```
src/
  platform/      errors, ids, clock, logger, schema, result, LLM port   (depends on nothing)
  core/          account, tenancy scope, channel vocabulary
  policy/        action vocabulary, authority matrix, the action gate
  knowledge/     Account Packs, knowledge entries, the Knowledge Gate
  operations/    jobs (queue port, worker, reaper), outbox, audit, dead letters, transactions
  moderation/    the conversation domain and its application services
  integrations/  Meta webhook parser + signature verifier, mock LLM, CRM contract
  adapters/      in-memory and PostgreSQL: database, repositories, job queue, migrator
  runtime/       config, composition root, application shell, worker loop, scheduler, http, demo
db/migrations/   PostgreSQL DDL - core, moderation, operations, knowledge, roles, relay + health
docs/            architecture review, domain model, state machines, failure register, ADRs
tests/           unit, integration, architecture, contract, postgres
```

The dependency graph is **enforced by a test**, not by convention:
`tests/architecture/module-boundaries.test.ts` parses every import in `src/` and fails on any edge
outside the declared graph. It also fails if a client-specific identifier appears anywhere in the
runtime — client business content belongs in an Account Pack (ADR-010).

## The mechanisms worth knowing

- **Persist first, process second.** A webhook is signature-verified, written to an immutable raw
  event ledger, and acknowledged. Interpretation happens later, in a job. The ingest path cannot
  even import the LLM port — a test enforces that.
- **Atomic enqueue.** The job row is written in the same transaction as the raw event. This is the
  single argument that decided ADR-004 against Redis: a queue in another store makes ingest a dual
  write, and a crash between the two loses the event silently.
- **Partition exclusivity.** At most one job per conversation runs at a time, expressed as one
  `NOT EXISTS` predicate in the claim query. It gives per-conversation ordering and
  cross-conversation parallelism together.
- **Leases, not locks.** A crashed worker's job returns to `READY` when its lease lapses. A job
  with no attempts left is dead-lettered, recorded, and escalated to a human.
- **Ownership is versioned, and writes are compare-and-swap.** A moderator run re-reads the
  conversation after the model call, and commits with
  `UPDATE ... WHERE ownership_version = $observed`. A takeover landing in that window makes the run
  supersede itself and send nothing.
- **The Knowledge Gate runs twice.** Before the model, so only approved, in-validity entries are
  ever visible. After it, so citations are checked for containment and re-validated — a price can
  expire mid-run.
- **Every early exit is a recorded state with a reason.** "The AI did nothing" is never silent.
- **Raw bytes survive the HTTP layer.** Nothing parses a webhook body before its signature is
  verified, the size cap is enforced _while reading_ rather than after buffering, and a body that
  is not valid UTF-8 is refused rather than silently repaired into different bytes.
- **Privilege is a database role, not a code comment.** `app_runtime` is RLS-bound to one tenant,
  `app_worker` sees the queue and two tables, `app_relay` sees the outbox and may write exactly
  one column. Each limit is asserted by a test that connects as that role and gets `42501`.
- **Shutdown releases work instead of failing it.** An interrupted job goes back to `READY` with
  its lease cleared, not to the dead-letter queue.

## Documentation

| Document                                                       | What it answers                                        |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| [docs/ARCHITECTURE-REVIEW.md](docs/ARCHITECTURE-REVIEW.md)     | Why the system is shaped this way                      |
| [docs/DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md)                   | Entities, relationships, invariants                    |
| [docs/STATE-MACHINES.md](docs/STATE-MACHINES.md)               | Every lifecycle and its legal transitions              |
| [docs/FAILURE-MODE-REGISTER.md](docs/FAILURE-MODE-REGISTER.md) | The F-numbers referenced throughout the code           |
| [docs/adr/](docs/adr/)                                         | The ten decisions, their options, and revisit triggers |
| [docs/HANDOFF-PHASE-00.md](docs/HANDOFF-PHASE-00.md)           | The foundation, proven against an in-memory store      |
| [docs/HANDOFF-PHASE-01.md](docs/HANDOFF-PHASE-01.md)           | The PostgreSQL proof, and the six defects it found     |
| [docs/HANDOFF-PHASE-02A.md](docs/HANDOFF-PHASE-02A.md)         | The runtime shell: what runs, what is still simulated  |

## Configuration

See [.env.example](.env.example). Every value has a safe default; an empty `.env` boots. Config is
validated eagerly, so a bad value fails the process at start-up rather than on the first customer
message. Secrets are never read from config — they are resolved by reference through the
`SecretResolver` port.

## Status

**Phase 02A: the application shell is built and proven.** The process polls PostgreSQL, reaps
expired leases on a timer, relays the outbox, serves signed webhooks over HTTP, reports its own
health, and shuts down cleanly. Every suite runs against a real PostgreSQL server in CI on a
GitHub-hosted runner.

**Live Meta connection is not authorised.** There is no provider transport, no outbound delivery
and no real model. See [docs/HANDOFF-PHASE-02A.md](docs/HANDOFF-PHASE-02A.md) for the full account
of what is proven, what remains simulated, and what has to be true before that changes.
