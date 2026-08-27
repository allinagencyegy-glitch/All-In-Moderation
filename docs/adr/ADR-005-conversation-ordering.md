# ADR-005: Conversation Ordering, Serialisation and Burst Handling

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

The motivating scenario from the requirements:

> A customer sends "price?", "Fomos", "installment please" within seconds. The system must not
> produce three conflicting AI replies.

This is three distinct problems wearing one coat:

1. **Ordering** — messages must be interpreted in the order the customer meant them, even though
   webhooks can arrive out of order and retries can arrive late.
2. **Mutual exclusion** — two workers must never reason about the same conversation at once.
3. **Coalescing** — even with perfect exclusion, three sequential runs would produce three
   replies. Correctness requires _deciding once about the whole burst_.

A fourth, easily missed: **staleness**. A run that started before a new message arrived (or
before a human took over) must not deliver its now-obsolete conclusion.

## Decision

Four mechanisms, each solving exactly one of the above.

### 1. Ordering: two clocks, one sequence

Every message stores three time facts:

- `provider_ts` — the timestamp the channel claims. Semantic order; used to render the
  transcript for the model and for operators.
- `received_at` — when we observed it. Never null, never trusted to match `provider_ts`.
- `seq` — a strictly increasing per-conversation integer assigned **at insert time, under the
  conversation row lock**. This is the processing order and the basis of the watermark.

`seq` is allocated as `conversations.next_seq` incremented inside the same transaction that
inserts the message, with the conversation row locked (`SELECT ... FOR UPDATE`). It is dense,
gapless, and monotonic per conversation — which is what makes the watermark a safe high-water
mark rather than a guess.

Late arrivals (a message whose `provider_ts` is older than one already stored) still get the
next `seq`. Consequence: the _processing_ watermark never moves backwards, so nothing is skipped,
while the _rendered_ transcript is sorted by `(provider_ts, seq)` so the model sees the
customer's intended order. Ordering by `seq` alone would show a confusing transcript; ordering
by `provider_ts` alone would let a late arrival fall below the watermark and be silently ignored.
Both facts are needed; conflating them is the bug.

Normalisation itself is serialised per channel connection (`partition_key =
acct:{account}:conn:{connection}`), so events from one connection are turned into messages in
arrival order. Normalisation does no I/O beyond the database, so this is cheap. If a single
connection ever becomes a throughput bottleneck, the partition key shards to
`conn:{connection}:{hash(sender) % N}`, which preserves per-conversation ordering because a
conversation's sender hash is stable.

### 2. Mutual exclusion: partition exclusivity, not locks in application code

The job queue guarantees **at most one `RUNNING` job per `partition_key`** (ADR-004). Moderator
runs use `partition_key = acct:{account}:conv:{conversation}`. Therefore:

- Two workers cannot process the same conversation concurrently — the claim query will not hand
  the second job out.
- Different conversations run fully in parallel, including within the same account.
- No advisory locks are held across an LLM call. Exclusion is a property of _work admission_,
  not of a lock we must remember to release. A crashed worker's lease expires; it does not
  deadlock a conversation.

### 3. Coalescing: debounce with a starvation ceiling

Enqueueing a moderator run is idempotent per conversation:

```text
scheduleModeratorRun(conversation, now):
  key = "moderator.run:" + conversationId
  if a non-terminal job with this dedupe_key exists and is still READY:
      run_at = min(now + debounceMs, first_enqueued_at + maxDelayMs)   # never past the ceiling
      bump the existing job's run_at to that value (only ever forward, never past the ceiling)
  else:
      insert job with run_at = now + debounceMs, first_enqueued_at = now
```

- `debounceMs` (default 2500) lets a burst settle so one run sees all three messages.
- `maxDelayMs` (default 8000) is the anti-starvation ceiling: a customer who types continuously
  still gets an answer. Without it, a chatty customer could push `run_at` forward forever.
