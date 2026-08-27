/**
 * The contract between the parent test and a forked worker process.
 *
 * Kept in its own module so importing the *shape* of a worker's result does not execute the
 * worker: `worker-process.ts` runs its loop at module scope, which is what makes it a script.
 */

export const RESULT_PREFIX = '__WORKER_RESULT__';

export interface WorkerProcessResult {
  readonly workerId: string;
  readonly claimed: string[];
  /** Highest number of live-leased jobs ever observed in the worker's own partition. */
  readonly maxConcurrentInPartition: number;
  readonly requeued?: string[];
  readonly deadLettered?: string[];
}
