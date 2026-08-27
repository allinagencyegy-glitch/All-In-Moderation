# State Machines

- Status: Phase 0
- Date: 2026-08-27

Every state machine here is **total**: every state is either terminal or has at least one defined
exit, every transition names its trigger and its guard, and no state can be reached except through
a listed transition. The executable form lives in `src/**/domain/*.ts`; illegal transitions throw
`InvalidTransitionError` rather than silently no-op, because a silent no-op is a silent failure.

A rule applied throughout: **there is no "stuck" state without a timer**. If a state can be
entered and its exit depends on something external, a durable timer (`run_at`) exists that forces
an exit. Absence of that timer is how systems hang quietly at 3am.

---

## 1. RawInboundEvent lifecycle

```text
                    ┌──────────────┐
   webhook accepted │              │ signature invalid
        ┌───────────►   RECEIVED   ├──────────────────► REJECTED  (terminal)
        │           │              │
        │           └──────┬───────┘
        │                  │ normalize job claimed
        │                  ▼
        │           ┌──────────────┐  nothing actionable
        │           │ NORMALIZING  ├────────────────────► IGNORED   (terminal)
        │           └──────┬───────┘  (echo, read receipt,
        │                  │           delivery notification)
        │      success     │
        │                  ▼
        │           ┌──────────────┐
        │           │  NORMALIZED  │ (terminal)
        │           └──────────────┘
        │
        │  lease expired / worker crash (reaper)
        └──────────────────┐
                           │
                    ┌──────┴───────┐  retries exhausted
                    │ NORMALIZING  ├────────────────────► DEAD_LETTERED (terminal, replayable)
                    └──────────────┘
```

| Transition                    | Trigger                                    | Guard                            | Side effects                                                  |
| ----------------------------- | ------------------------------------------ | -------------------------------- | ------------------------------------------------------------- |
| `→ RECEIVED`                  | Webhook accepted                           | Signature valid, size within cap | Insert ledger row **and** normalize job in one transaction    |
| `→ REJECTED`                  | Webhook accepted                           | Signature invalid                | Stored for forensics; never normalised; short retention       |
| `RECEIVED → NORMALIZING`      | Job claimed                                | State is `RECEIVED` (CAS)        | Lease taken                                                   |
| `NORMALIZING → NORMALIZED`    | Parse + persist succeeded                  | —                                | `produced_message_ids` recorded; moderator runs scheduled     |
| `NORMALIZING → IGNORED`       | Envelope has nothing actionable            | —                                | Counter only. Not a failure                                   |
| `NORMALIZING → RECEIVED`      | Lease expired (reaper)                     | `attempt < max_attempts`         | Redelivery; safe because normalisation is idempotent          |
| `NORMALIZING → DEAD_LETTERED` | Retries exhausted, or terminal parse error | —                                | `DeadLetter` row, `moderation.degraded` event, operator alert |

Notes:

- `REJECTED` and `IGNORED` are **terminal and normal**. Conflating either with failure trains
  operators to ignore alerts.
- `DEAD_LETTERED` is terminal but **replayable**: the payload is immutable, so a fixed parser can
  re-run the event. This is the recovery path for "we shipped a parser bug".
- There is no `PROCESSING` state that can be entered twice: the `RECEIVED → NORMALIZING` step is a
  compare-and-set.

---

## 2. Conversation lifecycle — three orthogonal axes (ADR-008)

### Axis 1 — Lifecycle

```text
      inbound message
   ────────────────────► OPEN ◄──────────────┐
                          │ │                │
        operator snooze   │ │  resolve       │ inbound message
                          ▼ ▼                │ (reopen)
                    SNOOZED   CLOSED ────────┘
                          │
                          └── snoozed_until timer ──► OPEN
```

| Transition       | Trigger                         | Guard                                  | Side effects                                           |
| ---------------- | ------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| `→ OPEN`         | First inbound message           | —                                      | `conversation.started` event                           |
| `OPEN → SNOOZED` | Operator, or policy             | `snoozed_until` in the future          | Durable timer job scheduled                            |
| `SNOOZED → OPEN` | Timer fires, or inbound message | —                                      | Engagement recomputed                                  |
| `OPEN → CLOSED`  | Operator, or auto-close policy  | No pending inbound above the watermark | `closed_at` set                                        |
| `CLOSED → OPEN`  | Inbound message                 | —                                      | Always. A closed conversation never discards a message |

`CLOSED` is **not** terminal by design. A customer replying to a "resolved" conversation is the
most ordinary event in messaging; treating it as terminal would drop that message.

### Axis 2 — Ownership (safety critical)

```text
                    request_handoff(reason)
      ┌────────────────────────────────────────────┐
      │                                            ▼
  AI_OWNED ◄─── release(user, explicit) ─── PENDING_HUMAN
      │  ▲                                         │
      │  │                                         │ accept(user)
      │  │           takeover(user)                ▼
      └──┼─────────────────────────────────► HUMAN_OWNED
         │                                         │
         │  policy_fallback (opt-in, per account)  │
         └─────────────────────────────────────────┘
                (PENDING_HUMAN only, on timeout)
```

