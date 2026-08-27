# Domain Model

- Status: Phase 0
- Date: 2026-08-27

Canonical definitions for the entities in the moderation platform. Every entity here is
account-scoped unless explicitly marked otherwise. The TypeScript types in `src/**/domain/`
are the executable form of this document; where they disagree, the code is wrong.

Notation: `PK` primary key, `FK` foreign key, `U` unique, `→` reference. All FKs between
business tables are **composite with `account_id`** (ADR-002).

---

## Map

```text
Account
 ├── ChannelConnection ──────── ChannelIdentity ──┐
 │        │                                       │
 │        └── RawInboundEvent                     │
 │                  │ normalises to               │
 │                  ▼                             │
 │            Conversation ◄──── ContactIdentity ─┘
 │                  ├── Message ──── MessageAttachment
 │                  ├── ConversationOwnership (audit log of the ownership axis)
 │                  ├── ConversationObjective
 │                  ├── ModeratorRun ──── ModeratorDecision ──── OutboundAction
 │                  ├── Handoff
 │                  └── LeadCandidate
 ├── AccountPackVersion ──── PackSection
 ├── KnowledgeEntry
 ├── Policy (authority matrix, materialised from the pack)
 ├── User ──── AccountMembership
 └── AuditEvent

operations: Job, DeadLetter, DomainEventOutbox, EventDelivery
```

---

## Core

### Account

The tenant. Root of every scope.

| Field                      | Type                              | Notes                                                                                                                                                                    |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                       | `AccountId`                       | PK                                                                                                                                                                       |
| `slug`                     | `string`                          | U; stable external handle                                                                                                                                                |
| `name`                     | `string`                          | Display                                                                                                                                                                  |
| `status`                   | `ACTIVE \| SUSPENDED \| ARCHIVED` | Suspended accounts still _ingest and persist_, but perform no autonomous outbound. Losing a suspended client's messages would be a data-loss bug, not a billing feature. |
| `default_locale`           | `string`                          | BCP-47                                                                                                                                                                   |
| `timezone`                 | `string`                          | IANA; SLA and business-hours evaluation                                                                                                                                  |
| `created_at`, `updated_at` | `timestamptz`                     |                                                                                                                                                                          |

### User / AccountMembership

`User` is **platform-scoped** (a person may operate several accounts).
`AccountMembership{ account_id, user_id, role, status }` grants scope; `role ∈ OWNER | ADMIN |
OPERATOR | VIEWER`. A scope for an account cannot be resolved without an active membership.
Platform staff access is a distinct role that emits an `account.impersonated` audit event.

---

## Channel and identity

### ChannelConnection

One connected surface: a Facebook Page, an Instagram account, a WhatsApp number.

