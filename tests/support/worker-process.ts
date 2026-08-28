/**
 * A worker in its own OS process.
 *
 * Promise-based "concurrency" inside one Node process shares an event loop, a connection pool and
 * a module registry. None of those are shared in production, and several of the guarantees this
 * platform makes — partition exclusivity, lease recovery, reaper safety — are precisely about what
 * happens when they are not. So the multi-worker proof forks real processes.
 *
 * Configuration arrives by environment variable because a connection string on a command line is a
 * connection string in `ps` output.
 *
 * Modes:
 *   drain   — claim and complete jobs until the queue is empty, reporting what was seen.
 *   crash   — claim one job and exit immediately without completing or releasing it.
 *   reap    — run the reaper once and report what it recovered.
 *
 * The result is a single JSON line on stdout, prefixed so it cannot be confused with log noise.
 */
import { createDeterministicIdFactory } from '../../src/platform/ids.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { createDeadLetterSink } from '../../src/operations/jobs/dead-letter-sink.ts';
import { createReaper } from '../../src/operations/jobs/reaper.ts';
import { systemClock } from '../../src/platform/clock.ts';
import {
  DEFAULT_POSTGRES_CONFIG,
  createPostgresDatabase,
} from '../../src/adapters/postgres/client.ts';
import { createPostgresJobQueue } from '../../src/adapters/postgres/job-queue.ts';
import { createPostgresDeadLetterStore } from '../../src/adapters/postgres/repositories.ts';
import type { WorkerProcessResult } from './worker-protocol.ts';
import { RESULT_PREFIX } from './worker-protocol.ts';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`missing env ${name}`);
  return value;
};

const workerId = env('WORKER_ID');
const mode = env('WORKER_MODE');
const holdMs = Number(process.env['WORKER_HOLD_MS'] ?? '25');
const maxJobs = Number(process.env['WORKER_MAX_JOBS'] ?? '100');

const logger = createMemoryLogger().logger;
const workerDb = createPostgresDatabase({
  config: {
    ...DEFAULT_POSTGRES_CONFIG,
    connectionString: env('WORKER_DB_URL'),
    maxConnections: 3,
  },
  logger,
  bypassTenantContext: true,
});

const ids = createDeterministicIdFactory();
const queue = createPostgresJobQueue({ enqueueDb: workerDb, workerDb, ids });

const claimed: string[] = [];
let maxConcurrentInPartition = 0;

/**
 * Asks the *database* how many jobs are live-leased in this partition right now.
 *
 * Using the database as the observer rather than a counter in either process is what makes this a
 * real cross-process assertion: neither worker can see the other's memory, but both can see the
 * same rows.
 */
const observePartition = async (partitionKey: string): Promise<void> => {
  const live = await workerDb.unscoped(async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs
        WHERE partition_key = $1 AND state = 'RUNNING' AND lease_expires_at > now()`,
      [partitionKey],
    );
    return Number(result.rows[0]!.n);
  }, 'observe:partition');
  maxConcurrentInPartition = Math.max(maxConcurrentInPartition, live);
};

const emit = (result: WorkerProcessResult): void => {
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
};

try {
  if (mode === 'crash') {
    const job = await queue.claim({
      workerId,
      leaseMs: Number(env('WORKER_LEASE_MS')),
      now: new Date(),
    });
    if (job) claimed.push(job.id);
    emit({ workerId, claimed, maxConcurrentInPartition });
    // Exit without completing, releasing or renewing. Only the lease can recover this job now,
    // which is exactly the scenario under test.
    process.exit(0);
  }

  if (mode === 'reap') {
    const deadLetters = createPostgresDeadLetterStore(workerDb, ids);
    const reaper = createReaper({
      queue,
      deadLetterSink: createDeadLetterSink({ deadLetters, clock: systemClock, logger }),
      clock: systemClock,
      logger,
    });
    const outcome = await reaper.reap();
    emit({
      workerId,
      claimed: [],
      maxConcurrentInPartition,
      requeued: [...outcome.requeued],
      deadLettered: [...outcome.deadLettered],
    });
  } else {
    let idle = 0;
    while (claimed.length < maxJobs && idle < 5) {
      const job = await queue.claim({ workerId, leaseMs: 30_000, now: new Date() });
      if (!job) {
        idle += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      idle = 0;
      claimed.push(job.id);
      await observePartition(job.partitionKey);
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await observePartition(job.partitionKey);
      await queue.complete(job.id, new Date());
    }
    emit({ workerId, claimed, maxConcurrentInPartition });
  }
} finally {
  await workerDb.close();
}
