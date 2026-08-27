# Failure Mode Register

- Status: Phase 0
- Date: 2026-08-27

Every entry answers six questions:

| Field                   | Question                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| **Detection**           | How do we _know_? A failure we cannot detect is a silent failure by definition.                  |
| **Durable state**       | What is on disk at the moment of failure? What survives the crash?                               |
| **Retry**               | What is retried, how often, and when does it stop? Unbounded retry is a failure mode, not a fix. |
| **Customer impact**     | What does the person on the other end experience?                                                |
| **Operator visibility** | What does a human see, where, and how urgently?                                                  |
| **Recovery**            | How do we get back to correct, and who does it?                                                  |

Legend for the `Covered` column: **T** = covered by an automated test in this repository,
**D** = designed and specified but not yet implemented, **P** = planned for a later phase.

---

## F-01 · Duplicate Meta webhook delivery — **T**

|                         |                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Unique violation on `(channel_connection_id, delivery_key)` at insert; counted as `ingest.duplicate`.                                                                                                                                                           |
| **Durable state**       | The original ledger row and its normalize job. The duplicate creates nothing.                                                                                                                                                                                   |
| **Retry**               | None needed. The duplicate returns 200 so the provider stops retrying.                                                                                                                                                                                          |
| **Customer impact**     | None. Exactly one reply.                                                                                                                                                                                                                                        |
| **Operator visibility** | Metric only. **Deliberately not an alert** — duplicates are normal provider behaviour, and alerting on normal behaviour trains operators to ignore alerts. A _sustained_ duplicate rate above baseline is a dashboard signal that our ack path may be too slow. |
| **Recovery**            | Not required.                                                                                                                                                                                                                                                   |

## F-02 · Same message inside a different envelope (re-batched redelivery) — **T**

|                         |                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Delivery-level dedupe misses (different body ⇒ different hash), so item-level unique `(account_id, channel, provider_message_id)` catches it. |
| **Durable state**       | Second ledger row exists (legitimately — it is a different delivery); no second message row.                                                  |
| **Retry**               | None.                                                                                                                                         |
| **Customer impact**     | None. The moderator sees one message.                                                                                                         |
| **Operator visibility** | Metric `normalize.item_duplicate`.                                                                                                            |
| **Recovery**            | Not required. This is exactly why deduplication is two-level (ADR-006).                                                                       |

## F-03 · Out-of-order message arrival — **T**

|                         |                                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | `provider_ts` of a new message is older than the newest stored message. Counted, not rejected.                                                                                                                               |
| **Durable state**       | The message is stored with the next `seq` regardless, so it is above the watermark and _will_ be processed.                                                                                                                  |
| **Retry**               | Not applicable.                                                                                                                                                                                                              |
| **Customer impact**     | The reply accounts for the message. The transcript given to the model is ordered by `(provider_ts, seq)`, so the customer's intended order is preserved.                                                                     |
| **Operator visibility** | Metric `normalize.out_of_order`; a spike suggests provider-side or connection issues.                                                                                                                                        |
| **Recovery**            | None needed. The dual-clock design (ADR-005) makes this ordinary rather than exceptional. Ordering by `provider_ts` alone would have let a late message fall below the watermark and vanish — that is the bug this prevents. |

## F-04 · Message burst (three messages in seconds) — **T**

|                         |                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Multiple `scheduleModeratorRun` calls collapse onto one `dedupe_key`; counted as `run.coalesced`.                    |
| **Durable state**       | Three message rows, **one** `READY` job whose `run_at` was bumped within the `first_enqueued_at + maxDelay` ceiling. |
| **Retry**               | Not applicable.                                                                                                      |
| **Customer impact**     | One considered reply that addresses all three messages, after a short, human-like pause.                             |
| **Operator visibility** | Metric; the coalescing ratio informs debounce tuning per account.                                                    |
| **Recovery**            | Not required. Anti-starvation ceiling guarantees a continuously typing customer still gets an answer.                |

## F-05 · LLM timeout — **T**

