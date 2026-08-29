import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { AccountScope } from '../../src/core/account/index.ts';
import { asId } from '../../src/platform/ids.ts';
import type { KnowledgeEntryId, UserId } from '../../src/platform/ids.ts';
import { decisionJson, metaCommentEnvelope } from '../support/harness.ts';
import type { PostgresHarness } from '../support/postgres-harness.ts';
import { createPostgresHarness } from '../support/postgres-harness.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import {
  acquirePostgres,
  postgresAvailable,
  releasePostgres,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * Migration 0009 and the review queue, asserted against real PostgreSQL.
 *
 * The memory adapter cannot prove any of this. Three things only the database can enforce, and
 * each of them is the last line rather than the first:
 *
 *   1. **`APPROVED_FOR_MANUAL_SEND` belongs to suggestions alone.** A future edit that routed an
 *      autonomous action through the review path would be refused by a CHECK constraint rather
 *      than by whoever reviews that pull request.
 *   2. **The review log is append-only.** `app_runtime` has SELECT and INSERT and nothing else —
 *      the posture `audit_events` already has. A record that can be rewritten is not a record.
 *   3. **Reviews are tenant-isolated by RLS,** enforced against a non-superuser connection, the
 *      only way the assertion means anything.
 */

const REVIEWER = asId<UserId>('usr_reviewer');
const available = postgresAvailable();

