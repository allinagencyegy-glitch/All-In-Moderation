import type { Logger } from '../platform/logger.ts';
import { describeError } from '../platform/errors.ts';

/**
 * Recurring background work on a server-side timer.
 *
 * This module exists because of R-1, the oldest open risk in the project: the reaper has been
 * wired, tested and proven across processes since Phase 00, and nothing has ever called it on a
 * timer. Crash recovery that nobody triggers is crash recovery that does not happen.
 *
 * Four properties, each of which is a way a naive `setInterval` breaks a real service:
 *
 *   - **Ticks never overlap.** `setInterval` fires on a wall clock regardless of whether the
 *     previous tick finished. A reaper that takes longer than its interval would then run
 *     concurrently with itself, and two reapers racing on the same expired lease is exactly the
 *     scenario the queue's `SKIP LOCKED` exists to survive — surviving it is not a reason to
 *     cause it. The next tick is scheduled *after* the previous one settles.
 *   - **A failing tick cannot kill the process.** An async callback passed to `setInterval` that
 *     rejects becomes an unhandled rejection, which is fatal in Node by default. Every tick is
 *     wrapped; failures are logged and the schedule continues.
 *   - **Stop actually waits.** `stop()` resolves once the in-flight tick has settled, so a
 *     shutdown can close the database pools knowing nothing is still holding a connection.
 *   - **The timer is unref'd.** A background timer must not be the reason a process refuses to
 *     exit. What keeps this process alive is the HTTP listener and the worker loops — things that
 *     are doing work — not the fact that something is scheduled to happen in ten seconds.
 */

export interface ScheduledTask {
  readonly name: string;
  start(): void;
  /** Runs the task body immediately, outside the schedule. The unit of test. */
  runNow(): Promise<void>;
  stop(): Promise<void>;
  readonly stats: () => { ticks: number; failures: number; running: boolean };
}

export function createScheduledTask(deps: {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  logger: Logger;
  /** Injected so a test can drive the schedule without owning the global timer functions. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
}): ScheduledTask {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let handle: NodeJS.Timeout | null = null;
  let stopped = true;
  let inFlight: Promise<void> | null = null;
  let ticks = 0;
  let failures = 0;

  const tick = async (): Promise<void> => {
    ticks += 1;
    try {
      await deps.run();
    } catch (error) {
      failures += 1;
      const described = describeError(error);
      // Logged, never rethrown. A scheduled task that takes the process down on one bad tick
      // converts a transient database blip into an outage.
      deps.logger.error('scheduled task failed', {
        task: deps.name,
        code: described.code,
        message: described.message,
      });
    }
  };

  /**
   * The single-flight gate.
   *
   * Both callers — the timer and `runNow` — go through here, and a caller that finds a tick
   * already running *joins* it rather than starting a second. Guarding only the timer would leave
   * the one overlap that is easiest to cause and hardest to see: an operator (or a test) invoking
   * the task by hand at the moment the schedule fires.
   */
  const runGuarded = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const schedule = (): void => {
    if (stopped) return;
    handle = setTimer(() => {
      handle = null;
      void runGuarded().finally(() => {
        // Re-armed only after the tick settles, so the interval is a gap between ticks rather
        // than a rate they are expected to keep up with.
        schedule();
      });
    }, deps.intervalMs);
    handle.unref?.();
  };

  return {
    name: deps.name,

    start() {
      if (!stopped) return;
      stopped = false;
      deps.logger.info('scheduled task started', {
        task: deps.name,
        interval_ms: deps.intervalMs,
      });
      schedule();
    },

    async runNow() {
      // Two steps on purpose. Waiting out the tick already in flight is what makes "now" mean
      // *after* everything currently running; the second call is what makes it run at all, rather
      // than silently returning someone else's older result.
      const joined = inFlight;
      if (joined) await joined;
      await runGuarded();
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (handle) {
        clearTimer(handle);
        handle = null;
      }
      // Waiting matters: the caller is about to close the pools this tick may be using.
      if (inFlight) await inFlight;
      deps.logger.info('scheduled task stopped', {
        task: deps.name,
        ticks,
        failures,
      });
    },

    stats: () => ({ ticks, failures, running: !stopped }),
  };
}
