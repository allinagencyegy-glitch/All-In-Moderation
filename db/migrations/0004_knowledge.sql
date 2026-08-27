-- 0004_knowledge.sql — Account Packs, knowledge entries, and the knowledge-gap backlog.
--
-- The constraints here are what make ADR-010 real rather than aspirational: exactly one ACTIVE
-- pack per account, immutability of published versions, and validity windows that live in columns
-- the application can filter on — never in prose a language model is trusted to read.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- account_pack_versions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE account_pack_versions (
  id             text PRIMARY KEY,
  account_id     text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  version        integer NOT NULL,
  status         text NOT NULL CHECK (status IN
                   ('DRAFT','IN_REVIEW','APPROVED','ACTIVE','SUPERSEDED','ROLLED_BACK')),
  -- Content-addressed: identical content produces an identical hash, which makes "did anything
  -- actually change?" answerable without diffing documents.
  content_hash   text NOT NULL,
  sections       jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version text NOT NULL,
  published_by   text,
  published_at   timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, version),
  CONSTRAINT pack_published_requires_publisher
    CHECK (status IN ('DRAFT','IN_REVIEW') OR (published_by IS NOT NULL AND published_at IS NOT NULL))
);

-- Exactly one ACTIVE version per account. Enforced by the database, because "we always deactivate
-- the old one first" is the kind of rule that survives until the first concurrent publish.
CREATE UNIQUE INDEX account_pack_versions_one_active_idx ON account_pack_versions (account_id)
  WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------------------------
-- knowledge_entries
-- ---------------------------------------------------------------------------------------------
CREATE TABLE knowledge_entries (
  id            text PRIMARY KEY,
  account_id    text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN
                  ('FAQ','POLICY','PRODUCT','SERVICE','LOCATION','HOURS','WARRANTY','DELIVERY',
                   'INSTALLATION','OFFER','PRICE','CLAIM')),
  title         text NOT NULL,
  body          text NOT NULL,
  locale        text NOT NULL,
  status        text NOT NULL CHECK (status IN ('DRAFT','APPROVED','ARCHIVED')),
  -- Validity is a column, so expiry is a WHERE clause rather than an instruction in a prompt.
  valid_from    timestamptz,
  valid_until   timestamptz,
  source_ref    text,
  evidence      text,
  approved_by   text,
  approved_at   timestamptz,
  product_ref   text,
  payment_type  text,
  -- numeric, never float. Money that drifts by a cent is money we have to explain.
  price_amount  numeric(12,2),
  price_currency text CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$'),
  tags          text[] NOT NULL DEFAULT '{}',
  intent_codes  text[] NOT NULL DEFAULT '{}',
  -- Price history without mutation: a new row supersedes rather than edits, so what we told a
  -- customer in March is still reconstructable in September.
  supersedes_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, supersedes_id) REFERENCES knowledge_entries (account_id, id),
  CONSTRAINT knowledge_approved_requires_approver
    CHECK (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT knowledge_validity_ordered
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until),
  -- A commercial claim without a price is a claim we cannot substantiate.
  CONSTRAINT knowledge_price_complete
    CHECK (kind NOT IN ('PRICE','OFFER')
           OR (price_amount IS NOT NULL AND price_currency IS NOT NULL)),
  -- An approved commercial claim must state when it stops being true.
  CONSTRAINT knowledge_commercial_requires_expiry
    CHECK (kind NOT IN ('PRICE','OFFER') OR status <> 'APPROVED' OR valid_until IS NOT NULL)
);

-- The retrieval path used by the Knowledge Gate.
CREATE INDEX knowledge_retrieval_idx ON knowledge_entries (account_id, locale, status)
  WHERE status = 'APPROVED';
CREATE INDEX knowledge_intent_idx ON knowledge_entries USING gin (intent_codes);
CREATE INDEX knowledge_tags_idx ON knowledge_entries USING gin (tags);
-- The proactive half of F-08: "what expires in the next N days?"
CREATE INDEX knowledge_expiry_idx ON knowledge_entries (account_id, valid_until)
  WHERE status = 'APPROVED' AND valid_until IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- knowledge_gaps
-- ---------------------------------------------------------------------------------------------
-- Turns "the AI could not answer" into a tracked content backlog rather than an invisible failure.
CREATE TABLE knowledge_gaps (
  id               text PRIMARY KEY,
  account_id       text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  conversation_id  text,
  moderator_run_id text,
  -- Normalised and minimised — never the customer's raw sentence, because this shape leaves the
  -- moderation boundary in the faq.unanswered event (ADR-009).
  question_shape   text NOT NULL,
  intent_code      text NOT NULL,
  locale           text NOT NULL,
  occurrences      integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN','CONTENT_REQUESTED','RESOLVED','WONT_FIX')),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, question_shape, locale)
);

CREATE INDEX knowledge_gaps_open_idx ON knowledge_gaps (account_id, occurrences DESC)
  WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_pack_versions','knowledge_entries','knowledge_gaps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (account_id = app_current_account_id())',
      t || '_tenant_isolation', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_runtime', t);
  END LOOP;
END
$$;

-- A published pack version is immutable except for its lifecycle status. Rollback publishes a new
-- version carrying old content; it never rewrites history.
CREATE OR REPLACE FUNCTION account_pack_versions_immutability() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status NOT IN ('DRAFT', 'IN_REVIEW') THEN
    IF NEW.sections IS DISTINCT FROM OLD.sections
       OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
       OR NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'account_pack_versions: published version % is immutable', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER account_pack_versions_immutability_trg
  BEFORE UPDATE ON account_pack_versions
  FOR EACH ROW EXECUTE FUNCTION account_pack_versions_immutability();

COMMIT;