| Field               | Type                                               | Notes                                                                                                                  |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`, `account_id`  | ids                                                | PK / tenant                                                                                                            |
| `channel`           | `FACEBOOK \| INSTAGRAM \| WHATSAPP \| WEB \| TEST` | Extensible union, `CHECK` constrained                                                                                  |
| `surface_support`   | `DIRECT_MESSAGE[] \| PUBLIC_COMMENT[]`             | What this connection can carry                                                                                         |
| `external_id`       | `string`                                           | Page id / IG id / phone id. U per `(channel, external_id)` **platform-wide** — two accounts cannot claim the same page |
| `public_webhook_id` | `string`                                           | U; opaque id in the webhook URL. Establishes tenancy before parsing (ADR-006)                                          |
| `credentials_ref`   | `string`                                           | Pointer into the secret store. **Never the secret itself**                                                             |
| `status`            | `PENDING \| ACTIVE \| DEGRADED \| DISABLED`        | `DEGRADED` = token expiring / permissions reduced                                                                      |
| `settings`          | `jsonb`                                            | Connection-level overrides (debounce, rate caps)                                                                       |

### ChannelIdentity

A stable address on a channel: a PSID, an IG-scoped id, a phone number.

| Field                           | Type         | Notes                                  |
| ------------------------------- | ------------ | -------------------------------------- |
| `id`, `account_id`              | ids          |                                        |
| `channel`, `external_id`        |              | U `(account_id, channel, external_id)` |
| `contact_identity_id`           | FK, nullable | Link to the merged person, when known  |
| `display_name`, `profile_ref`   | nullable     | Only what the channel gives us         |
| `first_seen_at`, `last_seen_at` |              |                                        |

The same human on Messenger and WhatsApp is **two** `ChannelIdentity` rows. Deliberately: the ids
are not comparable, and pretending they are is how one customer gets another's history.

### ContactIdentity

An account-scoped person record: the merge point for channel identities.

| Field                                | Type             | Notes                                                                        |
| ------------------------------------ | ---------------- | ---------------------------------------------------------------------------- |
| `id`, `account_id`                   | ids              |                                                                              |
| `display_name`, `locale`, `timezone` | nullable         |                                                                              |
| `attributes`                         | `jsonb`          | Facts the customer told us, each with provenance and a captured-at timestamp |
| `merged_into_id`                     | nullable self-FK | Merges are recorded, never destructive                                       |

**Not** a CRM contact. No pipeline, no owner, no value. It exists so a returning customer is
recognised, nothing more.

---

## Ingestion

### RawInboundEvent

The immutable ledger. The system's only reconstructible truth.

| Field                          | Type               | Notes                                                                           |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------- |
| `id`, `account_id`             | ids                |                                                                                 |
| `channel_connection_id`        | FK                 |                                                                                 |
| `delivery_key`                 | `string`           | `sha256(raw body)`; U `(channel_connection_id, delivery_key)` (ADR-006)         |
| `payload`                      | `jsonb`            | Verbatim body. **Immutable**                                                    |
| `headers`                      | `jsonb`            | Signature and delivery headers, secrets stripped                                |
| `signature_valid`              | `boolean`          |                                                                                 |
| `state`                        | see state machines | `RECEIVED \| NORMALIZING \| NORMALIZED \| IGNORED \| REJECTED \| DEAD_LETTERED` |
| `received_at`, `normalized_at` | `timestamptz`      |                                                                                 |
| `produced_message_ids`         | `uuid[]`           | What this event became — the replay/audit link                                  |
| `error`                        | `jsonb`, nullable  | Terminal failure detail                                                         |
| `trace_id`                     | `string`           | Correlates the whole downstream chain                                           |

`UPDATE`/`DELETE` on `payload` is revoked from the application role.

---

## Conversation

### Conversation

The aggregate root for moderation. Three orthogonal state axes (ADR-008).

| Field                                 | Type                                                                   | Notes                                                     |
| ------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `id`, `account_id`                    | ids                                                                    |                                                           |
| `channel_connection_id`               | FK                                                                     |                                                           |
| `channel_identity_id`                 | FK                                                                     | The customer's address                                    |
| `contact_identity_id`                 | FK, nullable                                                           |                                                           |
| `surface`                             | `DIRECT_MESSAGE \| PUBLIC_COMMENT`                                     | Drives the authority matrix                               |
| `thread_ref`                          | `string`, nullable                                                     | Post/comment thread for public surfaces                   |
| `lifecycle`                           | `OPEN \| SNOOZED \| CLOSED`                                            | Axis 1                                                    |
| `ownership`                           | `AI_OWNED \| PENDING_HUMAN \| HUMAN_OWNED`                             | Axis 2 — safety critical                                  |
| `ownership_version`                   | `integer`                                                              | Bumped on every ownership change; the takeover race guard |
| `owner_user_id`                       | nullable FK                                                            | Set iff `HUMAN_OWNED`                                     |
| `engagement`                          | `AWAITING_MODERATOR \| AWAITING_CUSTOMER \| AWAITING_EXTERNAL \| IDLE` | Axis 3                                                    |
| `next_seq`                            | `integer`                                                              | Allocator for `Message.seq`                               |
| `last_inbound_seq`                    | `integer`                                                              | Highest inbound `seq`                                     |
| `last_processed_inbound_seq`          | `integer`                                                              | The watermark (ADR-005)                                   |
| `locale`                              | `string`, nullable                                                     | Detected/declared                                         |
| `snoozed_until`, `closed_at`          | nullable                                                               |                                                           |
| `first_message_at`, `last_message_at` |                                                                        | SLA inputs                                                |

Invariant: `last_processed_inbound_seq <= last_inbound_seq < next_seq`.
Invariant: `owner_user_id IS NOT NULL` iff `ownership = HUMAN_OWNED`.
There is **no** `lead_id`, no stage, no value (ADR-003 / three-noun rule).

### Message

Append-only.

| Field                                 | Type                                                                                               | Notes                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `id`, `account_id`, `conversation_id` | ids                                                                                                |                                                                            |
| `seq`                                 | `integer`                                                                                          | U `(conversation_id, seq)`; gapless, allocated under the conversation lock |
| `direction`                           | `INBOUND \| OUTBOUND`                                                                              |                                                                            |
| `author_kind`                         | `CUSTOMER \| AI \| HUMAN_AGENT \| SYSTEM`                                                          |                                                                            |
| `author_user_id`                      | nullable                                                                                           | Set for `HUMAN_AGENT`                                                      |
| `provider_message_id`                 | `string`, nullable                                                                                 | U `(account_id, channel, provider_message_id)`                             |
| `dedupe_source`                       | `PROVIDER_ID \| DERIVED`                                                                           | Makes key ambiguity visible (ADR-006)                                      |
| `content_type`                        | `TEXT \| IMAGE \| AUDIO \| VIDEO \| DOCUMENT \| STICKER \| LOCATION \| SYSTEM_NOTE \| UNSUPPORTED` |                                                                            |
| `text`                                | `text`, nullable                                                                                   | Redactable in place under retention policy                                 |
| `provider_ts`, `received_at`          | `timestamptz`                                                                                      | Two different facts (ADR-005)                                              |
| `raw_inbound_event_id`                | nullable FK                                                                                        | Provenance for inbound                                                     |
| `outbound_action_id`                  | nullable FK                                                                                        | Provenance for outbound                                                    |
| `redacted_at`                         | nullable                                                                                           |                                                                            |

### MessageAttachment

| Field                                 | Notes                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `id`, `account_id`, `message_id`      |                                                                                        |
| `kind`                                | `IMAGE \| AUDIO \| VIDEO \| DOCUMENT \| OTHER`                                         |
| `provider_url`, `storage_ref`         | Provider URLs expire; we re-host under `{account}/{conversation}/{id}`                 |
| `mime_type`, `size_bytes`, `checksum` | Validated before storage                                                               |
| `derived_artifacts`                   | `jsonb` — transcripts, captions, OCR, each with the model and version that produced it |

Present in the model now so multimodal is a _feature_ later, not a migration. No processing in Phase 0.

### ConversationOwnership

Append-only audit of Axis 2. Answers "who took this over, when, and why".

| Field                                         | Notes                                            |
| --------------------------------------------- | ------------------------------------------------ |
| `id`, `account_id`, `conversation_id`         |                                                  |
| `from_ownership`, `to_ownership`              |                                                  |
| `version`                                     | The `ownership_version` this transition produced |
| `actor_kind`                                  | `HUMAN \| POLICY \| SYSTEM`                      |
| `actor_user_id`, `reason`, `moderator_run_id` | nullable                                         |
| `created_at`                                  |                                                  |

### ConversationObjective

What the moderator is trying to achieve. Kinds come from the Account Pack, so a client-specific
objective never becomes a core state (ADR-008).

| Field                                 | Notes                                                          |
| ------------------------------------- | -------------------------------------------------------------- |
| `id`, `account_id`, `conversation_id` |                                                                |
| `kind`                                | Pack-defined code (e.g. `QUALIFICATION`, `SUPPORT_TRIAGE`)     |
| `status`                              | `IN_PROGRESS \| COMPLETED \| ABANDONED \| BLOCKED`             |
| `collected`                           | `jsonb` — field → `{ value, source_message_seq, captured_at }` |
| `missing`                             | `text[]` — required fields still outstanding                   |

### ModeratorRun

One attempt to decide what to do next. The audit unit of AI behaviour.

| Field                                                    | Notes                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `id`, `account_id`, `conversation_id`                    |                                                                                       |
| `state`                                                  | `PENDING \| RUNNING \| COMPLETED \| SKIPPED \| SUPERSEDED \| FAILED \| DEAD_LETTERED` |
| `trigger`                                                | `INBOUND_MESSAGE \| TIMER \| OPERATOR \| REPLAY`                                      |
| `input_watermark`                                        | Highest inbound `seq` this run considered                                             |
| `observed_ownership_version`                             | The staleness guard (ADR-005 §4)                                                      |
| `pack_version_id`                                        | **Non-null.** Reproducibility (ADR-010)                                               |
| `prompt_template_version`                                |                                                                                       |
| `provider`, `model`, `role`                              | Resolved at call time                                                                 |
| `tokens_in`, `tokens_out`, `cost_estimate`, `latency_ms` | Attribution per account                                                               |
| `raw_response`                                           | `jsonb` — retained for audit, redaction-eligible                                      |
| `skip_reason`, `error`                                   | nullable                                                                              |
| `job_id`, `trace_id`                                     |                                                                                       |

### ModeratorDecision

The validated structured proposal. One per completed run.

| Field                                  | Notes                                                          |
| -------------------------------------- | -------------------------------------------------------------- |
| `id`, `account_id`, `moderator_run_id` |                                                                |
| `intent_code`, `intent_confidence`     | Must exist in the account's taxonomy                           |
| `entities`                             | `jsonb`                                                        |
| `detected_locale`, `sentiment`         | nullable                                                       |
| `proposed_action`                      | `ActionType` (see Policy)                                      |
| `action_payload`                       | `jsonb`, schema-validated per action type                      |
| `knowledge_refs`                       | `uuid[]` — must be contained in what the run was given (I9)    |
| `needs_human`, `handoff_reason`        |                                                                |
| `policy_outcome`                       | `ALLOWED \| DOWNGRADED \| REQUIRES_APPROVAL \| DENIED`         |
| `policy_reason`, `final_action`        | What the _application_ decided, versus what the model proposed |

Storing both the proposal and the verdict is deliberate: "the model wanted X, policy allowed Y" is
the record that makes AI behaviour auditable.

### OutboundAction

An authorised effect. **Cannot be constructed without a passing `PolicyDecision` (I7).**

| Field                                          | Notes                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`, `account_id`, `conversation_id`          |                                                                                                                         |
| `moderator_run_id`                             | nullable — operator-initiated actions have none                                                                         |
| `action_type`                                  | `SEND_MESSAGE \| ASK_CLARIFICATION \| ADD_TAG \| REQUEST_HANDOFF \| CREATE_LEAD_CANDIDATE \| PUBLIC_REPLY \| NO_ACTION` |
| `delivery_mode`                                | `AUTONOMOUS \| SUGGESTED \| SIMULATED`                                                                                  |
| `state`                                        | `PENDING_DISPATCH \| DISPATCHING \| DELIVERED \| FAILED \| CANCELLED \| SUPPRESSED \| SIMULATED`                        |
| `idempotency_key`                              | U per account; derived from `(conversation, run, ordinal)` (ADR-006)                                                    |
| `payload`                                      | `jsonb` — the exact content                                                                                             |
| `provider_message_id`, `attempt`, `last_error` | Delivery bookkeeping                                                                                                    |
| `cancelled_reason`                             | e.g. `HUMAN_TOOK_OVER`                                                                                                  |