- The partial unique index `(partition_key, dedupe_key) WHERE state = 'READY'` makes double-enqueue
  impossible even under a race — the loser gets a conflict and bumps instead.
- That index covers `READY` only, **not** `RUNNING`, and the distinction matters: a running job has
  already captured its input watermark, so a message arriving mid-run must be able to queue a _new_
  job behind it. Including `RUNNING` in the index would silently drop that follow-up run — and
  partition exclusivity already prevents the queued job from starting early.
- Both values are per-account policy (`Account Pack -> routing.debounce`), because a comment
  thread and a WhatsApp chat have different natural pacing.

A run processes **all** messages above the watermark, not one message. That is what turns three
messages into one considered reply.

### 4. Staleness: an optimistic guard at the commit boundary

At run start, the run records the conversation state it observed:

```text
observed = { inputWatermark: conversation.lastInboundSeq,
             ownershipVersion: conversation.ownershipVersion }
```

After the LLM returns and the decision passes policy, the commit re-reads the conversation and
requires that both values are unchanged. If either moved — a new message arrived, or a human took
over — the run is recorded as `SUPERSEDED`, **no outbound action is created**, and a fresh run is
scheduled if there is unprocessed input.

This is the mechanism that makes "human takeover during AI generation" safe (ADR-008), and it is
the reason the watermark may only advance inside the same transaction that records the decision.

### Watermark rules

- `conversation.last_processed_inbound_seq` advances only in the transaction that records a
  terminal, non-superseded run outcome.
- It advances to the run's `inputWatermark`, never to "the newest message right now" — anything
  that arrived mid-run must be processed by the next run.
- It never moves backwards. A replay or re-run that finds the watermark already past its
  `inputWatermark` exits as a no-op, which is what makes job redelivery safe.

## Options considered

| Option                                               | Verdict                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Partition exclusivity in the queue (chosen)**      | One predicate solves ordering and exclusion; no lock is held across an LLM call                                                                    |
| Postgres advisory lock per conversation              | Works, but the lock is held across a slow LLM call, blocks a connection for its duration, and requires careful release on crash paths              |
| A single-threaded worker per conversation-hash shard | Ordering by construction, but a rebalance or restart breaks the guarantee, and a slow conversation blocks its whole shard                          |
| Optimistic concurrency alone (no exclusion)          | Two workers would both call the LLM; one wasted call every time, and the losing run must be detected reliably. Wasteful and harder to reason about |
| No debounce, one run per message                     | Produces the exact failure the requirement forbids                                                                                                 |
| Debounce without a ceiling                           | Starvation risk for a talkative customer                                                                                                           |

## Consequences

### Positive

- The three-message burst produces exactly one reply. This is directly tested.
- Cross-conversation throughput is unaffected by per-conversation serialisation.
- No distributed lock manager, and no lock held across a network call to a model provider.

### Negative / accepted cost

- Replies are delayed by up to `debounceMs` (up to `maxDelayMs` under continuous typing).
  Accepted, and arguably desirable — instant replies read as robotic.
- A superseded run wastes one LLM call. Accepted: correctness over cost, and it is bounded by
  how often takeover or mid-run arrivals actually happen. It is a metric, so we will know.

## Enforcement

- `tests/integration/burst-coalescing.test.ts` — three rapid messages produce exactly one run and
  one outbound action.
- `tests/integration/partition-exclusivity.test.ts` — concurrent workers never co-run a
  conversation, and different conversations do run in parallel.
- `tests/integration/staleness-guard.test.ts` — a message arriving mid-run supersedes the run and
  reschedules; the watermark does not advance.
- `tests/integration/human-takeover.test.ts` — takeover mid-generation produces no outbound.

## Revisit trigger

- Per-connection normalisation becomes a throughput bottleneck (shard the partition key).
- Product decides that public comments need near-instant replies, which would mean a
  surface-specific debounce of zero and a different coalescing story.
