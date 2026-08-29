import type { Clock } from '../platform/clock.ts';
import { systemClock } from '../platform/clock.ts';
import type { IdFactory } from '../platform/ids.ts';
import type { Logger } from '../platform/logger.ts';
import { createLogger } from '../platform/logger.ts';
import { describeError } from '../platform/errors.ts';
import type { LlmProvider } from '../platform/llm/provider.ts';
import type { RelayTarget } from '../operations/events/relay.ts';
import type { CoreContainer, Persistence } from './container.ts';
import { createContainerWith } from './container.ts';
import type { RuntimeConfig } from './config.ts';
import { loadConfig } from './config.ts';
import type { HttpServer } from './http/server.ts';
import { createHttpServer } from './http/server.ts';
import type { ScheduledTask } from './scheduler.ts';
import { createScheduledTask } from './scheduler.ts';
import type { WorkerLoop } from './worker-loop.ts';
import { createWorkerLoop } from './worker-loop.ts';

/**
 * The application shell: the thing that runs.
 *
 * Phase 00 and 01 built a library and proved it. Nothing in the tree had a `main`. Every test
 * called `drain()` by hand, the reaper was invoked by an assertion, and the webhook path — the
 * one surface a provider actually talks to — had never seen a socket. This module is where those
 * pieces become a process.
 *
 * ### Start-up order
 *
 * Workers and timers start **before** the listener binds. A process that accepts webhooks before
 * it can process them is briefly a queue with no consumer; doing it the other way round is free.
 *
 * ### Shutdown order, and why it is exactly this
 *
 *   1. **Flag first.** `/health/ready` starts answering 503 the instant a signal arrives, so a
 *      load balancer stops sending work while the process is still perfectly capable of finishing
 *      what it has. Draining before dying is the entire point.
 *   2. **Listener next.** Stop accepting new webhooks, let in-flight requests finish. Each one is
 *      a durable write that is nearly done; killing it would make the provider redeliver.
 *   3. **Timers.** The reaper and the relay stop, and `stop()` waits for a tick in progress —
 *      otherwise step 5 would close a pool a scheduled task is still holding.
 *   4. **Workers.** Stop claiming, then let the current job finish or hand its lease back.
 *   5. **Pools last.** Everything above needs the database right up to the moment it finishes.
 *
 * Reversing any two of these produces a specific, familiar bug: closing pools first turns a clean
 * shutdown into a burst of connection errors that look like data loss.
 */

export interface ApplicationOptions {
  readonly persistence: Persistence;
  readonly config?: RuntimeConfig;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly logger?: Logger;
  readonly provider?: LlmProvider;
  /**
   * The model API key. Read from the environment at the boot edge and passed through, so it never
   * lands on `RuntimeConfig` — see the note at the end of that interface.
   */
  readonly llmApiKey?: string;
  readonly relayTarget?: RelayTarget;
  /** Closes the persistence bundle. Runs last, once nothing else can be using it. */
  readonly closePersistence?: () => Promise<void>;
  /**
   * Off by default. A library that installs process-wide signal handlers the moment it is
   * constructed is a library that cannot be tested twice in one process.
   */
  readonly installSignalHandlers?: boolean;
  /** Called after a signal-initiated shutdown completes. `main` exits here. */
  readonly onShutdownComplete?: (reason: string) => void;
}

export interface Application {
  readonly container: CoreContainer;
  readonly config: RuntimeConfig;
  /** Null when this process has no web role. */
  readonly http: HttpServer | null;
  readonly reaperTask: ScheduledTask | null;
  readonly relayTask: ScheduledTask | null;
  readonly workers: readonly WorkerLoop[];
  start(): Promise<{ http: { port: number; host: string } | null }>;
  stop(reason: string): Promise<void>;
  readonly shuttingDown: () => boolean;
}

