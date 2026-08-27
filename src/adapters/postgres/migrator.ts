import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../platform/logger.ts';
import { TerminalError } from '../../platform/errors.ts';
import type { PgClient, PostgresDatabase } from './client.ts';
import { translatePgError } from './errors.ts';

/**
 * A migration runner small enough to read in one sitting.
 *
 * ADR-003 argued against a framework here, and this is the bill for that argument: roughly a
 * hundred lines that must actually be correct. The properties it buys are the ones a framework
 * would have given us anyway —
 *
 *   * **Deterministic order.** Files sort by their numeric prefix, not by directory iteration.
 *   * **Exactly once.** Each file's application and its history row commit in one transaction, so
 *     there is no window in which a migration ran but was not recorded.
 *   * **No silent drift.** Every applied file's checksum is stored. Editing a migration that has
 *     already run is a hard failure rather than a difference between environments that nobody
 *     notices until an incident.
 *   * **No partial application.** A failure inside a file rolls that file back whole.
 *   * **Safe to repeat.** A second run applies nothing and reports nothing changed.
 */

/** Namespaced so it cannot collide with the queue's partition locks. */
const MIGRATION_ADVISORY_LOCK = 4_017_320_100;

export interface MigrationFile {
  readonly version: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly alreadyCurrent: boolean;
}

const VERSION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(directory: string): readonly MigrationFile[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  const seen = new Set<string>();
  return files.map((filename) => {
    const match = VERSION_PATTERN.exec(filename);
    if (!match) {
      throw new TerminalError(
        'MIGRATION_NAME_INVALID',
        `Migration '${filename}' must be named NNNN_lower_snake.sql`,
      );
    }
    const version = match[1]!;
    if (seen.has(version)) {
      // Two files claiming 0003 would apply in an order that depends on the rest of the name.
      throw new TerminalError(
        'MIGRATION_VERSION_DUPLICATE',
        `Duplicate migration version ${version}`,
      );
    }
    seen.add(version);
    const sql = readFileSync(join(directory, filename), 'utf8');
    return {
      version,
      filename,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    };
  });
}

/**
 * Removes the file's own `BEGIN;`/`COMMIT;` so the runner can put the migration and its history
 * row in *one* transaction.
 *
 * Left in place, the file's `COMMIT;` would end the runner's transaction early and the history
 * insert would land in a second one — reintroducing exactly the window this design removes. The
 * match is anchored to column zero so the `BEGIN` inside a `DO $$ ... $$` block (which carries no
 * semicolon and is always indented) is never mistaken for transaction control.
 */
export function stripOuterTransaction(sql: string, filename: string): string {
  const beginMatches = [...sql.matchAll(/^BEGIN;[ \t]*$/gm)];
  const commitMatches = [...sql.matchAll(/^(?:COMMIT|END|ROLLBACK);[ \t]*$/gm)];

  if (beginMatches.length === 0 && commitMatches.length === 0) return sql;
  if (beginMatches.length !== 1 || commitMatches.length !== 1) {
    throw new TerminalError(
      'MIGRATION_TRANSACTION_SHAPE',
      `Migration '${filename}' must contain at most one top-level BEGIN;/COMMIT; pair`,
      { beginCount: beginMatches.length, commitCount: commitMatches.length },
    );
  }
  const begin = beginMatches[0]!;
  const commit = commitMatches[0]!;
  if (begin.index > commit.index) {
    throw new TerminalError(
      'MIGRATION_TRANSACTION_SHAPE',
      `Migration '${filename}' closes its transaction before it opens one`,
    );
  }
  return (
    sql.slice(0, begin.index) +
    sql.slice(begin.index + begin[0].length, commit.index) +
    sql.slice(commit.index + commit[0].length)
  );
}

const HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  filename    text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL
)`;

export interface Migrator {
  migrate(): Promise<MigrationResult>;
  applied(): Promise<readonly AppliedMigration[]>;
  pending(): Promise<readonly string[]>;
}

export function createMigrator(deps: {
  db: PostgresDatabase;
  directory: string;
  logger: Logger;
  /** Injected so migration timing is deterministic in tests. */
  now?: () => number;
}): Migrator {
  const { db, directory, logger } = deps;
  const nowMs = deps.now ?? (() => Date.now());

  const readApplied = async (client: PgClient): Promise<Map<string, AppliedMigration>> => {
    await client.query(HISTORY_DDL);
    const result = await client.query<{
      version: string;
      checksum: string;
      applied_at: Date;
      duration_ms: number;
    }>('SELECT version, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY version');
    return new Map(
      result.rows.map((row) => [
        row.version,
        {
          version: row.version,
          checksum: row.checksum,
          appliedAt: row.applied_at,
          durationMs: row.duration_ms,
        },
      ]),
    );
  };

  return {
    async applied() {
      return await db.unscoped(async (client) => {
        const map = await readApplied(client);
        return [...map.values()];
      }, 'migrations:applied');
    },

    async pending() {
      const files = loadMigrations(directory);
      return await db.unscoped(async (client) => {
        const done = await readApplied(client);
        return files.filter((file) => !done.has(file.version)).map((file) => file.filename);
      }, 'migrations:pending');
    },

    async migrate() {
      const files = loadMigrations(directory);
      const applied: string[] = [];
      const skipped: string[] = [];

      // One session-level advisory lock around the whole run. Two deploying instances is the
      // normal case, not the exotic one, and `CREATE TABLE` racing itself produces a confusing
      // duplicate-object error rather than a clean wait.
      return await db.unscoped(async (lockClient) => {
        await lockClient.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_ADVISORY_LOCK]);
        const done = await readApplied(lockClient);

        for (const file of files) {
          const previous = done.get(file.version);
          if (previous) {
            if (previous.checksum !== file.checksum) {
              throw new TerminalError(
                'MIGRATION_CHECKSUM_MISMATCH',
                `Migration ${file.filename} changed after it was applied. Applied checksum ` +
                  `${previous.checksum.slice(0, 12)}, file checksum ${file.checksum.slice(0, 12)}. ` +
                  'Add a new migration instead of editing an applied one.',
                { version: file.version },
              );
            }
            skipped.push(file.filename);
            continue;
          }

          const startedAt = nowMs();
          const body = stripOuterTransaction(file.sql, file.filename);
          try {
            // Same transaction as the advisory lock, so the whole run is one unit: a failure in
            // 0003 leaves 0001 and 0002 unapplied too, rather than a half-migrated schema whose
            // state depends on which file broke.
            await lockClient.query(body);
            await lockClient.query(
              'INSERT INTO schema_migrations (version, filename, checksum, duration_ms) VALUES ($1,$2,$3,$4)',
              [file.version, file.filename, file.checksum, nowMs() - startedAt],
            );
          } catch (error) {
            const translated = translatePgError(error, `migration:${file.filename}`);
            logger.error('migration failed; the whole run is rolled back', {
              version: file.version,
              filename: file.filename,
              message: translated.message,
            });
            throw translated;
          }
          applied.push(file.filename);
          logger.info('migration applied', { version: file.version, filename: file.filename });
        }

        return { applied, skipped, alreadyCurrent: applied.length === 0 };
      }, 'migrations:migrate');
    },
  };
}