| Transition                    | Trigger                                                  | Guard                                  | Side effects                                                                                        |
| ----------------------------- | -------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `AI_OWNED → PENDING_HUMAN`    | Decision requests handoff, or policy escalation          | —                                      | `ownership_version++`; `Handoff(REQUESTED)`; **AI stops immediately**; SLA timer scheduled          |
| `AI_OWNED → HUMAN_OWNED`      | Operator takeover, **or an operator sends any message**  | Operator has an active membership      | `ownership_version++`; in-flight run will supersede; pending outbound cancelled (`HUMAN_TOOK_OVER`) |
| `PENDING_HUMAN → HUMAN_OWNED` | Operator accepts the handoff                             | Handoff still open                     | `ownership_version++`; `Handoff(ACCEPTED)`                                                          |
| `PENDING_HUMAN → AI_OWNED`    | SLA timer expires **and** account policy allows fallback | `policy.handoff_fallback_to_ai = true` | `ownership_version++`; `sales.handoff_failed` / `handoff.failed` event; audit entry                 |
| `HUMAN_OWNED → AI_OWNED`      | Explicit release by the operator                         | —                                      | `ownership_version++`; audit entry with actor                                                       |

Rules that make I5 hold:

- Every transition bumps `ownership_version`. Every run records the version it observed and
  re-checks it inside the commit; a mismatch means `SUPERSEDED` and no send.
- The AI stops at `PENDING_HUMAN`, not at `HUMAN_OWNED` — the dangerous window is the gap between
  requesting and accepting a handoff.
- Autonomous send requires `ownership = AI_OWNED`, checked twice: at run admission and inside the
  action gate.
- **No automatic `HUMAN_OWNED → AI_OWNED`.** The only automatic return is out of `PENDING_HUMAN`,
  it is opt-in per account, and it is loudly audited.

### Axis 3 — Engagement (derived; SLA only, never authority)

```text
  new inbound above watermark ─────────► AWAITING_MODERATOR
  outbound delivered ──────────────────► AWAITING_CUSTOMER
  external dependency requested ───────► AWAITING_EXTERNAL ──(deadline)──► AWAITING_MODERATOR
  nothing pending ─────────────────────► IDLE
```

`AWAITING_EXTERNAL` always carries a deadline. On expiry the dependency is marked failed and the
conversation returns to `AWAITING_MODERATOR` with the failure as an input — it never waits forever.

---

## 3. ModeratorRun lifecycle

```text
   scheduled
      │
      ▼
   PENDING ──claim──► RUNNING ──┬── decision allowed ──────────► COMPLETED   (terminal)
      │                         │
      │                         ├── nothing to do / not owned ─► SKIPPED     (terminal)
      │                         │
      │                         ├── state moved under us ──────► SUPERSEDED  (terminal)
      │                         │                                 └─ reschedule if input pending
      │                         │
      │                         └── error ─────────────────────► FAILED
      │                                                            │
      │                            attempt < max ─── retry ────────┘
      │                                                            │
      └────────────────────────── attempts exhausted ──────► DEAD_LETTERED (terminal)
                                                                   └─ raise Handoff(REQUESTED)
```

| Transition               | Trigger                                                             | Guard                                                      | Side effects                                                                                       |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `→ PENDING`              | Inbound message, timer, operator, replay                            | Coalesced per conversation (ADR-005)                       | Job enqueued with debounce                                                                         |
| `PENDING → RUNNING`      | Job claimed                                                         | Partition exclusive; ownership `AI_OWNED` (or shadow mode) | Records `input_watermark`, `observed_ownership_version`, `pack_version_id`                         |
| `RUNNING → SKIPPED`      | No unprocessed input, or not AI-owned, or account suspended         | —                                                          | `skip_reason` recorded. **Never silent**                                                           |
| `RUNNING → COMPLETED`    | Decision validated, policy allowed, guard held                      | `ownership_version` and `last_inbound_seq` unchanged       | Decision + `OutboundAction` persisted; watermark advanced; events emitted — all in one transaction |
| `RUNNING → SUPERSEDED`   | Guard failed at commit                                              | —                                                          | **No outbound.** Watermark not advanced. Fresh run scheduled if input pending                      |
| `RUNNING → FAILED`       | Provider timeout, malformed output after repair, transient DB error | Retryable class                                            | Job retried with backoff and jitter                                                                |
| `FAILED → RUNNING`       | Retry claimed                                                       | `attempt < max_attempts`                                   | —                                                                                                  |
| `FAILED → DEAD_LETTERED` | Attempts exhausted, or terminal error                               | —                                                          | `DeadLetter`; `Handoff(REQUESTED, reason=AI_UNAVAILABLE)`; `moderation.degraded` event             |

The last row is the most important line in this document: **when the AI cannot work, a human is
asked to.** The customer is never abandoned to a retry loop that quietly ends.

`SKIPPED` and `SUPERSEDED` are separate states on purpose. "I had nothing to do" and "I did work
that was invalidated" have different operational meanings; a spike in `SUPERSEDED` means the
debounce window is mistuned, while a spike in `SKIPPED` means something upstream is over-scheduling.