export function createApplication(options: ApplicationOptions): Application {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger({ level: config.logLevel, now: () => clock.now() });
  const startedAt = clock.now();

  let shuttingDown = false;
  const container = createContainerWith(options.persistence, {
    config,
    clock,
    logger,
    startedAt,
    // Read live rather than captured, so a snapshot taken mid-shutdown reports the truth.
    isShuttingDown: () => shuttingDown,
    ...(options.ids ? { ids: options.ids } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.llmApiKey ? { llmApiKey: options.llmApiKey } : {}),
    ...(options.relayTarget ? { relayTarget: options.relayTarget } : {}),
  });

  const runsWorkers = config.role === 'worker' || config.role === 'all';
  const runsWeb = config.role === 'web' || config.role === 'all';

  const workers: WorkerLoop[] = runsWorkers
    ? Array.from({ length: config.worker.concurrency }, (_, index) => {
        const workerId = `${config.role}-${String(process.pid)}-${String(index + 1)}`;
        return createWorkerLoop({
          worker: container.createWorker(workerId),
          queue: container.queue,
          clock,
          logger,
          workerId,
          pollIntervalMs: config.worker.pollIntervalMs,
        });
      })
    : [];

  /**
   * Timers live with the worker role, not the web role.
   *
   * The reaper and the relay are background work, and a web process is one signal away from
   * being replaced during a deploy. Attaching recovery to the shortest-lived role in the system
   * is how "the reaper runs" becomes "the reaper ran until the last deploy".
   */
  const reaperTask: ScheduledTask | null = runsWorkers
    ? createScheduledTask({
        name: 'reaper',
        intervalMs: config.scheduler.reaperIntervalMs,
        run: () => container.reaper.reap(),
        logger,
      })
    : null;

  const relayTask: ScheduledTask | null = runsWorkers
    ? createScheduledTask({
        name: 'outbox-relay',
        intervalMs: config.scheduler.relayIntervalMs,
        run: () => container.relay.relayOnce(),
        logger,
      })
    : null;

  const http: HttpServer | null = runsWeb
    ? createHttpServer({
        ingest: container.ingest,
        health: container.health,
        clock,
        logger,
        options: {
          port: config.http.port,
          host: config.http.host,
          headersTimeoutMs: config.http.headersTimeoutMs,
          requestTimeoutMs: config.http.requestTimeoutMs,
          maxBodyBytes: config.ingest.maxBodyBytes,
        },
      })
    : null;

  let stopping: Promise<void> | null = null;
  let signalsInstalled: (() => void) | null = null;

  const stop = async (reason: string): Promise<void> => {
    // Idempotent: a SIGTERM followed by a SIGINT must join the shutdown already under way rather
    // than start a second one that races it through the same teardown.
    if (stopping) return await stopping;
    stopping = (async () => {
      shuttingDown = true;
      logger.info('shutdown started', { reason, role: config.role });

      if (http) await http.stop(config.http.shutdownGraceMs);
      await Promise.all([reaperTask?.stop(), relayTask?.stop()]);

      const outcomes = await Promise.all(
        workers.map((worker) => worker.stop(config.worker.shutdownGraceMs)),
      );
      const forced = outcomes.filter((outcome) => outcome.forced).length;

      if (options.closePersistence) {
        try {
          await options.closePersistence();
        } catch (error) {
          // Never rethrow out of shutdown. The process is going away; a failure to close a pool
          // must not turn a clean exit into a non-zero one that pages somebody.
          logger.error('closing persistence failed', {
            code: describeError(error).code,
            message: describeError(error).message,
          });
        }
      }

      signalsInstalled?.();
      logger.info('shutdown complete', { reason, forced_workers: forced });
      options.onShutdownComplete?.(reason);
    })();
    return await stopping;
  };

  const installSignals = (): void => {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    const handlers = new Map<NodeJS.Signals, () => void>();
    let received = false;

    for (const signal of signals) {
      const handler = (): void => {
        if (received) {
          // The operator (or the orchestrator) asked twice. Honour it: a shutdown that ignores a
          // second signal is indistinguishable from a hung process.
          logger.warn('second signal received; exiting immediately', { signal });
          process.exit(1);
        }
        received = true;
        void stop(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }

    signalsInstalled = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      signalsInstalled = null;
    };
  };

  return {
    container,
    config,
    http,
    reaperTask,
    relayTask,
    workers,
    shuttingDown: () => shuttingDown,

    async start() {
      if (options.installSignalHandlers) installSignals();

      for (const worker of workers) worker.start();
      reaperTask?.start();
      relayTask?.start();

      const bound = http ? await http.start() : null;
      logger.info('application started', {
        role: config.role,
        outbound_mode: config.outboundMode,
        workers: workers.length,
        http_port: bound?.port ?? null,
      });
      return { http: bound };
    },

    stop,
  };
}
