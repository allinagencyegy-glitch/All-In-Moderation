-- 0005_runtime_roles.sql — the privilege model the Phase 1 adapter actually needs.
--
-- Phase 0 wrote the DDL against a single application role. Running it revealed three places where
-- that model and the *ports* contradict each other. None of them is a domain change; all three are
-- consequences of enforcing tenancy in the database rather than only in the application.
--
--   1. `bigserial` needs a sequence grant. `jobs.seq` is a bigserial, so `INSERT INTO jobs` fails
--      with "permission denied for sequence jobs_seq_seq" under a non-owner role. Migrations
--      0001-0004 grant on tables only. This is invisible until a non-superuser inserts a job.
--
--   2. The job queue is cross-tenant infrastructure. `JobQueue.claim()` takes no `AccountScope` by
--      design: a worker asks "what is there to do?" across every account. Under an RLS policy
--      keyed on `app.account_id`, that query returns nothing. The fix is a second role rather than
--      a weaker policy — `app_worker` sees the queue, and is granted nothing else, so a bug in a
--      worker cannot read a conversation even by accident.
--
--   3. Webhook ingest must resolve tenancy *before* it has tenancy. `findByPublicWebhookId` is
--      unscoped by design (ADR-006): the opaque id in the URL is what establishes which account a
--      request belongs to, before the body is parsed. Under RLS the lookup returns nothing. The
--      fix is one narrow SECURITY DEFINER function that takes the opaque id and returns two ids —
--      not a policy that opens the table.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Sequence privileges
-- ---------------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_runtime;

DO $$
DECLARE s text;
BEGIN
  FOR s IN
    SELECT quote_ident(sequencename) FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%s TO app_runtime', s);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. app_worker — the queue-facing role
-- ---------------------------------------------------------------------------------------------
-- Deliberately NOT `BYPASSRLS`. A permissive policy scoped `TO app_worker` grants exactly the
-- visibility the queue needs; the role's *grants* still stop at two tables, so the blast radius of
-- a worker bug is the queue, never the conversation store.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_worker;
GRANT SELECT, INSERT, UPDATE ON jobs TO app_worker;
GRANT SELECT, INSERT ON dead_letters TO app_worker;
GRANT USAGE, SELECT ON SEQUENCE jobs_seq_seq TO app_worker;

-- PostgreSQL OR-combines permissive policies, so app_worker gets tenant-visibility OR everything.
-- app_runtime is not a member of app_worker and is unaffected by these.
CREATE POLICY jobs_worker_access ON jobs
  TO app_worker USING (true) WITH CHECK (true);
CREATE POLICY dead_letters_worker_access ON dead_letters
  TO app_worker USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------------------------
-- 3. Tenancy resolution for inbound webhooks
-- ---------------------------------------------------------------------------------------------
-- The narrowest possible hole in RLS: one lookup, by an unguessable opaque id, returning the two
-- identifiers required to establish a scope — and nothing else. No payload, no credentials_ref,
-- no settings. The caller then re-reads the full connection row *inside* the resulting tenant
-- context, so the row itself is never read outside RLS.
--
-- `search_path` is pinned: a SECURITY DEFINER function that resolves object names through the
-- caller's search_path is the classic privilege-escalation bug.
CREATE OR REPLACE FUNCTION app_resolve_webhook_connection(p_public_webhook_id text)
  RETURNS TABLE (connection_id text, account_id text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.account_id
  FROM channel_connections c
  WHERE c.public_webhook_id = p_public_webhook_id
    AND c.status <> 'DISABLED'
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION app_resolve_webhook_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_webhook_connection(text) TO app_runtime;

COMMIT;
