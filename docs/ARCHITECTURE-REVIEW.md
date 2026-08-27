# Architecture Review — All In Moderation Platform

- Status: Phase 0 analysis
- Date: 2026-08-27
- Author: Lead Systems Architect

This document is the analysis that produced the ADRs. It records _why_ the boundaries are
where they are, which invariants must never break, and which decisions were deliberately
deferred. Read this before any ADR.

---

## 1. What this system actually is

Stripped of channel detail, the platform is:

> A **durable, multi-tenant, per-conversation state machine** that consumes untrusted
> third-party events, derives structured meaning from them with a probabilistic component,
> and emits _authorised_ actions — where "authorised" is decided by deterministic code,
> never by the probabilistic component.

Three properties follow directly, and they drive nearly every decision below:

1. **The event stream is the product.** If an inbound event is lost, no amount of AI quality
   matters. Durability outranks latency, throughput, and elegance.
2. **The AI is a function, not an actor.** It maps `(context) -> proposal`. It has no
   identity, no permissions, and no side effects. Everything it "does" is done by the
   application on its behalf, after validation.
3. **Concurrency is the hard part, not the AI.** Bursts, retries, duplicate webhooks, human
   takeover, and multiple workers all converge on one contested resource: _a single
   conversation's next reply_. This architecture is largely a story about serialising that.

## 2. Domain boundaries

Six bounded contexts were identified. The boundary test used was: _"if this context's rules
changed for one client, would the others need to be redeployed or re-reasoned about?"_

| Context                       | Owns                                                                                                                      | Must not own                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Core / Tenancy**            | Accounts, users, roles, permissions, account context                                                                      | Any moderation semantics                |
| **Ingestion**                 | Channel connections, signature verification, raw inbound event ledger, deduplication, normalisation to canonical messages | Interpretation of message meaning       |
| **Conversation**              | Conversations, messages, ordering, ownership, handoff, moderator runs, outbound action records                            | Channel wire formats; knowledge content |
| **Knowledge & Configuration** | Account Pack, knowledge entries, products, offers, validity/approval, intent taxonomy                                     | How a reply is composed                 |
| **Policy & Authority**        | Authority matrix, action gating, guardrails, escalation rules                                                             | Business content                        |
| **Integration**               | Meta adapter, LLM providers, CRM adapter, All In event publishing, outbox/delivery                                        | Any core invariant                      |

Deliberately **not** separate contexts:

- _Lead management_ — a `LeadCandidate` exists inside the Conversation context as an artefact
  of moderation. The real lead lifecycle belongs to the future CRM (ADR-009). Building a lead
  context here would grow into a CRM by accident.
- _Reporting / analytics_ — a read-model concern. It consumes domain events; it does not own state.
- _Operator UI_ — a delivery mechanism over the same application services, not a context.

### The three-noun rule (explicitly preserved)

`Conversation != Lead`, `Contact != Lead`, `Lead != Opportunity`.

Enforced structurally, not by convention:

- `Conversation` has **no** `lead_id`, no pipeline stage, no owning salesperson, no value field.
- `ContactIdentity` is a _channel-scoped_ identity (a PSID, an IG user id, a phone number).
  It is a communication address — not a person record, and not a sales contact.
- `LeadCandidate` is a moderation artefact with exactly one job: carry qualified facts across
  the boundary to CRM, and record whether that crossing succeeded.
- No table in `moderation/` may store a pipeline stage, a win probability, a close date, or a
  monetary value. If that pressure appears, the answer is a CRM event, not a column.

## 3. Invariants

These must hold at all times. Every one has an enforcement point; "we will be careful" is not
an enforcement point.

| #   | Invariant                                                                                                  | Enforced by                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| I1  | Every accepted inbound webhook is durably persisted before any interpretation happens                      | Ingestion transaction; no LLM call is reachable from the HTTP handler                                                              |
| I2  | The same provider event is never processed twice into domain state                                         | Unique `(channel_connection_id, dedupe_key)` on the raw ledger; unique `(account_id, channel, provider_message_id)` on messages    |
| I3  | At most one moderator run is in flight per conversation                                                    | Job queue partition exclusivity keyed by `conversation_id` (ADR-005)                                                               |
| I4  | A run may only produce outbound actions if the conversation state it observed is still current             | Optimistic guard on `(ownership_version, last_inbound_seq)` re-checked at commit                                                   |
| I5  | While a conversation is `HUMAN_OWNED`, the platform emits no autonomous outbound message                   | Ownership gate at run start **and** at action-gate time; `OutboundAction` cannot be constructed without a passing `PolicyDecision` |
| I6  | Every business row carries `account_id`, and no query may return rows from two accounts                    | Explicit `AccountScope` argument in every repository signature + Postgres RLS (ADR-002)                                            |
| I7  | LLM output can never become an action without schema validation, policy validation, and an authority check | `runModerator` pipeline order + the `PolicyDecision` token                                                                         |
| I8  | Knowledge that is expired, unapproved, or from another account never reaches the model or the customer     | `KnowledgeGate` filters _before_ prompt assembly and re-validates _after_ the decision                                             |
| I9  | Every citation in a decision refers to a knowledge entry actually supplied to that run                     | Citation-containment check in decision validation                                                                                  |
| I10 | No inbound event ends in an undefined state                                                                | Terminal states are `NORMALIZED`, `IGNORED`, `REJECTED`, `DEAD_LETTERED`; a reaper moves stalled rows                              |
| I11 | Retries are bounded, and every exhaustion produces a visible, replayable artefact                          | `attempt`/`max_attempts` on jobs + dead-letter store + handoff fail-safe                                                           |
| I12 | Destructive public-comment actions cannot be performed in Phase 0                                          | Compile-time forbidden-action set, independent of account configuration                                                            |

