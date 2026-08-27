import { TimeoutError } from './errors.ts';

/**
 * Runs a promise under a hard deadline, propagating an AbortSignal so the underlying call can
 * actually be cancelled rather than merely abandoned. An abandoned HTTP call still holds a
 * socket and still bills us for the tokens.
 */
export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new TimeoutError(operation, timeoutMs)),
    timeoutMs,
  );
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly capMs: number;
  readonly jitter: 'FULL' | 'NONE';
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, capMs: 300_000, jitter: 'FULL' };

/**
 * Exponential backoff with full jitter. Full jitter (not "equal" or "decorrelated") is chosen
 * because our retries are triggered by shared dependencies — when a provider recovers, every
 * queued job would otherwise retry in the same instant and knock it over again.
 *
 * `random` is injected so the schedule is deterministic under test.
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number,
): number {
  const exponential = Math.min(policy.capMs, policy.baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  if (policy.jitter === 'NONE') return Math.round(exponential);
  return Math.round(random() * exponential);
}

/** Resolves after `ms`, using the injected timer so tests never wait on real time. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
