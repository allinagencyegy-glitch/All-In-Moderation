import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { asId, createDeterministicIdFactory } from '../../src/platform/ids.ts';
import type { AccountId, TraceId } from '../../src/platform/ids.ts';
import { createPostgresJobQueue } from '../../src/adapters/postgres/job-queue.ts';
import type { JobQueue } from '../../src/operations/jobs/queue.ts';
import type { PostgresTestCluster, PostgresTestDatabases } from '../support/postgres.ts';
import {
  acquirePostgres,
  createTestDatabases,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';
import type { WorkerProcessResult } from '../support/worker-protocol.ts';
import { RESULT_PREFIX } from '../support/worker-protocol.ts';

/**
 * Step 16: two or more independent worker *processes* against one database.
 *
 * Everything up to here shared an event loop. This file does not: each worker is a separate OS
 * process with its own pool, its own memory and its own scheduler. If any guarantee so far was
 * quietly relying on single-process cooperation, this is where it stops being true.
 */

const ACCOUNT = asId<AccountId>('acc_mw');
const TRACE = asId<TraceId>('trc_mw');
const WORKER_SCRIPT = resolve(import.meta.dirname, '..', 'support', 'worker-process.ts');

const available = postgresAvailable();

interface SpawnOptions {
  readonly workerId: string;
  readonly mode: 'drain' | 'crash' | 'reap';
  readonly holdMs?: number;
  readonly leaseMs?: number;
}

function runWorker(
  cluster: PostgresTestCluster,
  options: SpawnOptions,
): Promise<WorkerProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT], {
      env: {
        ...process.env,
        WORKER_ID: options.workerId,
        WORKER_MODE: options.mode,
        WORKER_DB_URL: cluster.workerUrl,
        WORKER_HOLD_MS: String(options.holdMs ?? 25),
        WORKER_LEASE_MS: String(options.leaseMs ?? 1_000),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT_PREFIX));
      if (!line) {
        reject(
          new Error(
            `worker ${options.workerId} produced no result (exit ${String(code)}): ${stderr.slice(0, 400)}`,
          ),
        );
        return;
      }
      resolvePromise(JSON.parse(line.slice(RESULT_PREFIX.length)) as WorkerProcessResult);
    });
  });
}

