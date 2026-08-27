-- 0003_operations.sql — the durable job queue, dead letters, the transactional outbox,
-- event deliveries, and the audit log.
--
-- The claim query at the bottom of this file is the mechanism behind ADR-004 and ADR-005. It is
-- deliberately written out here, in SQL, rather than hidden behind an ORM: the concurrency design
-- *is* this query.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------------------------
CREATE TABLE jobs (
  id                text PRIMARY KEY,
  seq               bigserial NOT NULL,
  account_id        text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  type              text NOT NULL,
  -- The serialisation domain. At most one RUNNING job per partition (ADR-005).
  partition_key     text NOT NULL,
  -- Enables burst coalescing: at most one READY job per (partition, dedupe).
  dedupe_key        text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  state             text NOT NULL CHECK (state IN
                      ('READY','RUNNING','SUCCEEDED','FAILED','DEAD_LETTERED','CANCELLED')),
  -- The durable timer. A READY job is invisible until run_at <= now().
  run_at            timestamptz NOT NULL DEFAULT now(),
  attempt           integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 5,
  lease_owner       text,
  lease_expires_at  timestamptz,
  -- Anchors the anti-starvation ceiling to the start of the burst, not the latest message (F-21).
  first_enqueued_at timestamptz NOT NULL DEFAULT now(),
  last_error        jsonb,
  trace_id          text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_lease_consistency
    CHECK ((state = 'RUNNING') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

-- Coalescing constraint. NOTE: READY only, not READY+RUNNING. A RUNNING job has already captured
-- its input watermark, so a message arriving mid-run must be able to queue a *new* job behind it;
-- including RUNNING here would silently drop that follow-up run.
CREATE UNIQUE INDEX jobs_coalesce_idx ON jobs (partition_key, dedupe_key)
  WHERE state = 'READY' AND dedupe_key IS NOT NULL;

-- The claim path.
CREATE INDEX jobs_ready_idx ON jobs (run_at, seq) WHERE state = 'READY';
-- The partition-exclusivity subquery.
CREATE INDEX jobs_running_partition_idx ON jobs (partition_key, lease_expires_at) WHERE state = 'RUNNING';
-- The reaper.
CREATE INDEX jobs_lease_expiry_idx ON jobs (lease_expires_at) WHERE state = 'RUNNING';
-- Operator visibility: "which conversations are stuck?" is a query, not a guess.
CREATE INDEX jobs_account_state_idx ON jobs (account_id, state, run_at);

-- ---------------------------------------------------------------------------------------------
-- dead_letters
-- ---------------------------------------------------------------------------------------------
CREATE TABLE dead_letters (
  id          text PRIMARY KEY,
  account_id  text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  job_id      text NOT NULL,
  job_type    text NOT NULL,
  job_payload jsonb NOT NULL,
  error       jsonb NOT NULL,
  attempts    integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  UNIQUE (account_id, id)
);

CREATE INDEX dead_letters_open_idx ON dead_letters (account_id, recorded_at) WHERE replayed_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- domain_event_outbox and event_deliveries
-- ---------------------------------------------------------------------------------------------
-- Rows are inserted in the SAME transaction as the state change they describe. That is the whole
-- mechanism: an event is never emitted for a change that rolled back, and never lost for a change
-- that committed (ADR-009).
CREATE TABLE domain_event_outbox (
  id           text PRIMARY KEY,
  account_id   text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  type         text NOT NULL,
  version      integer NOT NULL,
  subject_type text NOT NULL,
  subject_id   text NOT NULL,
  data         jsonb NOT NULL,
  trace_id     text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  relayed_at   timestamptz,
  UNIQUE (account_id, id)
);

CREATE INDEX domain_event_outbox_relay_idx ON domain_event_outbox (occurred_at)
  WHERE relayed_at IS NULL;

CREATE TABLE event_subscriptions (
  id             text PRIMARY KEY,
  account_id     text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  destination    text NOT NULL,
  types          text[] NOT NULL,
  -- Per-type field projection. A consumer cannot receive a field it did not contract for, even
  -- if we add that field to the event later (ADR-009, data minimisation).
  allowed_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ref     text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  UNIQUE (account_id, id)
);

-- One row per (event, subscription): independent retry state, so one slow consumer cannot block
-- another.
CREATE TABLE event_deliveries (
  id              text PRIMARY KEY,
  account_id      text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  event_id        text NOT NULL,
  subscription_id text NOT NULL,
  state           text NOT NULL CHECK (state IN
                    ('PENDING','IN_FLIGHT','DELIVERED','RETRY_SCHEDULED','FAILED_PERMANENT','DEAD_LETTERED')),
  attempt         integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  response_code   integer,
  last_error      text,
  delivered_at    timestamptz,
  UNIQUE (account_id, event_id, subscription_id),
  FOREIGN KEY (account_id, event_id)        REFERENCES domain_event_outbox (account_id, id),
  FOREIGN KEY (account_id, subscription_id) REFERENCES event_subscriptions (account_id, id)
);

CREATE INDEX event_deliveries_pending_idx ON event_deliveries (next_attempt_at)
  WHERE state IN ('PENDING','RETRY_SCHEDULED');

-- ---------------------------------------------------------------------------------------------
-- audit_events — append-only
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit_events (
  id            text PRIMARY KEY,
  account_id    text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('HUMAN','SYSTEM','POLICY','AI')),
  actor_user_id text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);

CREATE INDEX audit_events_subject_idx ON audit_events (account_id, subject_type, subject_id, occurred_at DESC);

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jobs','dead_letters','domain_event_outbox','event_subscriptions','event_deliveries','audit_events'
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

REVOKE UPDATE, DELETE ON audit_events FROM app_runtime;
REVOKE DELETE ON domain_event_outbox FROM app_runtime;

-- ---------------------------------------------------------------------------------------------
-- Reference: the claim query (ADR-004 / ADR-005)
-- ---------------------------------------------------------------------------------------------
-- The Postgres adapter (Phase 1) must use exactly this shape. It is recorded here so the design
-- is reviewable as SQL and so the adapter cannot quietly diverge from it.
--
--   UPDATE jobs SET
--     state = 'RUNNING',
--     lease_owner = $1,
--     lease_expires_at = now() + ($2 || ' milliseconds')::interval,
--     attempt = attempt + 1
--   WHERE id = (
--     SELECT j.id FROM jobs j
--     WHERE j.state = 'READY'
--       AND j.run_at <= now()
--       AND ($3::text[] IS NULL OR j.type = ANY($3))
--       AND NOT EXISTS (                          -- partition exclusivity
--         SELECT 1 FROM jobs r
--         WHERE r.partition_key = j.partition_key
--           AND r.state = 'RUNNING'
--           AND r.lease_expires_at > now())       -- an EXPIRED lease must not block the partition
--     ORDER BY j.run_at, j.seq
--     FOR UPDATE SKIP LOCKED                      -- lock-free horizontal scaling of workers
--     LIMIT 1)
--   RETURNING *;
--
-- The reaper (crash recovery, F-11):
--
--   UPDATE jobs SET state = 'READY', lease_owner = NULL, lease_expires_at = NULL,
--                   last_error = '{"code":"LEASE_EXPIRED"}'::jsonb
--   WHERE state = 'RUNNING' AND lease_expires_at <= now() AND attempt < max_attempts;
--
--   UPDATE jobs SET state = 'DEAD_LETTERED', lease_owner = NULL, lease_expires_at = NULL
--   WHERE state = 'RUNNING' AND lease_expires_at <= now() AND attempt >= max_attempts;

COMMIT;