|                         |                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | `AbortSignal` fires at the per-call deadline, which is derived from the job lease so a call can never outlive its lease.                                                                                             |
| **Durable state**       | `ModeratorRun` in `FAILED` with the timeout recorded; the job is `READY` again with backoff. No partial decision, no outbound.                                                                                       |
| **Retry**               | Exponential backoff with full jitter, bounded by `max_attempts` **and** a total time budget. The circuit breaker per `(provider, role)` opens after repeated failures so we fail fast rather than queueing timeouts. |
| **Customer impact**     | Delayed reply. On exhaustion, a human is asked to take over — the customer is never left with silence and no owner.                                                                                                  |
| **Operator visibility** | `moderation.degraded` event, LLM latency/error dashboards, and a `Handoff(REQUESTED, AI_UNAVAILABLE)` in the operator queue.                                                                                         |
| **Recovery**            | Automatic once the provider recovers (circuit half-opens). Dead-lettered runs are replayable.                                                                                                                        |

## F-06 · LLM malformed / schema-invalid response — **T**

|                         |                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Our own schema validation. Vendor structured-output guarantees are treated as an optimisation, never as a contract (ADR-007).                                                                           |
| **Durable state**       | Raw response stored on the run for audit; no decision, no outbound.                                                                                                                                     |
| **Retry**               | **One** repair attempt with the validation errors fed back at lower temperature; then the normal job retry path; then dead-letter plus handoff. We never coerce partially valid output into a decision. |
| **Customer impact**     | Slight delay; on exhaustion, a human takes over. Never a malformed or partial reply.                                                                                                                    |
| **Operator visibility** | Metric `llm.schema_invalid` broken down by model and prompt version — a spike after a model or prompt change is the signal to roll back.                                                                |
| **Recovery**            | Roll back the prompt template or pin the previous model; both are configuration, not deploys.                                                                                                           |

## F-07 · LLM hallucinated knowledge citation or fabricated price — **T**

|                         |                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Citation containment: every `knowledge_ref` must be in the candidate set given to that run. Cited price and offer entries are re-validated for approval status and validity window _after_ the decision. |
| **Durable state**       | Decision stored with `policy_outcome = DENIED` or `DOWNGRADED` and the reason. The proposal is preserved — "what the model wanted" is auditable.                                                         |
| **Retry**               | None. The action is downgraded to clarification or escalation rather than retried; retrying a hallucination usually produces another one.                                                                |
| **Customer impact**     | Receives a clarifying question or a human, never an invented price.                                                                                                                                      |
| **Operator visibility** | `policy.denied` metric by reason; a rising rate is a prompt or knowledge-coverage problem.                                                                                                               |
| **Recovery**            | Add the missing knowledge (the gap is recorded automatically) or fix the prompt.                                                                                                                         |

## F-08 · Expired or unapproved knowledge — **T**

|                         |                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | The Knowledge Gate filters on `status`, `valid_from`, `valid_until` **before** prompt assembly, and re-checks cited entries after the decision to catch a price expiring mid-run. |
| **Durable state**       | A `KnowledgeGap` row when nothing valid matched.                                                                                                                                  |
| **Retry**               | Not applicable — this is a content state, not a transient error.                                                                                                                  |
| **Customer impact**     | Gets a clarification or a human. **Never an expired price presented as current.**                                                                                                 |
| **Operator visibility** | `faq.unanswered` domain event and a knowledge-gap backlog per account. A near-expiry report (entries expiring within N days) is the proactive version.                            |
| **Recovery**            | The client approves updated content; no deploy involved.                                                                                                                          |

## F-09 · Meta send failure (Phase 2 transport; designed now) — **D**

|                         |                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Non-2xx or timeout from the send transport; per-connection error-rate monitor.                                                                                                                                                                                                                                                                       |
| **Durable state**       | `OutboundAction` in `FAILED` with `attempt` and `last_error`. The decision and the conversation state are already committed, so nothing is lost.                                                                                                                                                                                                     |
| **Retry**               | Backoff with jitter, bounded. **Ambiguous timeouts are reconciled, not blind-retried**: read recent thread state and mark `DELIVERED` if our message is already there; if reconciliation is impossible the action moves to `PENDING_RECONCILIATION` for an operator. We prefer a missing message a human notices over a duplicate the customer sees. |
| **Customer impact**     | Delayed or (in the reconciliation case) no automated reply — with a human explicitly asked to intervene.                                                                                                                                                                                                                                             |
| **Operator visibility** | Failed-outbound queue, per-connection error rate, `moderation.degraded`.                                                                                                                                                                                                                                                                             |
| **Recovery**            | Operator retries or replies manually; token/permission problems surface as `ChannelConnection.status = DEGRADED`.                                                                                                                                                                                                                                    |

