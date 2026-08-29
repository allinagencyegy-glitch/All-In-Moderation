# Architecture Decision Records

Each ADR records one decision, the forces behind it, the options rejected, and — critically —
the **revisit trigger**: the observable condition that should cause us to reopen it.

An ADR is never edited to change a decision. It is superseded by a new ADR.

| ADR                                                       | Decision                                                                       | Status   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| [ADR-001](ADR-001-application-architecture.md)            | Modular monolith, single deployable, enforced module boundaries                | Accepted |
| [ADR-002](ADR-002-tenancy-model.md)                       | Shared database, shared schema, explicit `AccountScope` + Postgres RLS         | Accepted |
| [ADR-003](ADR-003-persistence.md)                         | PostgreSQL as system of record; SQL-first access; no ORM lazy-loading          | Accepted |
| [ADR-004](ADR-004-async-workflow.md)                      | Postgres-backed durable job queue (not Redis/BullMQ, not Temporal — yet)       | Accepted |
| [ADR-005](ADR-005-conversation-ordering.md)               | Per-conversation partition exclusivity, sequence numbers, burst coalescing     | Accepted |
| [ADR-006](ADR-006-idempotency-raw-events.md)              | Persist-first raw event ledger with two-level deduplication                    | Accepted |
| [ADR-007](ADR-007-ai-provider-abstraction.md)             | Provider-agnostic `LlmProvider` port with role-based model selection           | Accepted |
| [ADR-008](ADR-008-conversation-ownership.md)              | Decomposed conversation state; ownership as an independent, versioned axis     | Accepted |
| [ADR-009](ADR-009-integration-contracts.md)               | Versioned domain events via transactional outbox; adapters, never dependencies | Accepted |
| [ADR-010](ADR-010-knowledge-and-configuration.md)         | Immutable, versioned Account Packs pinned per moderator run                    | Accepted |
| [ADR-011](ADR-011-human-review-and-suggested-delivery.md) | `REQUIRE_APPROVAL` yields a suggested draft; approval is not delivery          | Accepted |
| [ADR-012](ADR-012-llm-egress-and-provider-adapter.md)     | One allowlisted file may reach one host; the Meta ban is unconditional         | Accepted |

## Template

See [ADR-000-template.md](ADR-000-template.md).
