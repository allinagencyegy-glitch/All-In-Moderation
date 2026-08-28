import type { Clock } from '../platform/clock.ts';
import type { Logger } from '../platform/logger.ts';
import { describeError } from '../platform/errors.ts';
import type { JobQueue } from '../operations/jobs/queue.ts';
import type { Worker } from '../operations/jobs/worker.ts';

/**
 * A worker that keeps running.
 *
 * Phase 00 and 01 proved the *unit*: claim a job, run it, complete or fail it, recover a lease.
 * Every one of those proofs was driven by a test calling `drain()`. Nothing in the tree ever
 * looped. This is the loop, and it is where the operational questions live that a drain never
 * has to answer.
 *
 * **Backoff on idle, not on work.** A worker that just did something asks again immediately —
 * that is how a burst drains at the speed of the database rather than at the speed of the poll
 * interval. A worker that found nothing waits, so an idle deployment is not a self-inflicted
 * denial of service against its own queue.
 *
 * **A claim failure is not a crash.** The database will be briefly unavailable at some point:
 * failover, a restart, a network blip. The loop logs it, backs off (longer than the idle
 * interval, because the cause is not "no work"), and tries again. A worker that exits on the
 * first `ECONNREFUSED` turns a ten-second failover into a full outage requiring a redeploy.
 *
 * **Shutdown is a state, not an event.** `stop()` flips the loop into draining, waits out the
 * handler that is running, and resolves. It never cancels a job mid-write.
 */

export interface WorkerLoop {
  readonly workerId: string;
  start(): void;
  /**
   * Stops claiming, then waits for the in-flight job.
   *
   * Within `graceMs` the job either finishes or is aborted and its lease handed back
   * (`releaseLease`), so the partition frees immediately. Past `graceMs` the loop stops waiting
   * and reports `forced: true` — and deliberately does **not** release the lease: a handler still
   * running might yet commit, and handing its partition to a second worker would put two writers
   * on one conversation. The lease expires on its own and the reaper recovers it, which is the
   * slower but strictly safe answer.
   */
  stop(graceMs: number): Promise<{ forced: boolean }>;
  readonly stats: () => {
    claims: number;
    idleRounds: number;
    errors: number;
    running: boolean;
    draining: boolean;
  };
}

export function createWorkerLoop(deps: {
  worker: Worker;
  queue: JobQueue;
  clock: Clock;
  logger: Logger;
  workerId: string;
  pollIntervalMs: number;
  /** Backoff after a claim error. Distinct from the idle wait: the cause is different. */
  errorBackoffMs?: number;
  /** Injected so tests are not at the mercy of the host's timer resolution. */
  sleep?: (ms: number) => Promise<void>;
}): WorkerLoop {
  const errorBackoffMs = deps.errorBackoffMs ?? Math.max(deps.pollIntervalMs, 1_000);
  const logger = deps.logger.child({ worker_id: deps.workerId });

  let running = false;
  let draining = false;
  let loop: Promise<void> | null = null;
  let claims = 0;
  let idleRounds = 0;
  let errors = 0;

  // A pending idle wait must be interruptible, or `stop()` pays up to one full poll interval for
  // nothing. The resolver is kept so shutdown can cut the wait short.
  let wake: (() => void) | null = null;
  const pause = async (ms: number): Promise<void> => {
    if (draining) return;
    if (deps.sleep) {
      await deps.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const run = async (): Promise<void> => {
    while (!draining) {
      let did: boolean;
      try {
        did = await deps.worker.runOnce();
        if (did) claims += 1;
      } catch (error) {
        errors += 1;
        const described = describeError(error);
        // `runOnce` handles its own handler failures; reaching here means the *queue* failed —
        // the claim, the complete, or the fail itself.
        logger.error('worker loop error; backing off', {
          code: described.code,
          message: described.message,
        });
        await pause(errorBackoffMs);
        continue;
      }
      if (did) continue;
      idleRounds += 1;
      await pause(deps.pollIntervalMs);
    }
  };

  return {
    workerId: deps.workerId,

    start() {
      if (running) return;
      running = true;
      draining = false;
      logger.info('worker loop started', { poll_interval_ms: deps.pollIntervalMs });
      loop = run().finally(() => {
        running = false;
      });
    },

    async stop(graceMs) {
      if (!running && loop === null) return { forced: false };
      draining = true;
      // Order matters. Flip the flag first so no new claim starts, then interrupt the handler
      // that is already in flight, then cut short any idle wait.
      deps.worker.interrupt();
      wake?.();

      const held = loop;
      loop = null;
      if (!held) return { forced: false };

      let forced = false;
      let timer: NodeJS.Timeout | null = null;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          forced = true;
          resolve();
        }, graceMs);
      });
      await Promise.race([held, deadline]);
      if (timer) clearTimeout(timer);

      if (forced) {
        const stuck = deps.worker.current();
        // Named loudly. This is the one shutdown path that leaves work to the reaper, and an
        // operator needs to be able to find it in a log without knowing to look for it.
        logger.error('worker loop shutdown forced; lease left to expire', {
          grace_ms: graceMs,
          job_id: stuck?.id ?? null,
          job_type: stuck?.type ?? null,
        });
      } else {
        logger.info('worker loop stopped', { claims, idle_rounds: idleRounds, errors });
      }
      return { forced };
    },

    stats: () => ({ claims, idleRounds, errors, running, draining }),
  };
}
