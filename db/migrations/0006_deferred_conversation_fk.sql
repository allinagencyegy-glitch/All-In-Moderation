-- 0006_deferred_conversation_fk.sql — let the message and its conversation commit as one fact.
--
-- Found by running Phase 0's normalize path against a real server. `normalizeItem` inserts the
-- message *before* saving the conversation, and the ordering is deliberate:
--
--     const inserted = await deps.messages.insertIfNew(scope, message);
--     if (!inserted.inserted) return { duplicate: true, ... };   // conversation untouched
--     await deps.conversations.save(scope, { ...conversation, nextSeq: seq + 1, ... });
--
-- The rule that ordering encodes is "a duplicate delivery must not mutate the conversation" — and
-- in particular must not leave behind an empty conversation for a message that already exists
-- elsewhere (F-02). The in-memory adapter has no foreign keys, so the ordering was free there.
-- PostgreSQL rejected the insert immediately, the whole normalize transaction rolled back, and the
-- job dead-lettered.
--
-- Two ways out. Reorder the writes, which trades a domain rule for SQL convenience and leaves an
-- empty conversation behind on the duplicate path. Or say what is actually true: the message and
-- its conversation are one atomic fact, and the constraint should hold at COMMIT rather than
-- between two statements. That is exactly what DEFERRABLE INITIALLY DEFERRED means.
--
-- The guarantee is not weakened. An orphaned message still fails — the transaction aborts at
-- COMMIT and nothing is written. What changes is *when* the error surfaces, which costs some
-- diagnosability: a genuine ordering bug elsewhere now reports at commit rather than at the
-- offending statement. That is the price, and it is worth naming.
--
-- Scope is deliberately narrow. Only this one constraint is deferred; every other foreign key
-- still fires immediately, so real ordering mistakes keep failing fast and loudly.

BEGIN;

ALTER TABLE messages DROP CONSTRAINT messages_account_id_conversation_id_fkey;

ALTER TABLE messages
  ADD CONSTRAINT messages_account_id_conversation_id_fkey
  FOREIGN KEY (account_id, conversation_id)
  REFERENCES conversations (account_id, id)
  DEFERRABLE INITIALLY DEFERRED;

COMMIT;
