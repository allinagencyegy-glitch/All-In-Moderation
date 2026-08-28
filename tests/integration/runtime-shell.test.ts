import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../../src/platform/clock.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { TransientError } from '../../src/platform/errors.ts';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, JobId, TraceId } from '../../src/platform/ids.ts';
import type { Job } from '../../src/operations/jobs/job.ts';
import { createWorker } from '../../src/operations/jobs/worker.ts';
import { createMemoryDatabase } from '../../src/adapters/memory/database.ts';
import { createMemoryJobQueue } from '../../src/adapters/memory/job-queue.ts';
import { createMemoryDeadLetterStore } from '../../src/adapters/memory/repositories.ts';
import { createScheduledTask } from '../../src/runtime/scheduler.ts';
import { createWorkerLoop } from '../../src/runtime/worker-loop.ts';

/**
 * The application shell's own mechanics: the poll loop, the timer, and the shutdown.
 *
 * These are the pieces Phase 00 and 01 never had. Every previous proof drove the worker by
 * calling `drain()` and the reaper by calling `reap()`; nothing looped, nothing was scheduled,
 * and nothing was ever asked to stop. The failures this suite is looking for only exist in that
 * gap — a loop that spins on an empty queue, a timer that overlaps itself, a shutdown that
 * dead-letters the job it interrupted.
 *
 * Real timers, deliberately, with short intervals. A fake timer would prove the fake advances.
 */

const ACCOUNT = asId<AccountId>('acc_shell');
const TRACE = asId<TraceId>('trc_shell');

interface Rig {
  readonly queue: ReturnType<typeof createMemoryJobQueue>;
  readonly db: ReturnType<typeof createMemoryDatabase>;
  readonly logs: ReturnType<typeof createMemoryLogger>['records'];
  readonly logger: ReturnType<typeof createMemoryLogger>['logger'];
}

function rig(): Rig {
  const db = createMemoryDatabase();
  const { logger, records } = createMemoryLogger('debug');
  return { db, queue: createMemoryJobQueue(db), logs: records, logger };
}

function enqueue(r: Rig, partitionKey: string, payload: Record<string, string> = {}): Promise<Job> {
  return r.queue.enqueue({
    accountId: ACCOUNT,
    type: 'moderator.run',
    partitionKey,
    payload,
    runAt: systemClock.now(),
    maxAttempts: 3,
    traceId: TRACE,
  });
}

function workerFor(
  r: Rig,
  handler: (job: Job, signal: AbortSignal) => Promise<void>,
  options: { leaseMs?: number } = {},
) {
  return createWorker({
    queue: r.queue,
    handlers: { 'moderator.run': handler },
    deadLetters: createMemoryDeadLetterStore(r.db),
    clock: systemClock,
    logger: r.logger,
    options: { workerId: 'w-shell', leaseMs: options.leaseMs ?? 30_000, random: () => 0.5 },
  });
}

