import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { asId } from '../../src/platform/ids.ts';
import type { ConversationId } from '../../src/platform/ids.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { createDeadLetterSink } from '../../src/operations/jobs/dead-letter-sink.ts';
import { createReaper } from '../../src/operations/jobs/reaper.ts';
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
 * Steps 12 and 17: crash recovery, dead letters, and deliberate failure injection.
 *
 * Phase 0 found that lease expiry could move a job to the terminal `DEAD_LETTERED` state without
 * writing a dead-letter row or raising a handoff — a crashed worker was a *quieter* way to abandon
 * a customer than a failing one. That fix is re-proven here against a database that can actually
 * lose a worker mid-flight.
 *
 * The standard every case below is held to: **no silent failure**. Every injected fault must end
 * as a durable, queryable, escalated fact.
 */

const available = postgresAvailable();

describe(
  'postgres durability and failure injection',
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

    const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      await withAdminClient(cluster.adminUrl, async (client) => {
        const result = await client.query(sql, params);
        return result.rows as T[];
      });

    /** Drives one message to the point where a moderator job is queued and claimable. */
    const queuedModeratorJob = async (options: { maxAttempts?: number } = {}) => {
      const seeded = await h.seedAccount();
      await h.postWebhook(
        seeded,
        metaMessageEnvelope(seeded.connection.externalId, [
          { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
        ]),
      );
      await h.drainTypes(['raw_event.normalize']);
      h.clock.advanceMs(10_000);
      if (options.maxAttempts !== undefined) {
        await query("UPDATE jobs SET max_attempts = $1 WHERE type = 'moderator.run'", [
          options.maxAttempts,
        ]);
      }
      return seeded;
    };

    it('a crashed worker returns its job to READY once the lease lapses', async () => {
      await queuedModeratorJob();
      const claimed = await h.persistence.queue.claim({
        workerId: 'doomed',
        leaseMs: 1_000,
        now: h.clock.now(),
      });
      assert.ok(claimed);

      // The worker dies here: no complete, no fail, no lease renewal.
      h.clock.advanceMs(1_500);
      const outcome = await h.container.reaper.reap();

      assert.deepEqual(outcome.requeued, [claimed.id]);
      assert.deepEqual(outcome.deadLettered, []);

      const [job] = await query<{ state: string; attempt: number; lease_owner: string | null }>(
        'SELECT state, attempt, lease_owner FROM jobs WHERE id = $1',
        [claimed.id],
      );
      assert.equal(job!.state, 'READY');
      assert.equal(job!.attempt, 1, 'the attempt survives, so a crash loop still exhausts retries');
      assert.equal(job!.lease_owner, null);
      assert.equal(
        await h.container.deadLetters.count(),
        0,
        'a recoverable crash is not a dead end',
      );
    });

    it('a lease that expires with no attempts left is recorded and escalated, never silently buried', async () => {
      const seeded = await queuedModeratorJob({ maxAttempts: 1 });
      const claimed = await h.persistence.queue.claim({
        workerId: 'doomed',
        leaseMs: 1_000,
        now: h.clock.now(),
      });
      assert.ok(claimed);

      h.clock.advanceMs(1_500);
      const outcome = await h.container.reaper.reap();
      assert.deepEqual(outcome.deadLettered, [claimed.id]);

      const [job] = await query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [
        claimed.id,
      ]);
      assert.equal(job!.state, 'DEAD_LETTERED');

      // The three things that make a dead letter visible rather than a disappearance.
      assert.equal(await h.container.deadLetters.count(), 1, 'an operator can query it');
      const [letter] = await query<{ job_id: string; error: { code: string }; attempts: number }>(
        'SELECT job_id, error, attempts FROM dead_letters',
      );
      assert.equal(letter!.job_id, claimed.id);
      assert.equal(letter!.error.code, 'LEASE_EXPIRED');

      const handoffs = await query<{ state: string; reason_code: string }>(
        'SELECT state, reason_code FROM handoffs',
      );
      assert.equal(handoffs.length, 1, 'a human was asked to take the conversation');
      assert.equal(handoffs[0]!.state, 'REQUESTED');

      const [conversation] = await query<{ ownership: string }>(
        'SELECT ownership FROM conversations WHERE id = $1',
        [asId<ConversationId>(`cnv_0001`)],
      );
      assert.equal(conversation!.ownership, 'PENDING_HUMAN');
      assert.ok(seeded.account.id);
    });

    it('there is no terminal orphan: every reaped job is either retryable or escalated', async () => {
      await queuedModeratorJob({ maxAttempts: 1 });
      const claimed = await h.persistence.queue.claim({
        workerId: 'doomed',
        leaseMs: 500,
        now: h.clock.now(),
      });
      assert.ok(claimed);
      h.clock.advanceMs(1_000);
      await h.container.reaper.reap();

      const orphans = await query<{ id: string }>(
        `SELECT j.id FROM jobs j
        WHERE j.state = 'DEAD_LETTERED'
          AND NOT EXISTS (SELECT 1 FROM dead_letters d WHERE d.job_id = j.id)`,
      );
      assert.deepEqual(
        orphans,
        [],
        'a dead-lettered job with no dead-letter row is an abandonment',
      );
    });

    it('two reapers running at once do not double-recover the same job', async () => {
      await queuedModeratorJob({ maxAttempts: 1 });
      const claimed = await h.persistence.queue.claim({
        workerId: 'doomed',
        leaseMs: 500,
        now: h.clock.now(),
      });
      assert.ok(claimed);
      h.clock.advanceMs(1_000);

      // A second, independent reaper on its own pool — the realistic deployment, not a hypothetical.
      const rival = await createPostgresHarness(cluster, { fresh: false, instance: 'reaper2' });
      try {
        const rivalReaper = createReaper({
          queue: rival.persistence.queue,
          deadLetterSink: createDeadLetterSink({
            deadLetters: rival.persistence.deadLetters,
            clock: rival.clock,
            logger: createMemoryLogger().logger,
          }),
          clock: h.clock,
          logger: createMemoryLogger().logger,
        });

        const [a, b] = await Promise.all([h.container.reaper.reap(), rivalReaper.reap()]);
        const allIds = [...a.requeued, ...a.deadLettered, ...b.requeued, ...b.deadLettered];
        assert.equal(allIds.length, 1, `exactly one reaper claimed the job, got ${String(allIds)}`);

        const letters = await query<{ n: string }>('SELECT count(*)::text AS n FROM dead_letters');
        assert.equal(Number(letters[0]!.n), 1, 'and it was recorded once, not twice');
      } finally {
        await rival.close();
      }
    });

    it('repeated reaping does not stack handoffs for one conversation', async () => {
      await queuedModeratorJob({ maxAttempts: 1 });
      const claimed = await h.persistence.queue.claim({
        workerId: 'doomed',
        leaseMs: 500,
        now: h.clock.now(),
      });
      assert.ok(claimed);
      h.clock.advanceMs(1_000);

      await h.container.reaper.reap();
      await h.container.reaper.reap();
      await h.container.reaper.reap();

      const handoffs = await query<{ n: string }>('SELECT count(*)::text AS n FROM handoffs');
      assert.equal(Number(handoffs[0]!.n), 1, 'the operator queue is not flooded by a timer');
    });

    // --- failure injection ------------------------------------------------------------------------

    it('a worker exception is retried with backoff, then dead-lettered and escalated', async () => {
      await queuedModeratorJob({ maxAttempts: 2 });
      h.provider.script({ kind: 'TRANSIENT_ERROR', code: 'PROVIDER_EXPLODED' });

      for (let attempt = 0; attempt < 4; attempt++) {
        await h.drainTypes(['moderator.run']);
        h.clock.advanceMs(60_000);
      }

      const [job] = await query<{ state: string; attempt: number; last_error: { code: string } }>(
        "SELECT state, attempt, last_error FROM jobs WHERE type = 'moderator.run'",
      );
      assert.equal(job!.state, 'DEAD_LETTERED', 'retries are bounded');
      assert.ok(job!.attempt <= 2, 'and bounded by max_attempts, not by luck');
      assert.equal(await h.container.deadLetters.count(), 1);
      const handoffs = await query<{ n: string }>('SELECT count(*)::text AS n FROM handoffs');
      assert.equal(Number(handoffs[0]!.n), 1, 'the customer is handed to a person, not dropped');
    });

    it('an archived account fails the job terminally instead of acting without authority', async () => {
      const seeded = await queuedModeratorJob();
      // A scope cannot be minted for an archived account (ADR-002). The job must stop, loudly.
      await query("UPDATE accounts SET status = 'ARCHIVED' WHERE id = $1", [seeded.account.id]);

      await h.drainTypes(['moderator.run']);

      const [job] = await query<{ state: string; last_error: { code: string } | null }>(
        "SELECT state, last_error FROM jobs WHERE type = 'moderator.run'",
      );
      assert.equal(job!.state, 'DEAD_LETTERED', 'a terminal error is not retried');
      assert.equal(job!.last_error?.code, 'ACCOUNT_ARCHIVED');
      const outbound = await query<{ n: string }>(
        'SELECT count(*)::text AS n FROM outbound_actions',
      );
      assert.equal(Number(outbound[0]!.n), 0, 'nothing was sent on behalf of an archived client');
    });

    it('a killed connection surfaces as a retryable failure, not a terminal one', async () => {
      // The most common production fault of all: the database restarts, or an admin disconnects a
      // backend. Misclassifying it as terminal would dead-letter healthy work during a failover.
      const victim = new pg.Client({ connectionString: cluster.runtimeUrl });
      // A killed backend reaches the driver by two routes that race each other: the pending
      // query rejects, and the client emits `error` asynchronously when the socket closes.
      // Whichever wins, the *other* still happens — and an `error` event with no listener is
      // fatal in Node, which made this test fail intermittently for reasons unrelated to what it
      // asserts. Capturing the event is what makes it deterministic; the assertion is unchanged.
      let asyncError: unknown = null;
      victim.on('error', (error: unknown) => {
        asyncError ??= error;
      });
      await victim.connect();
      const pid = await victim
        .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        .then((r) => r.rows[0]!.pid);

      await withAdminClient(cluster.adminUrl, async (client) => {
        await client.query('SELECT pg_terminate_backend($1)', [pid]);
      });

      const queryError = await victim.query('SELECT 1').then(
        () => null,
        (error: unknown) => error,
      );
      // The asynchronous event carries PostgreSQL's own 57P01; the query rejection may be the
      // derived "not queryable" symptom, so prefer the cause when both arrived.
      const failure = asyncError ?? queryError;
      assert.ok(failure, 'the terminated backend really did fail');

      const { isTransientPgError } = await import('../../src/adapters/postgres/errors.ts');
      assert.equal(
        isTransientPgError(failure),
        true,
        'a lost connection must be retried, never dead-lettered',
      );
      // Both routes must classify the same way. A worker that retried one and dead-lettered the
      // other would behave differently depending on socket timing.
      if (queryError && asyncError) {
        assert.equal(isTransientPgError(queryError), true, 'the derived symptom is retryable too');
      }
      await victim.end().catch(() => undefined);
    });

    it('an outbox publisher failure takes the whole commit with it', async () => {
      const seeded = await h.seedAccount();
      h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });
      await h.postWebhook(
        seeded,
        metaMessageEnvelope(seeded.connection.externalId, [
          { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
        ]),
      );
      await h.drainTypes(['raw_event.normalize']);
      h.clock.advanceMs(10_000);

      const outbox = h.persistence.outbox;
      const original = outbox.append.bind(outbox);
      let failures = 0;
      (outbox as { append: unknown }).append = () => {
        failures += 1;
        return Promise.reject(new Error('publisher exploded'));
      };
      try {
        await h.drainTypes(['moderator.run']);
      } finally {
        (outbox as { append: unknown }).append = original;
      }

      assert.ok(failures > 0, 'the injected failure was actually reached');
      const outbound = await query<{ n: string }>(
        'SELECT count(*)::text AS n FROM outbound_actions',
      );
      assert.equal(
        Number(outbound[0]!.n),
        0,
        'no outbound action survived a commit whose event could not be published',
      );
      const watermark = await query<{ last_processed_inbound_seq: number }>(
        'SELECT last_processed_inbound_seq FROM conversations',
      );
      assert.equal(
        watermark[0]!.last_processed_inbound_seq,
        0,
        'and the message is still pending, so nothing was skipped',
      );
    });

    it('a duplicate delivery after processing changes nothing', async () => {
      const seeded = await h.seedAccount();
      h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });
      const body = metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
      ]);

      await h.postWebhook(seeded, body);
      await h.drain();
      h.clock.advanceMs(10_000);
      await h.drain();

      const before = await query<{ table_name: string; n: string }>(
        `SELECT 'messages' AS table_name, count(*)::text AS n FROM messages
       UNION ALL SELECT 'runs', count(*)::text FROM moderator_runs
       UNION ALL SELECT 'outbound', count(*)::text FROM outbound_actions`,
      );

      const replay = await h.postWebhook(seeded, body);
      assert.equal(replay.status, 'DUPLICATE');
      await h.drain();

      const after = await query<{ table_name: string; n: string }>(
        `SELECT 'messages' AS table_name, count(*)::text AS n FROM messages
       UNION ALL SELECT 'runs', count(*)::text FROM moderator_runs
       UNION ALL SELECT 'outbound', count(*)::text FROM outbound_actions`,
      );
      assert.deepEqual(after, before, 'a redelivered webhook is a non-event');
    });

    it('a job whose handler has no registration is dead-lettered, not dropped', async () => {
      const seeded = await h.seedAccount();
      // `outbound.dispatch` is deliberately unregistered in Phase 0. A job of that type must not
      // vanish quietly; an unhandled job that disappears is the failure class we promised not to
      // have.
      await h.persistence.queue.enqueue({
        accountId: seeded.account.id,
        type: 'outbound.dispatch',
        partitionKey: 'acct:x:conv:y',
        payload: {},
        runAt: h.clock.now(),
        traceId: asId('trc_x'),
      });

      await h.drainTypes(['outbound.dispatch']);

      const [job] = await query<{ state: string; last_error: { code: string } | null }>(
        "SELECT state, last_error FROM jobs WHERE type = 'outbound.dispatch'",
      );
      assert.equal(job!.state, 'DEAD_LETTERED');
      assert.equal(job!.last_error?.code, 'NO_HANDLER');
      assert.equal(await h.container.deadLetters.count(), 1);
    });

    it('a dead letter survives the job row it describes', async () => {
      const seeded = await queuedModeratorJob({ maxAttempts: 1 });
      const claimed = await h.persistence.queue.claim({
        workerId: 'doomed',
        leaseMs: 500,
        now: h.clock.now(),
      });
      assert.ok(claimed);
      h.clock.advanceMs(1_000);
      await h.container.reaper.reap();

      // Retention will eventually purge the queue. The dead letter is a snapshot, not a join, so it
      // stays readable and replayable afterwards.
      await query('DELETE FROM jobs WHERE id = $1', [claimed.id]);
      const letters = await h.container.deadLetters.list();
      assert.equal(letters.length, 1);
      assert.equal(letters[0]!.job.id, claimed.id);
      assert.equal(letters[0]!.job.accountId, seeded.account.id);
      assert.equal(letters[0]!.error.code, 'LEASE_EXPIRED');
    });
  },
);
