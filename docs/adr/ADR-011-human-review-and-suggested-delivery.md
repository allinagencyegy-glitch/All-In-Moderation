# ADR-011: Human Review and Suggested Delivery

- Status: Accepted
- Date: 2026-08-29
- Deciders: Lead Systems Architect

## Context

The authority matrix (ADR-010) has three effects: `ALLOW`, `REQUIRE_APPROVAL`, `DENY`. Two of them
worked. `REQUIRE_APPROVAL` did not.

When the matrix returned `REQUIRE_APPROVAL`, `gateAction` refused to mint an `AuthorizedAction`,
and the moderator fell back to raising a human handoff. That is safe, and it discards the one
artefact the effect exists to produce: **the drafted reply**. An operator opening the queue saw
"the AI wants a human to look at this" and no draft. There was nothing to approve, nothing to
measure, and no evidence that could ever justify granting the account more autonomy.

The first real client is onboarding in exactly this posture. Every customer-visible action in its
pack is `REQUIRE_APPROVAL` — the account is not ready for autonomous replies and will not be for
some time. So the effect that did nothing is the only effect that account uses.

Three further forces shaped the design:

- **The audit's fifteenth finding was that nobody owned the inbox.** A question sat unanswered for
  five days. An approval by "the system" or by an anonymous session reproduces that in a new place.
- **There is no transport.** `src/` contains no outbound HTTP client, no Meta API host, and no
  dispatcher; `OUTBOUND_MODE=LIVE` is refused at boot. Whatever review produces, it cannot be a
  send, and it must not become one by accident later.
- **"The model proposed X, the human sent Y"** is the only dataset that can answer whether this
  account is ready for more autonomy. It only exists if both halves survive.

## Decision

**`REQUIRE_APPROVAL` produces a suppressed `SUGGESTED` draft carrying the reply and its evidence.
A named person then approves, edits, rejects or escalates it. Approval writes a state; it never
sends.**

### The gate

`gateAction` gains one new outcome path, and only one. When the matrix effect is
`REQUIRE_APPROVAL` and the caller requested `SUGGESTED` delivery, the gate mints an
`AuthorizedAction` whose `deliveryMode` is `SUGGESTED`. Every other check is unchanged and runs
first: forbidden actions, surface invariants, ownership, account status, and **grounding**. A
suggestion with no citation is refused exactly as an autonomous reply would be.

The moderator gates twice. It asks for `AUTONOMOUS` first; on `REQUIRES_APPROVAL` it re-gates the
same action as `SUGGESTED`. If that is also refused, it falls through to the handoff fallback as
before. Human review is a narrower outcome, not a bypass.

### The action

- `deliveryMode: 'SUGGESTED'`, `state: 'SUPPRESSED'`, `cancelledReason: 'AWAITING_HUMAN_APPROVAL'`.
  It is never queued for dispatch, and there is no dispatcher to queue it for.
- `payload.text` is the model's reply, unmodified and never rewritten.
- `payload.review` snapshots what a reviewer needs, at the moment the decision was made: intent
  and its confidence, overall confidence, risk, proposed action, policy reason, knowledge
  citations, pack version, prompt version, input watermark, and run id. Snapshotted rather than
  looked up later, because the pack can be republished and an entry can expire in between.

`SUGGESTED` is deliberately **not** collapsed into `SIMULATED`. They answer different questions:
simulation is about transport ("this system would have sent, but is not connected"), suggestion is
about authority ("this system deliberately did not try, because a person must decide"). Collapsing
them empties the review queue on every deployment this phase can legally run.

### The decision

A new state, `APPROVED_FOR_MANUAL_SEND`, terminal, reachable only from `SUPPRESSED`, and permitted
by a database CHECK only when `delivery_mode = 'SUGGESTED'`. It means: _a person may now send this
text themselves._ It is not `PENDING_DISPATCH`, and routing it there would be the single edit that
converts human review into autonomous delivery.

`outbound_action_reviews` is append-only — `app_runtime` holds SELECT and INSERT and nothing else,
the same posture `audit_events` has. Each row carries the decision, the **reviewer's user id
(NOT NULL)**, the reason, the original text, the edited text, and the time. A separate table rather
than columns on the action, because a draft can be reviewed more than once and the history is the
product.

The text a person is to send is **derived from the review log**, not stored a second time on the
action. `outbound:save` upserts state and delivery bookkeeping and deliberately never rewrites
`payload`; a mutable second copy of the reply is how the two drift.

