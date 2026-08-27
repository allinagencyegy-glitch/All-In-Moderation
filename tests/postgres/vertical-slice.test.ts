import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { KnowledgeEntryId } from '../../src/platform/ids.ts';
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
 * Step 15: the whole Phase 0 slice, on PostgreSQL, asserted by querying the database.
 *
 * Every assertion below reads rows back through a superuser connection rather than through the
 * repositories that wrote them. Asking the writer whether it wrote is not a proof of durability;
 * asking the database is.
 */

const available = postgresAvailable();

describe('postgres vertical slice', { skip: available ? false : 'no PostgreSQL' }, () => {
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

  it('a signed webhook becomes durable state, a queued job, and one simulated reply', async () => {
    const seeded = await h.seedAccount();
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_hours'),
      title: 'Opening hours',
      body: 'Open Monday to Friday, 9 to 5.',
      intentCodes: ['GENERAL_QUESTION'],
      tags: ['hours'],
    });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        action: 'ANSWER_FROM_KNOWLEDGE',
        replyText: 'We are open Monday to Friday, 9 to 5.',
        knowledgeRefs: ['kne_hours'],
      }),
    });

    const outcome = await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_1', text: 'What are your hours?' },
      ]),
    );
    assert.equal(outcome.status, 'ACCEPTED');

    // The ingest transaction has committed: the ledger row and its job are both durable, and the
    // model has not been consulted yet. "Persist first, process second" as a database fact.
    const ledger = await rows<{ state: string; signature_valid: boolean }>(
      'SELECT state, signature_valid FROM raw_inbound_events',
    );
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.signature_valid, true);
    assert.equal(h.provider.callCount(), 0, 'nothing interpreted before the event was durable');

    const queuedBeforeWork = await rows<{ type: string; state: string }>(
      'SELECT type, state FROM jobs',
    );
    assert.deepEqual(queuedBeforeWork, [{ type: 'raw_event.normalize', state: 'READY' }]);

    await h.drain();
    h.clock.advanceMs(10_000);
    await h.drain();

    const conversations = await rows<{
      id: string;
      ownership: string;
      last_processed_inbound_seq: number;
      engagement: string;
    }>('SELECT id, ownership, last_processed_inbound_seq, engagement FROM conversations');
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]!.ownership, 'AI_OWNED');
    assert.equal(conversations[0]!.last_processed_inbound_seq, 1, 'the watermark advanced');
    assert.equal(conversations[0]!.engagement, 'AWAITING_CUSTOMER');

    const outbound = await rows<{
      state: string;
      delivery_mode: string;
      idempotency_key: string;
      payload: { text?: string };
    }>('SELECT state, delivery_mode, idempotency_key, payload FROM outbound_actions');
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]!.delivery_mode, 'SIMULATED', 'nothing was sent to a network');
    assert.equal(outbound[0]!.state, 'SIMULATED');
    assert.match(outbound[0]!.payload.text ?? '', /Monday to Friday/);

    const runs = await rows<{ state: string; pack_version_id: string; decision: unknown }>(
      'SELECT state, pack_version_id, decision FROM moderator_runs',
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.state, 'COMPLETED');
    assert.equal(runs[0]!.pack_version_id, seeded.packId, 'the run is pinned to a pack version');
    assert.ok(runs[0]!.decision, 'a completed run must carry its decision');

    const outbox = await rows<{ type: string }>(
      'SELECT type FROM domain_event_outbox ORDER BY occurred_at, id',
    );
    assert.ok(outbox.some((e) => e.type === 'conversation.started'));

    const jobs = await rows<{ type: string; state: string }>(
      'SELECT type, state FROM jobs ORDER BY seq',
    );
    assert.deepEqual(
      jobs.map((j) => j.state),
      ['SUCCEEDED', 'SUCCEEDED'],
      'both jobs finished; none is left RUNNING with a live lease',
    );
  });

  it('the message body is stored once, with its provenance intact', async () => {
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.drain();

    const messages = await rows<{
      id: string;
      seq: number;
      direction: string;
      dedupe_key: string;
      dedupe_source: string;
      raw_inbound_event_id: string | null;
      text: string;
    }>(
      `SELECT id, seq, direction, dedupe_key, dedupe_source, raw_inbound_event_id, text
         FROM messages ORDER BY seq`,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.seq, 1);
    assert.equal(messages[0]!.direction, 'INBOUND');
    assert.equal(messages[0]!.dedupe_source, 'PROVIDER_ID');
    assert.equal(messages[0]!.text, 'hello');

    // Provenance runs ledger -> message, not the other way: `produced_message_ids` is what a
    // corrected parser replays from, and it is the direction the immutable ledger can guarantee.
    const produced = await rows<{ produced_message_ids: string[]; state: string }>(
      'SELECT produced_message_ids, state FROM raw_inbound_events',
    );
    assert.equal(produced[0]!.state, 'NORMALIZED');
    assert.deepEqual(
      produced[0]!.produced_message_ids,
      [messages[0]!.id],
      'the ledger names exactly the message it produced, which is what makes replay possible',
    );
  });

  it('an invalid signature is recorded and never interpreted', async () => {
    const seeded = await h.seedAccount();
    const outcome = await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
      ]),
      { signature: 'sha256=deadbeef' },
    );
    assert.equal(outcome.status, 'REJECTED_SIGNATURE');

    const jobs = await rows<{ count: string }>('SELECT count(*)::text AS count FROM jobs');
    assert.equal(Number(jobs[0]!.count), 0, 'a forged delivery must not schedule work');
    assert.equal(h.provider.callCount(), 0);
  });

  it('two accounts processed through the same worker keep their rows apart', async () => {
    const a = await h.seedAccount({ webhookId: 'hook-a', pageId: 'page-a', slug: 'acct-a' });
    const b = await h.seedAccount({ webhookId: 'hook-b', pageId: 'page-b', slug: 'acct-b' });
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      a,
      metaMessageEnvelope('page-a', [{ senderId: 'psid_a', mid: 'm_a', text: 'from a' }]),
    );
    await h.postWebhook(
      b,
      metaMessageEnvelope('page-b', [{ senderId: 'psid_b', mid: 'm_b', text: 'from b' }]),
    );
    await h.drain();
    h.clock.advanceMs(10_000);
    await h.drain();

    const pairs = await rows<{ account_id: string; text: string }>(
      'SELECT account_id, text FROM messages ORDER BY account_id',
    );
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0]!.account_id, a.account.id);
    assert.equal(pairs[0]!.text, 'from a');
    assert.equal(pairs[1]!.account_id, b.account.id);
    assert.equal(pairs[1]!.text, 'from b');

    // Partition keys are tenant-prefixed, so two accounts can never contend for one partition.
    const partitions = await rows<{ partition_key: string }>(
      "SELECT DISTINCT partition_key FROM jobs WHERE type = 'moderator.run'",
    );
    assert.equal(partitions.length, 2);
    for (const p of partitions) assert.match(p.partition_key, /^acct:acc_test_\d+:conv:/);
  });
});
