-- 0010_operator_provisioning.sql — narrow runtime capabilities for first-tenant provisioning.
--
-- Provisioning still connects as app_runtime and all account/membership writes still pass through
-- FORCE RLS. The only pre-scope operation is resolving the operator-supplied slug to an account
-- id, because the id is what establishes the tenant context. As with the webhook resolver in
-- 0005, the SECURITY DEFINER function returns identifiers only; callers re-read the row under RLS.

BEGIN;

-- Email is the platform user identity. Existing data is compared after trimming and case-folding,
-- so the database must arbitrate concurrent inserts with the same definition.
CREATE UNIQUE INDEX users_normalized_email_uq ON users (lower(btrim(email)));

-- `search_path` is pinned to prevent caller-controlled object resolution in SECURITY DEFINER code.
CREATE OR REPLACE FUNCTION app_resolve_account_id_by_slug(p_slug text)
  RETURNS TABLE (account_id text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT a.id
  FROM accounts a
  WHERE a.slug = p_slug
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION app_resolve_account_id_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_account_id_by_slug(text) TO app_runtime;

COMMIT;
