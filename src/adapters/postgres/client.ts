import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { AccountId } from '../../platform/ids.ts';
import type { Logger } from '../../platform/logger.ts';
import { TenantViolationError, TerminalError } from '../../platform/errors.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';
import { translatePgError } from './errors.ts';

const { Pool } = pg;
export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

/**
 * PostgreSQL parses `numeric` into a JS number by default, which silently loses precision on
 * money. ADR-003 says prices are decimal strings end to end; this is where that is enforced for
 * reads. OID 1700 is `numeric`, 20 is `int8`.
 */
pg.types.setTypeParser(1700, (value: string) => value);
pg.types.setTypeParser(20, (value: string) => value);

export interface PostgresConfig {
  readonly connectionString: string;
  /** Bounded on purpose: an unbounded pool converts a slow query into a connection outage. */
  readonly maxConnections: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  /** Applied per transaction as `SET LOCAL statement_timeout`. */
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
}

export const DEFAULT_POSTGRES_CONFIG = {
  maxConnections: 10,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 15_000,
  applicationName: 'all-in-moderation',
} as const;

/**
 * The unit of work bound to the current async context.
 *
 * `accountId` starts null and is pinned by the first scoped repository call. Pinning — rather
 * than re-issuing `SET LOCAL` per statement — is what makes a cross-tenant transaction a loud
 * error instead of a silent context switch halfway through a commit.
 */
interface UnitOfWork {
  readonly client: PgClient;
  accountId: AccountId | null;
  readonly bypassTenantContext: boolean;
}

