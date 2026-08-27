# ADR-008: Conversation State, Ownership and Human Handoff

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

The brief proposed candidate states and explicitly asked us not to adopt them blindly:

```text
AI_OWNED, WAITING_CUSTOMER, QUALIFYING, WAITING_HUMAN,
HUMAN_OWNED, WAITING_EXTERNAL_SYSTEM, CLOSED
```

Analysed as a single enum, this list is not a state machine — it conflates three independent
questions:

- `AI_OWNED` / `HUMAN_OWNED` answer **who may speak**.
- `WAITING_CUSTOMER` / `WAITING_HUMAN` / `WAITING_EXTERNAL_SYSTEM` answer **whose turn it is**.
- `QUALIFYING` answers **what the moderator is currently trying to achieve**.
- `CLOSED` answers **whether the conversation is active at all**.

Forcing them into one field creates impossible questions with no good answer: a conversation
owned by a human while waiting for the customer is both `HUMAN_OWNED` and `WAITING_CUSTOMER`; a
conversation in qualification that is also waiting on a CRM call is both `QUALIFYING` and
`WAITING_EXTERNAL_SYSTEM`. Systems that hit this either invent combinatorial states
(`HUMAN_OWNED_WAITING_CUSTOMER`) or start lying — and when the lie is about _who may speak_, the
customer receives two replies.

The critical requirement — "AI and a human must NOT unknowingly send competing replies" — depends
entirely on the ownership question. It therefore deserves its own field, its own transitions, and
its own version counter.

## Decision

**Decompose conversation state into three orthogonal axes plus one derived label.**

### Axis 1 — Lifecycle (is this conversation active?)

```text
OPEN ──────► SNOOZED ──────► OPEN
  │                            │
  └──────────► CLOSED ◄────────┘
                 │
                 └──► OPEN   (reopened by a new inbound message)
```

| State     | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `OPEN`    | Active; inbound messages are processed normally                         |
| `SNOOZED` | Intentionally dormant until `snoozed_until`; a durable timer reopens it |
| `CLOSED`  | Resolved. A new inbound message reopens it (never silently discarded)   |

### Axis 2 — Ownership (who may send outbound messages?)

**This is the safety-critical axis.**

```text
                 takeover(user)
    AI_OWNED ────────────────────────► HUMAN_OWNED
        ▲                                  │
        │      release(user, explicit)     │
        └──────────────────────────────────┘
        │                                  │
        │ request_handoff / policy         │ (no auto-return by default)
        ▼                                  │
  PENDING_HUMAN ──────accept(user)─────────┘
        │
        └── timeout / no acceptance ──► AI_OWNED (only if account policy allows fallback)
```

| State           | AI may send                              | Human may send              | Meaning                                          |
| --------------- | ---------------------------------------- | --------------------------- | ------------------------------------------------ |
| `AI_OWNED`      | yes (subject to policy)                  | yes (implicitly takes over) | Default                                          |
| `PENDING_HUMAN` | **no**                                   | yes (accepting = takeover)  | A handoff has been requested; the AI has stopped |
| `HUMAN_OWNED`   | **no** (shadow mode may still _propose_) | yes                         | A human is handling it                           |

Rules:

- `ownership_version` is a monotonically increasing integer bumped on **every** ownership change.
  Every moderator run records the version it observed and re-checks it before creating an
  outbound action (ADR-005 §4). A run that lost the race is recorded as `SUPERSEDED` and sends
  nothing. This is what makes takeover-during-generation safe.
- Any human message sent into an `AI_OWNED` conversation performs an **implicit takeover** before
  the send. An operator should never have to remember to click a button to prevent the AI from
  talking over them.
- Return of ownership to the AI is **explicit by default**. Automatic return after inactivity is
  an account policy, default off (open decision D7), because silently resuming autonomous replies
  in a conversation a human was handling is exactly the failure operators will not forgive.
- `PENDING_HUMAN` is not "waiting for a human to be free"; it is "the AI has already stopped".
  The AI stops the moment the handoff is _requested_, not when it is accepted — because the risk
  window is the gap between them.
- **Shadow mode** (account policy, default off): while `HUMAN_OWNED`, the moderator may still run
  and persist a decision with `delivery_mode = SUGGESTED`. Suggestions are surfaced to the
  operator; they can never become an `OutboundAction` without an explicit human accept, and the
  action gate rejects autonomous delivery on any non-`AI_OWNED` conversation regardless of what
  the decision proposed. Two independent checks, because this is I5.

### Axis 3 — Engagement (whose turn is it?)

Derived and cheap; used for SLA timers and operator queues, never for authority.

