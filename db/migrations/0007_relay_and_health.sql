-- 0007_relay_and_health.sql — the outbox relay's role, and the two cross-tenant aggregates the
-- health endpoints need.
--
-- Phase 01 left the relay unbuilt and said why: `EventOutbox.markRelayed` carries no
-- `AccountScope`, so under RLS it matches zero rows, the watermark never moves, and the relay
-- loops forever redelivering. The adapter threw `NotImplementedError` rather than pretend.
--
-- The fix is the shape 0005 already established for the queue: a role whose *grants* are the
-- boundary, not a policy that opens a table to everyone. Three things follow from that.
--
--   1. `app_relay` is granted exactly one table, and on that table exactly one writable column.
--      Reading the outbox across tenants is what a relay is for; writing anything except
--      `relayed_at` is not. Column-level UPDATE makes that a privilege rather than a convention,
--      so a relay bug cannot rewrite an event's `data` on its way out of the platform.
--
--   2. Like `app_worker`, it is NOT `BYPASSRLS`. Cross-tenant visibility comes from a policy
--      scoped `TO app_relay`, so the blast radius of the role stops at `domain_event_outbox` —
--      it cannot read a conversation, a message, a knowledge entry or a job.
--
--   3. "Oldest unprocessed inbound event" is a genuinely cross-tenant question asked by an
--      endpoint that must stay boring. Rather than grant anyone a cross-tenant read of
--      `raw_inbound_events`, one SECURITY DEFINER function returns a *count and a timestamp* and
--      nothing else. There is no row to leak because the function never selects one.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. app_relay — the outbox-facing role
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_relay') THEN
    CREATE ROLE app_relay NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_relay;

-- SELECT is the minimum a relay can do its job with: it has to read the envelope it delivers.
-- Event payloads are already minimised by contract (ADR-009 carries ids and derived facts, never
-- message text), so this grant does not expose customer content even though it is cross-tenant.
GRANT SELECT ON domain_event_outbox TO app_relay;
-- The only write in the entire role. Not `GRANT UPDATE ON ...` — that would also permit rewriting
-- `data`, `type` and `account_id`.
GRANT UPDATE (relayed_at) ON domain_event_outbox TO app_relay;

-- PostgreSQL OR-combines permissive policies, so this grants app_relay cross-tenant visibility
-- without altering what app_runtime sees. app_runtime is not a member of app_relay.
CREATE POLICY domain_event_outbox_relay_access ON domain_event_outbox
  TO app_relay USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------------------------
-- 2. Inbound backlog — an aggregate, not a query over rows
-- ---------------------------------------------------------------------------------------------
-- RECEIVED and NORMALIZING are exactly the states in `raw_inbound_events_pending_idx`, so this is
-- an index-only question. REJECTED events are deliberately excluded: a bad signature is not a
-- backlog, and counting it as one would make a spoofing attempt look like an outage.
--
-- `search_path` is pinned, as in 0005: a SECURITY DEFINER function that resolves object names
-- through the caller's search_path is the classic privilege-escalation bug.
CREATE OR REPLACE FUNCTION app_inbound_backlog()
  RETURNS TABLE (pending bigint, oldest_received_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::bigint, min(r.received_at)
  FROM raw_inbound_events r
  WHERE r.state IN ('RECEIVED', 'NORMALIZING')
$$;

REVOKE EXECUTE ON FUNCTION app_inbound_backlog() FROM PUBLIC;
-- The worker pool is what serves health: it is the role that already sees the queue across
-- tenants, so this adds no new reach that the health check did not already have.
GRANT EXECUTE ON FUNCTION app_inbound_backlog() TO app_worker;

COMMIT;