describe('postgres review queue', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let h: PostgresHarness;

  before(async () => {
    cluster = await acquirePostgres();
  });

  beforeEach(async () => {
    await h?.close();
    h = await createPostgresHarness(cluster);
  });

  after(async () => {
    await h?.close();
    await releasePostgres();
  });

  const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query(sql, params);
      return result.rows as T[];
    });

  /** Drives a comment through to a persisted, suppressed suggestion. */
  const suggest = async (
    index = 1,
  ): Promise<{ actionId: string; accountId: string; scope: AccountScope }> => {
    const seeded = await h.seedAccount({ slug: `queue-${String(index)}` });
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>(`kne_hours_${String(index)}`),
      title: 'Opening hours',
      body: 'Open Monday to Friday.',
      tags: ['hours'],
      intentCodes: ['GENERAL_QUESTION'],
    });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        action: 'PUBLIC_REPLY',
        replyText: 'We are open Monday to Friday.',
        knowledgeRefs: [`kne_hours_${String(index)}`],
      }),
    });
    await h.postWebhook(
      seeded,
      metaCommentEnvelope(seeded.connection.externalId, {
        commentId: `c_${String(index)}`,
        postId: `p_${String(index)}`,
        fromId: `u_${String(index)}`,
        text: 'what are your hours?',
      }),
    );
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const queue = await h.container.review.list(seeded.scope);
    assert.equal(queue.length, 1, 'the fixture must leave exactly one draft awaiting review');
    return { actionId: queue[0]!.action.id, accountId: seeded.account.id, scope: seeded.scope };
  };

  it('persists a suggestion as SUPPRESSED / SUGGESTED, never queued for dispatch', async () => {
    const { actionId } = await suggest();
    const [row] = await rows<{
      state: string;
      delivery_mode: string;
      cancelled_reason: string | null;
      payload: Record<string, unknown>;
    }>(
      'SELECT state, delivery_mode, cancelled_reason, payload FROM outbound_actions WHERE id = $1',
      [actionId],
    );

    assert.equal(row!.state, 'SUPPRESSED');
    assert.equal(row!.delivery_mode, 'SUGGESTED');
    assert.equal(row!.cancelled_reason, 'AWAITING_HUMAN_APPROVAL');
    assert.equal(row!.payload['text'], 'We are open Monday to Friday.');
    // The reviewer's evidence bundle round-trips through jsonb.
    const review = row!.payload['review'] as Record<string, unknown>;
    assert.equal(review['intentCode'], 'GENERAL_QUESTION');
    assert.ok(Array.isArray(review['knowledgeRefs']));
  });

  it('refuses APPROVED_FOR_MANUAL_SEND on anything that is not a suggestion', async () => {
    const { actionId } = await suggest();
    // The constraint, not the application, is what makes this impossible. Attempted as the
    // superuser precisely so that no policy or grant can be credited for the refusal.
    await assert.rejects(
      () =>
        withAdminClient(cluster.adminUrl, (client) =>
          client.query(
            `UPDATE outbound_actions
                SET delivery_mode = 'AUTONOMOUS', state = 'APPROVED_FOR_MANUAL_SEND'
              WHERE id = $1`,
            [actionId],
          ),
        ),
      (error: unknown) => {
        const failure = error as { code?: string; constraint?: string };
        assert.equal(failure.code, '23514', 'a check-constraint violation');
        assert.equal(failure.constraint, 'outbound_actions_manual_send_is_suggested');
        return true;
      },
    );
  });

  it('still refuses a state outside the vocabulary, so 0009 widened it rather than removing it', async () => {
    const { actionId } = await suggest();
    await assert.rejects(
      () =>
        withAdminClient(cluster.adminUrl, (client) =>
          client.query("UPDATE outbound_actions SET state = 'SENT' WHERE id = $1", [actionId]),
        ),
      (error: unknown) =>
        (error as { constraint?: string }).constraint === 'outbound_actions_state_check',
    );
  });

  it('records a decision, its reviewer and both texts', async () => {
    const { actionId, scope } = await suggest();

    await h.container.review.decide(scope, {
      actionId: asId(actionId),
      decision: 'EDITED',
      reviewerUserId: REVIEWER,
      editedText: 'We are open Monday to Friday, 9am to 5pm.',
    });

    const [review] = await rows<{
      decision: string;
      reviewer_user_id: string;
      original_text: string;
      edited_text: string;
      reason: string | null;
    }>(
      'SELECT decision, reviewer_user_id, original_text, edited_text, reason FROM outbound_action_reviews',
    );
    assert.equal(review!.decision, 'EDITED');
    assert.equal(review!.reviewer_user_id, REVIEWER);
    assert.equal(review!.original_text, 'We are open Monday to Friday.');
    assert.equal(review!.edited_text, 'We are open Monday to Friday, 9am to 5pm.');

    const [action] = await rows<{ state: string; payload: Record<string, unknown> }>(
      'SELECT state, payload FROM outbound_actions WHERE id = $1',
      [actionId],
    );
    assert.equal(action!.state, 'APPROVED_FOR_MANUAL_SEND');
    // The payload is untouched. `outbound:save` upserts state and delivery bookkeeping and never
    // rewrites `payload`, so the model's proposal is immutable once written — which is why the
    // human's text lives in the review row and nowhere else.
    assert.equal(action!.payload['text'], 'We are open Monday to Friday.');
    assert.equal(action!.payload['finalText'], undefined);

    // And the service reports it back from the review log.
    const detail = await h.container.review.show(scope, asId(actionId));
    assert.equal(detail.finalText, 'We are open Monday to Friday, 9am to 5pm.');
    assert.equal(detail.history.length, 1);
  });

  describe('the schema refuses a malformed review directly', () => {
    const insert = async (
      columns: Record<string, string | null>,
    ): Promise<{ code?: string; constraint?: string } | null> => {
      const { actionId, accountId } = await suggest();
      const [conversation] = await rows<{ id: string }>(
        'SELECT conversation_id AS id FROM outbound_actions WHERE id = $1',
        [actionId],
      );
      try {
        await withAdminClient(cluster.adminUrl, (client) =>
          client.query(
            `INSERT INTO outbound_action_reviews
               (id, account_id, outbound_action_id, conversation_id, decision,
                reviewer_user_id, reason, original_text, edited_text)
             VALUES ('rvw_x', $1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              accountId,
              actionId,
              conversation!.id,
              columns['decision'],
              columns['reviewer_user_id'],
              columns['reason'] ?? null,
              'the draft',
              columns['edited_text'] ?? null,
            ],
          ),
        );
        return null;
      } catch (error) {
        return error as { code?: string; constraint?: string };
      }
    };

    it('an EDITED decision with no edit', async () => {
      const failure = await insert({ decision: 'EDITED', reviewer_user_id: REVIEWER });
      assert.equal(failure?.constraint, 'outbound_action_reviews_edit_shape');
    });

    it('an edit attached to a decision that is not an edit', async () => {
      const failure = await insert({
        decision: 'APPROVED',
        reviewer_user_id: REVIEWER,
        edited_text: 'a rewrite with no decision to justify it',
      });
      assert.equal(failure?.constraint, 'outbound_action_reviews_edit_shape');
    });

    it('a rejection with no reason', async () => {
      const failure = await insert({ decision: 'REJECTED', reviewer_user_id: REVIEWER });
      assert.equal(failure?.constraint, 'outbound_action_reviews_reason_required');
    });

    it('an anonymous decision', async () => {
      // Issue 15 of the audit was that nobody owned the inbox. A nullable reviewer would put that
      // back into the schema.
      const failure = await insert({ decision: 'APPROVED', reviewer_user_id: null });
      assert.equal(failure?.code, '23502', 'reviewer_user_id is NOT NULL');
    });

    it('a decision outside the vocabulary', async () => {
      const failure = await insert({ decision: 'MAYBE', reviewer_user_id: REVIEWER });
      assert.equal(failure?.constraint, 'outbound_action_reviews_decision_check');
    });
  });

  describe('the runtime role', () => {
    let runtime: pg.Client;

    const asTenant = async <T>(
      accountId: string,
      fn: (client: pg.Client) => Promise<T>,
    ): Promise<T> => {
      runtime ??= await (async () => {
        const client = new pg.Client({ connectionString: cluster.runtimeUrl });
        await client.connect();
        return client;
      })();
      await runtime.query('BEGIN');
      try {
        await runtime.query('SELECT set_config($1,$2,true)', ['app.account_id', accountId]);
        return await fn(runtime);
      } finally {
        await runtime.query('ROLLBACK');
      }
    };

    after(async () => {
      await runtime?.end();
    });

    it('can insert and read a review but can never rewrite or delete one', async () => {
      const { actionId, accountId, scope } = await suggest();
      await h.container.review.decide(scope, {
        actionId: asId(actionId),
        decision: 'REJECTED',
        reviewerUserId: REVIEWER,
        reason: 'the hours are out of date',
      });

      const visible = await asTenant(accountId, async (client) => {
        const result = await client.query('SELECT id FROM outbound_action_reviews');
        return result.rowCount ?? 0;
      });
      assert.equal(visible, 1, 'the row the service just wrote is readable');

      for (const sql of [
        "UPDATE outbound_action_reviews SET reason = 'something else'",
        'DELETE FROM outbound_action_reviews',
      ]) {
        await assert.rejects(
          () => asTenant(accountId, (client) => client.query(sql)),
          (error: unknown) => (error as { code?: string }).code === '42501',
          `${sql} must be refused: a record that can be rewritten is not a record`,
        );
      }
    });

    it('cannot see another tenant’s reviews, with no predicate at all', async () => {
      const first = await suggest(1);
      const second = await suggest(2);
      for (const target of [first, second]) {
        await h.container.review.decide(target.scope, {
          actionId: asId(target.actionId),
          decision: 'APPROVED',
          reviewerUserId: REVIEWER,
        });
      }

      const seen = await asTenant(first.accountId, async (client) => {
        const result = await client.query<{ account_id: string }>(
          'SELECT account_id FROM outbound_action_reviews',
        );
        return result.rows.map((row) => row.account_id);
      });
      assert.deepEqual(seen, [first.accountId]);
    });
  });

  it('has an index that finds the queue without scanning every outbound action', async () => {
    await suggest();
    const [index] = await rows<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'outbound_actions_review_idx'",
    );
    assert.ok(index, 'migration 0009 must create the review index');
    assert.match(index.indexdef, /SUPPRESSED/);
    assert.match(index.indexdef, /SUGGESTED/);
    // Oldest first: the audit's costliest finding was a question that sat for five days, and a
    // newest-first queue is how that stays invisible.
    assert.ok(!/created_at DESC/.test(index.indexdef));
  });
});
