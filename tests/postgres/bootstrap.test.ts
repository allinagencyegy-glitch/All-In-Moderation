import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { createTestClock } from '../../src/platform/clock.ts';
import { createMockLlmProvider } from '../../src/integrations/llm/mock-provider.ts';
import {
  META_SIGNATURE_HEADER,
  computeMetaSignature,
} from '../../src/integrations/meta/signature.ts';
import { createMemorySecretResolver } from '../../src/adapters/memory/repositories.ts';
import {
  DEFAULT_POSTGRES_CONFIG,
  buildConnectionString,
  createPostgresDatabase,
} from '../../src/adapters/postgres/client.ts';
import {
  MIGRATION_ROLE,
  MIN_PASSWORD_LENGTH,
  ROLE_MODEL,
  bootstrapDatabase,
} from '../../src/adapters/postgres/bootstrap.ts';
import type { BootstrapReport } from '../../src/adapters/postgres/bootstrap.ts';
import { createMigrator, loadMigrations } from '../../src/adapters/postgres/migrator.ts';
import { createPostgresPersistence } from '../../src/adapters/postgres/index.ts';
import type { PostgresPersistence } from '../../src/adapters/postgres/index.ts';
import { createApplication } from '../../src/runtime/application.ts';
import type { Application } from '../../src/runtime/application.ts';
import { traceRawEvent } from '../../src/runtime/admin/shadow-trace.ts';
import { createHarnessOver } from '../support/harness.ts';
import type { HarnessOver, SeededAccount } from '../support/harness.ts';
import {
  TEST_APP_SECRET,
  TEST_CONFIG,
  TEST_SECRETS,
  decisionJson,
  metaMessageEnvelope,
} from '../support/harness.ts';
import { createInstanceIdFactory } from '../support/postgres-harness.ts';
import { httpRequest, jsonBody } from '../support/http-client.ts';
import type { DisposableCluster } from '../support/postgres.ts';
import {
  MIGRATIONS_DIR,
  generateTestPassword,
  postgresAvailable,
  startDisposableCluster,
} from '../support/postgres.ts';

/**
 * Phase 02B.1: the deployment bootstrap, proved on a cluster that has never been touched.
 *
 * ### Why this needs its own cluster
 *
 * PostgreSQL roles are cluster-wide. The shared harness cluster already ran the bootstrap in its
 * `before` hook, so a second *database* there would find every role present and would prove
 * nothing about creating them. This suite pays for a second `initdb` in order to start from
 * genuinely nothing: no database, no roles, no extension.
 *
 * ### The chain being proved, in order
 *
 *   CREATE DATABASE (operator, privileged, cannot be transactional)
 *     -> bootstrap: privilege roles, login identities, memberships, pgcrypto, schema grants
 *     -> migrate every migration on disk as app_migrator_login assuming app_migrator
 *     -> runtime / worker / relay logins connect
 *     -> each does exactly its own work, and nothing else
 *     -> the application boots and takes a webhook off a real socket
 *     -> the delivery traces end to end and every outbound action is SIMULATED
 *
 * ### The finding that made this phase necessary
 *
 * The migrations create `app_runtime`, `app_migrator`, `app_worker` and `app_relay` — all
 * `NOLOGIN`. Nothing created an identity that could connect, and the checklist told operators to
 * put `app_migrator` in `PG_MIGRATOR_URL`, which cannot work. The test harness papered over it by
 * inventing three login roles of its own and migrating as the superuser, so the suite proved a
 * role model that no documented procedure produced.
 *
 * The subtler half is `BYPASSRLS`. It is a role *attribute*, and PostgreSQL does not inherit
 * attributes through membership: `app_migrator_login` is a member of `app_migrator` and still has
 * `rolbypassrls = false`. Only an explicit `SET ROLE` confers it — and it has to be conferred,
 * because both SECURITY DEFINER resolvers execute as their owner against tables that `FORCE` row
 * level security. That is asserted below rather than described.
 */

const available = postgresAvailable();
const DATABASE = 'moderation_bootstrap_proof';

