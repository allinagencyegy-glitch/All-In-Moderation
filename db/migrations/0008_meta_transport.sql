-- 0008_meta_transport.sql — the provider transport layer, receive-only.
--
-- Phase 02A modelled a connected surface as one string: `external_id`, compared against the
-- `entry.id` of a webhook. That is sufficient for Facebook Messenger and for nothing else.
--
--   * A WhatsApp delivery names a **business account** in `entry.id` and the routable **phone
--     number id** in `value.metadata`. One WABA can carry many numbers belonging to different
--     clients under one partner app. Routing on `entry.id` would deliver one client's messages
--     into another client's account — the single most expensive bug available in this system.
--   * An Instagram professional account and the Facebook Page it is linked to are different
--     identifiers, and either may appear depending on which subscription produced the event.
--
-- So a connection owns a *set* of typed identities, and the uniqueness that prevents misrouting
-- is enforced by a primary key rather than by application code (ADR-002, layer 2). Four further
-- columns make the safety posture of a connection readable in a single row.
--
-- Nothing here stores a credential. `credentials_ref` remains a pointer, and the app secret and
-- verify token continue to live behind the `SecretResolver` port (objective 5).

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Transport configuration on the connection
-- ---------------------------------------------------------------------------------------------
ALTER TABLE channel_connections
  ADD COLUMN provider text NOT NULL DEFAULT 'META'
    CHECK (provider IN ('META', 'INTERNAL')),
  -- The safety flag. RECEIVE_ONLY is the default *and* the only value this phase provisions:
  -- a connection must be deliberately promoted, one at a time, and the promotion is a visible
  -- write rather than a process-wide environment variable (objective 8).
  ADD COLUMN transport_mode text NOT NULL DEFAULT 'RECEIVE_ONLY'
    CHECK (transport_mode IN ('RECEIVE_ONLY', 'SEND_AND_RECEIVE')),
  ADD COLUMN subscription_state text NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK (subscription_state IN
      ('UNCONFIGURED', 'CHALLENGE_PENDING', 'CHALLENGE_PASSED', 'SUBSCRIBED', 'REVOKED')),
  ADD COLUMN capabilities text[] NOT NULL DEFAULT '{}',
  -- Distinct from supported_surfaces: what the channel *can* carry and what this client has
  -- *asked* us to read are different statements, and conflating them means enabling a channel
  -- silently enables every surface it is capable of.
  ADD COLUMN enabled_surfaces text[] NOT NULL DEFAULT '{}';

-- A row that claims receive-only while holding a send capability is a contradiction, and
-- contradictions in safety configuration resolve the wrong way under pressure. The database
-- refuses it outright rather than trusting every future writer to check.
ALTER TABLE channel_connections
  ADD CONSTRAINT channel_connections_receive_only_has_no_send_capability CHECK (
    transport_mode <> 'RECEIVE_ONLY'
    OR NOT (capabilities && ARRAY['SEND_DIRECT_MESSAGE','SEND_PUBLIC_COMMENT',
                                  'REACT','HIDE_COMMENT','DELETE_COMMENT']::text[])
  );

-- ---------------------------------------------------------------------------------------------
-- 2. channel_connection_identities — every provider id a connection owns
-- ---------------------------------------------------------------------------------------------
CREATE TABLE channel_connection_identities (
  account_id            text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel_connection_id text NOT NULL,
  provider              text NOT NULL CHECK (provider IN ('META', 'INTERNAL')),
  kind                  text NOT NULL CHECK (kind IN
                          ('FACEBOOK_PAGE','INSTAGRAM_ACCOUNT','WHATSAPP_BUSINESS_ACCOUNT',
                           'WHATSAPP_PHONE_NUMBER','INTERNAL')),
  external_id           text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Platform-wide and deliberately NOT scoped by account. This is the structural answer to
  -- "could one client's event enter another client's account?" — two accounts cannot both claim
  -- the same page, IG account, WABA or phone number, because the second INSERT fails.
  PRIMARY KEY (provider, kind, external_id),
  UNIQUE (account_id, channel_connection_id, kind, external_id),
  FOREIGN KEY (account_id, channel_connection_id)
    REFERENCES channel_connections (account_id, id) ON DELETE CASCADE
);

CREATE INDEX channel_connection_identities_connection_idx
  ON channel_connection_identities (account_id, channel_connection_id);

ALTER TABLE channel_connection_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_connection_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY channel_connection_identities_tenant_isolation ON channel_connection_identities
  USING (account_id = app_current_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON channel_connection_identities TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. The normalisation verdict, on the ledger row
-- ---------------------------------------------------------------------------------------------
-- The payload was always durable; the *verdict* was not. `state = 'IGNORED'` cannot distinguish
-- an echo from a delivery receipt from a message type nobody has taught the parser about, and
-- those need three different people (objective 7).
--
-- Counts and classification names only. No text, no identifiers: this column is read by
-- dashboards and pasted into tickets.
ALTER TABLE raw_inbound_events ADD COLUMN normalization jsonb;

-- raw_inbound_events is append-only for app_runtime (0002 REVOKEd UPDATE). The lifecycle columns
-- are granted individually; this is one more of them, granted the same narrow way rather than by
-- re-granting UPDATE on the table.
GRANT UPDATE (normalization) ON raw_inbound_events TO app_runtime;

-- Per-connection receive status is a scoped question — "when did *this* client's page last send
-- us anything?" — so it is served by an ordinary indexed query under RLS rather than by another
-- cross-tenant SECURITY DEFINER function.
CREATE INDEX raw_inbound_events_connection_recent_idx
  ON raw_inbound_events (account_id, channel_connection_id, received_at DESC);

-- ---------------------------------------------------------------------------------------------
-- 4. Provider provenance, on the message
-- ---------------------------------------------------------------------------------------------
-- Reply context, ad referral, the envelope id, the identity kind the item was routed on. Per
-- item rather than per delivery, because one envelope can carry a story reply and an ad referral
-- for two different customers. Meta sends some of these exactly once — an ad referral arrives
-- with the first message and never again — so the choice is to keep them on arrival or lose them.
ALTER TABLE messages ADD COLUMN provider_context jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------------------------
-- 5. Webhook resolution: let the application decide what a disabled connection means
-- ---------------------------------------------------------------------------------------------
-- 0005 filtered `status <> 'DISABLED'` inside the resolver, which made a disabled connection
-- indistinguishable from a webhook id that never existed. Two consequences, both bad:
--
--   * `ingest()` has an explicit CONNECTION_DISABLED branch that answers 200. On PostgreSQL that
--     branch was unreachable, so the in-memory adapter and the real one disagreed about a case
--     the tests exercise — and the memory suite is the regression test for the Postgres one.
--   * Meta treats 404 as a failed delivery and retries, then escalates to disabling the
--     subscription. A deliberately disabled connection should answer "received, and I am doing
--     nothing with it", which is exactly 200.
--
-- The function still returns two identifiers and nothing else, and the caller still re-reads the
-- row inside the resulting tenant context. The hole in RLS is no wider than 0005 made it.
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
  LIMIT 1
$$;

COMMIT;
