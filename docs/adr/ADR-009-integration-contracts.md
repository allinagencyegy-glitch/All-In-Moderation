# ADR-009: Integration and Event Contracts

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

The platform must publish business events to All In systems and hand qualified leads to a future
CRM, without either becoming a runtime dependency. Two hard constraints:

- If CRM or All In is unavailable, moderation continues, and no customer context is lost.
- We must not fire every raw customer message into All In. Data minimisation is a design input,
  not a later clean-up.

## Decision

**All outward integration goes through versioned domain events written to a transactional outbox
and delivered asynchronously by per-destination adapters. No synchronous outward call exists in
the moderation request path.**

### Event envelope

```jsonc
{
  "event_id": "01J...", // ULID; the consumer's idempotency key
  "type": "lead.qualified",
  "version": 1, // per-type schema version
  "occurred_at": "2026-08-27T10:00:00Z",
  "account_id": "acc_...",
  "subject": { "type": "conversation", "id": "cnv_..." },
  "trace_id": "...", // correlates back to the raw inbound event
  "data": {
    /* type-specific, schema-validated */
  },
}
```

Rules:

- `event_id` is stable across redeliveries; consumers deduplicate on it. Delivery is at-least-once
  and consumers must be idempotent — this is stated in the contract, not assumed.
- Versioning is additive: new optional fields do not bump `version`; removing or re-typing a field
  does. Two versions of a type may be emitted during a migration window, and consumers declare
  which versions they accept.
- Payloads carry **ids and derived facts**, never raw message text by default (see minimisation).

### Catalogue (Phase 0 registry)

| Type                        | Emitted when                                   | Payload principle                                                |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| `conversation.started`      | First message of a new conversation            | Ids, channel, surface — no content                               |
| `intent.detected`           | A run classifies an intent                     | Intent code, confidence, ids — no content                        |
| `product_interest.detected` | An entity resolves to a known product          | Product ref, confidence                                          |
| `faq.unanswered`            | Knowledge gate found nothing usable            | The _normalised question shape_, not the raw text, plus a gap id |
| `complaint.detected`        | Complaint intent above threshold               | Intent, severity, ids                                            |
| `lead.candidate_created`    | A lead candidate is persisted                  | Candidate id, captured field _names_, not values                 |
| `lead.qualified`            | Qualification rules satisfied                  | Candidate id plus the agreed CRM field set (values, by contract) |
| `sales.handoff_requested`   | Handoff to sales requested                     | Handoff id, reason, urgency                                      |
| `sales.handoff_failed`      | Handoff unacknowledged past SLA                | Handoff id, reason, elapsed                                      |
| `handoff.failed`            | Any handoff exhausted its retries              | Handoff id, terminal reason                                      |
| `moderation.degraded`       | Provider circuit opened / dead letters spiking | Component, counts — operational, no customer data                |

The registry lives in code (`integrations/events/contracts.ts`) with a schema per type. Publishing
an unregistered type, or a payload failing its schema, is a programming error that fails loudly in
tests and in development.

### Delivery

```text
domain write + outbox insert   (one transaction)
        │
        ▼
outbox relay job  ──► for each subscription matching (account, type):
                        create event_delivery row (PENDING)
                        ▼
                      deliver job → HTTP POST, signed (HMAC-SHA256 over body + timestamp)
                        ├── 2xx        → DELIVERED
                        ├── 4xx        → FAILED_PERMANENT (no retry; alert)
                        └── 5xx/timeout→ retry with backoff → DEAD_LETTERED after max attempts
```

- The outbox insert is in the same transaction as the state change it describes, so an event is
  never "emitted" for a change that rolled back, and never lost for a change that committed.
- `event_deliveries` is per `(event, subscription)`, so one slow consumer cannot block another,
  and each has independent retry state.
- Ordering is per subject where it matters: deliveries for the same `subject.id` use the outbox
  partition key so a consumer sees `conversation.started` before `intent.detected`.
- Every delivery attempt is recorded with status, response code, and duration. "Did All In get
  it?" is a query, not a guess.

### Data minimisation

Three rules, enforced by the event schemas rather than by reviewer diligence:

1. **Ids over content.** Consumers that need content call back with an authorised, scoped,
   audited read. Push carries references.
2. **Derived over raw.** `faq.unanswered` carries a normalised question shape and a gap id, not
   the customer's sentence.
3. **Per-account opt-in for anything with personal data.** A subscription declares the fields it
   receives; the publisher projects the payload down to that declaration. A consumer cannot
   receive a field it did not contract for, even if we add it to the event later.

### CRM as an adapter

```text
qualification succeeds
   → LeadCandidate persisted locally (moderation owns this row)
   → lead.qualified event in the outbox
   → CRM adapter consumes, calls the CRM API with an idempotency key
   → on success:  candidate.external_ref recorded, handoff COMPLETED
   → on failure:  retry with backoff; on exhaustion → handoff.failed + human escalation
```

The conversation is never blocked on the CRM. If the CRM is down for a day, candidates accumulate
locally and drain when it returns — with no customer context lost, because the moderation side
already owns everything it needs. See `docs/CRM-HANDOFF-CONTRACT.md` for the field-level contract.

### Inbound from other systems

Other All In systems may need to push facts in (an operator action, a knowledge update). Same
discipline in reverse: a signed, versioned, idempotent command endpoint that writes to our
database and enqueues our jobs. No system reaches into our tables, and we reach into no one's.

## Options considered

| Option                                                          | Verdict                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transactional outbox with per-destination delivery (chosen)** | Only design where "we changed state" and "we told you" cannot diverge                                                                       |
| Direct synchronous API calls from the moderator                 | Couples customer response time to CRM uptime; violates the core reliability requirement                                                     |
| Message broker (Kafka/RabbitMQ) as the primary bus              | Reintroduces the dual-write problem at the producer, plus new infrastructure. The outbox can feed a broker later without changing producers |
| Consumers polling our API                                       | Simple, but adds latency and forces every consumer to build state tracking                                                                  |
| Emit everything, let consumers filter                           | Fails data minimisation and makes every consumer a PII processor                                                                            |

## Consequences

### Positive

- Downstream outages are invisible to customers and fully recoverable.
- Every promise made to a consumer is auditable per attempt.
- Adding a consumer is a subscription row plus an adapter; producers are untouched.

### Negative / accepted cost

- At-least-once delivery pushes idempotency onto consumers. Documented in the contract, and
  `event_id` makes it mechanical.
- Eventual consistency: the CRM lags moderation by seconds to minutes. Accepted, and the correct
  trade for availability.
- The outbox table needs archiving. Standard maintenance job.

## Enforcement

- Event publication is only possible through the outbox port; no HTTP client exists in
  `moderation/` (module boundary test).
- Every event type has a schema; `tests/unit/event-contracts.test.ts` asserts registry/schema
  agreement and that no payload declares a field outside its subscription projection.
- `tests/integration/crm-outage.test.ts` asserts that with a failing CRM adapter, conversations
  still complete, the candidate persists, deliveries retry, and exhaustion escalates.

## Revisit trigger

- A consumer needs sub-second fan-out at a volume where relay polling is too slow (then add
  `LISTEN/NOTIFY` or a broker fed by the outbox).
- More than a handful of consumers, or cross-account aggregation, justifies a real event bus.
- A regulator or client requires that certain events never leave a region.
