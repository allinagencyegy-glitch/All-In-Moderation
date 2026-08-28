import { resolve } from 'node:path';
import { systemClock } from '../../platform/clock.ts';
import { TerminalError } from '../../platform/errors.ts';
import { createLogger } from '../../platform/logger.ts';
import {
  DEFAULT_POSTGRES_CONFIG,
  MIGRATION_ROLE,
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
 * ### `PG_MIGRATOR_URL` names an identity, not the privilege role
 *
 * Phase 02B's checklist showed `postgres://app_migrator:...@host/db`, and that connection string
 * can never work: `app_migrator` is created `NOLOGIN` by migration 0001 and has no password. It is
 * a *privilege role* — a bundle of authority that things are granted, not a credential anything
 * logs in as.
 *
 * The identity is `app_migrator_login`, created by `bootstrap` as a member of `app_migrator` and
 * deliberately `NOINHERIT`, so connecting grants nothing. This command then issues
 * `SET LOCAL ROLE app_migrator` for the duration of the run, which is what actually confers the
 * two properties the schema depends on: objects are owned by `app_migrator`, and `BYPASSRLS`
 * applies — PostgreSQL does not inherit role attributes through membership, so without the
 * `SET ROLE` the connecting identity's `rolbypassrls` is still `false`.
 *
 * Two things this deliberately does **not** do:
 *
 *   * **It does not run on start-up.** A process that migrates when it boots migrates once per
 *     replica, and the one that loses the advisory-lock race waits on a schema change while it is
 *     supposed to be serving. Migration is a deploy step with a human behind it.
 *   * **It does not accept a runtime connection string.** `app_runtime` cannot change the schema —
 *     that is asserted by the security suite — so pointing this at the runtime URL would fail
 *     confusingly; naming the variable differently makes the privilege boundary visible in the
 *     command itself.
 *
 * Usage
 *   PG_MIGRATOR_URL=postgres://app_migrator_login:...@host/db node src/runtime/cli/migrate.ts
 *   PG_MIGRATOR_URL=... node src/runtime/cli/migrate.ts --status
 */

const USAGE = `usage:
  PG_MIGRATOR_URL=<url> migrate            apply every pending migration
  PG_MIGRATOR_URL=<url> migrate --status   list what is applied and what is pending

The URL is the migrator *login identity* (app_migrator_login by default), created by
  PG_BOOTSTRAP_URL=<privileged url> node src/runtime/cli/bootstrap.ts
The run then assumes the app_migrator privilege role. Override with PG_MIGRATOR_ROLE only if you
bootstrapped under different names.`;

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
      'PG_MIGRATOR_URL is required: the migrator login identity (app_migrator_login), which this ' +
        'command uses to assume the app_migrator privilege role. It is never app_runtime, and it ' +
        'is never `app_migrator` itself — that role is NOLOGIN. Run the bootstrap first: ' +
        'docs/DEPLOYMENT-BOOTSTRAP.md.',
    );
  }
  // Overridable for a deployment that bootstrapped under different names, but never blank: a
  // migration that quietly ran as whichever identity happened to connect is how a schema ends up
  // owned by a credential.
  const assumeRole = process.env['PG_MIGRATOR_ROLE'] ?? MIGRATION_ROLE;

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
    const migrator = createMigrator({ db, directory: MIGRATIONS_DIR, logger, assumeRole });

    if (args['status'] !== undefined) {
      // Sequential, not `Promise.all`. Both reads open their own transaction and both begin with
      // `CREATE TABLE IF NOT EXISTS schema_migrations`; run concurrently against a database that
      // does not have it yet, the two racing creates produce a duplicate-object error rather than
      // the status report the operator asked for. It surfaced exactly once in ten runs, which is
      // the worst possible frequency for a command whose whole job is to tell you the truth.
      const applied = await migrator.applied();
      const pending = await migrator.pending();
      emit({
        role: assumeRole,
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
      role: assumeRole,
      applied: result.applied,
      skipped: result.skipped,
      alreadyCurrent: result.alreadyCurrent,
    });
  } finally {
    await db.close();
  }
}

await main().catch(fail);
