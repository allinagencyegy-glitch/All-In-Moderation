import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import { describeError, retryabilityOf } from '../../platform/errors.ts';
import type { Job, JobType } from './job.ts';
import type { JobQueue, RetryPolicy } from './queue.ts';
import { DEFAULT_RETRY_POLICY, nextRetryAt } from './queue.ts';
import type { DeadLetterStore } from '../dead-letter.ts';
import type { DeadLetterHandler, DeadLetterSink } from './dead-letter-sink.ts';
import { createDeadLetterSink } from './dead-letter-sink.ts';

export type { DeadLetterHandler, DeadLetterSink } from './dead-letter-sink.ts';

/**
 * A job handler.
 *
 * Handlers MUST be idempotent: the queue delivers at least once, and a lease expiry after a
 * successful commit will redeliver work that already happened. Every handler in this codebase
 * achieves that by reading current state and exiting early when its effect is already present —
 * never by trusting that it runs exactly once.
 */
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly retryPolicy?: RetryPolicy;
  readonly types?: readonly JobType[];
  readonly random?: () => number;
}

export interface Worker {
  /** Claims and runs at most one job. Returns false when there was nothing to do. */
  runOnce(): Promise<boolean>;
  /** Drains until the queue yields nothing, bounded so a bug cannot spin forever. */
  drain(maxJobs?: number): Promise<number>;
  /** The job this worker is handling right now, or null. Read by graceful shutdown. */
  current(): Job | null;
  /**
   * Aborts the handler running right now and marks the outcome as a shutdown rather than a
   * failure.
   *
   * Without the distinction, an interrupted handler would surface as a plain `Error` from the
   * abort — which `retryabilityOf` classifies TERMINAL, which dead-letters the job. Restarting a
   * process would then dead-letter one conversation per worker, and a rolling deploy would look
   * like a spate of unrecoverable failures. Interrupted work is released, not judged.
   */
  interrupt(): void;
  /** True once `interrupt` has been called; the drain loop stops claiming. */
  interrupted(): boolean;
}

export function createWorker(deps: {
  queue: JobQueue;
  handlers: Readonly<Partial<Record<JobType, JobHandler>>>;
  deadLetterHandlers?: Readonly<Partial<Record<JobType, DeadLetterHandler>>>;
  /** Share one sink with the reaper so both paths to a dead letter behave identically. */
  deadLetterSink?: DeadLetterSink;
  deadLetters: DeadLetterStore;
  clock: Clock;
  logger: Logger;
  options: WorkerOptions;
}): Worker {
  const { queue, handlers, deadLetters, clock, logger, options } = deps;

  const onDeadLetter: DeadLetterSink =
    deps.deadLetterSink ??
    createDeadLetterSink({
      deadLetters,
      ...(deps.deadLetterHandlers !== undefined ? { handlers: deps.deadLetterHandlers } : {}),
      clock,
      logger,
    });
  const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const random = options.random ?? Math.random;

  let currentJob: Job | null = null;
  let currentController: AbortController | null = null;
  let interrupted = false;

  const runOnce = async (): Promise<boolean> => {
    // A worker told to stop must not open new work, even if a caller loops one more time.
    if (interrupted) return false;
    const claimOptions = {
      workerId: options.workerId,
      leaseMs: options.leaseMs,
      now: clock.now(),
      ...(options.types !== undefined ? { types: options.types } : {}),
    };
    const job = await queue.claim(claimOptions);
    if (!job) return false;

    const jobLogger = logger.child({
      job_id: job.id,
      job_type: job.type,
      account_id: job.accountId,
      trace_id: job.traceId,
      attempt: job.attempt,
    });

    const handler = handlers[job.type];
    if (!handler) {
      // Deploy skew, or a job type removed while rows still reference it. Dead-letter rather than
      // dropping: an unhandled job that silently disappears is exactly the failure class we
      // promised not to have.
      jobLogger.error('no handler registered for job type');
      await onDeadLetter(job, { code: 'NO_HANDLER', message: `No handler for ${job.type}` });
      await queue.fail(
        job.id,
        { code: 'NO_HANDLER', message: `No handler for ${job.type}` },
        null,
        clock.now(),
      );
      return true;
    }

    // The handler's deadline is the lease. A handler that outlives its lease would be working on
    // a job another worker has already reclaimed — two writers, one conversation.
    const controller = new AbortController();
    const leaseTimer = setTimeout(
      () => controller.abort(new Error('lease expired')),
      options.leaseMs,
    );
    currentJob = job;
    currentController = controller;
    // An interrupt that arrived between the claim and here would otherwise be missed, and the
    // shutdown would wait out a handler it had already asked to stop.
    if (interrupted) controller.abort(new Error('worker interrupted'));

    try {
      await handler(job, controller.signal);
      await queue.complete(job.id, clock.now());
      jobLogger.debug('job completed');
    } catch (error) {
      if (interrupted) {
        // Shutdown, not failure. Hand the partition straight back so the next process picks the
        // job up immediately instead of waiting out a lease that nothing is holding. The attempt
        // is still spent — see `JobQueue.releaseLease`.
        const released = await queue.releaseLease(job.id, clock.now());
        jobLogger.warn('job released on shutdown', { released });
        return true;
      }
      const described = describeError(error);
      const retryability = retryabilityOf(error);
      const retryAt = nextRetryAt(
        job.attempt,
        job.maxAttempts,
        retryability,
        clock.now(),
        retryPolicy,
        random,
      );
      if (retryAt === null) {
        jobLogger.error('job dead-lettered', { code: described.code, message: described.message });
        await onDeadLetter(job, described);
      } else {
        jobLogger.warn('job failed, will retry', {
          code: described.code,
          message: described.message,
          retry_at: retryAt.toISOString(),
        });
      }
      await queue.fail(job.id, described, retryAt, clock.now());
    } finally {
      clearTimeout(leaseTimer);
      currentJob = null;
      currentController = null;
    }
    return true;
  };

  return {
    runOnce,
    current: () => currentJob,
    interrupted: () => interrupted,
    interrupt() {
      if (interrupted) return;
      interrupted = true;
      // Abort *before* the flag is read anywhere else, so a handler that honours its signal
      // unwinds into the release path rather than into the retry path.
      currentController?.abort(new Error('worker interrupted'));
    },
    async drain(maxJobs = 1000) {
      let processed = 0;
      while (processed < maxJobs) {
        const did = await runOnce();
        if (!did) break;
        processed += 1;
      }
      return processed;
    },
  };
}
