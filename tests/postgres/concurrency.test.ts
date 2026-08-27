import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { asId, createDeterministicIdFactory } from '../../src/platform/ids.ts';
import type { AccountId, TraceId } from '../../src/platform/ids.ts';
import { createPostgresJobQueue } from '../../src/adapters/postgres/job-queue.ts';
import type { JobQueue } from '../../src/operations/jobs/queue.ts';
import { decisionJson, metaMessageEnvelope } from '../support/harness.ts';
import type { PostgresHarness } from '../support/postgres-harness.ts';
import { createPostgresHarness } from '../support/postgres-harness.ts';
import type { PostgresTestCluster, PostgresTestDatabases } from '../support/postgres.ts';
import {
  acquirePostgres,
  createTestDatabases,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * Steps 9, 10 and 11: partition serialisation, duplicate ingest, and bursts — under real
 * concurrency.
 *
 * "Concurrent" here means separate connection pools issuing overlapping statements against one
 * server, never `await` in a loop dressed up as parallelism. That distinction is the entire value
 * of this file: the in-memory adapter runs on one thread, so *every* concurrency guarantee it
 * appears to provide is an artefact of there being nothing to race against.
 */

const ACCOUNT = asId<AccountId>('acc_conc');
const TRACE = asId<TraceId>('trc_conc');

const available = postgresAvailable();

describe('postgres concurrency', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  /** One pool per worker: genuinely independent sessions competing for the same rows. */
  let pools: PostgresTestDatabases[] = [];

  before(async () => {
    cluster = await acquirePostgres();
  });

  after(async () => {
    await Promise.all(pools.map((p) => p.close()));
    await releasePostgres();
  });

  const freshQueues = async (n: number): Promise<JobQueue[]> => {
    await Promise.all(pools.map((p) => p.close()));
    pools = [];
    await truncateAll(cluster.adminUrl);
    await withAdminClient(cluster.adminUrl, async (client) => {
      await client.query(
        `INSERT INTO accounts (id, slug, name, status) VALUES ($1,$1,'Conc','ACTIVE')`,
        [ACCOUNT],
      );
    });
    const queues: JobQueue[] = [];
    for (let i = 0; i < n; i++) {
      const dbs = createTestDatabases(cluster, { maxConnections: 4 });
      pools.push(dbs);
      queues.push(
        createPostgresJobQueue({
          enqueueDb: dbs.worker,
          workerDb: dbs.worker,
          ids: createDeterministicIdFactory(),
        }),
      );
    }
    return queues;
  };

  const enqueue = (queue: JobQueue, partitionKey: string, now: Date) =>
    queue.enqueue({
      accountId: ACCOUNT,
      type: 'moderator.run',
      partitionKey,
      payload: {},
      runAt: now,
      traceId: TRACE,
    });

  it('three concurrent workers cannot claim the same partition at once', async () => {
    const [q0, q1, q2] = await freshQueues(3);
    const now = new Date();
    // Three separate jobs, one partition. Nothing stops three workers picking three *different*
    // rows — which is exactly the write skew a bare `NOT EXISTS` check permits.
    await enqueue(q0!, 'p_shared', now);
    await enqueue(q0!, 'p_shared', now);
    await enqueue(q0!, 'p_shared', now);

    const claims = await Promise.all([
      q0!.claim({ workerId: 'w0', leaseMs: 60_000, now }),
      q1!.claim({ workerId: 'w1', leaseMs: 60_000, now }),
      q2!.claim({ workerId: 'w2', leaseMs: 60_000, now }),
    ]);

    const won = claims.filter((job) => job !== null);
    assert.equal(won.length, 1, 'exactly one worker may hold a conversation at a time');

    const running = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM jobs WHERE state = 'RUNNING'",
      );
      return Number(result.rows[0]!.n);
    });
    assert.equal(running, 1, 'the database agrees: one RUNNING row in the partition');
  });

  it('different conversations do run concurrently', async () => {
    const [q0, q1, q2] = await freshQueues(3);
    const now = new Date();
    await enqueue(q0!, 'p_a', now);
    await enqueue(q0!, 'p_b', now);
    await enqueue(q0!, 'p_c', now);

    const claims = await Promise.all([
      q0!.claim({ workerId: 'w0', leaseMs: 60_000, now }),
      q1!.claim({ workerId: 'w1', leaseMs: 60_000, now }),
      q2!.claim({ workerId: 'w2', leaseMs: 60_000, now }),
    ]);

    const won = claims.filter((job) => job !== null);
    assert.equal(won.length, 3, 'cross-conversation parallelism is the other half of the design');
    assert.equal(new Set(won.map((j) => j.partitionKey)).size, 3);
  });

  it('sustained contention never overlaps two runs of one conversation', async () => {
    const queues = await freshQueues(4);
    const now = new Date();
    for (let i = 0; i < 12; i++) await enqueue(queues[0]!, 'p_hot', now);

    let inFlight = 0;
    let maxInFlight = 0;
    let processed = 0;

    // Four workers hammering one partition. `maxInFlight` is the observation that matters: a
    // conversation answered by two workers at once is two replies to one customer.
    await Promise.all(
      queues.map(async (queue, index) => {
        for (;;) {
          const job = await queue.claim({
            workerId: `w${String(index)}`,
            leaseMs: 60_000,
            now: new Date(),
          });
          if (!job) {
            const remaining = await queue.countByState();
            if ((remaining['READY'] ?? 0) === 0) break;
            continue;
          }
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setImmediate(resolve));
          inFlight -= 1;
          processed += 1;
          await queue.complete(job.id, new Date());
        }
      }),
    );

    assert.equal(maxInFlight, 1, 'partition exclusivity held under real contention');
    assert.equal(processed, 12, 'and every job was still processed exactly once');
  });

  it('a job is claimed exactly once even when many workers race for it', async () => {
    const queues = await freshQueues(6);
    const now = new Date();
    await enqueue(queues[0]!, 'p_single', now);

    const claims = await Promise.all(
      queues.map((queue, i) => queue.claim({ workerId: `w${String(i)}`, leaseMs: 60_000, now })),
    );
    const ids = claims.filter((j) => j !== null).map((j) => j.id);
    assert.equal(ids.length, 1);

    const attempt = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ attempt: number }>(
        'SELECT attempt FROM jobs WHERE id = $1',
        [ids[0]],
      );
      return result.rows[0]!.attempt;
    });
    assert.equal(attempt, 1, 'the attempt counter was incremented once, not six times');
  });
});

