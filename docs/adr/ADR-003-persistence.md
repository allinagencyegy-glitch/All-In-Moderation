# ADR-003: Persistence and Data Ownership

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

The platform needs: strict transactional guarantees at ingest, row-level locking for
conversation serialisation, `SELECT ... FOR UPDATE SKIP LOCKED` for the job queue, JSON storage
for raw provider envelopes and account configuration, and eventually full-text or vector search
over knowledge. It must also be operable by a small team.

Data ownership must also be settled: the moderation platform is the system of record for
conversational state, and it must stay fully functional when the CRM, All In Studio, or the LLM
provider is unavailable.

## Decision

**PostgreSQL is the single system of record for the moderation platform. Access is SQL-first
through narrow repository adapters behind ports. No ORM entity graph, no lazy loading, no
cross-aggregate joins in the domain.**

Specifics:

- Schema is managed by plain, forward-only, numbered SQL migration files in `db/migrations/`.
  The concurrency-critical parts of this system _are_ SQL (`SKIP LOCKED`, partial unique
  indexes, RLS policies); hiding them behind an ORM DSL would hide the actual design.
- Query layer: the `pg` driver plus hand-written SQL in adapter classes, with a small typed
  query helper. A typed SQL builder (Kysely) is pre-approved if hand-written SQL becomes
  repetitive; it would not change any port contract. Prisma is excluded (see below).
- `jsonb` is used for exactly three things: raw provider envelopes (immutable), account pack
  section documents (versioned, schema-validated on write), and raw LLM responses (audit).
  Anything the system queries or enforces an invariant on is a real column with a real constraint.
- Money is `numeric(12,2)` plus an ISO-4217 currency column — never floats. Prices are values on
  an approved offer row, never free text.
- Timestamps are `timestamptz`, UTC at rest. Inbound stores two: `provider_ts` (what the channel
  claims) and `received_at` (what we observed). They are not the same fact (ADR-005).
- Enumerations are `text` with `CHECK` constraints rather than PostgreSQL `enum` types, so adding
  a state is a normal migration rather than a lock-taking type alteration.
- Append-only tables (`raw_inbound_events`, `messages`, `audit_events`, `domain_event_outbox`)
  have `UPDATE` and `DELETE` revoked from the application role.

### Data ownership boundary

| Owned by the moderation platform                                 | Owned elsewhere                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Accounts (as tenants), channel connections, channel identities   | Sales contacts, leads, opportunities, pipeline, quotations, revenue (future CRM) |
| Raw inbound events, conversations, messages, attachments         | Client billing, staffing, campaign performance (All In Studio)                   |
| Moderator runs, decisions, ownership, handoffs, outbound actions | Ad spend, creative assets                                                        |
| Account packs, knowledge entries, products, offers, policies     | The client's own ERP or inventory truth                                          |
| Audit events, jobs, dead letters, outbox and deliveries          | —                                                                                |

The platform **never** reads from the CRM synchronously in the request path. If it needs a fact
the CRM owns, that fact must have been projected into the moderation side beforehand, or the
conversation escalates to a human. That is what makes "a CRM outage does not stop moderation"
true rather than aspirational.

## Options considered

| Option                                            | Pros                                                                                                                                                | Cons                                                                                                                                     | Verdict                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Postgres, SQL-first via repositories (chosen)** | Transactions, `SKIP LOCKED`, `jsonb`, partial indexes, RLS, `LISTEN/NOTIFY`, `pgvector` later — one engine covers ledger, queue, config, and search | We write SQL; pooling needs care                                                                                                         | **Chosen**                                                     |
| Postgres + Prisma                                 | Strong DX, migrations, typed client                                                                                                                 | Fights `FOR UPDATE SKIP LOCKED`, advisory locks, RLS session settings, and partial unique indexes — precisely our hard parts; hidden N+1 | Rejected                                                       |
| Postgres + Drizzle/Kysely                         | Typed, thin, SQL-shaped                                                                                                                             | A dependency we do not yet need; adds no capability at Phase 0                                                                           | Deferred — pre-approved for Phase 1 if repetition justifies it |
| MongoDB                                           | Flexible documents                                                                                                                                  | No transactional guarantee we would trust for ledger+queue atomicity; weaker constraint enforcement, which is our main leakage defence   | Rejected                                                       |
| Postgres + Kafka as event store                   | Great fan-out and replay                                                                                                                            | A second system of record and a second ops burden, and the dual-write problem returns                                                    | Rejected for Phase 0; the outbox keeps this migration open     |

## Consequences

### Positive

- One engine to operate, back up, and reason about; one transaction boundary spanning ledger,
  queue, and outbox.
- Concurrency-critical logic is visible and reviewable as SQL.

### Negative / accepted cost

- The database is the scaling bottleneck. Accepted until measured; the mitigations (read replicas
  for operator views, monthly partitioning of `raw_inbound_events` and `messages`) are known and
  do not change the domain.
- Hand-written SQL is more verbose than an ORM. Mitigated by narrow repositories and the shared
  contract test suite.

## Enforcement

- Ports live in the domain modules; SQL exists only under `src/adapters/postgres/`. The module
  boundary test fails if a domain module imports a database driver.
- Every adapter must pass `tests/contract/*` — the same suite the in-memory adapters pass. This
  is the acceptance criterion for the Phase 1 Postgres adapters.
- Append-only tables have `UPDATE`/`DELETE` revoked from the app role in migration `0001`.

## Revisit trigger

- Sustained write throughput approaches what a single primary can absorb, or ledger tables grow
  past the point where monthly partitioning suffices.
- Knowledge retrieval requires vector search at a scale where `pgvector` underperforms a
  dedicated store.