`SUPPRESSED` exists so "we decided not to send" is a visible record rather than an absence.

### Handoff

First-class escalation (ADR-008).

| Field                                                                      | Notes                                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `id`, `account_id`, `conversation_id`                                      |                                                                                    |
| `kind`                                                                     | `HUMAN_AGENT \| SALES \| SUPPORT \| VENDOR \| EXTERNAL_SYSTEM`                     |
| `state`                                                                    | `REQUESTED \| ASSIGNED \| ACCEPTED \| COMPLETED \| EXPIRED \| CANCELLED \| FAILED` |
| `reason_code`, `urgency`                                                   | Pack-defined reason vocabulary                                                     |
| `target_queue`, `assigned_user_id`                                         | nullable                                                                           |
| `context_summary`                                                          | `jsonb` — structured, not free prose                                               |
| `requested_at`, `assigned_at`, `accepted_at`, `completed_at`, `sla_due_at` | Measurable                                                                         |
| `triggering_run_id`                                                        | nullable                                                                           |

### LeadCandidate

The **only** commercial artefact moderation owns. Exists so the CRM boundary is crossable while
the CRM does not exist, and so a CRM outage loses nothing (ADR-009).

| Field                                                        | Notes                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `id`, `account_id`, `conversation_id`, `contact_identity_id` |                                                             |
| `status`                                                     | `DRAFT \| QUALIFIED \| DELIVERED \| REJECTED \| FAILED`     |
| `qualification_rule_version`                                 | Which pack rules judged it                                  |
| `captured_fields`                                            | `jsonb` — each `{ value, source_message_seq, captured_at }` |
| `product_interest`                                           | `jsonb[]` — refs plus confidence                            |
| `external_ref`, `delivered_at`, `delivery_error`             | Set by the CRM adapter, never by the moderator              |

