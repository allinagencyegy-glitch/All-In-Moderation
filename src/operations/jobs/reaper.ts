import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import type { JobId } from '../../platform/ids.ts';
import type { JobQueue } from './queue.ts';
import type { DeadLetterSink } from './dead-letter-sink.ts';

export interface ReapOutcome {
  /** Expired leases returned to READY for redelivery. */
  readonly requeued: readonly JobId[];
  /** Expired leases with no attempts left: terminal, recorded, and escalated. */
  readonly deadLettered: readonly JobId[];
}

export interface Reaper {
  reap(): Promise<ReapOutcome>;
}

const LEASE_EXPIRED = {
  code: 'LEASE_EXPIRED',
  message: 'worker lease expired with no attempts left',
} as const;

/**
 * Crash recovery (ADR-004, F-11/F-20).
 *
 * `JobQueue.reapExpiredLeases` moves rows: an expired lease with attempts left goes back to
 * READY, one without goes to DEAD_LETTERED. Moving the row is only half the job. A worker that
 * dead-letters writes a `dead_letters` row and raises a human handoff; a lease that expires into
 * the same terminal state must do exactly the same, or a crashed worker becomes a quieter way to
 * abandon a customer than a failing one.
 *
 * So the reaper reads back what the queue decided and routes the terminal cases through the same
 * sink the worker uses. Recording is idempotent-safe to repeat: a job only enters DEAD_LETTERED
 * once, because that state is terminal and the reaper skips anything not RUNNING.
 */
export function createReaper(deps: {
  queue: JobQueue;
  deadLetterSink: DeadLetterSink;
  clock: Clock;
  logger: Logger;
}): Reaper {
  return {
    async reap() {
      const reclaimed = await deps.queue.reapExpiredLeases(deps.clock.now());
      const requeued: JobId[] = [];
      const deadLettered: JobId[] = [];

      for (const jobId of reclaimed) {
        const job = await deps.queue.findById(jobId);
        if (!job) continue;
        if (job.state !== 'DEAD_LETTERED') {
          requeued.push(jobId);
          deps.logger.warn('expired lease reclaimed', {
            job_id: job.id,
            job_type: job.type,
            account_id: job.accountId,
            trace_id: job.traceId,
            attempt: job.attempt,
          });
          continue;
        }
        deadLettered.push(jobId);
        deps.logger.error('expired lease dead-lettered', {
          job_id: job.id,
          job_type: job.type,
          account_id: job.accountId,
          trace_id: job.traceId,
          attempt: job.attempt,
        });
        await deps.deadLetterSink(job, job.lastError ?? LEASE_EXPIRED);
      }

      return { requeued, deadLettered };
    },
  };
}
