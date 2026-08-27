# ADR-006: Idempotency and the Raw Inbound Event Architecture

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

Meta retries webhook deliveries. Retries can duplicate, arrive out of order, or arrive after we
have already processed the original. Our own workers can also redeliver jobs after a lease
expiry. Against that, the platform's headline requirement is **zero silent failure**: an inbound
customer event must never disappear.

Two failure directions must both be closed:

- **Loss** — we acknowledged an event and never processed it.
- **Duplication** — we processed the same event twice and replied twice.

## Decision

**Persist first, process second, with deduplication at two independent levels and idempotent
handlers throughout.**

### Ingest path

```text
POST /webhooks/meta/{connectionPublicId}
  1. Look up the channel connection by the opaque path id      -> account_id known
  2. Enforce the body size cap and the per-connection rate limit
  3. Verify the HMAC signature against that connection's app secret (constant-time compare)
  4. Compute delivery_key = sha256(canonical(raw body))
  5. BEGIN
       INSERT INTO raw_inbound_events (..., state='RECEIVED')
         ON CONFLICT (channel_connection_id, delivery_key) DO NOTHING
       IF inserted:
         INSERT INTO jobs (type='raw_event.normalize',
                           partition_key='acct:{a}:conn:{c}', ...)
     COMMIT
  6. Return 200
```

Properties this buys:

- **The account is known before the body is parsed.** The webhook URL is per connection and
  carries an opaque, non-guessable id. Tenancy never depends on trusting payload contents.
- **No parsing, no interpretation, and above all no LLM call happens before the commit.** The
  handler cannot reach the model — the module boundary test enforces that the HTTP ingress layer
  does not import the LLM port.
- **The ledger row and the promise to process it are one transaction** (ADR-004). There is no
  window in which we have acknowledged an event that nothing will process.
- **Acknowledge only what we durably hold.** If the transaction fails we return 5xx and let Meta
  retry — a duplicate is cheap, a loss is not.

### Signature failures

A payload that fails signature verification is stored with `state='REJECTED'` and
`signature_valid=false`, and is never normalised. Rationale: forensic value during incidents
(misconfigured secret vs. genuine spoofing look identical without evidence). To prevent this
from becoming a storage-exhaustion vector, rejected rows are subject to a strict body-size cap, a
per-connection rate limit, and a short retention window (7 days, versus the account's normal
retention for accepted events).

### Two levels of deduplication

| Level        | Key                                                               | Catches                                                                                                    |
| ------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Delivery** | `(channel_connection_id, sha256(raw body))` unique                | Meta redelivering the identical HTTP payload                                                               |
| **Item**     | `(account_id, channel, provider_message_id)` unique on `messages` | The same message arriving inside two _different_ envelopes (batched differently, or partially redelivered) |

Both are needed. Delivery-level alone misses re-batched redeliveries; item-level alone would let
us re-run the whole envelope. When Meta supplies no stable per-item id, the item key falls back
to `sha256(sender + recipient + provider_ts + content_hash)` — recorded on the row as
`dedupe_source = 'provider_id' | 'derived'` so ambiguity is visible rather than assumed.

A duplicate is **not** an error. It increments a counter, writes an audit trail entry, and
returns success. Alerting on duplicates would train operators to ignore alerts.

### Normalisation

`raw_event.normalize` is idempotent by construction:

```text
for each messaging item in the envelope, in envelope order:
   INSERT message ... ON CONFLICT (account_id, channel, provider_message_id) DO NOTHING
   if not inserted -> item already known, skip (count it)
   else -> resolve identity, resolve/create conversation, assign seq, schedule moderator run
mark the raw event NORMALIZED with the ids it produced
```

Redelivery of the whole job re-executes the loop and inserts nothing new. Partial progress before
a crash is safe for the same reason: the surviving rows are skipped on the retry.

### Outbound idempotency

Every `OutboundAction` carries a stable, deterministic `idempotency_key` derived from
`(conversation_id, moderator_run_id, action_ordinal)`. When the Meta transport is implemented
(Phase 2), it sends that key on the request; a retry after an ambiguous timeout can be
reconciled against the provider rather than blindly resent. Where a provider offers no
idempotency key, the transport must reconcile by reading recent thread state before resending —
never resend blind.

### Replay

Because the ledger is immutable and normalisation is idempotent, replay is safe by construction
for the ingest half: re-running `raw_event.normalize` for a range of events produces no
duplicates. Replay of `moderator.run` is _not_ automatically safe for the customer-facing half —
it could re-answer an old message — so the replay tool requires an explicit
`--allow-outbound` flag (default off) and, without it, produces decisions in `SIMULATED` mode
for comparison rather than delivery.

## Options considered

| Option                                                  | Verdict                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Persist-first ledger with two-level dedupe (chosen)** | Only design where "acknowledged" implies "durably held and scheduled"                            |
| Process synchronously in the webhook handler            | Meta's timeout becomes our LLM timeout; a slow model means dropped webhooks. Rejected outright   |
| Dedupe only on the provider message id                  | Misses envelope-level redelivery; also fails when the provider omits an id                       |
| Dedupe in Redis with a TTL                              | The dedupe set is then not transactional with the ledger, and expiry silently reopens the window |
| Reject duplicates with 4xx                              | Providers may treat that as failure and retry harder; duplicates are normal, not exceptional     |

## Consequences

### Positive

- Every accepted event is recoverable and replayable from an immutable record.
- Duplicate webhooks are a non-event, proven by test.
- The ledger is the audit trail regulators and incident reviews actually need.

### Negative / accepted cost

- Storage grows with raw traffic. Mitigated by monthly partitioning and per-account retention
  policy; raw bodies may be redacted in place after the retention window while keeping the
  metadata row.
- Two-level dedupe means two unique indexes to maintain and reason about.
- Rejected-signature storage is an attack surface, mitigated as described above.

## Enforcement

- Unique constraints in `db/migrations/0001_init.sql`, not application `if` statements.
- `tests/integration/duplicate-webhook.test.ts` — identical delivery twice yields one ledger row,
  one job, one message, one reply.
- `tests/integration/redelivery.test.ts` — the same message inside a different envelope yields no
  second message.
- The module boundary test forbids `moderation/ingress` from importing any LLM port.

## Revisit trigger

- A channel is added whose webhooks carry no stable id and no reliable timestamp, making the
  derived key unsafe.
- Raw retention volume becomes the dominant storage cost, forcing a move to object storage for
  bodies with the metadata row kept in Postgres.
