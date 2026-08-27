import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import { describeError } from '../../platform/errors.ts';
import type { Job, JobType } from './job.ts';
import type { DeadLetterStore } from '../dead-letter.ts';

/**
 * Runs when a job reaches its terminal failure.
 *
 * This is how "the AI could not work, so ask a human" is wired without the worker or the reaper
 * knowing what a conversation is. A hook that itself fails must never mask the original failure,
 * so its errors are logged and swallowed — the dead letter is already recorded by then.
 */
export type DeadLetterHandler = (
  job: Job,
  error: { code: string; message: string },
) => Promise<void>;

export type DeadLetterSink = (job: Job, error: { code: string; message: string }) => Promise<void>;

/**
 * The single place a job becomes operator-visible after it stops being retryable.
 *
 * Both paths to a dead letter must come through here:
 *   - a worker exhausting attempts (or hitting a terminal error), and
 *   - the reaper finding an expired lease on a job with no attempts left.
 *
 * The second path is the one that is easy to forget, and forgetting it is the worst version of
 * the bug: the job is marked DEAD_LETTERED in the queue, so nothing retries it, while no
 * `dead_letters` row exists and no handoff is raised. The customer waits on a queue that quietly
 * ended — the exact silent failure ADR-004 exists to prevent.
 */
export function createDeadLetterSink(deps: {
  deadLetters: DeadLetterStore;
  handlers?: Readonly<Partial<Record<JobType, DeadLetterHandler>>>;
  clock: Clock;
  logger: Logger;
}): DeadLetterSink {
  const handlers = deps.handlers ?? {};

  return async (job, error) => {
    await deps.deadLetters.record({ job, error, recordedAt: deps.clock.now() });
    const escalate = handlers[job.type];
    if (!escalate) return;
    try {
      await escalate(job, error);
    } catch (hookError) {
      deps.logger.error('dead-letter escalation hook failed', {
        job_id: job.id,
        job_type: job.type,
        code: describeError(hookError).code,
      });
    }
  };
}