No stage, no probability, no close date, no monetary value. Those are the CRM's, permanently.

---

## Knowledge and configuration

### AccountPackVersion / PackSection

Immutable, versioned, schema-validated configuration (ADR-010).
`AccountPackVersion{ id, account_id, version, status, content_hash, published_by, published_at,
schema_version, notes }`; exactly one `ACTIVE` per account (partial unique index).
`PackSection{ pack_version_id, section_key, document jsonb, section_schema_version }`.

### KnowledgeEntry

Account-scoped, approval- and validity-bounded. Full field list in ADR-010.
Retrieval sees only `status = APPROVED` entries inside their validity window; price and offer rows
are superseded, never edited.

### KnowledgeGap

| Field                                                                   | Notes                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `id`, `account_id`, `conversation_id`, `moderator_run_id`               |                                                       |
| `question_shape`                                                        | Normalised, minimised — not the raw customer sentence |
| `intent_code`, `locale`, `occurrences`, `first_seen_at`, `last_seen_at` |                                                       |
| `status`                                                                | `OPEN \| CONTENT_REQUESTED \| RESOLVED \| WONT_FIX`   |

Turns "the AI could not answer" into a tracked content backlog and the `faq.unanswered` event.

### Policy

Materialised authority matrix for an account, derived from the pack and pinned by version:
`Policy{ account_id, pack_version_id, surface, action_type, effect: ALLOW | REQUIRE_APPROVAL |
DENY, constraints jsonb }`. Evaluation is deterministic and total: an action with no matching rule
is **denied**, never allowed by default.