## F-10 · Database unavailable — **D**

|                         |                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Connection pool errors; health check fails; readiness probe fails.                                                                       |
| **Durable state**       | Whatever committed before the outage. Nothing is held only in memory: this is why ingest cannot acknowledge before commit.               |
| **Retry**               | Webhook ingress returns **5xx so the provider retries** — we never acknowledge what we cannot store. Workers back off and stop claiming. |
| **Customer impact**     | Replies pause. Once the database returns, the provider's retries deliver the events we refused, so the backlog drains without loss.      |
| **Operator visibility** | Hard alert (page). This is the one dependency with no graceful degradation.                                                              |
| **Recovery**            | Restore the database; workers resume; expired leases are reaped and jobs redelivered. Idempotent handlers make redelivery safe.          |

## F-11 · Worker crash mid-run — **T**

|                         |                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | `lease_expires_at` passes with the job still `RUNNING`; the reaper finds it.                                                                                                                |
| **Durable state**       | Whatever committed before the crash. A moderator run commits **atomically** — decision, outbound action, and watermark move together, or none of them do. There is no half-applied outcome. |
| **Retry**               | The reaper returns the job to `READY`; the retry re-reads state and, if the previous attempt actually committed, exits as a no-op because the watermark has already advanced.               |
| **Customer impact**     | Reply delayed by up to the lease duration. Never duplicated.                                                                                                                                |
| **Operator visibility** | Metric `job.lease_reclaimed`; a spike indicates instability or an under-sized lease.                                                                                                        |
| **Recovery**            | Automatic.                                                                                                                                                                                  |

## F-12 · Two workers claim the same conversation — **T**

|                         |                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Detection**           | Structurally prevented: the claim query's partition-exclusivity predicate plus `FOR UPDATE SKIP LOCKED` means the second worker never receives the job. Belt and braces, the optimistic guard would catch a hypothetical escape at commit. |
| **Durable state**       | One `RUNNING` job for the partition.                                                                                                                                                                                                       |
| **Retry**               | The second worker simply claims different work — no spin, no wasted LLM call.                                                                                                                                                              |
| **Customer impact**     | None.                                                                                                                                                                                                                                      |
| **Operator visibility** | None required.                                                                                                                                                                                                                             |
| **Recovery**            | Not applicable. Tested directly, because "structurally prevented" is a claim that deserves a test.                                                                                                                                         |

## F-13 · Human takeover during AI generation — **T**

|                         |                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | The commit-time re-check finds `ownership_version` has moved.                                                                                       |
| **Durable state**       | Run recorded as `SUPERSEDED`; **no** `OutboundAction`; watermark **not** advanced; the ownership transition is in the audit log.                    |
| **Retry**               | None — the AI must not retry into a conversation a human now owns. Any already-pending outbound is cancelled with `HUMAN_TOOK_OVER`.                |
| **Customer impact**     | Sees only the human's reply. This is the failure the platform most exists to prevent.                                                               |
| **Operator visibility** | `run.superseded` metric; the operator sees the conversation as theirs immediately.                                                                  |
| **Recovery**            | Not applicable. If the human later releases ownership, the unprocessed messages are still above the watermark, so the AI resumes with full context. |

## F-14 · Operator sends a message without formally taking over — **T**

|                         |                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Not applicable — an operator send performs an **implicit takeover** first.                                    |
| **Durable state**       | Ownership transition recorded with the operator as actor before the message is appended.                      |
| **Retry**               | Not applicable.                                                                                               |
| **Customer impact**     | None; the AI stops immediately.                                                                               |
| **Operator visibility** | The conversation shows as human-owned.                                                                        |
| **Recovery**            | Not applicable. An operator should never have to remember to click a button to stop the AI talking over them. |

