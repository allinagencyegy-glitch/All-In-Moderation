import { randomBytes } from 'node:crypto';
import { systemClock } from '../../platform/clock.ts';
import { createUlidIdFactory } from '../../platform/ids.ts';
import { createLogger } from '../../platform/logger.ts';
import { TerminalError, describeError } from '../../platform/errors.ts';
import { createMemorySecretResolver } from '../../adapters/memory/repositories.ts';
import { createPostgresPersistence } from '../../adapters/postgres/index.ts';
import type { CoreContainer, Persistence } from '../container.ts';
import { createContainerWith } from '../container.ts';
import { loadConfig } from '../config.ts';
import { parseWebhookSecrets } from '../secrets-env.ts';

/**
 * Shared bootstrap for the admin CLIs.
 *
 * These tools talk to the same database as the running service, through the same repositories and
 * the same tenant scoping. That is the point: an operator command that reached the database by a
 * different path would be able to write a row the runtime could never have written, and the first
 * evidence of that would be a delivery that fails to route.
 *
 * They open the runtime pool only — `app_runtime`, bound by RLS. No CLI here needs the worker or
 * relay roles, and handing an interactive tool the cross-tenant roles would be handing it the two
 * privileges the schema exists to keep apart.
 */

export interface CliContext {
  readonly container: CoreContainer;
  readonly persistence: Persistence & { close(): Promise<void> };
  close(): Promise<void>;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new TerminalError('CONFIG_MISSING', `${name} is required`);
  }
  return value;
};

export function openCliContext(): CliContext {
  const config = loadConfig();
  const clock = systemClock;
  // `warn` by default: a CLI's output is its report, and an info-level log line interleaved with
  // it is noise an operator has to learn to ignore. `LOG_LEVEL` still overrides.
  const logger = createLogger({
    level: process.env['LOG_LEVEL'] ? config.logLevel : 'warn',
    now: () => clock.now(),
  });
  const ids = createUlidIdFactory(
    (n) => randomBytes(n),
    () => clock.nowMs(),
  );

  const runtimeUrl = required('PG_RUNTIME_URL');
  const persistence = createPostgresPersistence({
    runtimeConnectionString: runtimeUrl,
    // The admin tools never touch the queue or the outbox relay. Passing the runtime string for
    // all three keeps the factory happy without granting a privilege these commands never use.
    workerConnectionString: runtimeUrl,
    relayConnectionString: runtimeUrl,
    ids,
    logger,
    secrets: createMemorySecretResolver(parseWebhookSecrets(process.env['WEBHOOK_SECRETS'])),
  });

  const container = createContainerWith(persistence, { config, clock, ids, logger });
  return {
    container,
    persistence,
    close: () => persistence.close(),
  };
}

/** Structured stdout. Machine-readable by default so a check can be scripted rather than read. */
export function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The single failure path for every CLI.
 *
 * Prints the error *code* and message and never the cause chain, which on a database failure
 * contains the connection string.
 */
export function fail(error: unknown): never {
  const described = describeError(error);
  process.stderr.write(
    `${JSON.stringify({ ok: false, code: described.code, message: described.message })}\n`,
  );
  process.exit(1);
}

/** `--name value` and `--flag`, without a dependency. */
export function parseArgs(argv: readonly string[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[token.slice(2)] = 'true';
    } else {
      out[token.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}
