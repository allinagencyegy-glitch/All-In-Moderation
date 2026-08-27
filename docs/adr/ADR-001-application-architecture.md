# ADR-001: Application and Repository Architecture

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

We are building a platform that must serve many unrelated clients, integrate with several
external systems, and run 24/7 without silent failure. The team is small. The temptation in
this shape of problem is to reach for services-per-concern early ("ingest service", "AI
service", "delivery service") because the concerns are genuinely distinct.

The concerns being distinct is an argument for **module** boundaries. It is not, by itself, an
argument for **network** boundaries. Network boundaries buy independent scaling and independent
deploys; they cost distributed transactions, partial failure, versioned RPC, distributed
tracing, and N deployment pipelines. Our reliability requirement (zero silent failure) is far
easier to satisfy when the write to the event ledger and the enqueue of the work that processes
it are **the same database transaction** — which requires them to be in the same process and
the same database.

## Decision

**A modular monolith: one repository, one deployable artefact, one database, with explicitly
declared and machine-enforced module boundaries.**

Specifics:

- One Node.js/TypeScript process image, run in two roles selected at start-up: `web` (HTTP:
  webhook ingress, operator API) and `worker` (job execution). Same code, same deploy,
  different entry point. This gives independent _scaling_ of the two workloads without
  independent _codebases_.
- Source is organised by domain module, not by technical layer:

  ```text
  src/
    platform/       cross-cutting primitives: ids, clock, result, errors, logging, schema, llm port
    core/           accounts, tenancy scope, shared channel and state vocabulary
    policy/         authority matrix and the action gate
    knowledge/      account packs, knowledge entries, the knowledge gate
    operations/     jobs, retries, dead-letter, audit, transactions, event outbox and contracts
    moderation/     channels, ingest, conversations, messages, moderator runtime, handoffs
    integrations/   meta adapter, llm vendor adapters, crm adapter
    adapters/       concrete implementations of the repository ports (memory now, postgres next)
    runtime/        composition root and entry points
  ```

- Each module exposes a **ports** surface (interfaces plus domain types). Cross-module calls go
  through ports or through domain events. No module reaches into another module's internals.
- The dependency graph is acyclic and declared in `tests/architecture/module-boundaries.test.ts`.
  Adding an edge requires editing that file, which makes coupling a reviewed decision rather
  than an accident.

Allowed dependency edges (everything else is a test failure):

```text
platform      -> (nothing)
core          -> platform
policy        -> platform, core
knowledge     -> platform, core, policy
operations    -> platform, core
moderation    -> platform, core, policy, knowledge, operations
integrations  -> platform, core, knowledge, moderation, operations
adapters      -> platform, core, policy, knowledge, moderation, operations, integrations
runtime       -> everything
```

Three directions in that list are deliberate and were each corrected once the enforcement test
was written — which is the argument for having the test:

- **`knowledge -> policy`, not the reverse.** An Account Pack _contains_ policy configuration (the
  authority matrix), so the module that owns packs depends on the policy vocabulary. `policy`
  itself needs nothing from `knowledge`: the gate is handed facts, it does not fetch them.
- **`moderation` never depends on `integrations`.** Ports live with their consumer; adapters live
  in `integrations`. Concretely: `InboundEnvelopeParser` and `WebhookSignatureVerifier` are
  declared in `moderation/domain/inbound.ts` and _implemented_ by `integrations/meta`. Adding
  WhatsApp or TikTok is a new adapter plus one line in the composition root — the conversation
  model does not change. Before this correction, `normalize-event.ts` imported `parseMetaEnvelope`
  directly, which is precisely the "Meta shapes leaking into the domain" risk named in the
  architecture review.
- **The LLM port lives in `platform`, the vendors in `integrations`.** `LlmProvider` carries no
  domain knowledge — it is a capability like `Clock` or `Logger` — so it sits with the other
  injected primitives. The transactional outbox and the domain-event registry live in
  `operations` for the same reason: they are durable-delivery machinery, not conversation logic.

## Options considered

| Option                                  | Pros                                                                                                       | Cons                                                                                                                                                               | Verdict                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **Modular monolith (chosen)**           | Transactional ingest+enqueue; one deploy; refactoring boundaries is cheap; fewest moving parts to run 24/7 | Shared failure domain; requires discipline to keep boundaries real                                                                                                 | **Chosen**                                               |
| Microservices from day one              | Independent scale/deploy; forced boundaries                                                                | The dual-write problem becomes structural; distributed tracing and ops burden on a small team; boundaries chosen before we understand the domain are usually wrong | Rejected                                                 |
| Serverless functions per webhook        | Elastic; no idle cost                                                                                      | Per-conversation serialisation and durable timers become someone else's product; cold starts; hard to reason about ordering                                        | Rejected                                                 |
| Monorepo with npm workspaces per module | Real package boundaries; publishable                                                                       | Build-graph complexity, version skew, and project references for a benefit (independent versioning) we do not need yet                                             | Rejected for now — the layout stays workspace-compatible |

## Consequences

### Positive

- Ingest and enqueue are atomic (ADR-004, ADR-006), which is the backbone of "zero silent failure".
- A boundary violation is a failing test in CI, not a code-review opinion.
- Extracting a module into a service later is mechanical, because it already talks through ports.

### Negative / accepted cost

- One process's memory leak or crash loop affects all tenants. Mitigated by running multiple
  replicas of both roles, and by per-account rate limiting and job partitioning.
- Discipline is required; the enforcement test is what makes it survivable.

## Enforcement

- `tests/architecture/module-boundaries.test.ts` parses every `import` in `src/` and fails on
  any edge outside the allow-list and on any cycle between modules.
- The same test asserts that no client-specific identifier (e.g. a client brand name) appears
  anywhere in `src/`.

## Revisit trigger

Reopen if any of these become true:

- A single module's scaling profile diverges so far that co-deployment is wasteful (e.g. media
  transcoding).
- Team size passes roughly eight engineers with contention on one deploy pipeline.
- A regulatory requirement forces physical data separation for one client (see ADR-002).