## F-15 · CRM outage — **T**

|                         |                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Delivery attempts fail; the circuit breaker for the destination opens.                                                                                           |
| **Durable state**       | `LeadCandidate` persisted locally with `status = QUALIFIED`; `lead.qualified` event durable in the outbox; delivery rows carry their own retry state.            |
| **Retry**               | Backoff with jitter over hours; on exhaustion `handoff.failed` plus a human handoff, so a qualified lead is never lost.                                          |
| **Customer impact**     | **None.** The conversation continues normally — this is the whole point of CRM being an adapter.                                                                 |
| **Operator visibility** | Undelivered-lead queue and `moderation.degraded`.                                                                                                                |
| **Recovery**            | Automatic drain when the CRM returns; manual replay from the outbox otherwise. No customer context is lost, because moderation already owns everything it needs. |

## F-16 · All In / downstream consumer outage — **T**

|                         |                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Detection**           | Delivery failures per subscription; independent circuit breaker.                                            |
| **Durable state**       | Events remain in the outbox with per-subscription delivery rows, so one slow consumer never blocks another. |
| **Retry**               | Backoff, bounded, then dead-letter.                                                                         |
| **Customer impact**     | None.                                                                                                       |
| **Operator visibility** | Per-subscription delivery lag dashboard.                                                                    |
| **Recovery**            | Automatic on recovery; dead-lettered events are replayable by `event_id`, and consumers deduplicate on it.  |

## F-17 · Invalid client configuration (bad Account Pack) — **T**

|                         |                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Schema validation plus cross-section validation at publish time (every routed intent exists, every matrix action is a known type, every priced product exists). |
| **Durable state**       | The invalid version stays `DRAFT`/`IN_REVIEW`. **The previously `ACTIVE` version keeps serving traffic.**                                                       |
| **Retry**               | Not applicable.                                                                                                                                                 |
| **Customer impact**     | None — a bad configuration cannot reach the runtime.                                                                                                            |
| **Operator visibility** | Publish fails with per-section errors in the editor.                                                                                                            |
| **Recovery**            | Fix and re-publish; rollback is publishing a prior version's content as a new version, so history is never rewritten.                                           |

## F-18 · Account has no active pack, or the account is suspended — **T**

|                         |                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Pack resolution returns nothing, or the account status is not `ACTIVE`.                                                                                    |
| **Durable state**       | Events and messages **still persist** — a suspended or misconfigured account must never lose customer messages. The run records `SKIPPED` with the reason. |
| **Retry**               | None; this is a state, not an error.                                                                                                                       |
| **Customer impact**     | No automated reply. Escalation policy decides whether a human is notified.                                                                                 |
| **Operator visibility** | Explicit `run.skipped` with reason. Never a silent nothing.                                                                                                |
| **Recovery**            | Publish a pack or reactivate the account; unprocessed messages are still above the watermark and are answered on the next run.                             |

## F-19 · Cross-tenant data exposure — **T**

|                         |                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | Three independent layers must fail: the compile-time `AccountScope` argument, composite foreign keys, and Postgres RLS. Contract tests assert cross-account reads return nothing. |
| **Durable state**       | Not applicable.                                                                                                                                                                   |
| **Retry**               | Not applicable.                                                                                                                                                                   |
| **Customer impact**     | Catastrophic if it ever occurred — hence three layers.                                                                                                                            |
| **Operator visibility** | Any cross-account access attempt is an audit event and a hard alert.                                                                                                              |
| **Recovery**            | Incident process, client notification. **Prevention is the strategy; there is no good recovery.**                                                                                 |

## F-20 · Unbounded retry / poison-pill job — **T**

|                         |                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | `attempt >= max_attempts`, enforced in the claim path so it cannot be bypassed.                                      |
| **Durable state**       | `DeadLetter` row with the full error chain and enough context to replay.                                             |
| **Retry**               | Stops. Definitively.                                                                                                 |
| **Customer impact**     | Depends on the job type; for `moderator.run` a human handoff is raised automatically.                                |
| **Operator visibility** | Dead-letter queue with counts by type; a non-zero count is an alert.                                                 |
| **Recovery**            | Fix the cause, replay from the dead-letter (the raw event is immutable, so a fixed parser can re-derive everything). |

