-- 0002_moderation.sql — channels, the raw inbound ledger, conversations, messages, runs,
-- outbound actions, handoffs and lead candidates.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- channel_connections
-- ---------------------------------------------------------------------------------------------
CREATE TABLE channel_connections (
  id                 text PRIMARY KEY,
  account_id         text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel            text NOT NULL CHECK (channel IN ('FACEBOOK','INSTAGRAM','WHATSAPP','WEB','TEST')),
  supported_surfaces text[] NOT NULL,
  external_id        text NOT NULL,
  -- Opaque id in the webhook URL. Establishes tenancy before the body is parsed (ADR-006).
  public_webhook_id  text NOT NULL UNIQUE,
  -- A pointer into the secret store. Never the secret. A database dump must not contain app secrets.
  credentials_ref    text NOT NULL,
  status             text NOT NULL CHECK (status IN ('PENDING','ACTIVE','DEGRADED','DISABLED')),
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- Platform-wide, deliberately NOT scoped by account: two accounts must never claim the same
  -- page, or webhooks would be attributed to whichever row was found first.
  UNIQUE (channel, external_id)
);

-- ---------------------------------------------------------------------------------------------
-- identities
-- ---------------------------------------------------------------------------------------------
CREATE TABLE contact_identities (
  id             text PRIMARY KEY,
  account_id     text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  display_name   text,
  locale         text,
  timezone       text,
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_into_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, merged_into_id) REFERENCES contact_identities (account_id, id)
);

CREATE TABLE channel_identities (
  id                  text PRIMARY KEY,
  account_id          text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel             text NOT NULL,
  external_id         text NOT NULL,
  contact_identity_id text,
  display_name        text,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, channel, external_id),
  FOREIGN KEY (account_id, contact_identity_id) REFERENCES contact_identities (account_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- raw_inbound_events — the immutable ledger
-- ---------------------------------------------------------------------------------------------
CREATE TABLE raw_inbound_events (
  id                    text PRIMARY KEY,
  account_id            text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel_connection_id text NOT NULL,
  -- Delivery-level deduplication: sha256 of the verbatim body (ADR-006, level 1).
  delivery_key          text NOT NULL,
  payload               jsonb NOT NULL,
  headers               jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature_valid       boolean NOT NULL,
  state                 text NOT NULL CHECK (state IN
                          ('RECEIVED','NORMALIZING','NORMALIZED','IGNORED','REJECTED','DEAD_LETTERED')),
  received_at           timestamptz NOT NULL DEFAULT now(),
  normalized_at         timestamptz,
  produced_message_ids  text[] NOT NULL DEFAULT '{}',
  error                 jsonb,
  trace_id              text NOT NULL,
  UNIQUE (account_id, id),
  UNIQUE (channel_connection_id, delivery_key),
  FOREIGN KEY (account_id, channel_connection_id) REFERENCES channel_connections (account_id, id)
);

CREATE INDEX raw_inbound_events_pending_idx ON raw_inbound_events (state, received_at)
  WHERE state IN ('RECEIVED', 'NORMALIZING');

-- ---------------------------------------------------------------------------------------------
-- conversations — three orthogonal state axes (ADR-008)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE conversations (
  id                         text PRIMARY KEY,
  account_id                 text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel_connection_id      text NOT NULL,
  channel_identity_id        text NOT NULL,
  contact_identity_id        text,
  surface                    text NOT NULL CHECK (surface IN ('DIRECT_MESSAGE','PUBLIC_COMMENT')),
  thread_ref                 text,

  lifecycle                  text NOT NULL CHECK (lifecycle IN ('OPEN','SNOOZED','CLOSED')),
  ownership                  text NOT NULL CHECK (ownership IN ('AI_OWNED','PENDING_HUMAN','HUMAN_OWNED')),
  ownership_version          integer NOT NULL DEFAULT 0,
  owner_user_id              text,
  engagement                 text NOT NULL CHECK (engagement IN
                               ('AWAITING_MODERATOR','AWAITING_CUSTOMER','AWAITING_EXTERNAL','IDLE')),

  next_seq                   integer NOT NULL DEFAULT 1,
  last_inbound_seq           integer NOT NULL DEFAULT 0,
  last_processed_inbound_seq integer NOT NULL DEFAULT 0,

  locale                     text,
  snoozed_until              timestamptz,
  closed_at                  timestamptz,
  first_message_at           timestamptz,
  last_message_at            timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, channel_connection_id) REFERENCES channel_connections (account_id, id),
  FOREIGN KEY (account_id, channel_identity_id)   REFERENCES channel_identities (account_id, id),
  FOREIGN KEY (account_id, contact_identity_id)   REFERENCES contact_identities (account_id, id),

  -- The invariants from DOMAIN-MODEL.md, enforced by the database rather than by hope.
  CONSTRAINT conversations_watermark_bounds
    CHECK (last_processed_inbound_seq <= last_inbound_seq AND last_inbound_seq < next_seq),
  CONSTRAINT conversations_owner_iff_human_owned
    CHECK ((ownership = 'HUMAN_OWNED') = (owner_user_id IS NOT NULL))
);

