# ADR-002: Tenancy Model

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

Multi-client support is required from day one, and cross-tenant leakage is the single most
damaging failure this platform can produce: it is public, it is irreversible, and it ends client
relationships. The requirement explicitly asks how isolation is enforced in the database,
queries, authorization, jobs, events, cache, logs, and files.

An important asymmetry: leakage is rarely caused by a `WHERE account_id = ?` being _written_
wrong. It is caused by a query that never had one, in code where nothing forced the author to
think about tenancy. So the goal is not "remember the filter"; it is **make tenant-unaware data
access impossible to express.**

## Decision

**Shared database, shared schema, `account_id` on every business row, with three independent
layers of enforcement.**

### Layer 1 — Type system (primary, compile time)

Every repository method takes an `AccountScope` as its first argument. `AccountScope` is a
branded type produced only by an authenticated resolution path (`resolveAccountScope`), never
constructed literally by domain code:

```ts
type AccountScope = { readonly accountId: AccountId; readonly [scopeBrand]: true };
findConversation(scope: AccountScope, id: ConversationId): Promise<Conversation | null>;
```

Consequence: a data-access call that forgets tenancy does not compile. There is deliberately
**no** ambient current-account (for example, a bare `AsyncLocalStorage` lookup inside the
repository) as the primary mechanism — ambient state fails _open_ when someone forgets to set
it. Request context may still carry the scope, but it is passed explicitly down the call chain.

### Layer 2 — Database constraints and RLS (runtime, defence in depth)

- Every business table has a non-null `account_id` referencing `accounts(id)`.
- Foreign keys between business tables are **composite**, including `account_id` (for example
  `messages(account_id, conversation_id) REFERENCES conversations(account_id, id)`). A row can
  therefore never point at another tenant's row, even with buggy application code.
- Row Level Security is enabled with `FORCE` on every business table. The application connects
  as a non-superuser role and executes `SET LOCAL app.account_id = $1` at the start of each
  transaction; policies filter on `current_setting('app.account_id', true)`.
- Migrations, the reaper, and reconciliation jobs use a separate, clearly named role that may
  bypass RLS; its use is audited.

RLS is the backstop, not the plan. If the application layer is correct, RLS never changes a
result. If the application layer is wrong, RLS turns a leak into an empty result set.

### Layer 3 — Operational surfaces

| Surface               | Rule                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authorization**     | Users belong to accounts through memberships with roles. The auth layer resolves a scope per request; a user with no membership in the target account cannot obtain a scope for it. Platform-staff access to a client account is a distinct, audited role that emits an `account.impersonated` audit event.                     |
| **Jobs**              | Every job row carries `account_id`. Job payloads carry ids, never denormalised tenant data. The worker resolves a fresh `AccountScope` from `job.account_id` before invoking a handler — a handler never trusts its payload for tenancy. Partition keys are prefixed with the account id so keys cannot collide across tenants. |
| **Events**            | Every domain event envelope carries `account_id`. Outbound delivery configuration (endpoint, secret) is per account; the publisher asserts `event.accountId === destination.accountId` before dispatch.                                                                                                                         |
| **Cache**             | Every cache key is prefixed `acct:{account_id}:`. A cache port that accepts an unprefixed key does not exist. Account Pack caches are additionally keyed by pack version, so a config change invalidates by construction.                                                                                                       |
| **Logs**              | The logger is bound to a scope and always emits `account_id`. Message bodies and contact identifiers are never logged at `info`; they pass through a redactor. Logs are queryable per account for incident response.                                                                                                            |
| **Files / media**     | Object storage paths are `{account_id}/{conversation_id}/{artifact_id}`; access is via short-lived signed URLs issued only after a scope check; buckets deny public listing.                                                                                                                                                    |
| **Deletion / export** | Because every row is `account_id`-scoped and foreign keys cascade within the tenant, account deletion and export are single-predicate operations. This is a design goal, not a coincidence.                                                                                                                                     |

## Options considered

| Option                                                    | Pros                                                                 | Cons                                                                                                              | Verdict                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Shared DB, shared schema, `account_id` + RLS (chosen)** | One migration path; cheap; simple ops; supports hundreds of accounts | Leakage possible in principle; noisy-neighbour effects need rate limits                                           | **Chosen**                                                                      |
| Schema-per-tenant                                         | Strong isolation; easy per-tenant backup                             | Migrations across N schemas; connection/pool churn; the job queue and cross-account operator views become awkward | Rejected — real cost, mostly psychological benefit given composite FKs plus RLS |
| Database-per-tenant                                       | Strongest isolation; per-client residency                            | Operationally heavy at four-plus clients; platform-wide operator tooling and reconciliation become hard           | Rejected now; documented as the escape hatch for a regulated client             |
| Discriminator column, no RLS                              | Simplest                                                             | One mistake leaks data; no backstop                                                                               | Rejected                                                                        |

## Consequences

### Positive

- Cross-tenant access requires defeating three independent mechanisms.
- Per-account deletion and export are trivial, which matters for data-protection commitments.

### Negative / accepted cost

- RLS adds small per-query overhead and requires discipline about which role runs what.
- Noisy neighbours share the database; per-account rate limits and job fairness become required
  (Phase 1) rather than optional.
- Every repository signature is one argument longer. That is the point.

## Enforcement

- Repository interfaces take `AccountScope`; the scope cannot be forged (branded type backed by
  a module-private symbol).
- `tests/unit/tenancy.test.ts` asserts that reads scoped to account B cannot see account A's
  rows, that a job handler re-resolves scope from the job row, and that cache keys are prefixed.
- Migration `0001` enables `ROW LEVEL SECURITY ... FORCE` on all business tables; a Phase 1 test
  will assert that every table with an `account_id` column has RLS enabled.

## Revisit trigger

- A client contractually requires physical data separation or a specific data-residency region.
- Per-account load becomes uneven enough that shared-database contention causes SLA breaches.
