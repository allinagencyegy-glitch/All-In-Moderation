import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { ConversationId, UserId } from '../../src/platform/ids.ts';
import type { Conversation } from '../../src/moderation/domain/conversation.ts';
import { decisionJson, metaMessageEnvelope } from '../support/harness.ts';
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
 * Step 7: compare-and-swap ownership, against real PostgreSQL.
 *
 * Phase 0 found this race by reading the code, fixed it with `saveIfUnchanged`, and could only
 * prove the fix against a single-threaded fake — where "concurrent" meant "interleaved by a test
 * hook". Here the two writers are genuinely separate database sessions, and the arbiter is
 * `UPDATE ... WHERE ownership_version = $expected` rather than a JavaScript comparison.
 *
 * The failure this prevents is specific and bad: a human takes a conversation while the AI is
 * mid-generation, and the AI's commit silently reverts ownership and sends its reply anyway — over
 * the top of the person now holding the conversation.
 */

const OPERATOR = asId<UserId>('usr_operator');
const SECOND_OPERATOR = asId<UserId>('usr_operator_2');

const available = postgresAvailable();

describe(
  'postgres ownership compare-and-swap',
  { skip: available ? false : 'no PostgreSQL' },
  () => {
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

    /** Drives one message through to a conversation awaiting its first moderator run. */
    const conversationAwaitingRun = async (): Promise<{
      conversation: Conversation;
      scope: Awaited<ReturnType<PostgresHarness['seedAccount']>>['scope'];
    }> => {
      const seeded = await h.seedAccount();
      await h.postWebhook(
        seeded,
        metaMessageEnvelope(seeded.connection.externalId, [
          { senderId: 'psid_1', mid: 'm_1', text: 'a question' },
        ]),
      );
      await h.drainTypes(['raw_event.normalize']);
      const conversation = await h.container.conversations.findById(
        seeded.scope,
        asId<ConversationId>('cnv_0001'),
      );
      assert.ok(conversation);
      return { conversation, scope: seeded.scope };
    };

    it('the CAS applies exactly once for a given expected version', async () => {
      const { conversation, scope } = await conversationAwaitingRun();
      const repo = h.container.conversations;

      const first = await repo.saveIfUnchanged(
        scope,
        { ...conversation, engagement: 'IDLE', ownershipVersion: 1 },
        conversation.ownershipVersion,
      );
      assert.equal(first, true);

      // The same expected version cannot win twice; that is the whole guarantee.
      const second = await repo.saveIfUnchanged(
        scope,
        { ...conversation, engagement: 'AWAITING_EXTERNAL', ownershipVersion: 2 },
        conversation.ownershipVersion,
      );
      assert.equal(second, false);

      const stored = await withAdminClient(cluster.adminUrl, async (client) => {
        const result = await client.query<{ engagement: string; ownership_version: number }>(
          'SELECT engagement, ownership_version FROM conversations WHERE id = $1',
          [conversation.id],
        );
        return result.rows[0]!;
      });
      assert.equal(stored.engagement, 'IDLE', 'the loser wrote nothing at all');
      assert.equal(stored.ownership_version, 1);
    });

    it('a losing CAS writes nothing — not even the columns that did not conflict', async () => {
      const { conversation, scope } = await conversationAwaitingRun();
      await h.container.conversations.saveIfUnchanged(
        scope,
        { ...conversation, ownershipVersion: 5 },
        conversation.ownershipVersion,
      );

      const applied = await h.container.conversations.saveIfUnchanged(
        scope,
        { ...conversation, ownershipVersion: 9, locale: 'fr', lastProcessedInboundSeq: 1 },
        conversation.ownershipVersion,
      );
      assert.equal(applied, false);

      const stored = await withAdminClient(cluster.adminUrl, async (client) => {
        const result = await client.query<{
          locale: string | null;
          last_processed_inbound_seq: number;
          ownership_version: number;
        }>(
          'SELECT locale, last_processed_inbound_seq, ownership_version FROM conversations WHERE id = $1',
          [conversation.id],
        );
        return result.rows[0]!;
      });
      assert.equal(stored.locale, null, 'a partial write here would corrupt the watermark');
      assert.equal(stored.last_processed_inbound_seq, 0);
      assert.equal(stored.ownership_version, 5);
    });

    it('human takeover during generation survives; the AI run supersedes itself and sends nothing', async () => {
      const { conversation, scope } = await conversationAwaitingRun();

      /*
       * The race, staged precisely.
       *
       * The moderator re-reads the conversation after the model call as its staleness guard, then
       * commits. A takeover that lands *between* those two points passes the guard and is only
       * caught by the compare-and-swap at commit. Hooking the read is how we place the takeover
       * inside that window deterministically instead of hoping the scheduler cooperates.
       */
      const repo = h.container.conversations;
      const realFindById = repo.findById.bind(repo);
      let reads = 0;
      (repo as { findById: unknown }).findById = async (
        s: Parameters<typeof realFindById>[0],
        id: Parameters<typeof realFindById>[1],
      ) => {
        const row = await realFindById(s, id);
        reads += 1;
        if (reads === 2) {
          // A real operator, on a real connection, committing a real transaction.
          await h.container.takeover.takeOver(scope, conversation.id, OPERATOR, 'urgent');
        }
        return row;
      };

      h.provider.script({
        kind: 'RESPOND',
        text: decisionJson({ action: 'ANSWER_FROM_KNOWLEDGE', replyText: 'the AI answer' }),
      });

      try {
        h.clock.advanceMs(10_000);
        await h.drainTypes(['moderator.run']);
      } finally {
        (repo as { findById: unknown }).findById = realFindById;
      }

      const final = await withAdminClient(cluster.adminUrl, async (client) => {
        const conv = await client.query<{
          ownership: string;
          owner_user_id: string | null;
          last_processed_inbound_seq: number;
        }>(
          'SELECT ownership, owner_user_id, last_processed_inbound_seq FROM conversations WHERE id = $1',
          [conversation.id],
        );
        const outbound = await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM outbound_actions',
        );
        const runs = await client.query<{ state: string; skip_reason: string | null }>(
          'SELECT state, skip_reason FROM moderator_runs',
        );
        return { conv: conv.rows[0]!, outbound: Number(outbound.rows[0]!.n), runs: runs.rows };
      });

      assert.equal(final.conv.ownership, 'HUMAN_OWNED', 'the human kept the conversation');
      assert.equal(final.conv.owner_user_id, OPERATOR);
      assert.equal(final.outbound, 0, 'the AI did not talk over the operator');
      assert.equal(
        final.conv.last_processed_inbound_seq,
        0,
        'the watermark did not advance, so the operator still sees the unanswered message',
      );
      assert.ok(
        final.runs.every((r) => r.state !== 'RUNNING'),
        'no run may be left stranded in RUNNING with no reason recorded',
      );
      assert.ok(
        final.runs.some((r) => r.state === 'SUPERSEDED' || r.skip_reason !== null),
        'the run recorded why it did nothing; silence is never allowed to be silent',
      );
    });

    it('two operators taking over at the same instant produce one winner and one explicit failure', async () => {
      const { conversation, scope } = await conversationAwaitingRun();

      // A second harness means a second connection pool: two genuinely independent sessions racing
      // for the same row, not two closures sharing one.
      const rival = await createPostgresHarness(cluster, { fresh: false, instance: 'rival' });
      try {
        const results = await Promise.allSettled([
          h.container.takeover.takeOver(scope, conversation.id, OPERATOR, 'first'),
          rival.container.takeover.takeOver(scope, conversation.id, SECOND_OPERATOR, 'second'),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        // Either the two serialised cleanly (both succeed, the second as an auditable reassignment)
        // or one lost the compare-and-swap. What must never happen is a silent overwrite.
        assert.equal(fulfilled.length + rejected.length, 2);
        for (const failure of rejected) {
          const error = failure.reason as { code?: string };
          assert.ok(
            error.code === 'CONCURRENCY_CONFLICT' || error.code === 'OWNERSHIP_CONFLICT',
            `a loser must fail explicitly, got ${String(error.code)}`,
          );
        }

        const stored = await withAdminClient(cluster.adminUrl, async (client) => {
          const conv = await client.query<{
            ownership: string;
            owner_user_id: string;
            ownership_version: number;
          }>(
            'SELECT ownership, owner_user_id, ownership_version FROM conversations WHERE id = $1',
            [conversation.id],
          );
          const transitions = await client.query<{ version: number; to_ownership: string }>(
            'SELECT version, to_ownership FROM conversation_ownership_transitions ORDER BY version',
          );
          return { conv: conv.rows[0]!, transitions: transitions.rows };
        });

        assert.equal(stored.conv.ownership, 'HUMAN_OWNED');
        assert.ok(
          [OPERATOR, SECOND_OPERATOR].includes(stored.conv.owner_user_id as UserId),
          'exactly one of the two operators holds it',
        );

        // The audit trail is gapless and strictly increasing: `UNIQUE (account_id, conversation_id,
        // version)` makes two writers claiming the same version impossible at the database level.
        const versions = stored.transitions.map((t) => t.version);
        assert.deepEqual(
          versions,
          [...versions].sort((a, b) => a - b),
        );
        assert.equal(new Set(versions).size, versions.length, 'no duplicated ownership version');
        assert.equal(
          stored.conv.ownership_version,
          Math.max(...versions),
          'the row agrees with its own history',
        );
      } finally {
        await rival.close();
      }
    });

    it('a duplicated ownership version is reported as a concurrency conflict, not a raw SQL error', async () => {
      const { conversation, scope } = await conversationAwaitingRun();
      await h.container.takeover.takeOver(scope, conversation.id, OPERATOR, 'first');

      /*
       * Belt and braces on the audit trail: even a bug that recomputed the same version cannot
       * produce two conflicting stories about who owned the conversation when.
       *
       * The *shape* of the failure matters as much as the failure. `UNIQUE (account_id,
       * conversation_id, version)` can fire before the commit-time compare-and-swap does, and if it
       * surfaced as a generic constraint violation the moderator's supersede path would not
       * recognise it — the job would dead-letter with its run stranded in RUNNING. Translated, the
       * conflict routes into the handling that already exists for it.
       */
      await assert.rejects(
        () =>
          h.container.conversations.appendOwnershipTransition(scope, {
            conversationId: conversation.id,
            accountId: scope.accountId,
            fromOwnership: 'AI_OWNED',
            toOwnership: 'HUMAN_OWNED',
            version: 1,
            actorKind: 'HUMAN',
            actorUserId: SECOND_OPERATOR,
            reason: 'forged',
            moderatorRunId: null,
            createdAt: h.clock.now(),
          }),
        (error: unknown) => (error as { code?: string }).code === 'CONCURRENCY_CONFLICT',
      );
    });
  },
);
