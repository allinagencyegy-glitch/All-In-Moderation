/**
 * The process entrypoint: `npm start`.
 *
 * There is exactly one decision in this file that is not plumbing, and it is the refusal below.
 * Everything else — config, pools, migration checks — belongs to modules that are tested; a
 * `main` that contains logic is a `main` nobody can test.
 *
 * Three connection strings, three roles, no defaults. `app_runtime` is bound by RLS and may only
 * act inside a tenant context; `app_worker` sees the queue across tenants and is granted nothing
 * else; `app_relay` sees the outbox and one writable column. Falling back to a single URL would
 * quietly collapse three privilege boundaries into one, which is the kind of convenience that is
 * only ever discovered afterwards.
 */
import { randomBytes } from 'node:crypto';
import { systemClock } from '../platform/clock.ts';
import { createUlidIdFactory } from '../platform/ids.ts';
import { createLogger } from '../platform/logger.ts';
import { TerminalError, describeError } from '../platform/errors.ts';
import { createMemorySecretResolver } from '../adapters/memory/repositories.ts';
import { createPostgresPersistence } from '../adapters/postgres/index.ts';
import { createApplication } from './application.ts';
import { loadConfig } from './config.ts';
import { parseWebhookSecrets } from './secrets-env.ts';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new TerminalError(
      'CONFIG_MISSING',
      `${name} is required. The runtime, worker and relay roles are separate on purpose; see db/migrations/0005 and 0007.`,
    );
  }
  return value;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const clock = systemClock;
  const logger = createLogger({ level: config.logLevel, now: () => clock.now() });
  const ids = createUlidIdFactory(
    (n) => randomBytes(n),
    () => clock.nowMs(),
  );

  const persistence = createPostgresPersistence({
    runtimeConnectionString: required('PG_RUNTIME_URL'),
    workerConnectionString: required('PG_WORKER_URL'),
    relayConnectionString: required('PG_RELAY_URL'),
    ids,
    logger,
    /*
     * Secrets stay resolved by reference (ADR-002). This adapter reads them from the environment
     * because no secret manager is integrated yet; the *port* is what matters, and swapping in a
     * real resolver changes this file and nothing else.
     *
     * `WEBHOOK_SECRETS` is JSON: { "secret://<ref>": { "appSecret": "...", "verifyToken": "..." } }
     */
    secrets: createMemorySecretResolver(parseWebhookSecrets(process.env['WEBHOOK_SECRETS'])),
  });

  const app = createApplication({
    persistence,
    config,
    clock,
    ids,
    logger,
    closePersistence: () => persistence.close(),
    installSignalHandlers: true,
    onShutdownComplete: () => {
      // A clean shutdown exits 0. The pools are closed and the scheduled timers are unref'd, so
      // the loop should drain on its own; the explicit code is what makes that a promise rather
      // than a hope.
      process.exitCode = 0;
    },
  });

  await app.start();
}

main().catch((error: unknown) => {
  const described = describeError(error);
  // Structured, and without the cause chain: a connection string lives in there.
  console.error(JSON.stringify({ level: 'error', msg: 'startup failed', ...described }));
  process.exitCode = 1;
});
