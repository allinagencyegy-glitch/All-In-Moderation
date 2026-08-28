import { systemClock } from '../../platform/clock.ts';
import { TerminalError } from '../../platform/errors.ts';
import { createLogger } from '../../platform/logger.ts';
import {
  DEFAULT_POSTGRES_CONFIG,
  ROLE_MODEL,
  bootstrapDatabase,
  createPostgresDatabase,
} from '../../adapters/postgres/index.ts';
import { emit, fail, parseArgs } from './context.ts';

/**
 * `bootstrap` — turn an empty database into one this application can be deployed against.
 *
 * ### Why this command exists
 *
 * Everything else in the tree assumed the roles were already there. The migrations create four
 * `NOLOGIN` privilege roles and grant them table privileges; the runtime wants three connection
 * strings; the operator checklist named a fourth for the migrator. Nothing created a role that
 * could actually connect, and `app_migrator` — the one the checklist told operators to put in
 * `PG_MIGRATOR_URL` — cannot log in at all. On a fresh cluster the documented procedure stopped
 * working at its first command.
 *
 * ### The privilege it needs, and for how long
 *
 * It needs a genuinely privileged credential: creating roles requires `CREATEROLE`, creating
 * `app_migrator BYPASSRLS` requires `BYPASSRLS`, and granting `CREATE ON SCHEMA public` requires
 * owning that schema. There is no way to build this role model without an authority that exceeds
 * every role in it — the honest thing is to say so, use it once, and never wire it into anything
 * that runs unattended.
 *
 * `PG_BOOTSTRAP_URL` is therefore deliberately a different variable from everything the runtime
 * reads. Nothing in `src/runtime/main.ts` looks at it, this command is the only consumer in the
 * repository, and after it succeeds the credential can be put away: the migrator identity it
 * creates is enough for every subsequent deploy.
 *
 * ### Passwords
 *
 * Never on the command line — `argv` is world-readable on Linux — and never in a file this
 * repository owns. Either four environment variables, or one JSON object on stdin:
 *
 *   PG_MIGRATOR_PASSWORD  PG_RUNTIME_PASSWORD  PG_WORKER_PASSWORD  PG_RELAY_PASSWORD
 *
 *   printf '%s' "$SECRETS_JSON" | node src/runtime/cli/bootstrap.ts --passwords-stdin
 *
 * A password is only ever consulted for an identity that must be *created*. Re-running this
 * command against a bootstrapped database changes nothing at all — it will not rotate a password
 * you did not ask it to rotate, because a tool that silently re-credentialed a running deployment
 * would be one nobody could safely run twice.
 *
 * Usage
 *   PG_BOOTSTRAP_URL=<privileged url> bootstrap                      create roles and grants
 *   PG_BOOTSTRAP_URL=<privileged url> bootstrap --check              report the delta, change nothing
 *   PG_BOOTSTRAP_URL=<privileged url> bootstrap --rotate-passwords   deliberately re-credential
 *   ... | bootstrap --passwords-stdin                                read passwords as JSON on stdin
 */