describe('postgres deployment bootstrap', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: DisposableCluster;
  let passwords: Map<string, string>;
  let firstReport: BootstrapReport;
  let secondReport: BootstrapReport;
  let bootstrapLogs: ReturnType<typeof createMemoryLogger>['records'];

  const url = (loginRole: string): string =>
    buildConnectionString({
      host: cluster.host,
      port: cluster.port,
      database: DATABASE,
      user: loginRole,
      password: passwords.get(loginRole)!,
    });

  /** Opens a privileged pool the way `src/runtime/cli/bootstrap.ts` does. */
  const privilegedDb = (database = DATABASE) =>
    createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: cluster.superuserUrl(database),
        maxConnections: 1,
      },
      logger: createMemoryLogger().logger,
      bypassTenantContext: true,
    });

  const asSuperuser = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: cluster.superuserUrl(DATABASE) });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };

  before(async () => {
    cluster = await startDisposableCluster();
    await cluster.createDatabase(DATABASE);
    passwords = new Map(ROLE_MODEL.map((entry) => [entry.loginRole, generateTestPassword()]));
  });

  after(async () => {
    await cluster.stop();
  });

  // ----------------------------------------------------------------------------------------------
  // 1. Preflight and the privileged bootstrap
  // ----------------------------------------------------------------------------------------------

  it('--check on an empty database reports the whole delta and changes nothing', async () => {
    const db = privilegedDb();
    try {
      const report = await bootstrapDatabase({
        db,
        logger: createMemoryLogger().logger,
        passwords: new Map(),
        checkOnly: true,
      });
      assert.equal(report.mode, 'check');
      assert.equal(report.ok, false, 'an unbootstrapped database is not ok');
      // Four privilege roles, four login identities, four memberships, one extension.
      assert.equal(report.pending.length, 13, report.pending.join('; '));
      for (const entry of ROLE_MODEL) {
        assert.ok(
          report.pending.some((line) => line.includes(entry.privilegeRole)),
          `${entry.privilegeRole} is reported missing`,
        );
        assert.ok(
          report.pending.some((line) => line.includes(entry.loginRole)),
          `${entry.loginRole} is reported missing`,
        );
      }
    } finally {
      await db.close();
    }

    // The load-bearing half of "changes nothing".
    const roles = await asSuperuser(async (client) => {
      const result = await client.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname LIKE 'app\\_%'",
      );
      return result.rows;
    });
    assert.deepEqual(roles, [], '--check must not create a role');
  });

  it('refuses to bootstrap a maintenance database', async () => {
    // Roles are cluster-wide but CONNECT and schema privileges are not, so bootstrapping
    // `postgres` half-works and the mistake surfaces much later, as a migration failure.
    const db = privilegedDb('postgres');
    try {
      await assert.rejects(
        () =>
          bootstrapDatabase({
            db,
            logger: createMemoryLogger().logger,
            passwords,
          }),
        (error: unknown) => (error as { code?: string }).code === 'BOOTSTRAP_WRONG_DATABASE',
      );
    } finally {
      await db.close();
    }
  });

  it('refuses to create an identity without a password, and refuses a weak one', async () => {
    const db = privilegedDb();
    try {
      await assert.rejects(
        () => bootstrapDatabase({ db, logger: createMemoryLogger().logger, passwords: new Map() }),
        (error: unknown) => (error as { code?: string }).code === 'BOOTSTRAP_PASSWORD_MISSING',
        'a missing credential must fail closed rather than default to something',
      );
      await assert.rejects(
        () =>
          bootstrapDatabase({
            db,
            logger: createMemoryLogger().logger,
            passwords: new Map(
              ROLE_MODEL.map((entry) => [entry.loginRole, 'x'.repeat(MIN_PASSWORD_LENGTH - 1)]),
            ),
          }),
        (error: unknown) => (error as { code?: string }).code === 'BOOTSTRAP_PASSWORD_WEAK',
      );
    } finally {
      await db.close();
    }

    const roles = await asSuperuser(async (client) => {
      const result = await client.query("SELECT 1 FROM pg_roles WHERE rolname LIKE 'app\\_%'");
      return result.rowCount ?? 0;
    });
    assert.equal(roles, 0, 'a refused bootstrap leaves no partial role model behind');
  });

  it('creates the role model: four privilege roles, four login identities, four memberships', async () => {
    const memory = createMemoryLogger('debug');
    bootstrapLogs = memory.records;
    const db = privilegedDb();
    try {
      firstReport = await bootstrapDatabase({
        db,
        logger: memory.logger,
        passwords,
        endpoint: { host: cluster.host, port: cluster.port },
      });
    } finally {
      await db.close();
    }

    assert.equal(firstReport.ok, true, firstReport.pending.join('; '));
    assert.equal(firstReport.mode, 'apply');
    assert.equal(firstReport.database, DATABASE);
    assert.deepEqual(
      firstReport.privilegeRoles.map((role) => role.action),
      ['created', 'created', 'created', 'created'],
    );
    assert.deepEqual(
      firstReport.loginRoles.map((role) => role.action),
      ['created', 'created', 'created', 'created'],
    );
    assert.deepEqual(
      firstReport.memberships.map((m) => m.action),
      ['granted', 'granted', 'granted', 'granted'],
    );
    assert.deepEqual(firstReport.extensions, [{ name: 'pgcrypto', action: 'granted' }]);
  });

  it('gives the migrator BYPASSRLS and gives no login identity any role attribute at all', async () => {
    const rows = await asSuperuser(async (client) => {
      const result = await client.query<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolinherit: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
      }>(
        `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit, rolcreaterole, rolcreatedb
           FROM pg_roles WHERE rolname LIKE 'app\\_%' ORDER BY rolname`,
      );
      return result.rows;
    });
    const byName = new Map(rows.map((row) => [row.rolname, row]));

    for (const entry of ROLE_MODEL) {
      const privilege = byName.get(entry.privilegeRole);
      assert.ok(privilege, `${entry.privilegeRole} exists`);
      assert.equal(privilege.rolcanlogin, false, `${entry.privilegeRole} must be NOLOGIN`);
      assert.equal(privilege.rolsuper, false);
      assert.equal(privilege.rolbypassrls, entry.bypassRls, `${entry.privilegeRole} BYPASSRLS`);

      const login = byName.get(entry.loginRole);
      assert.ok(login, `${entry.loginRole} exists`);
      assert.equal(login.rolcanlogin, true, `${entry.loginRole} must be able to connect`);
      assert.equal(login.rolsuper, false, `${entry.loginRole} must not be a superuser`);
      // The one that matters. A login identity with BYPASSRLS is a tenancy model that is not in
      // force, and no GRANT would put it back.
      assert.equal(login.rolbypassrls, false, `${entry.loginRole} must not bypass RLS`);
      assert.equal(login.rolcreaterole, false);
      assert.equal(login.rolcreatedb, false);
      assert.equal(
        login.rolinherit,
        entry.inherit,
        `${entry.loginRole} INHERIT: the migrator identity is NOINHERIT so its authority is ` +
          'dormant until an explicit SET ROLE',
      );
    }
  });

  it('BYPASSRLS is not inherited through membership — only SET ROLE confers it', async () => {
    // The single most misleading thing about this role model, asserted so nobody has to rediscover
    // it. `app_migrator_login` is a member of a BYPASSRLS role and cannot bypass anything.
    const client = new pg.Client({ connectionString: url('app_migrator_login') });
    await client.connect();
    try {
      const before = await client.query<{ rolbypassrls: boolean; member: boolean }>(
        `SELECT r.rolbypassrls, pg_has_role(current_user, 'app_migrator', 'member') AS member
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      assert.equal(before.rows[0]?.member, true, 'membership is in place');
      assert.equal(
        before.rows[0]?.rolbypassrls,
        false,
        'membership does not confer the attribute — this is why migrate.ts issues SET ROLE',
      );

      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${MIGRATION_ROLE}`);
      const during = await client.query<{ rolbypassrls: boolean; who: string }>(
        `SELECT r.rolbypassrls, current_user AS who FROM pg_roles r WHERE r.rolname = current_user`,
      );
      assert.equal(during.rows[0]?.who, MIGRATION_ROLE);
      assert.equal(during.rows[0]?.rolbypassrls, true, 'SET ROLE is what confers it');
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('is idempotent: a second run grants nothing, creates nothing and rotates nothing', async () => {
    const before = await snapshotRoleModel();

    const db = privilegedDb();
    try {
      secondReport = await bootstrapDatabase({
        db,
        logger: createMemoryLogger().logger,
        // Deliberately empty. A re-run must not need the passwords again — needing them is how a
        // routine "check my deployment" turns into an unplanned credential rotation.
        passwords: new Map(),
        endpoint: { host: cluster.host, port: cluster.port },
      });
    } finally {
      await db.close();
    }

    assert.equal(secondReport.ok, true, secondReport.pending.join('; '));
    assert.deepEqual(
      secondReport.privilegeRoles.map((role) => role.action),
      ['present', 'present', 'present', 'present'],
    );
    assert.deepEqual(
      secondReport.loginRoles.map((role) => role.action),
      ['present', 'present', 'present', 'present'],
    );
    assert.deepEqual(
      secondReport.memberships.map((m) => m.action),
      ['present', 'present', 'present', 'present'],
      'a duplicate membership row is the classic non-idempotent bootstrap',
    );
    assert.deepEqual(await snapshotRoleModel(), before, 'the catalog is byte-identical');

    // And the passwords still work, which is the property the report cannot prove on its own.
    for (const entry of ROLE_MODEL) {
      const client = new pg.Client({ connectionString: url(entry.loginRole) });
      await client.connect();
      await client.end();
    }
  });

  it('never puts a password in its report or its log', () => {
    const rendered = `${JSON.stringify(firstReport)} ${JSON.stringify(secondReport)} ${JSON.stringify(bootstrapLogs)}`;
    for (const [role, password] of passwords) {
      assert.ok(!rendered.includes(password), `${role}'s password leaked into output`);
    }
    // What it prints instead is a template naming the environment variable.
    assert.equal(
      firstReport.connectionTemplates['PG_RUNTIME_URL'],
      `postgres://app_runtime_login:$PG_RUNTIME_PASSWORD@${cluster.host}:${String(cluster.port)}/${DATABASE}`,
    );
  });

  // ----------------------------------------------------------------------------------------------
  // 2. Migration, under the migrator identity
  // ----------------------------------------------------------------------------------------------

  it('migrates every migration on disk as app_migrator_login assuming app_migrator', async () => {
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: url('app_migrator_login'),
        maxConnections: 2,
      },
      logger: createMemoryLogger().logger,
      bypassTenantContext: true,
    });
    try {
      const result = await createMigrator({
        db,
        directory: MIGRATIONS_DIR,
        logger: createMemoryLogger().logger,
        assumeRole: MIGRATION_ROLE,
      }).migrate();
      assert.deepEqual(
        result.applied,
        loadMigrations(MIGRATIONS_DIR).map((file) => file.filename),
      );
      assert.equal(result.alreadyCurrent, false);
    } finally {
      await db.close();
    }

    const versions = await asSuperuser(async (client) => {
      const result = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      return result.rows.map((row) => row.version);
    });
    // Derived from the directory rather than hard-coded, so adding a migration cannot make this
    // test stale — and the contiguity check below is what a hard-coded list was really buying:
    // it still catches a deleted, renumbered or skipped migration.
    const onDisk = loadMigrations(MIGRATIONS_DIR).map((file) => file.filename.slice(0, 4));
    assert.deepEqual(versions, onDisk);
    assert.deepEqual(
      versions,
      versions.map((_version, index) => String(index + 1).padStart(4, '0')),
      'migrations must be contiguous from 0001: a gap means one was deleted or misnumbered',
    );
  });

  it('leaves every object owned by app_migrator, not by the identity that connected', async () => {
    const owners = await asSuperuser(async (client) => {
      const result = await client.query<{ owner: string; n: string }>(
        `SELECT pg_get_userbyid(c.relowner) AS owner, count(*)::text AS n
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','S')
          GROUP BY 1`,
      );
      return result.rows;
    });
    assert.deepEqual(
      owners.map((row) => row.owner),
      [MIGRATION_ROLE],
      'ownership must belong to the privilege role; a schema owned by a credential cannot be ' +
        'rotated without a hand-written ALTER for every object',
    );

    // Every SECURITY DEFINER resolver executes as its owner, against FORCE'd RLS. If the owner
    // were not BYPASSRLS they would return nothing and webhook ingest would fail for every
    // delivery — silently, because "no such connection" is a legitimate answer.
    const definers = await asSuperuser(async (client) => {
      const result = await client.query<{ proname: string; owner: string }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`,
      );
      return result.rows;
    });
    assert.deepEqual(definers, [
      { proname: 'app_inbound_backlog', owner: MIGRATION_ROLE },
      { proname: 'app_resolve_account_id_by_slug', owner: MIGRATION_ROLE },
      { proname: 'app_resolve_webhook_connection', owner: MIGRATION_ROLE },
    ]);
  });

  it('the running application never holds migration authority', async () => {
    // The runtime identity is not a member of app_migrator, so it cannot even assume the role —
    // which means "migrations run as a different role" is enforced rather than merely intended.
    for (const loginRole of ['app_runtime_login', 'app_worker_login', 'app_relay_login']) {
      const db = createPostgresDatabase({
        config: { ...DEFAULT_POSTGRES_CONFIG, connectionString: url(loginRole), maxConnections: 1 },
        logger: createMemoryLogger().logger,
        bypassTenantContext: true,
      });
      try {
        await assert.rejects(
          () =>
            createMigrator({
              db,
              directory: MIGRATIONS_DIR,
              logger: createMemoryLogger().logger,
              assumeRole: MIGRATION_ROLE,
            }).migrate(),
          (error: unknown) => (error as { code?: string }).code === 'MIGRATION_ROLE_UNAVAILABLE',
          `${loginRole} must not be able to assume ${MIGRATION_ROLE}`,
        );
      } finally {
        await db.close();
      }
    }
  });

  it('a second migrate applies nothing', async () => {
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: url('app_migrator_login'),
        maxConnections: 2,
      },
      logger: createMemoryLogger().logger,
      bypassTenantContext: true,
    });
    try {
      const result = await createMigrator({
        db,
        directory: MIGRATIONS_DIR,
        logger: createMemoryLogger().logger,
        assumeRole: MIGRATION_ROLE,
      }).migrate();
      assert.deepEqual(result.applied, []);
      assert.equal(result.alreadyCurrent, true);
    } finally {
      await db.close();
    }
  });

  // ----------------------------------------------------------------------------------------------
  // 3. Each identity connects, and can do exactly its own work
  // ----------------------------------------------------------------------------------------------

  describe('the three application identities', () => {
    let runtime: pg.Client;
    let worker: pg.Client;
    let relay: pg.Client;

    before(async () => {
      runtime = new pg.Client({ connectionString: url('app_runtime_login') });
      worker = new pg.Client({ connectionString: url('app_worker_login') });
      relay = new pg.Client({ connectionString: url('app_relay_login') });
      await Promise.all([runtime.connect(), worker.connect(), relay.connect()]);
      // One tenant row for the runtime assertions to act on. Written by the superuser because the
      // point of the following tests is what the *runtime* can see, not how it got there.
      await asSuperuser(async (client) => {
        await client.query(
          `INSERT INTO accounts (id, slug, name, status) VALUES ($1,$2,$3,'ACTIVE')
             ON CONFLICT (id) DO NOTHING`,
          ['acc_boot', 'boot', 'Bootstrap Proof'],
        );
      });
    });

    after(async () => {
      await Promise.all([runtime.end(), worker.end(), relay.end()]);
    });

    const refusedBy = async (client: pg.Client, sql: string): Promise<string | null> => {
      try {
        await client.query(sql);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
    };

    it('runtime: connects, is bound by RLS, and sees nothing without a tenant context', async () => {
      const attributes = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      assert.equal(attributes.rows[0]?.rolsuper, false);
      assert.equal(attributes.rows[0]?.rolbypassrls, false);

      // No `SET LOCAL app.account_id`: the policy predicate is NULL and every row is filtered.
      const blind = await runtime.query('SELECT id FROM accounts');
      assert.equal(blind.rowCount, 0, 'a connection that forgot its tenant context sees nothing');

      await runtime.query('BEGIN');
      await runtime.query('SELECT set_config($1,$2,true)', ['app.account_id', 'acc_boot']);
      const scoped = await runtime.query<{ id: string }>('SELECT id FROM accounts');
      assert.deepEqual(
        scoped.rows.map((row) => row.id),
        ['acc_boot'],
        'and sees exactly its own tenant once the context is set',
      );
      await runtime.query('ROLLBACK');
    });

    it('worker: reads the queue across tenants and cannot reach a conversation', async () => {
      const jobs = await worker.query('SELECT count(*) FROM jobs');
      assert.equal(jobs.rowCount, 1, 'the queue is what a worker is for');
      await worker.query('SELECT count(*) FROM dead_letters');

      for (const table of [
        'conversations',
        'messages',
        'raw_inbound_events',
        'knowledge_entries',
        'accounts',
        'channel_connections',
        'domain_event_outbox',
      ]) {
        assert.equal(
          await refusedBy(worker, `SELECT count(*) FROM ${table}`),
          '42501',
          `app_worker must not be able to read ${table}`,
        );
      }
    });

    it('relay: reads the outbox, writes only relayed_at, and reaches nothing else', async () => {
      await relay.query('SELECT id, type, data FROM domain_event_outbox');
      await relay.query('UPDATE domain_event_outbox SET relayed_at = now() WHERE false');

      for (const column of ['data', 'type', 'account_id']) {
        assert.equal(
          await refusedBy(relay, `UPDATE domain_event_outbox SET ${column} = NULL WHERE false`),
          '42501',
          `app_relay must not be able to rewrite ${column} on the way out of the platform`,
        );
      }
      for (const table of [
        'conversations',
        'messages',
        'raw_inbound_events',
        'jobs',
        'dead_letters',
        'knowledge_entries',
      ]) {
        assert.equal(
          await refusedBy(relay, `SELECT count(*) FROM ${table}`),
          '42501',
          `app_relay must not be able to read ${table}`,
        );
      }
    });

    it('none of the three can alter the schema', async () => {
      for (const [name, client] of [
        ['runtime', runtime],
        ['worker', worker],
        ['relay', relay],
      ] as const) {
        for (const sql of [
          'CREATE TABLE bootstrap_evil (id text)',
          'DROP TABLE jobs',
          'ALTER TABLE domain_event_outbox ADD COLUMN evil text',
        ]) {
          assert.equal(
            await refusedBy(client, sql),
            '42501',
            `${name} must not be able to run: ${sql}`,
          );
        }
      }
      // Including on PostgreSQL 13/14, where `public` was writable by PUBLIC until the bootstrap
      // revoked it. Asserted through the catalog so the claim does not depend on this server's
      // major version.
      const publicCreate = await asSuperuser(async (client) => {
        const result = await client.query<{ allowed: boolean }>(
          "SELECT has_schema_privilege('public', 'public', 'CREATE') AS allowed",
        );
        return result.rows[0]!.allowed;
      });
      assert.equal(publicCreate, false, 'PUBLIC must not hold CREATE on schema public');
    });

    it('an incorrect or unknown credential fails closed', async () => {
      const wrongPassword = buildConnectionString({
        host: cluster.host,
        port: cluster.port,
        database: DATABASE,
        user: 'app_runtime_login',
        password: 'not-the-password',
      });
      await assert.rejects(
        async () => {
          const client = new pg.Client({ connectionString: wrongPassword });
          await client.connect();
          await client.end();
        },
        (error: unknown) => (error as { code?: string }).code === '28P01',
        'a wrong password must be refused by the server, not tolerated',
      );

      const unknownRole = buildConnectionString({
        host: cluster.host,
        port: cluster.port,
        database: DATABASE,
        user: 'app_runtime',
        password: 'anything-at-all',
      });
      await assert.rejects(
        async () => {
          const client = new pg.Client({ connectionString: unknownRole });
          await client.connect();
          await client.end();
        },
        (error: unknown) => {
          const code = (error as { code?: string }).code;
          // The privilege role is NOLOGIN, so the server refuses the connection outright. This is
          // the assertion behind "do not pretend app_migrator can log in".
          return code === '28000' || code === '28P01';
        },
      );
    });
  });

  // ----------------------------------------------------------------------------------------------
  // 4. The application boots on the bootstrapped database, and stays simulated
  // ----------------------------------------------------------------------------------------------

  describe('the application, on the database this bootstrap produced', () => {
    let persistence: PostgresPersistence;
    let app: Application;
    let h: HarnessOver<Application['container']>;
    let base: { port: number; host: string };
    let seeded: SeededAccount;

    before(async () => {
      const clock = createTestClock();
      const ids = createInstanceIdFactory('boot');
      const { logger, records } = createMemoryLogger('debug');
      const provider = createMockLlmProvider({ clock });

      persistence = createPostgresPersistence({
        runtimeConnectionString: url('app_runtime_login'),
        workerConnectionString: url('app_worker_login'),
        relayConnectionString: url('app_relay_login'),
        ids,
        logger,
        secrets: createMemorySecretResolver(TEST_SECRETS),
        pool: { maxConnections: 4, applicationName: 'moderation-bootstrap-proof' },
      });

      app = createApplication({
        persistence,
        config: {
          ...TEST_CONFIG,
          role: 'all',
          http: { ...TEST_CONFIG.http, port: 0 },
          worker: { ...TEST_CONFIG.worker, concurrency: 2, pollIntervalMs: 20 },
          scheduler: { reaperIntervalMs: 50, relayIntervalMs: 50, relayBatchSize: 50 },
        },
        clock,
        ids,
        logger,
        provider,
        closePersistence: () => persistence.close(),
      });
      const started = await app.start();
      base = started.http!;
      h = createHarnessOver(app.container, clock, provider, records);
      seeded = await h.seedAccount({ webhookId: 'boot-hook', pageId: 'boot-page' });
      // The model is scripted to *want* to reply, for the same reason the shadow-acceptance
      // self-test scripts it: a moderator that reaches no decision produces no outbound action,
      // and "no action escaped SIMULATED" would then be true because there were none.
      h.provider.script({
        kind: 'RESPOND',
        text: decisionJson({
          action: 'ASK_CLARIFICATION',
          replyText: 'Could you tell me a little more about what you need?',
        }),
      });
    });

    after(async () => {
      await app.stop('test-cleanup');
    });

    it('takes a webhook off a real socket and turns it into a message', async () => {
      const raw = JSON.stringify(
        metaMessageEnvelope(seeded.connection.externalId, [
          { senderId: 'psid-boot', mid: 'm_boot_1', text: 'is anyone there?' },
        ]),
      );
      const response = await httpRequest(base, '/webhooks/meta/boot-hook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [META_SIGNATURE_HEADER]: computeMetaSignature(raw, TEST_APP_SECRET),
        },
        body: raw,
      });
      assert.equal(jsonBody(response)['status'], 'ACCEPTED');

      await until(async () => {
        const count = await asSuperuser(async (client) => {
          const result = await client.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM messages',
          );
          return Number(result.rows[0]!.n);
        });
        return count >= 1;
      }, 'the running worker normalised the delivery');
    });

    it('serves health, including the cross-tenant aggregates the worker role owns', async () => {
      const response = await httpRequest(base, '/health/status');
      const body = jsonBody(response);
      const database = body['database'] as { reachable: boolean };
      const inbound = body['inbound'] as { pending: number };
      assert.equal(database.reachable, true);
      // `app_inbound_backlog()` is SECURITY DEFINER, owned by app_migrator, granted to app_worker.
      // A number here proves the owner's BYPASSRLS, the grant and the pinned search_path together.
      assert.equal(typeof inbound.pending, 'number');
    });

    it('shadow acceptance passes on the delivery, and every action is SIMULATED', async () => {
      // The moderator runs on a debounce; advance past it and let the workers pick the job up.
      h.clock.advanceMs(30_000);
      await until(async () => {
        const count = await asSuperuser(async (client) => {
          const result = await client.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM outbound_actions',
          );
          return Number(result.rows[0]!.n);
        });
        return count >= 1;
      }, 'the moderator produced an outbound action');

      const rawEventIds = await app.container.rawEvents
        .listByConnection(seeded.scope, seeded.connection.id)
        .then((events) => events.map((event) => event.id));
      assert.ok(rawEventIds.length > 0, 'there is a delivery to trace');

      let simulated = 0;
      for (const rawEventId of rawEventIds) {
        const trace = await traceRawEvent(app.container, seeded.scope, rawEventId);
        assert.ok(trace, 'the delivery traces');
        assert.equal(trace.ok, true, trace.failures.join('; '));
        assert.equal(trace.receiveOnly, true);
        for (const conversation of trace.conversations) {
          for (const action of conversation.outboundActions) {
            assert.equal(action.simulated, true, `${action.actionType} escaped SIMULATED`);
            assert.equal(action.deliveryMode, 'SIMULATED');
            simulated += 1;
          }
        }
      }
      assert.ok(
        simulated > 0,
        'zero outbound actions would make the SIMULATED assertion vacuously true',
      );

      // And from the database directly, in case a repository were ever to filter.
      const modes = await asSuperuser(async (client) => {
        const result = await client.query<{ delivery_mode: string }>(
          'SELECT DISTINCT delivery_mode FROM outbound_actions',
        );
        return result.rows.map((row) => row.delivery_mode);
      });
      assert.deepEqual(modes, ['SIMULATED']);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // 5. Rotation — the one thing that is deliberately not idempotent
  // ----------------------------------------------------------------------------------------------

  // Last on purpose: it invalidates the credentials every test above uses.
  it('--rotate-passwords replaces every credential, and only when asked', async () => {
    const rotated = new Map(
      ROLE_MODEL.map((entry) => [entry.loginRole, generateTestPassword()] as const),
    );
    const db = privilegedDb();
    try {
      const report = await bootstrapDatabase({
        db,
        logger: createMemoryLogger().logger,
        passwords: rotated,
        rotatePasswords: true,
      });
      assert.deepEqual(
        report.loginRoles.map((role) => role.action),
        ['password-rotated', 'password-rotated', 'password-rotated', 'password-rotated'],
      );
    } finally {
      await db.close();
    }

    for (const entry of ROLE_MODEL) {
      // The new credential works.
      const fresh = new pg.Client({
        connectionString: buildConnectionString({
          host: cluster.host,
          port: cluster.port,
          database: DATABASE,
          user: entry.loginRole,
          password: rotated.get(entry.loginRole)!,
        }),
      });
      await fresh.connect();
      await fresh.end();

      // And the old one does not. Rotation that leaves the previous password working is not
      // rotation, it is an additional credential.
      await assert.rejects(
        async () => {
          const stale = new pg.Client({ connectionString: url(entry.loginRole) });
          await stale.connect();
          await stale.end();
        },
        (error: unknown) => (error as { code?: string }).code === '28P01',
        `${entry.loginRole}'s previous password must stop working`,
      );
    }
  });

  // ----------------------------------------------------------------------------------------------

  async function snapshotRoleModel(): Promise<string> {
    return await asSuperuser(async (client) => {
      const roles = await client.query<{ line: string }>(
        `SELECT rolname || ':' || rolcanlogin || ':' || rolsuper || ':' || rolbypassrls ||
                ':' || rolinherit AS line
           FROM pg_roles WHERE rolname LIKE 'app\\_%' ORDER BY 1`,
      );
      const members = await client.query<{ line: string }>(
        `SELECT m.rolname || '->' || r.rolname AS line
           FROM pg_auth_members am
           JOIN pg_roles m ON m.oid = am.member
           JOIN pg_roles r ON r.oid = am.roleid
          WHERE m.rolname LIKE 'app\\_%' ORDER BY 1`,
      );
      return [...roles.rows, ...members.rows].map((row) => row.line).join('\n');
    });
  }
});

async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for: ${what}`);
}