-- The lookup used on every inbound message.
CREATE INDEX conversations_lookup_idx
  ON conversations (account_id, channel_connection_id, channel_identity_id, surface, thread_ref);
-- Operator queues and SLA sweeps.
CREATE INDEX conversations_pending_idx ON conversations (account_id, engagement, last_message_at)
  WHERE lifecycle = 'OPEN';
CREATE INDEX conversations_snoozed_idx ON conversations (snoozed_until)
  WHERE lifecycle = 'SNOOZED';

-- Append-only audit of the ownership axis.
CREATE TABLE conversation_ownership_transitions (
  id                text PRIMARY KEY,
  account_id        text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conversation_id   text NOT NULL,
  from_ownership    text NOT NULL,
  to_ownership      text NOT NULL,
  version           integer NOT NULL,
  actor_kind        text NOT NULL CHECK (actor_kind IN ('HUMAN','POLICY','SYSTEM')),
  actor_user_id     text,
  reason            text NOT NULL,
  moderator_run_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, conversation_id, version),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- messages — append-only
-- ---------------------------------------------------------------------------------------------
CREATE TABLE messages (
  id                   text PRIMARY KEY,
  account_id           text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conversation_id      text NOT NULL,
  seq                  integer NOT NULL,
  direction            text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  author_kind          text NOT NULL CHECK (author_kind IN ('CUSTOMER','AI','HUMAN_AGENT','SYSTEM')),
  author_user_id       text,
  channel              text NOT NULL,
  provider_message_id  text,
  -- Item-level deduplication (ADR-006, level 2).
  dedupe_key           text NOT NULL,
  dedupe_source        text NOT NULL CHECK (dedupe_source IN ('PROVIDER_ID','DERIVED')),
  content_type         text NOT NULL,
  text                 text,
  attachments          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Two different facts, never conflated (ADR-005).
  provider_ts          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  raw_inbound_event_id text,
  outbound_action_id   text,
  redacted_at          timestamptz,
  UNIQUE (account_id, id),
  UNIQUE (account_id, conversation_id, seq),
  UNIQUE (account_id, channel, dedupe_key),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id)
);

CREATE INDEX messages_conversation_seq_idx ON messages (account_id, conversation_id, seq);
-- Transcript rendering order (ADR-005): provider time first, seq as the tiebreaker.
CREATE INDEX messages_transcript_idx ON messages (account_id, conversation_id, provider_ts, seq);

-- ---------------------------------------------------------------------------------------------
-- moderator_runs and outbound_actions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE moderator_runs (
  id                          text PRIMARY KEY,
  account_id                  text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conversation_id             text NOT NULL,
  state                       text NOT NULL CHECK (state IN
                                ('PENDING','RUNNING','COMPLETED','SKIPPED','SUPERSEDED','FAILED','DEAD_LETTERED')),
  trigger                     text NOT NULL CHECK (trigger IN ('INBOUND_MESSAGE','TIMER','OPERATOR','REPLAY')),
  input_watermark             integer NOT NULL,
  observed_ownership_version  integer NOT NULL,
  -- NOT NULL: reproducing a historical decision requires the exact configuration (ADR-010).
  pack_version_id             text NOT NULL,
  prompt_template_version     text NOT NULL,
  decision                    jsonb,
  llm                         jsonb,
  raw_response                text,
  skip_reason                 text,
  error                       jsonb,
  job_id                      text,
  trace_id                    text NOT NULL,
  started_at                  timestamptz NOT NULL DEFAULT now(),
  finished_at                 timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id),
  -- Terminal states must record why. "The AI did nothing" is never allowed to be silent.
  CONSTRAINT moderator_runs_skip_reason_required
    CHECK (state <> 'SKIPPED' OR skip_reason IS NOT NULL),
  CONSTRAINT moderator_runs_error_required
    CHECK (state NOT IN ('FAILED','DEAD_LETTERED') OR error IS NOT NULL),
  CONSTRAINT moderator_runs_decision_required
    CHECK (state <> 'COMPLETED' OR decision IS NOT NULL)
);

