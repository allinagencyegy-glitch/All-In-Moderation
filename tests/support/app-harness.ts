import type { TestClock } from '../../src/platform/clock.ts';
import { createTestClock } from '../../src/platform/clock.ts';
import type { IdFactory } from '../../src/platform/ids.ts';
import { createDeterministicIdFactory } from '../../src/platform/ids.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { createMockLlmProvider } from '../../src/integrations/llm/mock-provider.ts';
import type { RelayTarget } from '../../src/operations/events/relay.ts';
import { createMemoryDatabase } from '../../src/adapters/memory/database.ts';
import type { MemoryDatabase } from '../../src/adapters/memory/database.ts';
import type { Application } from '../../src/runtime/application.ts';
import { createApplication } from '../../src/runtime/application.ts';
import type { Persistence } from '../../src/runtime/container.ts';
import { createMemoryPersistence } from '../../src/runtime/container.ts';
import type { RuntimeConfig } from '../../src/runtime/config.ts';
import type { HarnessOver } from './harness.ts';
import { TEST_CONFIG, TEST_SECRETS, createHarnessOver } from './harness.ts';

/**
 * A running application, wrapped in the same harness the unit suites use.
 *
 * The point of running the *application* rather than a hand-assembled server is that the shutdown
 * ordering, the signal wiring and the composition are the things Phase 02 adds — testing a
 * server built differently from the one that ships would prove something about the test.
 *
 * Signal handlers are never installed here. A suite that installs process-wide `SIGTERM`
 * handlers leaks them into every subsequent test file in the same process, and
 * `--experimental-test-isolation=none` means there is always a subsequent test file. Shutdown is
 * driven by calling `stop()` — which is exactly what the real handler does.
 */

export interface AppHarness extends HarnessOver<Application['container']> {
  readonly app: Application;
  readonly db: MemoryDatabase;
  /** Bound address, present whenever the role includes `web`. */
  readonly base: { port: number; host: string };
  stop(): Promise<void>;
}

export interface AppHarnessOptions {
  readonly config?: Partial<RuntimeConfig>;
  readonly clock?: TestClock;
  readonly ids?: IdFactory;
  readonly relayTarget?: RelayTarget;
  /** Supplied by the Postgres variant; omitted, an in-memory bundle is built. */
  readonly persistence?: Persistence;
  readonly closePersistence?: () => Promise<void>;
}

export async function createAppHarness(options: AppHarnessOptions = {}): Promise<AppHarness> {
  const clock = options.clock ?? createTestClock();
  const ids = options.ids ?? createDeterministicIdFactory();
  const { logger, records } = createMemoryLogger('debug');
  const provider = createMockLlmProvider({ clock });
  const db = createMemoryDatabase();
  const persistence = options.persistence ?? createMemoryPersistence(db, ids, TEST_SECRETS);

  const app = createApplication({
    persistence,
    config: { ...TEST_CONFIG, ...options.config },
    clock,
    ids,
    logger,
    provider,
    ...(options.relayTarget ? { relayTarget: options.relayTarget } : {}),
    ...(options.closePersistence ? { closePersistence: options.closePersistence } : {}),
  });

  const started = await app.start();
  const base = started.http ?? { port: 0, host: '127.0.0.1' };
  const harness = createHarnessOver(app.container, clock, provider, records);

  return {
    ...harness,
    app,
    db,
    base,
    stop: () => app.stop('test'),
  };
}