## 4. Critical state

State whose corruption or loss is unrecoverable, ranked:

1. `raw_inbound_events` — the only reconstructible truth. Everything else can in principle be
   rebuilt by replaying it. **Immutable after write.**
2. `messages` — the customer's own words, plus ordering. Append-only.
3. `conversation.ownership` + `ownership_version` — a stale read here means a human and the AI
   both talk to the customer. Highest-visibility failure mode in the system.
4. `conversation.last_processed_inbound_seq` — the watermark. Too high means a silently ignored
   customer message; too low means duplicate replies. It may only move in the same transaction
   that records the run's result.
5. `outbound_actions` — the record of what we said, and the idempotency key we said it with.
6. `jobs` — in-flight work. Losing it means silent stalls, which are worse than crashes.
7. `domain_event_outbox` + `event_deliveries` — the promise made to downstream systems.

## 5. Failure modes (summary; full register in FAILURE-MODE-REGISTER.md)

The classes that shaped the design:

- **Dual-write** — persisting an event in Postgres and enqueueing work in Redis are two writes
  without a shared transaction. A crash between them loses the event _silently_. This single
  argument drove ADR-004 to a Postgres-backed queue.
- **Interleaving** — burst messages, or a retry racing a fresh event, producing two replies.
  Solved by partition exclusivity + coalescing + the optimistic guard (I3/I4).
- **Stale authority** — a human takes over mid-generation. Solved by `ownership_version`.
- **Probabilistic output treated as truth** — malformed JSON, hallucinated citations,
  fabricated prices, invented intents. Solved by validating _containment_, not plausibility.
- **Silent degradation** — the LLM is down and the system quietly answers nothing. Solved by
  making "no reply produced" an explicit, alerting state (`ModeratorRun.FAILED` → handoff).
- **Cross-tenant leakage** — the most damaging non-recoverable business failure. Defence in
  depth: explicit scope, composite foreign keys, RLS, and tests that a repository cannot be
  called without a scope.

## 6. Future coupling risks (and the pre-emptive cut)

| Risk                                        | Where it would have leaked in                         | Pre-emptive cut                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dental Hub rules hardening into the runtime | Intent lists, qualification logic, reply templates    | All business semantics live in the **Account Pack**, loaded per account and pinned per run. Core ships zero business content. An architecture test asserts no client name appears in `src/`. |
| Meta shapes leaking into the domain         | `Message.psid`, `Conversation.page_id`                | The domain speaks `ChannelIdentity{ channel, externalId }`. The Meta envelope never crosses `integrations/meta`.                                                                             |
| CRM becoming a runtime dependency           | A synchronous "create lead" call inside the moderator | CRM is reached only via outbox events. `LeadCandidate` is persisted locally first.                                                                                                           |
| One LLM vendor's API shape                  | Provider-specific message/tool formats in prompts     | The `LlmProvider` port speaks _our_ types; provider adapters translate. Structured output is our schema, not a vendor feature.                                                               |
| Channel assumptions (private DM only)       | Assuming a reply is always private                    | `Conversation.surface` is `DIRECT_MESSAGE` or `PUBLIC_COMMENT` from day one; the authority matrix is surface-aware.                                                                          |
| Single-process assumptions                  | In-process locks, module-level caches                 | All coordination lives in the database. Caches must be account-keyed and are treated as derived, never authoritative.                                                                        |

## 7. Missing architectural decisions (surfaced, not silently assumed)

Recorded so they are not mistaken for oversights. Each has an owning phase.

| #   | Open decision                                                          | Why deferred                                        | Needed by                            |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------ |
| D1  | Retrieval strategy for knowledge (deterministic lookup vs. embeddings) | Requires real Dental Hub content to evaluate recall | Phase 2                              |
| D2  | Whether AI shadow mode during human ownership is on by default         | Product/legal call; affects cost                    | Phase 2                              |
| D3  | Message retention and PII redaction windows per account                | Legal input required                                | Phase 1 (schema already supports it) |
| D4  | Operator UI stack (server-rendered vs SPA)                             | No operator workflows validated yet                 | Phase 2                              |
| D5  | Rate-limit budgets per Meta connection                                 | Requires real traffic shape                         | Phase 1                              |
| D6  | Multi-region / DR posture, RPO and RTO targets                         | Business input                                      | Phase 3                              |
| D7  | Auto-return of ownership from human to AI after inactivity             | Risky default; needs operator trust first           | Phase 2                              |
| D8  | Human approval queue for `REQUIRES_APPROVAL` actions                   | Depends on operator UI                              | Phase 2                              |
| D9  | Cost accounting and per-account LLM budget enforcement                 | Needs live usage data                               | Phase 2                              |
| D10 | Voice/image pipeline (transcription, vision) provider choice           | Not needed until multimodal traffic is real         | Phase 3                              |

## 8. Consequences accepted

- **Latency**: debounce plus a queue hop means the first reply is seconds, not milliseconds.
  Accepted — correct replies beat fast ones, and human-like pacing is desirable in messaging.
- **Postgres is the throughput bottleneck** by design. Accepted until measured; the `JobQueue`
  port keeps the exit open (ADR-004).
- **No horizontal service split.** A modular monolith is harder to accidentally couple than
  microservices are to correctly decouple, at this team size (ADR-001).
- **In-memory adapters in Phase 0** prove the _contracts_, not Postgres behaviour. This is
  stated explicitly in the handoff; the same contract suite is the acceptance test for the
  Postgres adapters in Phase 1.