---

## 4. Handoff lifecycle

```text
   REQUESTED ──assign──► ASSIGNED ──accept──► ACCEPTED ──complete──► COMPLETED (terminal)
       │                     │                    │
       │                     │ reassign           │ operator releases
       │                     ▼                    ▼
       │                 ASSIGNED             (conversation → AI_OWNED,
       │                                       handoff COMPLETED)
       │
       ├── sla_due_at passes with no acceptance ──► EXPIRED (terminal)
       │        └─ emits sales.handoff_failed / handoff.failed; escalates per policy
       │
       ├── customer resolved it themselves / operator dismissed ──► CANCELLED (terminal)
       │
       └── target system permanently unavailable (CRM/vendor) ────► FAILED (terminal)
                └─ emits handoff.failed; raises a HUMAN_AGENT handoff as the fallback
```

| Transition                     | Trigger                                    | Guard                          | Side effects                                                          |
| ------------------------------ | ------------------------------------------ | ------------------------------ | --------------------------------------------------------------------- |
| `→ REQUESTED`                  | Decision, policy, or run dead-lettering    | —                              | Conversation ownership → `PENDING_HUMAN`; SLA timer scheduled         |
| `REQUESTED → ASSIGNED`         | Routing picks a queue/user                 | Target exists and is available | Notification dispatched                                               |
| `ASSIGNED → ACCEPTED`          | Operator accepts                           | Handoff still open             | Ownership → `HUMAN_OWNED`                                             |
| `ACCEPTED → COMPLETED`         | Operator completes or releases             | —                              | Ownership per operator choice (`AI_OWNED` on release)                 |
| `REQUESTED/ASSIGNED → EXPIRED` | SLA timer                                  | Not accepted                   | `handoff.failed`; escalate per policy; optional AI fallback (opt-in)  |
| `any open → CANCELLED`         | Operator dismissal, or conversation closed | —                              | Ownership resolved explicitly, never left dangling                    |
| `any open → FAILED`            | External target permanently unavailable    | —                              | `handoff.failed`; **a HUMAN_AGENT handoff is always the last resort** |

An escalation chain always terminates at a human, never at a system that might be down.

---

## 5. External integration delivery lifecycle

Applies to every outward crossing — domain events to All In, lead delivery to CRM, and (from
Phase 2) outbound messages to Meta.

```text
   PENDING ──claim──► IN_FLIGHT ──2xx / ack──► DELIVERED (terminal)
      ▲                   │
      │                   ├── 4xx (rejected) ───► FAILED_PERMANENT (terminal, alerts)
      │                   │
      │                   ├── 5xx / timeout ────► RETRY_SCHEDULED
      │                   │                            │
      │                   │      attempts remain       │
      │                   └────────────────────────────┘
      │                                                │
      └───────────── backoff elapsed ──────────────────┘
                                                       │ attempts exhausted
                                                       ▼
                                               DEAD_LETTERED (terminal, replayable)
```

| Transition                     | Trigger                             | Guard                                                            | Side effects                                                       |
| ------------------------------ | ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `→ PENDING`                    | Outbox relay matched a subscription | Subscription active; `event.accountId === destination.accountId` | Delivery row created                                               |
| `PENDING → IN_FLIGHT`          | Delivery job claimed                | Circuit closed for this destination                              | Attempt counter incremented; idempotency key sent                  |
| `IN_FLIGHT → DELIVERED`        | 2xx                                 | —                                                                | Response code and duration recorded                                |
| `IN_FLIGHT → FAILED_PERMANENT` | 4xx (except 408/429)                | —                                                                | No retry. Alert: a permanent 4xx is a contract bug, not a blip     |
| `IN_FLIGHT → RETRY_SCHEDULED`  | 5xx, 429, timeout, connection error | `attempt < max_attempts`                                         | Backoff with full jitter; circuit breaker counter incremented      |
| `IN_FLIGHT → DEAD_LETTERED`    | Attempts exhausted                  | —                                                                | `DeadLetter`; `handoff.failed` for lead deliveries; operator alert |

**Ambiguous timeout** deserves its own note. A timeout means "unknown", not "failed". Retrying a
send that actually succeeded would message a customer twice. Rules:

- Every attempt carries a stable `idempotency_key`; providers that honour it make retries safe.
- Where a provider does not honour idempotency keys (Meta send today), the transport must
  **reconcile before resending**: read recent thread state, and if our message is present, mark
  `DELIVERED` instead of retrying.
- If reconciliation is impossible, the action goes to `PENDING_RECONCILIATION` for operator
  decision rather than being blind-retried. For customer-facing messages, we prefer a missing
  message a human notices over a duplicate message the customer sees.

Circuit breaker: `N` consecutive failures per destination opens the circuit; new deliveries fail
fast into `RETRY_SCHEDULED` without consuming attempts, and a half-open probe closes it. This is
what turns "provider down" into "degraded and visible" rather than "queue of timeouts".
