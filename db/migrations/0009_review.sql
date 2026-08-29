-- 0009_review.sql — human review of suggested replies (ADR-011).
--
-- Phase 02C makes the moderator draft a reply and hand it to a person. Two schema facts carry
-- that:
--
--   1. A new terminal state on `outbound_actions`, `APPROVED_FOR_MANUAL_SEND`. It is deliberately
--      NOT `PENDING_DISPATCH`. There is no dispatcher, no transport and no send capability
--      anywhere in `src/`, and routing an approval into the dispatch queue would be the single
--      edit that converts human review into autonomous delivery. The state name says what
--      happens next — a person sends the text themselves from Meta Inbox — so the absence of a
--      sender is legible in a database dump and not only in a comment.
--
--   2. `outbound_action_reviews`, which is append-only. `app_runtime` gets SELECT and INSERT and
--      nothing else: no UPDATE, no DELETE, matching the treatment `audit_events` already gets in
--      0003. A review is a statement a named person made at a point in time, and the whole value
--      of the table is that it can still be trusted months later when someone asks why a
--      particular reply went to a customer.
--
-- A separate table rather than columns on `outbound_actions` because a draft can be reviewed,
-- rejected, escalated and re-examined, and the history is the product. Columns would keep only
-- the last opinion.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. The approved-for-manual-send state
-- ---------------------------------------------------------------------------------------------
ALTER TABLE outbound_actions DROP CONSTRAINT outbound_actions_state_check;

ALTER TABLE outbound_actions
  ADD CONSTRAINT outbound_actions_state_check CHECK (state IN
    ('PENDING_DISPATCH','DISPATCHING','DELIVERED','FAILED','CANCELLED',
     'SUPPRESSED','SIMULATED','PENDING_RECONCILIATION','APPROVED_FOR_MANUAL_SEND'));

-- Only a suggestion can ever be approved for manual send. An AUTONOMOUS or SIMULATED action
-- reaching this state would mean the review path had been wired to something it was never meant
-- to touch, and the database refuses it rather than trusting every future writer to check.
ALTER TABLE outbound_actions
  ADD CONSTRAINT outbound_actions_manual_send_is_suggested CHECK (
    state <> 'APPROVED_FOR_MANUAL_SEND' OR delivery_mode = 'SUGGESTED'
  );

-- The review queue. Partial and ordered oldest-first: the audit's costliest finding was a price
-- question that sat unanswered for five days, and a newest-first queue hides exactly that.
-- `outbound_actions_dispatch_idx` does not cover this — it is partial on the dispatch states.
CREATE INDEX outbound_actions_review_idx ON outbound_actions (account_id, created_at)
  WHERE state = 'SUPPRESSED' AND delivery_mode = 'SUGGESTED';

-- ---------------------------------------------------------------------------------------------
-- 2. outbound_action_reviews — append-only
-- ---------------------------------------------------------------------------------------------
CREATE TABLE outbound_action_reviews (
  id                  text PRIMARY KEY,
  account_id          text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  outbound_action_id  text NOT NULL,
  conversation_id     text NOT NULL,
  decision            text NOT NULL
                        CHECK (decision IN ('APPROVED','EDITED','REJECTED','ESCALATED')),
  -- NOT NULL. An anonymous approval is not an approval; issue #15 in the audit was that nobody
  -- owned the inbox, and a nullable column here would reproduce it in the schema.
  reviewer_user_id    text NOT NULL,
  reason              text,
  -- Exactly what the model proposed. Never rewritten, including by an edit.
  original_text       text,
  -- What the reviewer intends to send instead. NULL when they changed nothing.
  edited_text         text,
  decided_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, outbound_action_id) REFERENCES outbound_actions (account_id, id),
  FOREIGN KEY (account_id, conversation_id)    REFERENCES conversations (account_id, id),
  -- An EDITED decision without the edit is a record of nothing; an edit on any other decision is
  -- a contradiction. Both are refused here rather than left to the application to remember.
  CONSTRAINT outbound_action_reviews_edit_shape CHECK (
    (decision =  'EDITED' AND edited_text IS NOT NULL AND length(btrim(edited_text)) > 0)
    OR
    (decision <> 'EDITED' AND edited_text IS NULL)
  ),
  -- A rejection or an escalation must say why. The knowledge backlog is built out of exactly
  -- these sentences, and an unexplained rejection teaches nobody anything.
  CONSTRAINT outbound_action_reviews_reason_required CHECK (
    decision NOT IN ('REJECTED','ESCALATED')
    OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
  )
);

CREATE INDEX outbound_action_reviews_action_idx
  ON outbound_action_reviews (account_id, outbound_action_id, decided_at DESC);
CREATE INDEX outbound_action_reviews_conversation_idx
  ON outbound_action_reviews (account_id, conversation_id, decided_at DESC);

-- ---------------------------------------------------------------------------------------------
-- 3. RLS and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE outbound_action_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_action_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY outbound_action_reviews_tenant_isolation ON outbound_action_reviews
  USING (account_id = app_current_account_id());

-- SELECT and INSERT only. No UPDATE, no DELETE — the same posture `audit_events` has, and for the
-- same reason. Review is a runtime-role operation: neither `app_worker` nor `app_relay` is
-- granted anything here, because neither has any business reading one tenant's review decisions.
GRANT SELECT, INSERT ON outbound_action_reviews TO app_runtime;

COMMIT;
