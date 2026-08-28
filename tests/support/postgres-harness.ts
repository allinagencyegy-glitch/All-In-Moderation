import type { TestClock } from '../../src/platform/clock.ts';
import { createTestClock } from '../../src/platform/clock.ts';
import type { IdFactory } from '../../src/platform/ids.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { createMockLlmProvider } from '../../src/integrations/llm/mock-provider.ts';
import { createMemorySecretResolver } from '../../src/adapters/memory/repositories.ts';
import { createPostgresPersistence } from '../../src/adapters/postgres/index.ts';
import type { PostgresPersistence } from '../../src/adapters/postgres/index.ts';
import type { CoreContainer } from '../../src/runtime/container.ts';
import { createContainerWith } from '../../src/runtime/container.ts';
import type { RuntimeConfig } from '../../src/runtime/config.ts';
import type { HarnessOver } from './harness.ts';
import {
  TEST_APP_SECRET,
  TEST_CONFIG,
  TEST_CREDENTIALS_REF,
  createHarnessOver,
} from './harness.ts';
import type { PostgresTestCluster } from './postgres.ts';
import { truncateAll } from './postgres.ts';

/**
 * The Phase 0 harness, wired to PostgreSQL.
 *
 * Everything except the persistence bundle is shared with the in-memory harness: the same
 * fixtures, the same webhook builders, the same mock model, the same deterministic clock. So when
 * a Postgres test disagrees with its in-memory twin, the difference is the database — which is the
 * only way this suite can be evidence of anything.
 *
 * Secrets stay in memory on purpose. They are resolved by reference (ADR-002), and moving them
 * into a table for testing convenience would model the one thing the design says never to store.
 */

export interface PostgresHarness extends HarnessOver<CoreContainer> {
  readonly persistence: PostgresPersistence;
  close(): Promise<void>;
}

export interface PostgresHarnessOptions {
  readonly config?: Partial<RuntimeConfig>;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
  /** Distinguishes concurrent harnesses in the logs; also seeds unique fixture ids. */
  readonly instance?: string;
  readonly clock?: TestClock;
  /** Skip truncation when several harnesses must share one already-seeded database. */
  readonly fresh?: boolean;
  readonly ids?: IdFactory;
}

/**
 * Deterministic ids that are still unique *across* harnesses.
 *
 * Several harnesses sharing a database model several application processes. A plain deterministic
 * factory restarts at 1 in each of them, so two "processes" mint the same primary key and the
 * insert fails on the PK rather than on the dedupe index the test is actually about. Production
 * uses ULIDs and never has this problem; the fixture has to earn the same property.
 */
export function createInstanceIdFactory(instance = '0'): IdFactory {
  const counters = new Map<string, number>();
  return {
    next<T extends string>(prefix: string): T {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      const suffix = instance === '0' ? '' : `${instance.replace(/[^a-z0-9]/gi, '')}`;
      return `${prefix}_${suffix}${String(n).padStart(4, '0')}` as T;
    },
  };
}

export async function createPostgresHarness(
  cluster: PostgresTestCluster,
  options: PostgresHarnessOptions = {},
): Promise<PostgresHarness> {
  if (options.fresh !== false) await truncateAll(cluster.adminUrl);

  const clock = options.clock ?? createTestClock();
  const ids = options.ids ?? createInstanceIdFactory(options.instance);
  const { logger, records } = createMemoryLogger('debug');
  const provider = createMockLlmProvider({ clock });

  const persistence = createPostgresPersistence({
    runtimeConnectionString: cluster.runtimeUrl,
    workerConnectionString: cluster.workerUrl,
    ids,
    logger,
    secrets: createMemorySecretResolver(new Map([[TEST_CREDENTIALS_REF, TEST_APP_SECRET]])),
    pool: {
      maxConnections: options.maxConnections ?? 8,
      ...(options.statementTimeoutMs !== undefined
        ? { statementTimeoutMs: options.statementTimeoutMs }
        : {}),
      applicationName: `moderation-test-${options.instance ?? '1'}`,
    },
  });

  const container = createContainerWith(persistence, {
    config: { ...TEST_CONFIG, ...options.config },
    clock,
    ids,
    logger,
    provider,
    random: () => 0.5,
  });

  const base = createHarnessOver(container, clock, provider, records);
  return {
    ...base,
    persistence,
    close: () => persistence.close(),
  };
}