---

## Operations

### AuditEvent

Append-only, account-scoped record of consequential actions — who or what did it, to which
subject, with before/after where meaningful. Written for: ownership changes, pack publication,
policy denials, impersonation, credential changes, retention deletions, replays. Distinct from
domain events: audit is internal accountability, domain events are external contracts.

### Job / DeadLetter

Per ADR-004. `Job{ id, account_id, type, partition_key, dedupe_key, payload, state, run_at,
attempt, max_attempts, lease_owner, lease_expires_at, first_enqueued_at, last_error, trace_id }`.
`DeadLetter` preserves the terminal job, its error chain, and enough context to replay it.

### DomainEventOutbox / EventDelivery

Per ADR-009. Outbox rows are written in the same transaction as the state change; deliveries track
each `(event, subscription)` attempt independently.

---

## Entities deliberately **not** modelled in Phase 0

| Not modelled                                   | Why                                                                        | Where it belongs                      |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------- |
| `Lead`, `Opportunity`, `Pipeline`, `Quotation` | Not ours (three-noun rule)                                                 | Future CRM                            |
| `Campaign`, `AdSpend`                          | Not moderation                                                             | All In Studio                         |
| `Ticket`                                       | `Handoff` covers Phase 0 escalation; a ticket system is a product decision | Later, if support workflows demand it |
| `Team`, `Shift`, `Roster`                      | Needed for routing by availability, not for the foundation                 | Phase 2 with routing                  |
| `Embedding` / `KnowledgeChunk`                 | Open decision D1                                                           | Phase 2                               |
| `BillingUsage`                                 | Cost data is recorded on `ModeratorRun`; aggregation is a read model       | Phase 2                               |
