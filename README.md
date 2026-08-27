# All In Moderation

A multi-client, 24/7 AI moderation platform for social messaging. This repository is the
**Phase 0 foundation**: the domain model, the architecture, the safety mechanisms, and the tests
that prove them — with no network I/O of any kind.

Phase 0 exists to make one claim defensible before any real traffic exists:

> A customer message is never lost, never answered twice, never answered by the AI while a human
> is holding the conversation, and never answered from knowledge the account has not approved.

Everything here is in service of that sentence.

## What Phase 0 is, and is not

| Built and proven                                                  | Deliberately absent                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Domain model, state machines, invariants                          | HTTP server / webhook endpoint                                             |
| Durable job queue contract, worker, lease recovery, dead letters  | PostgreSQL adapter (the in-memory one satisfies the same contract)         |
| Tenancy: branded scope tokens, per-row assertions, RLS in the DDL | Live Meta transport — outbound is `SIMULATE` only                          |
| Knowledge Gate, Account Packs, policy/authority matrix            | Real LLM provider — a deterministic mock stands in                         |
| Ownership model with compare-and-swap concurrency control         | Operator UI                                                                |
| SQL migrations (structurally verified)                            | Any client's business rules — those live in Account Packs, never in `src/` |

**No code in this repository contacts a network.** `OUTBOUND_MODE=LIVE` is refused at boot.

## Quick start

```bash
npm install
npm run demo      # end-to-end vertical slice, no network, no database
npm run verify    # format:check + lint + typecheck + the whole test suite
```

Requires Node.js >= 24 (TypeScript runs natively; there is no build step).

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
  adapters/      in-memory database, repositories, job queue
  runtime/       config, composition root, demo
db/migrations/   PostgreSQL DDL (0001 core, 0002 moderation, 0003 operations, 0004 knowledge)
docs/            architecture review, domain model, state machines, failure register, ADRs
tests/           unit, integration, architecture, contract
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

## Documentation

| Document                                                       | What it answers                                         |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| [docs/ARCHITECTURE-REVIEW.md](docs/ARCHITECTURE-REVIEW.md)     | Why the system is shaped this way                       |
| [docs/DOMAIN-MODEL.md](docs/DOMAIN-MODEL.md)                   | Entities, relationships, invariants                     |
| [docs/STATE-MACHINES.md](docs/STATE-MACHINES.md)               | Every lifecycle and its legal transitions               |
| [docs/FAILURE-MODE-REGISTER.md](docs/FAILURE-MODE-REGISTER.md) | The F-numbers referenced throughout the code            |
| [docs/adr/](docs/adr/)                                         | The ten decisions, their options, and revisit triggers  |
| [docs/HANDOFF-PHASE-00.md](docs/HANDOFF-PHASE-00.md)           | What is proven, what is not, and what Phase 1 should do |

## Configuration

See [.env.example](.env.example). Every value has a safe default; an empty `.env` boots. Config is
validated eagerly, so a bad value fails the process at start-up rather than on the first customer
message. Secrets are never read from config — they are resolved by reference through the
`SecretResolver` port.

## Status

Phase 0 is complete against its in-memory adapter. **The SQL migrations have been verified
structurally but have not been executed against a real PostgreSQL server**, and the Postgres
adapter does not exist yet. See [docs/HANDOFF-PHASE-00.md](docs/HANDOFF-PHASE-00.md) for the full
account of what the tests do and do not prove.
