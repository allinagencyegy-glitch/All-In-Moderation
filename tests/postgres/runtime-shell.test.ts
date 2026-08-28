import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../../src/platform/clock.ts';
import { createTestClock } from '../../src/platform/clock.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, TraceId } from '../../src/platform/ids.ts';
import { createDeterministicIdFactory } from '../../src/platform/ids.ts';
import { createMockLlmProvider } from '../../src/integrations/llm/mock-provider.ts';
import {
  META_SIGNATURE_HEADER,
  computeMetaSignature,
} from '../../src/integrations/meta/signature.ts';
import { createWorker } from '../../src/operations/jobs/worker.ts';
import { createDeadLetterSink } from '../../src/operations/jobs/dead-letter-sink.ts';
import { createReaper } from '../../src/operations/jobs/reaper.ts';
import { createPostgresJobQueue } from '../../src/adapters/postgres/job-queue.ts';
import { createPostgresDeadLetterStore } from '../../src/adapters/postgres/repositories.ts';
import { createMemorySecretResolver } from '../../src/adapters/memory/repositories.ts';
import { createPostgresPersistence } from '../../src/adapters/postgres/index.ts';
import type { PostgresPersistence } from '../../src/adapters/postgres/index.ts';
import { createApplication } from '../../src/runtime/application.ts';
import type { Application } from '../../src/runtime/application.ts';
import { createScheduledTask } from '../../src/runtime/scheduler.ts';
import { createWorkerLoop } from '../../src/runtime/worker-loop.ts';
import { createHarnessOver } from '../support/harness.ts';
import type { HarnessOver, SeededAccount } from '../support/harness.ts';
import {
  TEST_APP_SECRET,
  TEST_CONFIG,
  TEST_SECRETS,
  metaMessageEnvelope,
} from '../support/harness.ts';
import { createInstanceIdFactory } from '../support/postgres-harness.ts';
import type { PostgresTestCluster, PostgresTestDatabases } from '../support/postgres.ts';
import {
  acquirePostgres,
  createTestDatabases,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';
import { httpRequest, jsonBody } from '../support/http-client.ts';

/**
 * The application shell, running against a real database.
 *
 * The in-memory shell suite proves the mechanics against a Map. This one proves them against the
 * store that can actually contend: the poll loop claims through the real `SKIP LOCKED` path, the
 * scheduled reaper recovers a lease that expired in real wall-clock time, and a graceful shutdown
 * hands a lease back through a real `UPDATE`.
 *
 * It also closes the last item on Phase 01's follow-up list that Phase 02 owns: nothing here
 * calls `drain()` or `reap()`. The process does its own work, on its own timers, and stops when
 * it is told to.
 */

const available = postgresAvailable();
const ACCOUNT = asId<AccountId>('acc_shell_pg');
const TRACE = asId<TraceId>('trc_shell_pg');

async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

describe('postgres runtime shell', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let dbs: PostgresTestDatabases;

  before(async () => {
    cluster = await acquirePostgres();
    dbs = createTestDatabases(cluster, { maxConnections: 6 });
  });

  after(async () => {
    await dbs.close();
    await releasePostgres();
  });

  const seed = async () => {
    await truncateAll(cluster.adminUrl);
    await withAdminClient(cluster.adminUrl, async (client) => {
      await client.query(
        `INSERT INTO accounts (id, slug, name, status) VALUES ($1,$1,'Shell','ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [ACCOUNT],
      );
    });
  };

  const rig = () => {
    const { logger, records } = createMemoryLogger('debug');
    const ids = createDeterministicIdFactory();
    return {
      logger,
      records,
      queue: createPostgresJobQueue({ enqueueDb: dbs.worker, workerDb: dbs.worker, ids }),
      deadLetters: createPostgresDeadLetterStore(dbs.worker, ids),
    };
  };

  const enqueue = (queue: ReturnType<typeof createPostgresJobQueue>, partitionKey: string) =>
    queue.enqueue({
      accountId: ACCOUNT,
      type: 'moderator.run',
      partitionKey,
      payload: {},
      runAt: systemClock.now(),
      maxAttempts: 3,
      traceId: TRACE,
    });

  it('polls continuously and claims work that arrives after it started', async () => {
    await seed();
    const r = rig();
    const handled: string[] = [];
    const loop = createWorkerLoop({
      worker: createWorker({
        queue: r.queue,
        handlers: {
          'moderator.run': (job) => {
            handled.push(job.id);
            return Promise.resolve();
          },
        },
        deadLetters: r.deadLetters,
        clock: systemClock,
        logger: r.logger,
        options: { workerId: 'pg-loop', leaseMs: 30_000 },
      }),
      queue: r.queue,
      clock: systemClock,
      logger: r.logger,
      workerId: 'pg-loop',
      pollIntervalMs: 20,
    });

    loop.start();
    await until(() => loop.stats().idleRounds > 0, 'the loop idled against a real empty queue');

    await enqueue(r.queue, 'pg-p1');
    await enqueue(r.queue, 'pg-p2');
    await until(() => handled.length === 2, 'the running loop claimed both jobs');
    await loop.stop(2_000);

    const counts = await r.queue.countByState();
    assert.equal(counts['SUCCEEDED'], 2);
  });

  it('hands a lease back to the database when a shutdown interrupts a job', async () => {
    await seed();
    const r = rig();
    const loop = createWorkerLoop({
      worker: createWorker({
        queue: r.queue,
        handlers: {
          'moderator.run': (_job, signal) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        },
        deadLetters: r.deadLetters,
        clock: systemClock,
        logger: r.logger,
        options: { workerId: 'pg-interrupt', leaseMs: 60_000 },
      }),
      queue: r.queue,
      clock: systemClock,
      logger: r.logger,
      workerId: 'pg-interrupt',
      pollIntervalMs: 20,
    });

    const job = await enqueue(r.queue, 'pg-interrupt');
    loop.start();
    await until(async () => (await r.queue.findById(job.id))?.state === 'RUNNING', 'claimed');

    const outcome = await loop.stop(5_000);
    assert.equal(outcome.forced, false);

    // The database row, read through the superuser: READY, unleased, one attempt spent, and no
    // dead letter. A 60-second lease would otherwise have frozen this partition for a minute.
    const row = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{
        state: string;
        lease_owner: string | null;
        attempt: number;
        last_error: { code: string } | null;
      }>('SELECT state, lease_owner, attempt, last_error FROM jobs WHERE id = $1', [job.id]);
      return result.rows[0]!;
    });
    assert.equal(row.state, 'READY');
    assert.equal(row.lease_owner, null);
    assert.equal(row.attempt, 1);
    assert.equal(row.last_error?.code, 'LEASE_RELEASED');
    assert.equal(await r.deadLetters.count(), 0, 'an interrupted job is released, not judged');
  });

  it('recovers a lease that really expired, on a timer, with nobody calling reap()', async () => {
    await seed();
    const r = rig();

    const job = await enqueue(r.queue, 'pg-reap');
    // A 200ms lease that a worker takes and then abandons — the crash, in miniature. The expiry
    // is real wall-clock time in the database, not a test clock.
    const claimed = await r.queue.claim({
      workerId: 'pg-dead-worker',
      leaseMs: 200,
      now: systemClock.now(),
    });
    assert.equal(claimed?.id, job.id);

    const reaper = createReaper({
      queue: r.queue,
      deadLetterSink: createDeadLetterSink({
        deadLetters: r.deadLetters,
        clock: systemClock,
        logger: r.logger,
      }),
      clock: systemClock,
      logger: r.logger,
    });
    const task = createScheduledTask({
      name: 'reaper',
      intervalMs: 50,
      run: () => reaper.reap(),
      logger: r.logger,
    });

    task.start();
    await until(
      async () => (await r.queue.findById(job.id))?.state === 'READY',
      'the scheduled reaper recovered the expired lease',
    );
    await task.stop();

    const after = await r.queue.findById(job.id);
    assert.equal(after?.attempt, 1, 'the attempt count survives crash recovery');
    assert.equal(after?.lastError?.code, 'LEASE_EXPIRED');
    assert.ok(task.stats().ticks > 0);
  });

  it('dead-letters a lease that expires with no attempts left, via the same timer', async () => {
    await seed();
    const r = rig();
    const job = await r.queue.enqueue({
      accountId: ACCOUNT,
      type: 'moderator.run',
      partitionKey: 'pg-reap-terminal',
      payload: {},
      runAt: systemClock.now(),
      maxAttempts: 1,
      traceId: TRACE,
    });
    await r.queue.claim({ workerId: 'pg-dying', leaseMs: 200, now: systemClock.now() });

    const reaper = createReaper({
      queue: r.queue,
      deadLetterSink: createDeadLetterSink({
        deadLetters: r.deadLetters,
        clock: systemClock,
        logger: r.logger,
      }),
      clock: systemClock,
      logger: r.logger,
    });
    const task = createScheduledTask({
      name: 'reaper',
      intervalMs: 50,
      run: () => reaper.reap(),
      logger: r.logger,
    });

    task.start();
    await until(
      async () => (await r.queue.findById(job.id))?.state === 'DEAD_LETTERED',
      'the timer dead-lettered the exhausted lease',
    );
    await task.stop();

    // The half that is easy to forget: the queue row is terminal *and* a dead letter exists, so
    // the failure is operator-visible rather than a job that quietly stopped.
    assert.equal(await r.deadLetters.count(), 1);
  });
});

describe('postgres application lifecycle', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let persistence: PostgresPersistence;
  let app: Application;
  let h: HarnessOver<Application['container']>;
  let base: { port: number; host: string };
  let seeded: SeededAccount;

  before(async () => {
    cluster = await acquirePostgres();
    await truncateAll(cluster.adminUrl);

    const clock = createTestClock();
    const ids = createInstanceIdFactory('life');
    const { logger, records } = createMemoryLogger('debug');
    const provider = createMockLlmProvider({ clock });

    persistence = createPostgresPersistence({
      runtimeConnectionString: cluster.runtimeUrl,
      workerConnectionString: cluster.workerUrl,
      relayConnectionString: cluster.relayUrl,
      ids,
      logger,
      secrets: createMemorySecretResolver(TEST_SECRETS),
      pool: { maxConnections: 6, applicationName: 'moderation-test-lifecycle' },
    });

    app = createApplication({
      persistence,
      config: {
        ...TEST_CONFIG,
        // The real thing: web and workers in one process, timers running, nothing driven by hand.
        role: 'all',
        worker: { ...TEST_CONFIG.worker, concurrency: 2, pollIntervalMs: 20 },
        scheduler: { reaperIntervalMs: 50, relayIntervalMs: 50, relayBatchSize: 50 },
      },
      clock,
      ids,
      logger,
      provider,
      closePersistence: () => persistence.close(),
    });
    const started = await app.start();
    base = started.http!;
    h = createHarnessOver(app.container, clock, provider, records);
    seeded = await h.seedAccount({ webhookId: 'pg-life-hook', pageId: 'pg-life-page' });
  });

  after(async () => {
    // Idempotent: the lifecycle test below already stopped it.
    await app.stop('test-cleanup');
    // Balances the `acquirePostgres` above. An unbalanced suite leaves the cluster running and
    // the whole test process never exits — the Phase 01 failure that looked like a slow build
    // rather than a broken one (R-11).
    await releasePostgres();
  });

  it('takes a webhook off the socket and processes it with no drain() call', async () => {
    const raw = JSON.stringify(
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-life', mid: 'm_life_1', text: 'hello there' },
      ]),
    );
    const response = await httpRequest(base, '/webhooks/meta/pg-life-hook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [META_SIGNATURE_HEADER]: computeMetaSignature(raw, TEST_APP_SECRET),
      },
      body: raw,
    });
    assert.equal(jsonBody(response)['status'], 'ACCEPTED');

    // The running workers claim it. This is the whole phase in one assertion: an HTTP request
    // arrives, and the process turns it into a message without a test telling it to.
    await until(async () => {
      const count = await withAdminClient(cluster.adminUrl, async (client) => {
        const result = await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM messages',
        );
        return Number(result.rows[0]!.n);
      });
      return count >= 1;
    }, 'the running worker normalised the delivery');

    const state = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ state: string }>(
        `SELECT state FROM raw_inbound_events WHERE payload::text LIKE '%m_life_1%'`,
      );
      return result.rows[0]!.state;
    });
    assert.equal(state, 'NORMALIZED');
  });

  it('serves health from the database, including the inbound backlog aggregate', async () => {
    const response = await httpRequest(base, '/health/status');
    const body = jsonBody(response);
    const database = body['database'] as { reachable: boolean; latencyMs: number };
    const inbound = body['inbound'] as { pending: number; oldestAt: string | null };

    assert.equal(database.reachable, true);
    assert.ok(database.latencyMs >= 0, 'a real round trip was measured');
    // `app_inbound_backlog()` is a SECURITY DEFINER aggregate; the worker role has no grant on
    // `raw_inbound_events` at all, so a number here proves the function, the grant and the pinned
    // search_path all work.
    assert.equal(typeof inbound.pending, 'number');
    assert.ok('oldestAt' in inbound);

    const live = await httpRequest(base, '/health/live');
    assert.equal(live.status, 200);
  });

  it('shuts down in order: not-ready, listener, timers, workers, pools', async () => {
    await app.stop('SIGTERM');

    assert.equal(app.shuttingDown(), true);
    // Every scheduled task stopped, and stopped after having actually run.
    assert.equal(app.reaperTask?.stats().running, false);
    assert.equal(app.relayTask?.stats().running, false);
    assert.ok((app.reaperTask?.stats().ticks ?? 0) > 0, 'the reaper ran on its timer');
    assert.ok((app.relayTask?.stats().ticks ?? 0) > 0, 'the relay ran on its timer');
    for (const worker of app.workers) assert.equal(worker.stats().running, false);

    // The listener is closed: a new connection is refused rather than accepted and hung.
    await assert.rejects(
      () => httpRequest(base, '/health/live', { timeoutMs: 2_000 }),
      'the socket is closed',
    );

    // And the pools are closed last, which is the ordering assertion — every step above needed
    // the database right up to the moment it finished.
    await assert.rejects(
      () => app.container.queue.countByState(),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_CLOSED',
    );
  });

  it('is safe to stop twice', async () => {
    await app.stop('SIGINT');
    assert.equal(app.shuttingDown(), true);
  });
});