describe('postgres multi-process workers', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let dbs: PostgresTestDatabases;
  let queue: JobQueue;

  before(async () => {
    cluster = await acquirePostgres();
    dbs = createTestDatabases(cluster, { maxConnections: 4 });
    queue = createPostgresJobQueue({
      enqueueDb: dbs.worker,
      workerDb: dbs.worker,
      ids: createDeterministicIdFactory(),
    });
  });

  beforeEach(async () => {
    await truncateAll(cluster.adminUrl);
    await withAdminClient(cluster.adminUrl, async (client) => {
      await client.query(
        `INSERT INTO accounts (id, slug, name, status) VALUES ($1,$1,'Multi','ACTIVE')`,
        [ACCOUNT],
      );
    });
  });

  after(async () => {
    await dbs.close();
    await releasePostgres();
  });

  const enqueue = (partitionKey: string, maxAttempts = 5) =>
    queue.enqueue({
      accountId: ACCOUNT,
      type: 'moderator.run',
      partitionKey,
      payload: {},
      runAt: new Date(),
      maxAttempts,
      traceId: TRACE,
    });

  it('two processes divide the work and never claim the same job twice', async () => {
    for (let i = 0; i < 20; i++) await enqueue(`p_${String(i)}`);

    const [a, b] = await Promise.all([
      runWorker(cluster, { workerId: 'proc-a', mode: 'drain', holdMs: 5 }),
      runWorker(cluster, { workerId: 'proc-b', mode: 'drain', holdMs: 5 }),
    ]);

    const all = [...a.claimed, ...b.claimed];
    assert.equal(all.length, 20, 'every job was processed');
    assert.equal(new Set(all).size, 20, 'and none of them twice');
    assert.ok(a.claimed.length > 0 && b.claimed.length > 0, 'both processes actually did work');

    const states = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ state: string; n: string }>(
        'SELECT state, count(*)::text AS n FROM jobs GROUP BY state',
      );
      return Object.fromEntries(result.rows.map((r) => [r.state, Number(r.n)]));
    });
    assert.deepEqual(states, { SUCCEEDED: 20 });
  });

  it('three processes on one conversation never run it concurrently', async () => {
    // All twelve jobs share a partition. The observation is taken from the database by each
    // process independently, so neither can be fooled by the other's memory.
    for (let i = 0; i < 12; i++) await enqueue('p_one_conversation');

    const results = await Promise.all([
      runWorker(cluster, { workerId: 'proc-a', mode: 'drain', holdMs: 40 }),
      runWorker(cluster, { workerId: 'proc-b', mode: 'drain', holdMs: 40 }),
      runWorker(cluster, { workerId: 'proc-c', mode: 'drain', holdMs: 40 }),
    ]);

    for (const result of results) {
      assert.ok(
        result.maxConcurrentInPartition <= 1,
        `${result.workerId} saw ${String(result.maxConcurrentInPartition)} live leases in one partition`,
      );
    }
    const all = results.flatMap((r) => r.claimed);
    assert.equal(all.length, 12);
    assert.equal(new Set(all).size, 12, 'no job was handed to two processes');
  });

  it('a process that dies holding a job loses it to the lease, and another picks it up', async () => {
    await enqueue('p_crash');

    const crashed = await runWorker(cluster, {
      workerId: 'proc-doomed',
      mode: 'crash',
      leaseMs: 800,
    });
    assert.equal(crashed.claimed.length, 1, 'it really did take the job before dying');

    const stillRunning = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ state: string; lease_owner: string | null }>(
        'SELECT state, lease_owner FROM jobs WHERE id = $1',
        [crashed.claimed[0]],
      );
      return result.rows[0]!;
    });
    assert.equal(stillRunning.state, 'RUNNING', 'the dead process left the job leased');
    assert.equal(stillRunning.lease_owner, 'proc-doomed');

    // Wait for the lease to lapse in real time — the whole point is that recovery needs no
    // cooperation from the process that died.
    await new Promise((r) => setTimeout(r, 1_100));

    const reaped = await runWorker(cluster, { workerId: 'proc-reaper', mode: 'reap' });
    assert.deepEqual(reaped.requeued, crashed.claimed);

    const survivor = await runWorker(cluster, { workerId: 'proc-survivor', mode: 'drain' });
    assert.deepEqual(survivor.claimed, crashed.claimed, 'the work was picked up, not lost');
  });

  it('a crashed job with no attempts left is dead-lettered by whichever reaper wins', async () => {
    await enqueue('p_terminal', 1);
    const crashed = await runWorker(cluster, {
      workerId: 'proc-doomed',
      mode: 'crash',
      leaseMs: 600,
    });
    assert.equal(crashed.claimed.length, 1);
    await new Promise((r) => setTimeout(r, 900));

    // Two reapers, two processes, same expired lease.
    const [r1, r2] = await Promise.all([
      runWorker(cluster, { workerId: 'reaper-1', mode: 'reap' }),
      runWorker(cluster, { workerId: 'reaper-2', mode: 'reap' }),
    ]);

    const recovered = [
      ...(r1.requeued ?? []),
      ...(r1.deadLettered ?? []),
      ...(r2.requeued ?? []),
      ...(r2.deadLettered ?? []),
    ];
    assert.deepEqual(recovered, crashed.claimed, 'exactly one reaper recovered it');

    const letters = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ n: string; job_id: string | null }>(
        'SELECT count(*)::text AS n, min(job_id) AS job_id FROM dead_letters',
      );
      return result.rows[0]!;
    });
    assert.equal(Number(letters.n), 1, 'recorded once — two reapers must not double-record');
    assert.equal(letters.job_id, crashed.claimed[0]);
  });

  it('a worker process cannot read another tenant’s conversations, by grant not by policy', async () => {
    // The `app_worker` role exists so the queue can be cross-tenant. Its *grants* stop at two
    // tables, so even with permissive queue visibility a worker bug cannot reach customer data.
    const denied = await dbs.worker
      .unscoped((client) => client.query('SELECT count(*) FROM conversations'), 'probe:worker-role')
      .then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
    assert.ok(denied, 'the worker role must not be able to read conversations at all');
    assert.equal(denied.code, 'DATABASE_PERMISSION_DENIED');
  });
});
