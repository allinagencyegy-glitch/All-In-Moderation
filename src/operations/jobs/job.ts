import type { AccountId, JobId, TraceId } from '../../platform/ids.ts';
import { InvalidTransitionError } from '../../platform/errors.ts';

export const JOB_STATES = [
  'READY',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'DEAD_LETTERED',
  'CANCELLED',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Job types are a closed set: an unknown type in the queue is a deploy-skew bug, not a no-op. */
export const JOB_TYPES = [
  'raw_event.normalize',
  'moderator.run',
  'outbound.dispatch',
  'outbox.relay',
  'event.deliver',
  'handoff.sla_check',
  'conversation.unsnooze',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface Job {
  readonly id: JobId;
  readonly accountId: AccountId;
  readonly type: JobType;
  /**
   * The serialisation domain. At most one job per partition may be RUNNING at a time — this one
   * predicate delivers both per-conversation ordering and cross-conversation parallelism (ADR-005).
   */
  readonly partitionKey: string;
  /** Enables coalescing: at most one non-terminal job per (partition, dedupe) pair. */
  readonly dedupeKey: string | null;
  readonly payload: Readonly<Record<string, string>>;
  readonly state: JobState;
  /** Durable timer. A READY job is invisible until `runAt <= now`. */
  readonly runAt: Date;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  /** The anti-starvation anchor: debounce may never push `runAt` past this plus the ceiling. */
  readonly firstEnqueuedAt: Date;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly traceId: TraceId;
  /** Monotonic insert order; the tiebreaker that makes claim ordering deterministic. */
  readonly seq: number;
}

const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'READY', 'DEAD_LETTERED'],
  FAILED: ['READY', 'DEAD_LETTERED'],
  SUCCEEDED: [],
  DEAD_LETTERED: [],
  CANCELLED: [],
};

export function isTerminalJobState(state: JobState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function isActiveJobState(state: JobState): boolean {
  return state === 'READY' || state === 'RUNNING';
}

export function assertJobTransition(from: JobState, to: JobState): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError('Job', from, to);
  }
}

export function hasAttemptsLeft(job: Job): boolean {
  return job.attempt < job.maxAttempts;
}

/** A lease is live only while it has not expired; an expired lease is reclaimable work. */
export function isLeaseLive(job: Job, now: Date): boolean {
  return (
    job.state === 'RUNNING' &&
    job.leaseExpiresAt !== null &&
    job.leaseExpiresAt.getTime() > now.getTime()
  );
}