/** Polls a condition on real time rather than sleeping a guessed amount. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

describe('runtime shell: the worker loop', () => {
  it('keeps polling and picks up work that arrives after it started', async () => {
    const r = rig();
    const done: string[] = [];
    const loop = createWorkerLoop({
      worker: workerFor(r, (job) => {
        done.push(job.id);
        return Promise.resolve();
      }),
      queue: r.queue,
      clock: systemClock,
      logger: r.logger,
      workerId: 'w-shell',
      pollIntervalMs: 5,
    });

    loop.start();
    // The whole point: nothing is enqueued yet. A `drain()` would have returned zero and stopped.
    await until(() => loop.stats().idleRounds > 0, 'the loop idles on an empty queue');

    await enqueue(r, 'p1');
    await enqueue(r, 'p2');
    await until(() => done.length === 2, 'both jobs were claimed by the running loop');

    await loop.stop(1_000);
    assert.equal(loop.stats().claims, 2);
    const states = await r.queue.countByState();
    assert.equal(states['SUCCEEDED'], 2);
  });

  it('drains a burst without waiting a poll interval between jobs', async () => {
    const r = rig();
    let handled = 0;
    const loop = createWorkerLoop({
      worker: workerFor(r, () => {
        handled += 1;
        return Promise.resolve();
      }),
      queue: r.queue,
      clock: systemClock,
      logger: r.logger,
      workerId: 'w-burst',
      // Long enough that ten sequential poll waits could not fit in the budget below.
      pollIntervalMs: 200,
    });

    for (let i = 0; i < 10; i++) await enqueue(r, `burst-${String(i)}`);
    const startedAt = Date.now();
    loop.start();
    await until(() => handled === 10, 'the burst drained');
    const elapsed = Date.now() - startedAt;
    await loop.stop(1_000);

    // 10 jobs at a 200ms idle wait each would be 2s. Work follows work immediately; only an
    // empty queue costs a wait.
    assert.ok(elapsed < 1_000, `burst took ${String(elapsed)}ms`);
  });

  it('survives a queue failure and keeps going instead of exiting', async () => {
    const r = rig();
    let failures = 3;
    const flaky = {
      ...r.queue,
      claim: (options: Parameters<typeof r.queue.claim>[0]) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new TransientError('CONNECTION_LOST', 'simulated blip'));
        }
        return r.queue.claim(options);
      },
    };
    const handled: string[] = [];
    const loop = createWorkerLoop({
      worker: createWorker({
        queue: flaky,
        handlers: {
          'moderator.run': (job) => {
            handled.push(job.id);
            return Promise.resolve();
          },
        },
        deadLetters: createMemoryDeadLetterStore(r.db),
        clock: systemClock,
        logger: r.logger,
        options: { workerId: 'w-flaky', leaseMs: 30_000 },
      }),
      queue: flaky,
      clock: systemClock,
      logger: r.logger,
      workerId: 'w-flaky',
      pollIntervalMs: 5,
      errorBackoffMs: 5,
    });

    await enqueue(r, 'p-flaky');
    loop.start();
    await until(() => handled.length === 1, 'the loop recovered and did the work');
    await loop.stop(1_000);

    assert.equal(loop.stats().errors, 3, 'every blip was counted, not swallowed');
    const logged = r.logs.filter((record) => record.message === 'worker loop error; backing off');
    assert.equal(logged.length, 3);
  });
});

describe('runtime shell: graceful shutdown', () => {
  it('stops claiming immediately, and finishes the job already in flight', async () => {
    const r = rig();
    const started: string[] = [];
    const finished: string[] = [];
    let release: (() => void) | null = null;

    const loop = createWorkerLoop({
      worker: workerFor(r, async (job) => {
        started.push(job.id);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        finished.push(job.id);
      }),
      queue: r.queue,
      clock: systemClock,
      logger: r.logger,
      workerId: 'w-drain',
      pollIntervalMs: 5,
    });

    const first = await enqueue(r, 'p-a');
    const second = await enqueue(r, 'p-b');
    loop.start();
    await until(() => started.length === 1, 'the first job started');

    const stopping = loop.stop(5_000);
    // Give the shutdown a moment to have claimed anything it was going to claim.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(started, [first.id], 'no second job was claimed after the stop');

    release!();
    const outcome = await stopping;

    assert.equal(outcome.forced, false);
    assert.deepEqual(finished, [first.id], 'the in-flight job ran to completion');
    assert.equal((await r.queue.findById(first.id))?.state, 'SUCCEEDED');
    // The unclaimed job is untouched and immediately available to the next process.
    assert.equal((await r.queue.findById(second.id))?.state, 'READY');
  });

  it('releases the lease of a job it interrupted, rather than dead-lettering it', async () => {
    const r = rig();
    let aborted = false;

    const loop = createWorkerLoop({
      worker: workerFor(r, async (job, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            // A well-behaved handler unwinds on abort. Without the shutdown flag this rejection
            // is an ordinary `Error`, which `retryabilityOf` calls TERMINAL — and a terminal
            // failure at max-attempts-1 dead-letters the conversation.
            reject(new Error('aborted'));
          });
          void job;
        });
      }),
      queue: r.queue,
      clock: systemClock,
      logger: r.logger,
      workerId: 'w-interrupt',
      pollIntervalMs: 5,
    });

    const job = await enqueue(r, 'p-interrupt');
    loop.start();
    await until(async () => (await r.queue.findById(job.id))?.state === 'RUNNING', 'claimed');

    const outcome = await loop.stop(5_000);
    assert.equal(outcome.forced, false);
    assert.ok(aborted, 'the handler was told to stop');

    const after = await r.queue.findById(job.id);
    assert.equal(after?.state, 'READY', 'released, not failed and not dead-lettered');
    assert.equal(after?.leaseOwner, null, 'the partition is free for the next process');
    assert.equal(after?.attempt, 1, 'the attempt is spent, not refunded');
    assert.equal(after?.lastError?.code, 'LEASE_RELEASED');
    assert.equal(r.db.tables.deadLetters.length, 0);
  });

  it('reports a forced shutdown and leaves the lease for the reaper', async () => {
    const r = rig();
    const loop = createWorkerLoop({
      // A handler that ignores its abort signal entirely — the case the grace period exists for.
      // A short lease, only so the worker's own lease timer does not hold the event loop open
      // for a minute after the assertions finish. Nothing reaps it during the test.
      worker: workerFor(r, () => new Promise<void>(() => undefined), { leaseMs: 300 }),
      queue: r.queue,
      clock: systemClock,
      logger: r.logger,
      workerId: 'w-stuck',
      pollIntervalMs: 5,
    });

    const job = await enqueue(r, 'p-stuck');
    loop.start();
    await until(async () => (await r.queue.findById(job.id))?.state === 'RUNNING', 'claimed');

    const outcome = await loop.stop(100);
    assert.equal(outcome.forced, true);

    const after = await r.queue.findById(job.id);
    // Deliberately still RUNNING. The handler may yet commit, so handing its partition to a
    // second worker would put two writers on one conversation. The lease expires; the reaper
    // recovers it. Slower, and strictly safe.
    assert.equal(after?.state, 'RUNNING');
    assert.ok(
      r.logs.some(
        (record) => record.message === 'worker loop shutdown forced; lease left to expire',
      ),
      'a forced shutdown is loud',
    );
  });

  it('is safe to stop twice', async () => {
    const r = rig();
    const loop = createWorkerLoop({
      worker: workerFor(r, () => Promise.resolve()),
      queue: r.queue,
      clock: systemClock,
      logger: r.logger,
      workerId: 'w-twice',
      pollIntervalMs: 5,
    });
    loop.start();
    assert.deepEqual(await loop.stop(500), { forced: false });
    assert.deepEqual(await loop.stop(500), { forced: false });
  });
});

describe('runtime shell: the scheduler', () => {
  it('runs the task repeatedly on a timer', async () => {
    const { logger } = createMemoryLogger('debug');
    let ran = 0;
    const task = createScheduledTask({
      name: 'tick',
      intervalMs: 5,
      run: () => {
        ran += 1;
        return Promise.resolve();
      },
      logger,
    });

    task.start();
    await until(() => ran >= 3, 'the timer fired repeatedly');
    await task.stop();

    const settled = ran;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(ran, settled, 'nothing fires after stop');
  });

  it('never overlaps a tick with itself', async () => {
    const { logger } = createMemoryLogger('debug');
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = createScheduledTask({
      name: 'slow',
      // Far shorter than the task itself: a plain setInterval would stack these up.
      intervalMs: 1,
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
      },
      logger,
    });

    task.start();
    await until(() => task.stats().ticks >= 3, 'several ticks ran');
    await task.stop();
    assert.equal(maxConcurrent, 1);
  });

  it('logs a failing tick and keeps the schedule alive', async () => {
    const { logger, records } = createMemoryLogger('debug');
    let ran = 0;
    const task = createScheduledTask({
      name: 'flaky',
      intervalMs: 5,
      run: () => {
        ran += 1;
        // An async rejection from a `setInterval` callback is an unhandled rejection, which is
        // fatal in Node by default. Surviving this is the test.
        if (ran <= 2) return Promise.reject(new Error('tick failed'));
        return Promise.resolve();
      },
      logger,
    });

    task.start();
    await until(() => ran >= 4, 'the schedule outlived its failures');
    await task.stop();

    assert.equal(task.stats().failures, 2);
    assert.equal(records.filter((r) => r.message === 'scheduled task failed').length, 2);
  });

  it('waits for the tick in flight before stop() resolves', async () => {
    const { logger } = createMemoryLogger('debug');
    let inside = false;
    let completed = false;
    const task = createScheduledTask({
      name: 'draining',
      intervalMs: 1,
      run: async () => {
        inside = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        completed = true;
      },
      logger,
    });

    task.start();
    await until(() => inside, 'a tick started');
    await task.stop();
    // If stop() did not wait, the caller would close the database pools underneath this tick.
    assert.equal(completed, true);
  });

  it('runNow() joins an in-flight tick rather than racing it', async () => {
    const { logger } = createMemoryLogger('debug');
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = createScheduledTask({
      name: 'joined',
      intervalMs: 1,
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 15));
        concurrent -= 1;
      },
      logger,
    });

    task.start();
    await until(() => concurrent === 1, 'a scheduled tick is running');
    await task.runNow();
    await task.stop();
    assert.equal(maxConcurrent, 1);
  });
});

describe('runtime shell: the scheduled reaper', () => {
  it('recovers an expired lease without anyone calling reap()', async () => {
    const r = rig();
    const { logger } = createMemoryLogger('debug');

    // A worker that claims a job with a 20ms lease and then dies holding it.
    const job = await enqueue(r, 'p-reap');
    const claimed = await r.queue.claim({
      workerId: 'w-dead',
      leaseMs: 20,
      now: systemClock.now(),
    });
    assert.equal(claimed?.id, job.id);

    let reaped: readonly JobId[] = [];
    const task = createScheduledTask({
      name: 'reaper',
      intervalMs: 5,
      run: async () => {
        reaped = await r.queue.reapExpiredLeases(systemClock.now());
      },
      logger,
    });

    task.start();
    await until(
      async () => (await r.queue.findById(job.id))?.state === 'READY',
      'the timer, not the test, recovered the lease',
    );
    await task.stop();

    assert.deepEqual([...reaped], [job.id]);
    const after = await r.queue.findById(job.id);
    assert.equal(after?.attempt, 1, 'the attempt count survives recovery');
    assert.equal(after?.lastError?.code, 'LEASE_EXPIRED');
  });
});
