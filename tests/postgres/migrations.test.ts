import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import {
  DEFAULT_POSTGRES_CONFIG,
  createPostgresDatabase,
} from '../../src/adapters/postgres/client.ts';
import {
  createMigrator,
  loadMigrations,
  stripOuterTransaction,
} from '../../src/adapters/postgres/migrator.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import {
  MIGRATIONS_DIR,
  acquirePostgres,
  postgresAvailable,
  releasePostgres,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * Step 3: the migration runner, proven against a real server.
 *
 * The interesting assertions are the negative ones. "Migrations apply" is table stakes; what has
 * to be true is that applying them *twice* changes nothing, that a partially-failing run leaves no
 * trace, and that editing an applied file is caught rather than diverging silently between
 * environments.
 */

const available = postgresAvailable();

describe('postgres migrations', { skip: available ? false : 'no disposable PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;

  before(async () => {
    cluster = await acquirePostgres();
  });

  after(async () => {
    await releasePostgres();
  });

  it('migration files are well-formed and deterministically ordered', () => {
    const files = loadMigrations(MIGRATIONS_DIR);
    assert.ok(files.length >= 5);
    const versions = files.map((f) => f.version);
    assert.deepEqual(versions, [...versions].sort(), 'files apply in ascending version order');
    assert.equal(new Set(versions).size, versions.length, 'no duplicate versions');
  });

  it('stripping transaction control leaves DO $$ ... BEGIN blocks alone', () => {
    const sql = [
      '-- header',
      'BEGIN;',
      'DO $$',
      'BEGIN',
      "  RAISE NOTICE 'hello';",
      'END',
      '$$;',
      'COMMIT;',
      '',
    ].join('\n');
    const stripped = stripOuterTransaction(sql, 'test.sql');
    assert.ok(!/^BEGIN;$/m.test(stripped), 'the outer BEGIN; is removed');
    assert.ok(!/^COMMIT;$/m.test(stripped), 'the outer COMMIT; is removed');
    assert.ok(stripped.includes('DO $$'), 'the DO block survives');
    assert.ok(/^BEGIN$/m.test(stripped), "the block's own BEGIN is untouched");
  });

  it('a fresh database migrates to the full schema', async () => {
    const tables = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
      );
      return result.rows.map((r) => r.table_name);
    });

    // Every table the DDL declares must exist, by name — a count would pass while a table is
    // missing and an unexpected one is present.
    for (const expected of [
      'accounts',
      'users',
      'account_memberships',
      'channel_connections',
      'contact_identities',
      'channel_identities',
      'raw_inbound_events',
      'conversations',
      'conversation_ownership_transitions',
      'messages',
      'moderator_runs',
      'outbound_actions',
      'handoffs',
      'lead_candidates',
      'jobs',
      'dead_letters',
      'domain_event_outbox',
      'event_subscriptions',
      'event_deliveries',
      'audit_events',
      'account_pack_versions',
      'knowledge_entries',
      'knowledge_gaps',
      'schema_migrations',
    ]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
  });

  it('every migration is recorded exactly once, with its checksum', async () => {
    const files = loadMigrations(MIGRATIONS_DIR);
    const rows = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ version: string; checksum: string; filename: string }>(
        'SELECT version, checksum, filename FROM schema_migrations ORDER BY version',
      );
      return result.rows;
    });
    assert.equal(rows.length, files.length);
    for (const [index, file] of files.entries()) {
      assert.equal(rows[index]!.version, file.version);
      assert.equal(rows[index]!.checksum, file.checksum, `${file.filename} checksum recorded`);
    }
  });

  it('running migrate again applies nothing and reports it', async () => {
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: cluster.adminUrl,
        maxConnections: 2,
      },
      logger: createMemoryLogger().logger,
    });
    try {
      const before = await snapshotSchema(cluster);
      const result = await createMigrator({
        db,
        directory: MIGRATIONS_DIR,
        logger: createMemoryLogger().logger,
      }).migrate();

      assert.deepEqual(result.applied, [], 'nothing re-applied');
      assert.equal(result.alreadyCurrent, true);
      assert.equal(result.skipped.length, loadMigrations(MIGRATIONS_DIR).length);
      assert.deepEqual(await snapshotSchema(cluster), before, 'the schema is byte-identical');
    } finally {
      await db.close();
    }
  });

  it('editing an applied migration is a hard failure, not silent drift', async () => {
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: cluster.adminUrl,
        maxConnections: 2,
      },
      logger: createMemoryLogger().logger,
    });
    try {
      await withAdminClient(cluster.adminUrl, async (client) => {
        await client.query(
          "UPDATE schema_migrations SET checksum = 'tampered' WHERE version='0001'",
        );
      });

      await assert.rejects(
        () =>
          createMigrator({
            db,
            directory: MIGRATIONS_DIR,
            logger: createMemoryLogger().logger,
          }).migrate(),
        (error: unknown) => (error as { code?: string }).code === 'MIGRATION_CHECKSUM_MISMATCH',
      );
    } finally {
      // Restore, so later suites see a consistent history.
      const files = loadMigrations(MIGRATIONS_DIR);
      await withAdminClient(cluster.adminUrl, async (client) => {
        await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
          files[0]!.checksum,
          '0001',
        ]);
      });
      await db.close();
    }
  });

  it('a failing migration leaves no partial schema and no history row', async () => {
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: cluster.adminUrl,
        maxConnections: 2,
      },
      logger: createMemoryLogger().logger,
    });
    const scratch = resolveScratchDir();
    try {
      const result = createMigrator({
        db,
        directory: scratch,
        logger: createMemoryLogger().logger,
      });
      await assert.rejects(() => result.migrate());

      const leaked = await withAdminClient(cluster.adminUrl, async (client) => {
        const tableExists = await client.query(
          "SELECT to_regclass('public.half_applied_probe') AS oid",
        );
        const historyRow = await client.query(
          "SELECT 1 FROM schema_migrations WHERE version = '9001'",
        );
        return {
          table: tableExists.rows[0] as { oid: string | null },
          history: historyRow.rowCount ?? 0,
        };
      });

      assert.equal(leaked.table.oid, null, 'the table created before the error was rolled back');
      assert.equal(leaked.history, 0, 'no history row for a migration that did not complete');
    } finally {
      await db.close();
    }
  });
});

async function snapshotSchema(cluster: PostgresTestCluster): Promise<string> {
  return await withAdminClient(cluster.adminUrl, async (client) => {
    const result = await client.query<{ line: string }>(
      `SELECT c.table_name || '.' || c.column_name || ':' || c.data_type ||
              ':' || c.is_nullable || ':' || coalesce(c.column_default, '-') AS line
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
        ORDER BY 1`,
    );
    return result.rows.map((r) => r.line).join('\n');
  });
}

/**
 * A directory holding one deliberately broken migration.
 *
 * It creates a table and then references a column that does not exist, so the failure happens
 * *after* a real DDL change — which is the only way to prove the rollback covers schema work and
 * not just the history insert.
 */
function resolveScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bad-migration-'));
  writeFileSync(
    join(dir, '9001_broken.sql'),
    [
      'BEGIN;',
      'CREATE TABLE half_applied_probe (id text PRIMARY KEY);',
      'SELECT nope_no_column;',
      'COMMIT;',
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}