### The workflow

CLI, not a UI: `review list | show | approve | edit | reject | escalate`. A UI implies a workflow,
and the workflow for this account is one person working a short queue during business hours. The
CLI is a thin shell over `moderation/application/review.ts`, so the eventual UI calls the same
service and cannot acquire a capability the command does not have.

- `EDITED` requires text; every other decision refuses it.
- `REJECTED` and `ESCALATED` require a reason. The knowledge backlog is built out of those
  sentences.
- `APPROVED` and `EDITED` are refused when a person has taken the conversation over — the draft is
  stale. `REJECTED` stays available, because clearing a stale draft is housekeeping.
- `ESCALATED` cancels the draft, raises a HIGH-urgency handoff, and moves ownership to
  `PENDING_HUMAN`.
- A takeover cancels pending drafts outright, with `cancelledReason: 'HUMAN_TOOK_OVER'`.

`show` re-validates every citation **now**, against the same predicate the Knowledge Gate uses.
An expired or unapproved citation is reported as unresolved rather than displayed as evidence:
approving a draft whose evidence has gone stale would put an out-of-date claim in front of a
customer over a human's signature, which is worse than the model having said it.

### Engagement

A conversation with a suggestion waiting stays `AWAITING_MODERATOR`, not `AWAITING_CUSTOMER`.
Reporting the latter would tell an operator the customer had been answered while the reply sits
unread in a queue — the exact misreading this client is being onboarded to fix.

## Options considered

| Option                                                           | Verdict                                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Suppressed SUGGESTED draft + append-only review log (chosen)** | Preserves the draft and both halves of the record; approval is structurally not a send                         |
| Keep the handoff-only behaviour                                  | The effect stays inert; no draft, no measurement, no path to autonomy                                          |
| Approve into `PENDING_DISPATCH`                                  | One edit away from autonomous delivery, and there is no dispatcher — it would silently accumulate a send queue |
| Review columns on `outbound_actions`                             | Keeps only the last opinion; the history is the product                                                        |
| Overwrite `payload.text` on edit                                 | Destroys "what did the model write", the only evidence that could justify more autonomy                        |
| Nullable reviewer, or a `SYSTEM` actor                           | Reproduces the audit's ownership finding inside the schema                                                     |
| Build the web UI now                                             | A workflow nobody has run yet; the queue shape is the open question, not the buttons                           |

## Consequences

### Positive

- `REQUIRE_APPROVAL` does what it says, and the drafted reply survives to be judged.
- Every accepted reply has a named person attached to it, before a customer ever sees it.
- The proposed/final pair accumulates from day one, which is the evidence the next phase needs.
- Approval cannot become delivery by configuration: the terminal state, the CHECK constraint and
  the absent dispatcher are three independent obstacles.

### Negative / accepted cost

- A person must work the queue, or drafts age exactly as unanswered messages did. The queue is
  ordered oldest-first and reports the wait in hours for that reason; it is a process risk that
  tooling can surface but not remove.
- The CLI is not a product surface. Onboarding a non-technical reviewer needs the UI.
- Approving does not send, which will surprise someone at least once. Every accepted decision
  prints the sentence saying so.

## Enforcement

- `tests/integration/suggested-delivery.test.ts` — the draft, its evidence bundle, the engagement
  label, re-gating from scratch, and `SUGGESTED` surviving a simulating deployment.
- `tests/integration/review-approval.test.ts` — the six commands, the audit entry, staleness, and
  zero dispatch on every path.
- `tests/integration/dental-hub-acceptance.test.ts` — the whole chain on the published client pack.
- `tests/postgres/review-queue.test.ts` — the CHECK constraints, the append-only grants, the RLS
  policy against a non-superuser, and the queue index.
- `db/migrations/0009_review.sql` — `outbound_actions_manual_send_is_suggested`,
  `outbound_action_reviews_edit_shape`, `outbound_action_reviews_reason_required`.
- `tests/architecture/no-outbound-meta.test.ts` — the dispatch handler is still absent from the
  worker's handler map.

## Revisit trigger

- The proposed/final corpus shows an intent class where the human changes nothing over a
  meaningful sample. That is the evidence for moving that class to `ALLOW` — and it requires an
  outbound transport, which does not exist and is a decision of its own.
- A reviewer works the queue often enough that the CLI is the bottleneck (then the UI, calling
  this same service).
- Drafts age past the escalation SLA often enough to need an automatic expiry.
