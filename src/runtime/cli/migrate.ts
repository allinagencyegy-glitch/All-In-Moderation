import { resolve } from 'node:path';
import { systemClock } from '../../platform/clock.ts';
import { TerminalError } from '../../platform/errors.ts';
import { createLogger } from '../../platform/logger.ts';
import {
  DEFAULT_POSTGRES_CONFIG,
  createMigrator,
  createPostgresDatabase,
} from '../../adapters/postgres/index.ts';
import { emit, fail, parseArgs } from './context.ts';

/**
 * `migrate` — apply the schema, as the migrator role.
 *
 * Until now this existed only as a library that the test harness called. That was fine while the
 * only thing that ever migrated a database was a test; it stops being fine the moment an operator
 * has to run the migrations on a real deployment before attaching a real client, because a
 * documented step with no command behind it is a documented step that gets improvised.
 *
 * Two things this deliberately does **not** do:
 *
 *   * **It does not run on start-up.** A process that migrates when it boots migrates once per
 *     replica, and the one that loses the advisory-lock race waits on a schema change while it is
 *     supposed to be serving. Migration is a deploy step with a human behind it.
 *   * **It does not accept a runtime connection string.** `PG_MIGRATOR_URL` is a separate variable
 *     on purpose. `app_runtime` cannot change the schema — that is asserted by the security suite —
 *     so pointing this at the runtime URL would fail confusingly; naming the variable differently
 *     makes the privilege boundary visible in the command itself.
 *
 * Usage
 *   PG_MIGRATOR_URL=postgres://app_migrator:...@host/db node src/runtime/cli/migrate.ts
 *   PG_MIGRATOR_URL=... node src/runtime/cli/migrate.ts --status
 */

const USAGE = `usage:
  PG_MIGRATOR_URL=<url> migrate            apply every pending migration
  PG_MIGRATOR_URL=<url> migrate --status   list what is applied and what is pending`;

const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', '..', 'db', 'migrations');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args['help'] !== undefined) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const connectionString = process.env['PG_MIGRATOR_URL'];
  if (!connectionString) {
    throw new TerminalError(
      'CONFIG_MISSING',
      'PG_MIGRATOR_URL is required. Migrations run as app_migrator (BYPASSRLS, owns the schema), ' +
        'never as app_runtime — see db/migrations/0005_runtime_roles.sql.',
    );
  }

  const logger = createLogger({
    level: process.env['LOG_LEVEL'] === 'debug' ? 'debug' : 'warn',
    now: () => systemClock.now(),
  });
  const db = createPostgresDatabase({
    config: {
      ...DEFAULT_POSTGRES_CONFIG,
      connectionString,
      // Two connections is plenty: the whole run holds one advisory lock on one session.
      maxConnections: 2,
      // Far beyond the runtime's ceiling. A migration that adds an index to a large table is
      // slow *by design*, and killing it halfway is worse than waiting.
      statementTimeoutMs: 300_000,
      applicationName: 'moderation-migrate',
    },
    logger,
    // Migrations are cross-tenant by definition, and app_migrator is BYPASSRLS anyway. The
    // handshake would be meaningless here rather than merely unnecessary.
    bypassTenantContext: true,
  });

  try {
    const migrator = createMigrator({ db, directory: MIGRATIONS_DIR, logger });

    if (args['status'] !== undefined) {
      const [applied, pending] = await Promise.all([migrator.applied(), migrator.pending()]);
      emit({
        applied: applied.map((entry) => ({
          version: entry.version,
          appliedAt: entry.appliedAt.toISOString(),
          durationMs: entry.durationMs,
        })),
        pending,
        upToDate: pending.length === 0,
      });
      return;
    }

    const result = await migrator.migrate();
    emit({
      ok: true,
      applied: result.applied,
      skipped: result.skipped,
      alreadyCurrent: result.alreadyCurrent,
    });
  } finally {
    await db.close();
  }
}

await main().catch(fail);
