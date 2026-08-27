-- 0001_core.sql — accounts, users, tenancy scaffolding, and the RLS convention.
--
-- Conventions established here and relied on by every later migration:
--   * Every business table has a NOT NULL account_id referencing accounts(id).
--   * Every business table declares a UNIQUE (account_id, id) so that later tables can carry
--     COMPOSITE foreign keys including account_id. That is what makes it structurally impossible
--     for a row to reference another tenant's row (ADR-002, layer 2).
--   * Every business table has RLS enabled and FORCEd, filtered on current_setting('app.account_id').
--   * Enumerations are text + CHECK, not PostgreSQL enum types, so adding a state is an ordinary
--     migration rather than a lock-taking ALTER TYPE (ADR-003).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------------------------
-- app_runtime  : the application. Subject to RLS. Cannot UPDATE/DELETE append-only tables.
-- app_migrator : migrations and reconciliation. Bypasses RLS; its use is audited.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator NOLOGIN BYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Helper: the tenant predicate used by every RLS policy.
-- ---------------------------------------------------------------------------------------------
-- Returns NULL when unset, which makes every policy fail closed: a connection that forgot
-- `SET LOCAL app.account_id` sees nothing rather than seeing everything.
CREATE OR REPLACE FUNCTION app_current_account_id() RETURNS text
  LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.account_id', true), '') $$;

-- ---------------------------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE accounts (
  id             text PRIMARY KEY,
  slug           text NOT NULL UNIQUE,
  name           text NOT NULL,
  status         text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  default_locale text NOT NULL DEFAULT 'en',
  timezone       text NOT NULL DEFAULT 'UTC',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The accounts table is the one place where the tenant predicate is on `id`, not `account_id`.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant_isolation ON accounts
  USING (id = app_current_account_id());

-- ---------------------------------------------------------------------------------------------
-- users and memberships
-- ---------------------------------------------------------------------------------------------
-- Users are platform-scoped: one person may operate several client accounts. Authorisation for a
-- given account comes from an ACTIVE membership, never from the user row itself.
CREATE TABLE users (
  id         text PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  full_name  text,
  status     text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_memberships (
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER')),
  status     text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY account_memberships_tenant_isolation ON account_memberships
  USING (account_id = app_current_account_id());

CREATE INDEX account_memberships_user_idx ON account_memberships (user_id) WHERE status = 'ACTIVE';

GRANT SELECT, INSERT, UPDATE ON accounts, users, account_memberships TO app_runtime;

COMMIT;