describe(
  'postgres duplicate ingest and bursts',
  { skip: available ? false : 'no PostgreSQL' },
  () => {
    let cluster: PostgresTestCluster;
    let h: PostgresHarness;
    let rivals: PostgresHarness[] = [];

    before(async () => {
      cluster = await acquirePostgres();
    });

    beforeEach(async () => {
      await Promise.all(rivals.map((r) => r.close()));
      rivals = [];
      await h?.close();
      h = await createPostgresHarness(cluster);
    });

    after(async () => {
      await Promise.all(rivals.map((r) => r.close()));
      await h?.close();
      await releasePostgres();
    });

    /** N additional harnesses on the already-seeded database: N independent ingest processes. */
    const withRivals = async (n: number): Promise<PostgresHarness[]> => {
      for (let i = 0; i < n; i++) {
        rivals.push(
          await createPostgresHarness(cluster, {
            fresh: false,
            instance: `rival-${String(i)}`,
            clock: h.clock,
          }),
        );
      }
      return rivals;
    };

    const counts = async (): Promise<Record<string, number>> =>
      await withAdminClient(cluster.adminUrl, async (client) => {
        const out: Record<string, number> = {};
        for (const table of [
          'raw_inbound_events',
          'messages',
          'conversations',
          'moderator_runs',
          'outbound_actions',
          'jobs',
        ]) {
          const result = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${table}`,
          );
          out[table] = Number(result.rows[0]!.n);
        }
        return out;
      });

    it('two concurrent deliveries of one event produce exactly one of everything', async () => {
      const seeded = await h.seedAccount();
      const [rival] = await withRivals(1);
      h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });
      rival!.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

      const body = metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_dup', text: 'is this a duplicate?' },
      ]);

      const outcomes = await Promise.all([
        h.postWebhook(seeded, body),
        rival!.postWebhook(seeded, body),
      ]);

      const statuses = outcomes.map((o) => o.status).sort();
      assert.deepEqual(
        statuses,
        ['ACCEPTED', 'DUPLICATE'],
        'the loser is told it is a duplicate rather than being handed an error',
      );

      await h.drain();
      h.clock.advanceMs(10_000);
      await h.drain();

      const c = await counts();
      assert.equal(c['raw_inbound_events'], 1, 'the unique index arbitrated, not a pre-check');
      assert.equal(c['messages'], 1);
      assert.equal(c['conversations'], 1);
      assert.equal(c['moderator_runs'], 1, 'no duplicate moderator processing');
      assert.equal(c['outbound_actions'], 1, 'one action, not one per delivery');
    });

    it('ten concurrent deliveries of one event still produce exactly one', async () => {
      const seeded = await h.seedAccount();
      const many = await withRivals(9);
      const all = [h, ...many];
      for (const harness of all) {
        harness.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });
      }

      const body = metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_storm', text: 'ten times over' },
      ]);

      const outcomes = await Promise.all(all.map((harness) => harness.postWebhook(seeded, body)));
      assert.equal(
        outcomes.filter((o) => o.status === 'ACCEPTED').length,
        1,
        'exactly one delivery is new',
      );
      assert.equal(outcomes.filter((o) => o.status === 'DUPLICATE').length, 9);

      await h.drain();
      h.clock.advanceMs(10_000);
      await h.drain();

      const c = await counts();
      assert.equal(c['raw_inbound_events'], 1);
      assert.equal(c['messages'], 1);
      assert.equal(c['jobs'], 2, 'one normalize job and one moderator job — not ten of each');
    });

    it('the same message inside two different envelopes is still one message', async () => {
      const seeded = await h.seedAccount();
      const [rival] = await withRivals(1);
      h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

      // Different delivery keys (the bodies differ by timestamp) but the same provider message id.
      // Level-1 dedupe cannot catch this; level-2 must (ADR-006, F-02).
      await h.postWebhook(
        seeded,
        metaMessageEnvelope(
          seeded.connection.externalId,
          [{ senderId: 'psid_1', mid: 'm_same', text: 'hello' }],
          1_767_225_600_000,
        ),
      );
      await rival!.postWebhook(
        seeded,
        metaMessageEnvelope(
          seeded.connection.externalId,
          [{ senderId: 'psid_1', mid: 'm_same', text: 'hello' }],
          1_767_225_601_000,
        ),
      );

      await h.drain();
      const c = await counts();
      assert.equal(c['raw_inbound_events'], 2, 'both deliveries are recorded in the ledger');
      assert.equal(c['messages'], 1, 'but the customer said it once');
    });

    it('a burst of three messages keeps every event and answers once', async () => {
      const seeded = await h.seedAccount({ debounceMs: 2_500, maxDelayMs: 8_000 });
      h.provider.script({
        kind: 'RESPOND',
        text: decisionJson({
          action: 'ANSWER_FROM_KNOWLEDGE',
          replyText: 'one answer for all three',
        }),
      });

      for (const [index, text] of ['price?', 'for the large one', 'and instalments?'].entries()) {
        await h.postWebhook(
          seeded,
          metaMessageEnvelope(
            seeded.connection.externalId,
            [{ senderId: 'psid_1', mid: `m_${String(index)}`, text }],
            1_767_225_600_000 + index * 1_000,
          ),
        );
        h.clock.advanceMs(400);
        await h.drainTypes(['raw_event.normalize']);
      }

      const beforeRun = await counts();
      assert.equal(beforeRun['raw_inbound_events'], 3, 'no event discarded because of coalescing');
      assert.equal(beforeRun['messages'], 3, 'every message is retained');

      const moderatorJobs = await withAdminClient(cluster.adminUrl, async (client) => {
        const result = await client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM jobs WHERE type = 'moderator.run'",
        );
        return Number(result.rows[0]!.n);
      });
      assert.equal(moderatorJobs, 1, 'three messages coalesced onto one scheduled run');

      h.clock.advanceMs(10_000);
      await h.drain();

      const after = await counts();
      assert.equal(after['moderator_runs'], 1, 'one run, not three');
      assert.equal(after['outbound_actions'], 1, 'one reply, not three');

      const ordering = await withAdminClient(cluster.adminUrl, async (client) => {
        const result = await client.query<{ seq: number; text: string }>(
          'SELECT seq, text FROM messages ORDER BY seq',
        );
        return result.rows;
      });
      assert.deepEqual(
        ordering.map((m) => m.seq),
        [1, 2, 3],
        'the conversation stayed gaplessly ordered',
      );
      assert.deepEqual(
        ordering.map((m) => m.text),
        ['price?', 'for the large one', 'and instalments?'],
      );

      const watermark = await withAdminClient(cluster.adminUrl, async (client) => {
        const result = await client.query<{ last_processed_inbound_seq: number }>(
          'SELECT last_processed_inbound_seq FROM conversations',
        );
        return result.rows[0]!.last_processed_inbound_seq;
      });
      assert.equal(watermark, 3, 'the single run answered all three messages');
    });

    it('a message arriving mid-run schedules a follow-up rather than being swallowed', async () => {
      const seeded = await h.seedAccount({ debounceMs: 0, maxDelayMs: 0 });
      h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

      await h.postWebhook(
        seeded,
        metaMessageEnvelope(seeded.connection.externalId, [
          { senderId: 'psid_1', mid: 'm_1', text: 'first' },
        ]),
      );
      await h.drainTypes(['raw_event.normalize']);

      // Claim the moderator job so it is RUNNING, then deliver another message. The coalescing index
      // covers READY only, so this must create a *new* job behind the running one.
      const claimed = await h.persistence.queue.claim({
        workerId: 'holder',
        leaseMs: 60_000,
        now: h.clock.now(),
      });
      assert.ok(claimed);

      await h.postWebhook(
        seeded,
        metaMessageEnvelope(
          seeded.connection.externalId,
          [{ senderId: 'psid_1', mid: 'm_2', text: 'second' }],
          1_767_225_602_000,
        ),
      );
      await h.drainTypes(['raw_event.normalize']);

      const moderatorJobs = await withAdminClient(cluster.adminUrl, async (client) => {
        const result = await client.query<{ state: string }>(
          "SELECT state FROM jobs WHERE type = 'moderator.run' ORDER BY seq",
        );
        return result.rows.map((r) => r.state);
      });
      assert.deepEqual(
        moderatorJobs,
        ['RUNNING', 'READY'],
        'the follow-up queued behind the run instead of being coalesced into it and lost',
      );
    });
  },
);