CREATE INDEX moderator_runs_conversation_idx ON moderator_runs (account_id, conversation_id, started_at DESC);

CREATE TABLE outbound_actions (
  id                  text PRIMARY KEY,
  account_id          text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conversation_id     text NOT NULL,
  moderator_run_id    text,
  action_type         text NOT NULL,
  delivery_mode       text NOT NULL CHECK (delivery_mode IN ('AUTONOMOUS','SUGGESTED','SIMULATED')),
  state               text NOT NULL CHECK (state IN
                        ('PENDING_DISPATCH','DISPATCHING','DELIVERED','FAILED','CANCELLED',
                         'SUPPRESSED','SIMULATED','PENDING_RECONCILIATION')),
  -- Deterministic, so a retry after an ambiguous timeout is reconcilable rather than duplicative.
  idempotency_key     text NOT NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_message_id text,
  attempt             integer NOT NULL DEFAULT 0,
  last_error          jsonb,
  cancelled_reason    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz,
  UNIQUE (account_id, id),
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id, conversation_id)  REFERENCES conversations (account_id, id),
  FOREIGN KEY (account_id, moderator_run_id) REFERENCES moderator_runs (account_id, id)
);

CREATE INDEX outbound_actions_dispatch_idx ON outbound_actions (account_id, state, created_at)
  WHERE state IN ('PENDING_DISPATCH','FAILED','PENDING_RECONCILIATION');

-- ---------------------------------------------------------------------------------------------
-- handoffs and lead candidates
-- ---------------------------------------------------------------------------------------------
CREATE TABLE handoffs (
  id                text PRIMARY KEY,
  account_id        text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conversation_id   text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('HUMAN_AGENT','SALES','SUPPORT','VENDOR','EXTERNAL_SYSTEM')),
  state             text NOT NULL CHECK (state IN
                      ('REQUESTED','ASSIGNED','ACCEPTED','COMPLETED','EXPIRED','CANCELLED','FAILED')),
  reason_code       text NOT NULL,
  urgency           text NOT NULL CHECK (urgency IN ('LOW','NORMAL','HIGH')),
  target_queue      text,
  assigned_user_id  text,
  context_summary   jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggering_run_id text,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  assigned_at       timestamptz,
  accepted_at       timestamptz,
  completed_at      timestamptz,
  sla_due_at        timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id),
  CONSTRAINT handoffs_accepted_requires_assignee
    CHECK (state <> 'ACCEPTED' OR assigned_user_id IS NOT NULL)
);

-- The SLA sweep: open handoffs past their due time (F-13 / handoff.failed).
CREATE INDEX handoffs_sla_idx ON handoffs (sla_due_at)
  WHERE state IN ('REQUESTED','ASSIGNED');

CREATE TABLE lead_candidates (
  id                         text PRIMARY KEY,
  account_id                 text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conversation_id            text NOT NULL,
  contact_identity_id        text,
  state                      text NOT NULL CHECK (state IN ('DRAFT','QUALIFIED','DELIVERED','REJECTED','FAILED')),
  qualification_rule_version text NOT NULL,
  captured_fields            jsonb NOT NULL DEFAULT '{}'::jsonb,
  product_interest           jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_ref               text,
  delivered_at               timestamptz,
  delivery_error             jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id)
  -- Deliberately absent: stage, probability, close_date, value. Those belong to the CRM,
  -- permanently. Adding one here is how a moderation platform becomes a second CRM.
);

-- ---------------------------------------------------------------------------------------------
-- RLS for every table above
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channel_connections','contact_identities','channel_identities','raw_inbound_events',
    'conversations','conversation_ownership_transitions','messages','moderator_runs',
    'outbound_actions','handoffs','lead_candidates'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (account_id = app_current_account_id())',
      t || '_tenant_isolation', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_runtime', t);
  END LOOP;
END
$$;

-- Append-only enforcement: the application may insert and read these, never rewrite history.
REVOKE UPDATE, DELETE ON raw_inbound_events FROM app_runtime;
REVOKE UPDATE, DELETE ON messages FROM app_runtime;
REVOKE UPDATE, DELETE ON conversation_ownership_transitions FROM app_runtime;
-- Two exceptions, granted narrowly rather than by re-granting UPDATE on the whole table:
--   * raw_inbound_events: lifecycle state and the ids it produced.
--   * messages: `redacted_at`/`text` blanking under the retention policy.
GRANT UPDATE (state, normalized_at, produced_message_ids, error) ON raw_inbound_events TO app_runtime;
GRANT UPDATE (text, redacted_at) ON messages TO app_runtime;

COMMIT;
