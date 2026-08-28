import type { AccountId, JobId, TraceId } from '../../platform/ids.ts';
import type { BackoffPolicy } from '../../platform/async.ts';
import { DEFAULT_BACKOFF, backoffDelayMs } from '../../platform/async.ts';
import type { Job, JobType } from './job.ts';

export interface EnqueueRequest {
  readonly accountId: AccountId;
  readonly type: JobType;
  readonly partitionKey: string;
  readonly dedupeKey?: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly runAt: Date;
  readonly maxAttempts?: number;
  readonly traceId: TraceId;
}

/**
 * Debounce with an anti-starvation ceiling (ADR-005 §3).
 *
 * `debounceMs` lets a burst settle so one run answers all of it. `maxDelayMs`, measured from the
 * *first* enqueue, guarantees that a continuously typing customer still gets an answer — without
 * it, each new message would push the run further into the future, forever.
 */
export interface CoalesceOptions {
  readonly debounceMs: number;
  readonly maxDelayMs: number;
}

export interface CoalesceResult {
  readonly job: Job;
  readonly coalesced: boolean;
  /** True when the ceiling, rather than the debounce window, decided `runAt`. */
  readonly ceilingApplied: boolean;
}

export interface ClaimOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly now: Date;
  readonly types?: readonly JobType[];
}

/**
 * The durable job queue port (ADR-004).
 *
 * The contract every implementation must satisfy — asserted by `tests/contract/job-queue.ts`:
 *   1. At most one RUNNING job per `partitionKey` at any instant.
 *   2. A job is invisible until `runAt <= now`.
 *   3. `enqueueCoalesced` never creates a second active job for the same (partition, dedupe).
 *   4. An expired lease returns the job to READY without losing its attempt count.
 *   5. Exhausted attempts move to DEAD_LETTERED and never back to READY.
 *   6. Enqueue participates in the caller's transaction — this is what makes ingest atomic.
 *   7. `releaseLease` returns a RUNNING job to READY, keeping its attempt count, and refuses a
 *      job it no longer owns.
 */
export interface JobQueue {
  enqueue(request: EnqueueRequest): Promise<Job>;
  enqueueCoalesced(request: EnqueueRequest, options: CoalesceOptions): Promise<CoalesceResult>;
  claim(options: ClaimOptions): Promise<Job | null>;
  complete(jobId: JobId, now: Date): Promise<void>;
  /** `retryAt = null` means "no attempts left": dead-letter it. */
  fail(
    jobId: JobId,
    error: { code: string; message: string },
    retryAt: Date | null,
    now: Date,
  ): Promise<void>;
  /**
   * Hands a live-leased job back to the queue without judging it.
   *
   * This is the graceful-shutdown path (Phase 02): a worker told to stop mid-job aborts the
   * handler and gives the partition back immediately, instead of leaving the row RUNNING until
   * the lease lapses. Waiting for expiry would be correct but slow — a rolling deploy would stall
   * every in-flight conversation for a full lease period, and the reaper would then record it as
   * a crash it was not.
   *
   * The attempt is *not* refunded. It was genuinely spent, and refunding it would let a shutdown
   * loop retry a poisonous job forever. Returns false when the job is no longer RUNNING — the
   * lease already lapsed and someone else owns the outcome.
   */
  releaseLease(jobId: JobId, now: Date): Promise<boolean>;
  /** Returns expired leases to READY. Runs on a timer; this is crash recovery (F-11). */
  reapExpiredLeases(now: Date): Promise<readonly JobId[]>;
  findById(jobId: JobId): Promise<Job | null>;
  /** Operator visibility: "which conversations are stuck?" must be a query, not a guess. */
  countByState(): Promise<Readonly<Record<string, number>>>;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: BackoffPolicy;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 5, backoff: DEFAULT_BACKOFF };

/**
 * Decides what happens after a failure.
 *
 * Terminal errors skip retries entirely — retrying a schema violation or a policy denial just
 * burns budget and delays the human who needs to look at it.
 */
export function nextRetryAt(
  attempt: number,
  maxAttempts: number,
  retryability: 'RETRYABLE' | 'TERMINAL',
  now: Date,
  policy: RetryPolicy,
  random: () => number,
): Date | null {
  if (retryability === 'TERMINAL') return null;
  if (attempt >= maxAttempts) return null;
  return new Date(now.getTime() + backoffDelayMs(attempt, policy.backoff, random));
}
