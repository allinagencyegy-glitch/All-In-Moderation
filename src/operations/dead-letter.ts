import type { Job } from './jobs/job.ts';

export interface DeadLetter {
  readonly job: Job;
  readonly error: { readonly code: string; readonly message: string };
  readonly recordedAt: Date;
}

/**
 * The terminal destination for work that cannot succeed.
 *
 * A dead letter is not a deletion. It preserves the job, its error chain, and enough context to
 * replay it once the cause is fixed — which is possible precisely because the raw inbound ledger
 * is immutable, so a corrected parser can re-derive everything downstream (ADR-006).
 *
 * A non-zero dead-letter count is always an alert. This is the one queue that should be empty.
 */
export interface DeadLetterStore {
  record(entry: DeadLetter): Promise<void>;
  list(): Promise<readonly DeadLetter[]>;
  count(): Promise<number>;
}