/** Connection strings carry a password. Never log, never stringify into an error. */
function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.username ? '***@' : ''}${url.host}${url.pathname}`;
  } catch {
    return '<unparseable connection string>';
  }
}

export interface PostgresDatabase {
  /** Ambient unit of work for the current async context, or null outside a transaction. */
  current(): UnitOfWork | null;
  /**
   * Runs `fn` inside a transaction with no tenant context.
   *
   * Used by cross-tenant infrastructure (the job queue, the reaper, migrations). Any scoped
   * repository call made inside one still sets its own `app.account_id`, so this is a weaker
   * default rather than an escape hatch.
   */
  transaction<T>(fn: (client: PgClient) => Promise<T>, label: string): Promise<T>;
  /** Runs `fn` inside a transaction pinned to one account, with RLS context established. */
  tenantTransaction<T>(
    accountId: AccountId,
    fn: (client: PgClient) => Promise<T>,
    label: string,
  ): Promise<T>;
  /**
   * Executes one scoped statement, joining an ambient transaction when there is one and opening
   * a short implicit transaction when there is not.
   *
   * The implicit transaction is not a convenience: `SET LOCAL app.account_id` is only meaningful
   * inside a transaction, so a bare pooled query would run with whatever context the previous
   * borrower left behind. Making every scoped read transactional is what makes context leakage
   * through the pool structurally impossible.
   */
  scoped<T>(accountId: AccountId, fn: (client: PgClient) => Promise<T>, label: string): Promise<T>;
  /** Executes one unscoped statement. Only for cross-tenant infrastructure tables. */
  unscoped<T>(fn: (client: PgClient) => Promise<T>, label: string): Promise<T>;
  readonly transactions: TransactionRunner;
  close(): Promise<void>;
  readonly stats: () => { total: number; idle: number; waiting: number };
}

export function createPostgresDatabase(deps: {
  config: PostgresConfig;
  logger: Logger;
  /**
   * Set for the worker pool, whose role sees the queue across all tenants. It suppresses the
   * `SET LOCAL app.account_id` handshake rather than granting extra visibility — the privilege
   * itself comes from the role's grants and policies, never from this flag.
   */
  bypassTenantContext?: boolean;
}): PostgresDatabase {
  const { config, logger } = deps;
  const bypassTenantContext = deps.bypassTenantContext ?? false;
  const storage = new AsyncLocalStorage<UnitOfWork>();

  const pool: PgPool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    application_name: config.applicationName,
    allowExitOnIdle: true,
  });

  // An idle client that errors (server restart, admin disconnect) must not take the process with
  // it: `pg` emits on the pool, and an unhandled 'error' event is fatal in Node.
  pool.on('error', (error: Error) => {
    logger.error('idle postgres client errored', {
      target: redactConnectionString(config.connectionString),
      message: error.message,
    });
  });

  let closed = false;

  const beginOn = async (client: PgClient, accountId: AccountId | null): Promise<void> => {
    await client.query('BEGIN');
    // `SET LOCAL` is scoped to the transaction and reverts on COMMIT or ROLLBACK, which is the
    // property that makes it safe on a pooled connection. A bare `SET` here would survive the
    // release and leak into the next borrower's queries.
    await client.query(`SET LOCAL statement_timeout = ${String(config.statementTimeoutMs)}`);
    if (accountId !== null && !bypassTenantContext) {
      await client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
    }
  };

  const runOnNewClient = async <T>(
    accountId: AccountId | null,
    fn: (client: PgClient) => Promise<T>,
    label: string,
  ): Promise<T> => {
    if (closed) throw new TerminalError('DATABASE_CLOSED', 'The connection pool is shut down');
    const client = await pool.connect().catch((error: unknown) => {
      throw translatePgError(error, `connect:${label}`);
    });
    const unit: UnitOfWork = { client, accountId, bypassTenantContext };
    try {
      await beginOn(client, accountId);
      const result = await storage.run(unit, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // Rollback failure must never mask the original error — that is how a real cause disappears.
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        logger.error('rollback failed', {
          label,
          message: rollbackError instanceof Error ? rollbackError.message : 'unknown',
        });
      });
      throw translatePgError(error, label);
    } finally {
      client.release();
    }
  };

  /**
   * Joins the ambient transaction, pinning its account on first scoped use.
   *
   * The pin is the tenancy guarantee: once a unit of work has spoken for account A, a repository
   * call for account B inside the same transaction is a `TenantViolationError`, not a quiet
   * `SET LOCAL` that changes what the *rest* of the transaction can see.
   */
  const joinAmbient = async <T>(
    unit: UnitOfWork,
    accountId: AccountId | null,
    fn: (client: PgClient) => Promise<T>,
    label: string,
  ): Promise<T> => {
    if (accountId !== null && !bypassTenantContext) {
      if (unit.accountId === null) {
        await unit.client.query('SELECT set_config($1, $2, true)', ['app.account_id', accountId]);
        unit.accountId = accountId;
      } else if (unit.accountId !== accountId) {
        throw new TenantViolationError(unit.accountId, accountId, label);
      }
    }
    try {
      return await fn(unit.client);
    } catch (error) {
      throw translatePgError(error, label);
    }
  };

  const transactions: TransactionRunner = {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const ambient = storage.getStore();
      // Nested calls join the outer transaction rather than opening a savepoint — the same
      // semantics the in-memory runner documents, so the shared atomicity tests mean the same
      // thing against both adapters.
      if (ambient) return await fn();
      return await runOnNewClient(null, () => fn(), 'transaction');
    },
  };

  return {
    current: () => storage.getStore() ?? null,
    transactions,

    transaction(fn, label) {
      const ambient = storage.getStore();
      if (ambient) return joinAmbient(ambient, null, fn, label);
      return runOnNewClient(null, fn, label);
    },

    tenantTransaction(accountId, fn, label) {
      const ambient = storage.getStore();
      if (ambient) return joinAmbient(ambient, accountId, fn, label);
      return runOnNewClient(accountId, fn, label);
    },

    scoped(accountId, fn, label) {
      const ambient = storage.getStore();
      if (ambient) return joinAmbient(ambient, accountId, fn, label);
      return runOnNewClient(accountId, fn, label);
    },

    unscoped(fn, label) {
      const ambient = storage.getStore();
      if (ambient) return joinAmbient(ambient, null, fn, label);
      return runOnNewClient(null, fn, label);
    },

    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },

    stats: () => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }),
  };
}

/** Builds a connection string without ever putting the password in a log or an error. */
export function buildConnectionString(parts: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}): string {
  const url = new URL(`postgresql://${parts.host}:${String(parts.port)}`);
  url.username = encodeURIComponent(parts.user);
  url.password = encodeURIComponent(parts.password);
  url.pathname = `/${parts.database}`;
  return url.toString();
}

export { redactConnectionString };
