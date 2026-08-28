import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import type { PostgresDatabase } from '../../src/adapters/postgres/client.ts';
import {
  DEFAULT_POSTGRES_CONFIG,
  buildConnectionString,
  createPostgresDatabase,
} from '../../src/adapters/postgres/client.ts';
import { createMigrator } from '../../src/adapters/postgres/migrator.ts';

/**
 * A disposable PostgreSQL for the integration suite.
 *
 * The binaries come from an npm package that unpacks a real PostgreSQL distribution into
 * `node_modules` and runs `postgres` as an ordinary child process — no service registration, no
 * administrator rights, no shared cluster. Deleting `node_modules` removes it completely, which is
 * what makes it safe to point destructive tests at.
 *
 * Everything here exists to make one thing possible: **testing as a non-superuser**. A superuser
 * bypasses row-level security silently, so an RLS suite that connects as `postgres` proves
 * nothing at all. The roles below are the ones the application would really use.
 */

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', 'db', 'migrations');

const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'postgres';
const TEST_DATABASE = 'moderation_test';

/** Passwords for throwaway local roles on a throwaway local cluster. Never reused anywhere. */
const RUNTIME_ROLE = 'app_runtime_login';
const RUNTIME_PASSWORD = 'runtime-local-test';
const WORKER_ROLE = 'app_worker_login';
const WORKER_PASSWORD = 'worker-local-test';
const RELAY_ROLE = 'app_relay_login';
const RELAY_PASSWORD = 'relay-local-test';

export interface PostgresTestCluster {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Superuser connection string. Migrations and fixtures only — never the code under test. */
  readonly adminUrl: string;
  /** Non-superuser, RLS-bound. This is what the repositories use. */
  readonly runtimeUrl: string;
  /** Non-superuser, queue-only. This is what workers and the reaper use. */
  readonly workerUrl: string;
  /** Non-superuser, outbox-only, one writable column. This is what the relay uses. */
  readonly relayUrl: string;
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolvePort(port);
      });
    });
  });
}

interface SharedState {
  cluster: PostgresTestCluster;
  server: EmbeddedPostgres;
  dataDir: string;
}

let shared: SharedState | null = null;
let starting: Promise<SharedState> | null = null;
let refCount = 0;

/**
 * Reports whether a disposable PostgreSQL can be started here at all.
 *
 * The binaries ship as a platform-specific optional dependency. When one is missing the honest
 * outcome is a skipped suite with a loud reason, not a red build that looks like a code defect —
 * and not a green build that looks like proof.
 */
export function postgresAvailable(): boolean {
  try {
    return typeof EmbeddedPostgres === 'function';
  } catch {
    return false;
  }
}