| State                | Set when                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| `AWAITING_MODERATOR` | Unprocessed inbound exists (`last_inbound_seq > last_processed_inbound_seq`) |
| `AWAITING_CUSTOMER`  | We sent the last message and expect a reply                                  |
| `AWAITING_EXTERNAL`  | Blocked on an external system (CRM, stock lookup) with a deadline            |
| `IDLE`               | Nothing pending                                                              |

SLA timers key off this axis: `AWAITING_MODERATOR` beyond the account's SLA raises an alert and
optionally auto-escalates; `AWAITING_EXTERNAL` beyond its deadline fails the dependency and
escalates rather than waiting forever.

### The moderator's objective (not a conversation state)

`QUALIFYING` is not a conversation state — it is what the _moderator_ is currently doing, and it
belongs to a `ConversationObjective` record: `{ kind, status, collected_fields, missing_fields }`
where kind is a per-account value from the Account Pack (for example an information-gathering
objective). Reasons this is separate:

- Multiple objectives can be live at once (qualifying _and_ handling a complaint).
- Objectives are account-configurable; conversation lifecycle is platform-invariant. Putting a
  configurable value into a core state machine is how client rules leak into the runtime.
- An objective can be abandoned or completed without changing who owns the conversation.

### Derived operator label

Operators and reports keep the vocabulary from the brief. It is a **pure function** of the axes,
computed for display, never stored as truth:

```text
CLOSED                      if lifecycle = CLOSED
SNOOZED                     if lifecycle = SNOOZED
WAITING_HUMAN               if ownership = PENDING_HUMAN
HUMAN_OWNED                 if ownership = HUMAN_OWNED
WAITING_EXTERNAL_SYSTEM     if engagement = AWAITING_EXTERNAL
QUALIFYING                  if an objective of kind QUALIFICATION is IN_PROGRESS
WAITING_CUSTOMER            if engagement = AWAITING_CUSTOMER
AI_OWNED                    otherwise
```

The vocabulary is preserved for humans; the ambiguity is not preserved for machines.

## Handoff as a first-class entity

A `Handoff` is not a flag on the conversation. It is a record with its own lifecycle
(`REQUESTED -> ASSIGNED -> ACCEPTED -> COMPLETED`, plus `EXPIRED` and `CANCELLED`), carrying the
reason, the triggering run, the target queue or user, timestamps for SLA measurement, and a
structured context summary. Reasons:

- "Why did the AI hand this over, and how long did it take a human to pick it up?" is a core
  operational metric, and it is unanswerable from a boolean.
- Handoff failure (nobody accepted) is itself an event that must escalate — `handoff.failed` is a
  published domain event.
- The same entity models CRM handoff (`LeadCandidate` delivery) and human handoff, which keeps
  one escalation story rather than two.

## Options considered

| Option                                                | Verdict                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Three orthogonal axes plus derived label (chosen)** | Every question has exactly one field; ownership is independently versionable                        |
| Single flat enum as proposed                          | Ambiguous combinations; forces either combinatorial explosion or lying about authority              |
| Ownership as a lock with a TTL                        | Auto-expiring human ownership is dangerous: the AI resumes mid-conversation without anyone deciding |
| Ownership implied by "last sender"                    | Fragile — an operator's internal note or a delivery receipt would flip authority                    |
| Actor-per-conversation holding state in memory        | Loses the audit trail and does not survive restarts                                                 |

## Consequences

### Positive

- The competing-reply failure is closed by construction and directly tested.
- Operator queues, SLA timers, and authority stop interfering with each other.
- Client-specific objectives can be added without touching the core state machine.

### Negative / accepted cost

- Three fields instead of one, plus a derived label function to maintain.
- Shadow mode costs LLM spend during human ownership; hence default off.
- Explicit release means conversations can sit in `HUMAN_OWNED` after an operator forgets. Made
  visible by a stale-ownership report rather than fixed by silent auto-return.

## Enforcement

- `assertCanSendAutonomously(conversation)` is the only path to constructing an `OutboundAction`
  with `delivery_mode = AUTONOMOUS`, and it requires `ownership = AI_OWNED`.
- The commit-time re-check of `ownership_version` (ADR-005) makes the takeover race safe.
- `tests/integration/human-takeover.test.ts` covers takeover before, during, and after generation.
- `tests/unit/conversation-state.test.ts` enumerates legal and illegal transitions on all axes.

## Revisit trigger

- Operators demand auto-return after inactivity (D7) — requires an explicit policy design and an
  audit story before it is enabled.
- A channel arrives where "who may speak" is not binary (for example, a shared team inbox with
  multiple concurrent human agents).