## F-21 · Debounce starvation (continuously typing customer) — **T**

|                         |                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Detection**           | `first_enqueued_at + maxDelayMs` ceiling is reached; the run fires regardless of continued typing.               |
| **Durable state**       | Job with `run_at` capped at the ceiling.                                                                         |
| **Retry**               | Not applicable.                                                                                                  |
| **Customer impact**     | Reply arrives within the ceiling rather than never.                                                              |
| **Operator visibility** | Metric `run.ceiling_fired`.                                                                                      |
| **Recovery**            | Not required. This is the failure mode a naive debounce introduces; the ceiling exists specifically to close it. |

## F-22 · Clock skew between provider and platform — **D**

|                         |                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Detection**           | `provider_ts` far from `received_at` beyond a threshold.                                                                             |
| **Durable state**       | Both timestamps, always.                                                                                                             |
| **Retry**               | Not applicable.                                                                                                                      |
| **Customer impact**     | None: processing order uses `seq`, which is ours, so skew cannot skip or reorder work. Only transcript rendering uses `provider_ts`. |
| **Operator visibility** | Metric `ingest.clock_skew`.                                                                                                          |
| **Recovery**            | Not required — the design never trusts a third party's clock for correctness.                                                        |

## F-23 · Sensitive information requested on a public surface — **D**

|                         |                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**           | The action gate is surface-aware: a public reply requesting personal data is denied by the authority matrix, independent of what the model proposed. |
| **Durable state**       | Decision recorded with `policy_outcome = DENIED`.                                                                                                    |
| **Retry**               | Not applicable — the action is replaced by "move to DM" or escalation.                                                                               |
| **Customer impact**     | Asked to continue privately.                                                                                                                         |
| **Operator visibility** | `policy.denied` with the reason.                                                                                                                     |
| **Recovery**            | Not required. Enforced in code, not in the prompt.                                                                                                   |

## F-24 · Destructive public moderation action (hide/delete) attempted — **T**

|                         |                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Detection**           | `PHASE0_FORBIDDEN_ACTIONS` is a compile-time set checked by the gate **before** account configuration is consulted, so no client configuration can enable it.                              |
| **Durable state**       | The attempt is recorded as a denied decision.                                                                                                                                              |
| **Retry**               | None.                                                                                                                                                                                      |
| **Customer impact**     | None; nothing is hidden or deleted.                                                                                                                                                        |
| **Operator visibility** | Audit event — an attempt indicates a prompt or configuration problem worth investigating.                                                                                                  |
| **Recovery**            | Not applicable in Phase 0. When these actions are eventually enabled they will require: an explicit account grant, a distinct high-risk permission, human approval, and a reversal window. |

## F-25 · Attachment/media handling (Phase 3; boundary only) — **P**

|                         |                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Detection**           | Unsupported content types are recorded as `content_type = UNSUPPORTED`, not dropped.                               |
| **Durable state**       | The message row and its attachment metadata exist; provider URLs expire, so re-hosting is required before they do. |
| **Retry**               | Not applicable in Phase 0.                                                                                         |
| **Customer impact**     | The moderator sees "customer sent an image" and can escalate rather than answering as if the message were empty.   |
| **Operator visibility** | Metric by content type — the input for prioritising multimodal work.                                               |
| **Recovery**            | Human handles it until the modality is implemented.                                                                |

---

## Cross-cutting rules

1. **Never acknowledge what is not durable.** Ingest returns 5xx rather than 200 if the commit
   fails. A provider retry is cheap; a lost customer message is not.
2. **Every retry is bounded, and every exhaustion is visible.** No path ends in silence.
3. **Every escalation chain terminates at a human**, never at a system that might be down.
4. **Ambiguity is not success.** A timeout is "unknown", and unknown outbound is reconciled, never
   blind-retried.
5. **Normal-but-noteworthy events are metrics, not alerts.** Duplicates, skips, and ignored
   envelopes are counted. Alert fatigue is itself a failure mode.
6. **Degradation is explicit.** Every "we could not do the AI thing" produces a state, an event,
   and an owner — never an absence.