async function startShared(): Promise<SharedState> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'all-in-moderation-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: SUPERUSER,
    password: SUPERUSER_PASSWORD,
    port,
    persistent: false,
    // The server's own log would otherwise interleave with the test reporter's output.
    onLog: () => undefined,
  });

  await server.initialise();
  await server.start();

  const admin = new pg.Client({
    host: '127.0.0.1',
    port,
    user: SUPERUSER,
    password: SUPERUSER_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  // Roles are cluster-wide, so they are created once here rather than per database.
  await admin.query(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
         CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}';
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WORKER_ROLE}') THEN
         CREATE ROLE ${WORKER_ROLE} LOGIN PASSWORD '${WORKER_PASSWORD}';
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RELAY_ROLE}') THEN
         CREATE ROLE ${RELAY_ROLE} LOGIN PASSWORD '${RELAY_PASSWORD}';
       END IF;
     END $$`,
  );
  await admin.end();

  const cluster: PostgresTestCluster = {
    host: '127.0.0.1',
    port,
    database: TEST_DATABASE,
    adminUrl: buildConnectionString({
      host: '127.0.0.1',
      port,
      database: TEST_DATABASE,
      user: SUPERUSER,
      password: SUPERUSER_PASSWORD,
    }),
    runtimeUrl: buildConnectionString({
      host: '127.0.0.1',
      port,
      database: TEST_DATABASE,
      user: RUNTIME_ROLE,
      password: RUNTIME_PASSWORD,
    }),
    workerUrl: buildConnectionString({
      host: '127.0.0.1',
      port,
      database: TEST_DATABASE,
      user: WORKER_ROLE,
      password: WORKER_PASSWORD,
    }),
    relayUrl: buildConnectionString({
      host: '127.0.0.1',
      port,
      database: TEST_DATABASE,
      user: RELAY_ROLE,
      password: RELAY_PASSWORD,
    }),
  };

  // Migrate as the superuser (standing in for `app_migrator`), then grant the login roles their
  // membership. Doing it in this order proves the runtime role never needs schema-owner rights.
  const adminDb = createPostgresDatabase({
    config: { ...DEFAULT_POSTGRES_CONFIG, connectionString: cluster.adminUrl, maxConnections: 4 },
    logger: createMemoryLogger().logger,
  });
  const migrator = createMigrator({
    db: adminDb,
    directory: MIGRATIONS_DIR,
    logger: createMemoryLogger().logger,
  });
  await migrator.migrate();
  await adminDb.unscoped(async (client) => {
    await client.query(`GRANT app_runtime TO ${RUNTIME_ROLE}`);
    await client.query(`GRANT app_worker TO ${WORKER_ROLE}`);
    await client.query(`GRANT app_relay TO ${RELAY_ROLE}`);
  }, 'test:grant-membership');
  await adminDb.close();

  return { cluster, server, dataDir };
}

/**
 * How long the cluster stays up after the last suite releases it.
 *
 * Long enough that the next suite's `before` hook — which runs microseconds after the previous
 * suite's `after` — always finds it running, and short enough that the process exits promptly at
 * the end of the run.
 */
const LINGER_MS = 750;
let shutdownTimer: NodeJS.Timeout | null = null;

/**
 * Boots (or joins) the shared cluster.
 *
 * One cluster for the whole test *process*, not one per suite. `node --test
 * --experimental-test-isolation=none` runs every file in a single process, so paying the ~20s
 * initdb cost per suite would make the suite slow enough that nobody runs it.
 *
 * Shutdown cannot be hung on `process.on('beforeExit')`: the embedded server is an ordinary
 * `spawn`ed child with piped stdio and no `unref`, so its handle keeps the event loop alive
 * forever. `beforeExit` therefore never fires, and a test run that has finished every assertion
 * still never exits — which is exactly what a full `npm test` did before this. The lifetime is
 * driven by the reference count instead, with a short linger so that back-to-back suites share one
 * cluster. `beforeExit` remains only as a backstop for an abnormal path that skips `after`.
 */
export async function acquirePostgres(): Promise<PostgresTestCluster> {
  refCount += 1;
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  starting ??= startShared().then((state) => {
    shared = state;
    process.once('beforeExit', () => {
      void stopShared();
    });
    return state;
  });
  const state = await starting;
  return state.cluster;
}

/**
 * Balances `acquirePostgres`, and shuts the cluster down once nothing holds it.
 *
 * The timer is deliberately *not* unref'd: it is the only thing that will ever stop the server, so
 * it has to be able to keep the loop alive on its own.
 */
export function releasePostgres(): Promise<void> {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && shared !== null && shutdownTimer === null) {
    shutdownTimer = setTimeout(() => {
      shutdownTimer = null;
      if (refCount === 0) void stopShared();
    }, LINGER_MS);
  }
  return Promise.resolve();
}

async function stopShared(): Promise<void> {
  if (shared === null) return;
  const state = shared;
  shared = null;
  starting = null;
  if (truncateClient) {
    await truncateClient.end().catch(() => undefined);
    truncateClient = null;
  }
  if (adminClient) {
    await adminClient.end().catch(() => undefined);
    adminClient = null;
  }
  // A teardown failure must not become an unhandled rejection that kills an otherwise green run;
  // the process is exiting either way, and the data directory lives in the OS temp tree.
  await state.server.stop().catch(() => undefined);
  try {
    rmSync(state.dataDir, { recursive: true, force: true });
  } catch {
    // A Windows file handle can outlive the process for a moment. The directory is in the OS
    // temp tree; leaving it is untidy, not unsafe.
  }
}

/** All tenant-facing tables, child-first, so TRUNCATE order never fights a foreign key. */
export const ALL_TABLES = [
  'event_deliveries',
  'domain_event_outbox',
  'event_subscriptions',
  'audit_events',
  'dead_letters',
  'jobs',
  'knowledge_gaps',
  'knowledge_entries',
  'account_pack_versions',
  'lead_candidates',
  'handoffs',
  'outbound_actions',
  'moderator_runs',
  'messages',
  'conversation_ownership_transitions',
  'conversations',
  'raw_inbound_events',
  'channel_identities',
  'contact_identities',
  'channel_connection_identities',
  'channel_connections',
  'account_memberships',
  'accounts',
  'users',
] as const;

/**
 * Empties every table between tests.
 *
 * `RESTART IDENTITY` matters more than it looks: `jobs.seq` is the tiebreaker in the claim
 * ordering contract, so leaving the sequence running would make one test's assertions depend on
 * how many jobs the previous test happened to create.
 */
let truncateClient: pg.Client | null = null;

export async function truncateAll(adminUrl: string): Promise<void> {
  // One long-lived connection. Reconnecting per test cost roughly a second each, which turns a
  // fast suite into one nobody runs.
  truncateClient ??= await (async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    return client;
  })();
  await truncateClient.query(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export interface PostgresTestDatabases {
  readonly runtime: PostgresDatabase;
  readonly worker: PostgresDatabase;
  readonly relay: PostgresDatabase;
  close(): Promise<void>;
}

/** Three pools, three roles — the split the privilege model requires. */
export function createTestDatabases(
  cluster: PostgresTestCluster,
  options: { maxConnections?: number; statementTimeoutMs?: number } = {},
): PostgresTestDatabases {
  const logger = createMemoryLogger().logger;
  const base = {
    ...DEFAULT_POSTGRES_CONFIG,
    maxConnections: options.maxConnections ?? 8,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_POSTGRES_CONFIG.statementTimeoutMs,
  };
  const runtime = createPostgresDatabase({
    config: { ...base, connectionString: cluster.runtimeUrl },
    logger,
  });
  const worker = createPostgresDatabase({
    config: { ...base, connectionString: cluster.workerUrl },
    logger,
    bypassTenantContext: true,
  });
  const relay = createPostgresDatabase({
    config: { ...base, connectionString: cluster.relayUrl },
    logger,
    bypassTenantContext: true,
  });
  return {
    runtime,
    worker,
    relay,
    async close() {
      await Promise.all([runtime.close(), worker.close(), relay.close()]);
    },
  };
}

let adminClient: pg.Client | null = null;

/**
 * A raw superuser connection, for fixtures and for asserting on state RLS would hide.
 *
 * Held open for the life of the process. Connecting per call added roughly a second to every
 * fixture, and a suite slow enough to skip is a suite that stops being run.
 */
export async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  adminClient ??= await (async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    return client;
  })();
  return await fn(adminClient);
}