const USAGE = `usage:
  PG_BOOTSTRAP_URL=<url> bootstrap [--check] [--rotate-passwords] [--passwords-stdin]

  --check              report what is missing and change nothing; needs no passwords
  --rotate-passwords   reset the password of every existing login identity (deliberate act)
  --passwords-stdin    read {"migrator":"...","runtime":"...","worker":"...","relay":"..."}
                       from stdin instead of the environment

passwords (per identity, only consulted when the identity must be created or rotated):
${ROLE_MODEL.map((entry) => `  ${entry.passwordEnvVar.padEnd(21)} ${entry.loginRole}`).join('\n')}`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args['help'] !== undefined) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  // Refused explicitly rather than ignored. An operator who tries it once and gets silence will
  // assume it worked and leave the password in their shell history.
  for (const flag of ['password', 'passwords', 'migrator-password', 'runtime-password']) {
    if (args[flag] !== undefined) {
      throw new TerminalError(
        'ARGS_INVALID',
        `--${flag} is refused: command-line arguments are readable by every process on the host. ` +
          'Use the environment variables or --passwords-stdin.',
      );
    }
  }

  const connectionString = process.env['PG_BOOTSTRAP_URL'];
  if (!connectionString) {
    throw new TerminalError(
      'CONFIG_MISSING',
      'PG_BOOTSTRAP_URL is required: a privileged connection (superuser, or an owner with ' +
        'CREATEROLE and BYPASSRLS) to the application database. It is deliberately a different ' +
        'variable from PG_MIGRATOR_URL and is used by this command only. See ' +
        'docs/DEPLOYMENT-BOOTSTRAP.md.',
    );
  }

  const checkOnly = args['check'] !== undefined;
  const rotate = args['rotate-passwords'] !== undefined;
  const passwords = checkOnly
    ? new Map<string, string>()
    : args['passwords-stdin'] !== undefined
      ? await readPasswordsFromStdin()
      : readPasswordsFromEnv();

  const logger = createLogger({
    level: process.env['LOG_LEVEL'] === 'debug' ? 'debug' : 'warn',
    now: () => systemClock.now(),
  });

  const db = createPostgresDatabase({
    config: {
      ...DEFAULT_POSTGRES_CONFIG,
      connectionString,
      // One session does the whole thing, inside one transaction.
      maxConnections: 1,
      statementTimeoutMs: 60_000,
      applicationName: 'moderation-bootstrap',
    },
    logger,
    // Role and grant DDL is cluster-wide; a tenant handshake would be meaningless here.
    bypassTenantContext: true,
  });

  try {
    const report = await bootstrapDatabase({
      db,
      logger,
      passwords,
      checkOnly,
      rotatePasswords: rotate,
      ...(endpointOf(connectionString) ? { endpoint: endpointOf(connectionString)! } : {}),
    });
    emit(report);
    // `--check` on an incomplete database exits non-zero so it can gate a deploy script.
    if (!report.ok) process.exit(1);
  } finally {
    await db.close();
  }
}

function readPasswordsFromEnv(): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of ROLE_MODEL) {
    const value = process.env[entry.passwordEnvVar];
    if (value !== undefined && value !== '') out.set(entry.loginRole, value);
  }
  return out;
}

/**
 * Reads a JSON object of passwords from stdin.
 *
 * The point of the stdin path is that it composes with a secret manager without a temporary file:
 * `vault kv get -format=json ... | jq '.data.data' | bootstrap --passwords-stdin`. Nothing is
 * echoed, and the parsed object is never re-serialised anywhere.
 */
async function readPasswordsFromStdin(): Promise<Map<string, string>> {
  const chunks: Buffer[] = [];
  // Typed explicitly: `process.stdin` iterates as `any`, and an untyped concat here would be the
  // one place in this file where the compiler stops checking what is being handled.
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) {
    throw new TerminalError('CONFIG_MISSING', '--passwords-stdin was given but stdin was empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Deliberately does not echo what was read: it is a bag of passwords.
    throw new TerminalError(
      'CONFIG_INVALID',
      'stdin is not valid JSON. Expected {"migrator":"...","runtime":"...","worker":"...","relay":"..."}',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TerminalError('CONFIG_INVALID', 'stdin must be a JSON object keyed by role');
  }

  const record = parsed as Record<string, unknown>;
  const out = new Map<string, string>();
  for (const entry of ROLE_MODEL) {
    // Both spellings, because both are natural: the short key and the login role name.
    const value = record[entry.key] ?? record[entry.loginRole];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new TerminalError('CONFIG_INVALID', `the '${entry.key}' password must be a string`);
    }
    out.set(entry.loginRole, value);
  }
  return out;
}

/** Host and port only, for the printed templates. The password in the URL is never touched. */
function endpointOf(connectionString: string): { host: string; port: number } | null {
  try {
    const url = new URL(connectionString);
    return { host: url.hostname, port: Number(url.port || '5432') };
  } catch {
    return null;
  }
}

await main().catch(fail);
