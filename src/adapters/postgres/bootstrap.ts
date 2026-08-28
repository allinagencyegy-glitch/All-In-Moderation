import type { Logger } from '../../platform/logger.ts';
import { TerminalError } from '../../platform/errors.ts';
import type { PgClient, PostgresDatabase } from './client.ts';
import { translatePgError } from './errors.ts';

/**
 * The privileged bootstrap: what has to happen *before* a migration can run, and what the
 * migrations deliberately cannot do for themselves.
 *
 * ### The gap this closes
 *
 * Migrations 0001, 0005 and 0007 create four **privilege roles** — `app_runtime`, `app_migrator`,
 * `app_worker`, `app_relay` — every one of them `NOLOGIN`. Nothing in the tree ever created a role
 * that could *connect*. The test harness quietly invented three (`app_runtime_login` and friends)
 * and granted them membership, and the operator checklist named `PG_RUNTIME_URL`,
 * `PG_WORKER_URL`, `PG_RELAY_URL` and `PG_MIGRATOR_URL` as though those identities already
 * existed. On a fresh database none of them does, and `postgres://app_migrator:...@host/db` cannot
 * work at all: `app_migrator` has no password and no `LOGIN` attribute.
 *
 * So this module is the missing half. Privilege roles carry grants and are never logged into;
 * login roles carry passwords and no privileges of their own beyond membership. Separating them is
 * what lets a credential be rotated without touching a single `GRANT`, and what makes "which role
 * may do what" a property of the schema rather than of whoever created the user.
 *
 * ### Why role creation moves here rather than staying in the migrations
 *
 * `CREATE ROLE` requires `CREATEROLE` or superuser, and creating `app_migrator BYPASSRLS` requires
 * the creator to hold `BYPASSRLS` too (PostgreSQL 16 tightened this). Leaving those statements in
 * the migrations means every migration run for the rest of the system's life needs cluster-level
 * authority. Running them once, here, means migrations need only ownership of the schema they are
 * changing — the migrations' own `IF NOT EXISTS` guards then find the roles already present and do
 * nothing. Nothing in `db/migrations/` changes, which matters: those files are checksummed, and
 * editing an applied one is a hard failure by design.
 *
 * ### What it never does
 *
 * It does not create the database (`CREATE DATABASE` cannot run inside a transaction, and this
 * whole bootstrap is one transaction so that a half-applied role model is impossible). It does not
 * run migrations. It does not read, write or print a password other than the ones it is explicitly
 * handed, and it never puts one in a log line, an error, or its report.
 */

// ------------------------------------------------------------------------------------------------
// The role model
// ------------------------------------------------------------------------------------------------

export type RoleKey = 'migrator' | 'runtime' | 'worker' | 'relay';

export interface RoleModelEntry {
  readonly key: RoleKey;
  /** The `NOLOGIN` role that owns the grants. Created by the migrations, or here — whichever first. */
  readonly privilegeRole: string;
  /** The `LOGIN` identity that holds the password and is a member of the privilege role. */
  readonly loginRole: string;
  /** Only the migrator. A role *attribute*, and attributes are not inherited through membership. */
  readonly bypassRls: boolean;
  /**
   * `INHERIT` for the three application identities: the process connects and simply has the
   * privileges of its privilege role. `NOINHERIT` for the migrator identity, so its authority is
   * dormant until an explicit `SET ROLE` — the smallest window we can give the one role that can
   * drop a table.
   */
  readonly inherit: boolean;
  readonly urlEnvVar: string;
  readonly passwordEnvVar: string;
  readonly purpose: string;
}

export const ROLE_MODEL: readonly RoleModelEntry[] = [
  {
    key: 'migrator',
    privilegeRole: 'app_migrator',
    loginRole: 'app_migrator_login',
    bypassRls: true,
    inherit: false,
    urlEnvVar: 'PG_MIGRATOR_URL',
    passwordEnvVar: 'PG_MIGRATOR_PASSWORD',
    purpose: 'schema migration authority; owns every object; never serves traffic',
  },
  {
    key: 'runtime',
    privilegeRole: 'app_runtime',
    loginRole: 'app_runtime_login',
    bypassRls: false,
    inherit: true,
    urlEnvVar: 'PG_RUNTIME_URL',
    passwordEnvVar: 'PG_RUNTIME_PASSWORD',
    purpose: 'the application; RLS-bound; acts only inside a tenant context',
  },
  {
    key: 'worker',
    privilegeRole: 'app_worker',
    loginRole: 'app_worker_login',
    bypassRls: false,
    inherit: true,
    urlEnvVar: 'PG_WORKER_URL',
    passwordEnvVar: 'PG_WORKER_PASSWORD',
    purpose: 'job queue and reaper; granted jobs and dead_letters and nothing else',
  },
  {
    key: 'relay',
    privilegeRole: 'app_relay',
    loginRole: 'app_relay_login',
    bypassRls: false,
    inherit: true,
    urlEnvVar: 'PG_RELAY_URL',
    passwordEnvVar: 'PG_RELAY_PASSWORD',
    purpose: 'outbox relay; one table, one writable column',
  },
];

/** The role a migration run must assume. Owns the schema; the only role that may change it. */
export const MIGRATION_ROLE = 'app_migrator';

/** Extensions the schema needs. Installed here, while privilege is available, not by a migration. */
export const REQUIRED_EXTENSIONS = ['pgcrypto'] as const;

/**
 * Bootstrapping into a maintenance database would create the roles (which are cluster-wide) and
 * then grant schema privileges in entirely the wrong place — and the mistake is invisible until
 * the first migration fails. Refuse it outright.
 */
const MAINTENANCE_DATABASES = new Set(['postgres', 'template0', 'template1']);

/** Short enough to type, long enough that it was generated rather than chosen. */
export const MIN_PASSWORD_LENGTH = 12;

// ------------------------------------------------------------------------------------------------
// Identifier quoting
// ------------------------------------------------------------------------------------------------

/**
 * Every identifier this module writes comes from `ROLE_MODEL` or from `current_database()`, so none
 * of them is attacker-influenced. The validation is here anyway, because a role name that arrives
 * from an environment variable one refactor from now would otherwise be interpolated into DDL — and
 * DDL takes no bind parameters, so there is no second line of defence.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new TerminalError(
      'IDENTIFIER_INVALID',
      `'${name}' is not a valid lower-case SQL identifier`,
    );
  }
  return `"${name}"`;
}

// ------------------------------------------------------------------------------------------------
// Report
// ------------------------------------------------------------------------------------------------

export type RoleAction = 'created' | 'present' | 'password-rotated' | 'missing';
export type GrantAction = 'granted' | 'present' | 'missing';

export interface BootstrapCapabilities {
  readonly database: string;
  readonly currentUser: string;
  readonly serverVersionNum: number;
  readonly superuser: boolean;
  readonly createRole: boolean;
  readonly bypassRls: boolean;
  readonly ownsPublicSchema: boolean;
}

export interface BootstrapReport {
  readonly ok: boolean;
  readonly mode: 'apply' | 'check';
  readonly database: string;
  readonly capabilities: BootstrapCapabilities;
  readonly privilegeRoles: readonly { name: string; action: RoleAction }[];
  readonly loginRoles: readonly { name: string; memberOf: string; action: RoleAction }[];
  readonly memberships: readonly { member: string; role: string; action: GrantAction }[];
  readonly extensions: readonly { name: string; action: GrantAction }[];
  readonly schemaPrivileges: readonly string[];
  /**
   * What still has to happen. Empty after a successful apply; populated by `--check` so an operator
   * can see the delta without changing anything.
   */
  readonly pending: readonly string[];
  /**
   * Connection strings with the **environment variable name** where the password goes. A real
   * connection string is a credential; printing one — even to a terminal — puts it in a scrollback
   * buffer, a CI log and a screenshot.
   */
  readonly connectionTemplates: Readonly<Record<string, string>>;
}

export interface BootstrapOptions {
  /** A pool opened on a privileged connection. Used for this command only, never by the runtime. */
  readonly db: PostgresDatabase;
  readonly logger: Logger;
  /** Keyed by login role name. Only consulted for identities that must be created or rotated. */
  readonly passwords: ReadonlyMap<string, string>;
  /** Report the delta and change nothing. */
  readonly checkOnly?: boolean;
  /**
   * Off by default, and that is a correctness property rather than a convenience: a bootstrap that
   * reset passwords on every run would break the running deployment every time somebody re-ran it
   * to see what it would do.
   */
  readonly rotatePasswords?: boolean;
  /** Host and port for the printed templates. Cosmetic; no connection is made with them. */
  readonly endpoint?: { readonly host: string; readonly port: number };
}

// ------------------------------------------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------------------------------------------

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
}

/**
 * Idempotent by construction: every step reads the catalog first and does nothing when the answer
 * is already right. The whole run is one transaction, so a failure anywhere leaves the cluster
 * exactly as it was — there is no state in which half the identities exist.
 */
export async function bootstrapDatabase(options: BootstrapOptions): Promise<BootstrapReport> {
  const { db, logger } = options;
  const checkOnly = options.checkOnly ?? false;
  const rotate = options.rotatePasswords ?? false;

  return await db.unscoped(async (client) => {
    const capabilities = await readCapabilities(client);

    if (MAINTENANCE_DATABASES.has(capabilities.database)) {
      throw new TerminalError(
        'BOOTSTRAP_WRONG_DATABASE',
        `Refusing to bootstrap '${capabilities.database}'. Roles are cluster-wide but schema and ` +
          'CONNECT privileges are not: point PG_BOOTSTRAP_URL at the application database you ' +
          'created with CREATE DATABASE.',
        { database: capabilities.database },
      );
    }

    const existing = await readRoles(client);
    const memberships = await readMemberships(client);
    const installed = await readExtensions(client);

    const pending: string[] = [];
    const privilegeRoles: { name: string; action: RoleAction }[] = [];
    const loginRoles: { name: string; memberOf: string; action: RoleAction }[] = [];
    const membershipReport: { member: string; role: string; action: GrantAction }[] = [];
    const extensionReport: { name: string; action: GrantAction }[] = [];
    const schemaPrivileges: string[] = [];

    const missingPrivilegeRoles = ROLE_MODEL.filter((entry) => !existing.has(entry.privilegeRole));
    const missingLoginRoles = ROLE_MODEL.filter((entry) => !existing.has(entry.loginRole));
    const rotating = rotate ? ROLE_MODEL.filter((entry) => existing.has(entry.loginRole)) : [];

    // Passwords and capabilities are both validated before a single statement runs. Failing
    // halfway would roll back cleanly, but it would also mean an operator discovers the second
    // missing password only after supplying the first.
    if (!checkOnly) {
      for (const entry of [...missingLoginRoles, ...rotating]) {
        requirePassword(options.passwords, entry);
      }
      assertCapabilities(capabilities, missingPrivilegeRoles, missingLoginRoles);
    }

    // --- privilege roles ------------------------------------------------------------------------
    for (const entry of ROLE_MODEL) {
      const row = existing.get(entry.privilegeRole);
      if (row) {
        // A privilege role that can log in is a credential nobody meant to create. Say so rather
        // than silently "fixing" it: taking LOGIN away from a role somebody is using would be an
        // outage delivered by the tool the operator ran in order to be careful.
        if (row.rolcanlogin) {
          pending.push(
            `${entry.privilegeRole} has LOGIN. Privilege roles must not be login identities; ` +
              `revoke it with ALTER ROLE ${entry.privilegeRole} NOLOGIN once nothing uses it.`,
          );
        }
        if (entry.bypassRls && !row.rolbypassrls && !row.rolsuper) {
          pending.push(
            `${entry.privilegeRole} lacks BYPASSRLS. It owns the SECURITY DEFINER resolvers and ` +
              'every table FORCEs row-level security, so webhook tenancy resolution and the ' +
              'health backlog aggregate would silently return nothing.',
          );
        }
        privilegeRoles.push({ name: entry.privilegeRole, action: 'present' });
        continue;
      }
      if (checkOnly) {
        privilegeRoles.push({ name: entry.privilegeRole, action: 'missing' });
        pending.push(`CREATE ROLE ${entry.privilegeRole}`);
        continue;
      }
      await exec(
        client,
        `CREATE ROLE ${quoteIdentifier(entry.privilegeRole)} NOLOGIN NOSUPERUSER NOCREATEDB ` +
          `NOCREATEROLE NOREPLICATION ${entry.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`,
        `bootstrap:create-privilege-role:${entry.privilegeRole}`,
      );
      privilegeRoles.push({ name: entry.privilegeRole, action: 'created' });
      logger.info('privilege role created', { role: entry.privilegeRole });
    }

    // --- login identities -----------------------------------------------------------------------
    for (const entry of ROLE_MODEL) {
      const row = existing.get(entry.loginRole);
      if (!row) {
        if (checkOnly) {
          loginRoles.push({
            name: entry.loginRole,
            memberOf: entry.privilegeRole,
            action: 'missing',
          });
          pending.push(`CREATE ROLE ${entry.loginRole} LOGIN (${entry.passwordEnvVar} required)`);
          continue;
        }
        await createLoginRole(client, entry, options.passwords.get(entry.loginRole)!);
        loginRoles.push({
          name: entry.loginRole,
          memberOf: entry.privilegeRole,
          action: 'created',
        });
        logger.info('login identity created', { role: entry.loginRole });
        continue;
      }

      if (row.rolsuper || row.rolbypassrls) {
        // The whole point of these identities is that they are not privileged. If one has been
        // handed a role attribute, the isolation the schema describes is not the isolation in
        // force, and no amount of GRANTs below restores it.
        throw new TerminalError(
          'BOOTSTRAP_IDENTITY_OVERPRIVILEGED',
          `${entry.loginRole} is ${row.rolsuper ? 'a superuser' : 'BYPASSRLS'}. An application ` +
            'login identity must be neither; row-level security would not apply to it.',
          { role: entry.loginRole },
        );
      }
      if (!row.rolcanlogin) {
        pending.push(
          `${entry.loginRole} exists but cannot log in; ALTER ROLE ${entry.loginRole} LOGIN`,
        );
      }

      if (rotate && !checkOnly) {
        await setPassword(client, entry, options.passwords.get(entry.loginRole)!);
        loginRoles.push({
          name: entry.loginRole,
          memberOf: entry.privilegeRole,
          action: 'password-rotated',
        });
        logger.warn('login password rotated', { role: entry.loginRole });
        continue;
      }
      loginRoles.push({ name: entry.loginRole, memberOf: entry.privilegeRole, action: 'present' });
    }

    // --- memberships ----------------------------------------------------------------------------
    for (const entry of ROLE_MODEL) {
      const already = memberships.get(entry.loginRole)?.has(entry.privilegeRole) ?? false;
      if (already) {
        membershipReport.push({
          member: entry.loginRole,
          role: entry.privilegeRole,
          action: 'present',
        });
        continue;
      }
      if (checkOnly) {
        membershipReport.push({
          member: entry.loginRole,
          role: entry.privilegeRole,
          action: 'missing',
        });
        pending.push(`GRANT ${entry.privilegeRole} TO ${entry.loginRole}`);
        continue;
      }
      // Read first rather than re-grant blindly. Re-granting is harmless in PostgreSQL, but then
      // the report could not honestly distinguish "already correct" from "changed" — and an
      // idempotency claim nobody can observe is not a claim.
      await exec(
        client,
        `GRANT ${quoteIdentifier(entry.privilegeRole)} TO ${quoteIdentifier(entry.loginRole)}`,
        `bootstrap:grant-membership:${entry.loginRole}`,
      );
      membershipReport.push({
        member: entry.loginRole,
        role: entry.privilegeRole,
        action: 'granted',
      });
    }

    // --- extensions -----------------------------------------------------------------------------
    for (const extension of REQUIRED_EXTENSIONS) {
      if (installed.has(extension)) {
        extensionReport.push({ name: extension, action: 'present' });
        continue;
      }
      if (checkOnly) {
        extensionReport.push({ name: extension, action: 'missing' });
        pending.push(`CREATE EXTENSION ${extension}`);
        continue;
      }
      await exec(
        client,
        `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)}`,
        `bootstrap:create-extension:${extension}`,
      );
      extensionReport.push({ name: extension, action: 'granted' });
    }

    // --- schema and database privileges -----------------------------------------------------------
    if (!checkOnly) {
      // The migrator creates every object, so it needs CREATE on the schema it creates them in.
      // From PostgreSQL 15 `public` is no longer writable by PUBLIC, so this grant is not
      // redundant: without it a fresh cluster refuses migration 0001 outright.
      await exec(
        client,
        `GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(MIGRATION_ROLE)}`,
        'bootstrap:grant-schema-create',
      );
      schemaPrivileges.push(`GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATION_ROLE}`);

      // And on PostgreSQL 13 and 14 it *was* writable by PUBLIC, which quietly hands every login
      // identity the ability to create a table — the exact privilege the security suite asserts
      // `app_runtime` does not have. Revoking makes the posture identical on every server we
      // support instead of accidentally version-dependent.
      await exec(
        client,
        'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
        'bootstrap:revoke-public-create',
      );
      schemaPrivileges.push('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

      const database = quoteIdentifier(capabilities.database);
      for (const entry of ROLE_MODEL) {
        await exec(
          client,
          `GRANT CONNECT ON DATABASE ${database} TO ${quoteIdentifier(entry.loginRole)}`,
          `bootstrap:grant-connect:${entry.loginRole}`,
        );
      }
      schemaPrivileges.push(
        `GRANT CONNECT ON DATABASE ${capabilities.database} TO ` +
          ROLE_MODEL.map((entry) => entry.loginRole).join(', '),
      );
    }

    return {
      ok: pending.length === 0,
      mode: checkOnly ? 'check' : 'apply',
      database: capabilities.database,
      capabilities,
      privilegeRoles,
      loginRoles,
      memberships: membershipReport,
      extensions: extensionReport,
      schemaPrivileges,
      pending,
      connectionTemplates: buildTemplates(capabilities.database, options.endpoint),
    } satisfies BootstrapReport;
  }, 'bootstrap');
}

// ------------------------------------------------------------------------------------------------
// Steps
// ------------------------------------------------------------------------------------------------

async function readCapabilities(client: PgClient): Promise<BootstrapCapabilities> {
  const result = await client.query<{
    database: string;
    username: string;
    server_version_num: string;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolbypassrls: boolean;
    owns_public: boolean;
  }>(
    `SELECT current_database()                    AS database,
            current_user                          AS username,
            current_setting('server_version_num') AS server_version_num,
            r.rolsuper, r.rolcreaterole, r.rolbypassrls,
            pg_catalog.pg_has_role(current_user, n.nspowner, 'USAGE') AS owns_public
       FROM pg_catalog.pg_roles r
       JOIN pg_catalog.pg_namespace n ON n.nspname = 'public'
      WHERE r.rolname = current_user`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new TerminalError(
      'BOOTSTRAP_PREFLIGHT_FAILED',
      'Could not read the current role from pg_roles',
    );
  }
  return {
    database: row.database,
    currentUser: row.username,
    serverVersionNum: Number(row.server_version_num),
    superuser: row.rolsuper,
    createRole: row.rolcreaterole,
    bypassRls: row.rolbypassrls,
    ownsPublicSchema: row.owns_public,
  };
}

/**
 * The honest answer to "can this credential do the job?", given before anything is attempted.
 *
 * This is the function that decides whether a managed PostgreSQL is usable. The load-bearing clause
 * is the second: since PostgreSQL 16 a `CREATEROLE` role may only grant role attributes it holds
 * itself, so creating `app_migrator BYPASSRLS` requires the bootstrap credential to hold
 * `BYPASSRLS`. A provider that withholds it cannot host this schema unmodified — and finding that
 * out here, by name, is enormously cheaper than finding it out when webhook ingest silently
 * resolves no connection.
 */
function assertCapabilities(
  capabilities: BootstrapCapabilities,
  missingPrivilegeRoles: readonly RoleModelEntry[],
  missingLoginRoles: readonly RoleModelEntry[],
): void {
  const missing: string[] = [];
  const rolesToCreate = missingPrivilegeRoles.length + missingLoginRoles.length;

  if (rolesToCreate > 0 && !capabilities.superuser && !capabilities.createRole) {
    missing.push(`CREATEROLE (or superuser): ${String(rolesToCreate)} roles must be created`);
  }
  if (
    missingPrivilegeRoles.some((entry) => entry.bypassRls) &&
    !capabilities.superuser &&
    !capabilities.bypassRls
  ) {
    missing.push(
      'BYPASSRLS: app_migrator must be created with it, and since PostgreSQL 16 a CREATEROLE ' +
        'role can only grant attributes it holds itself',
    );
  }
  if (!capabilities.superuser && !capabilities.ownsPublicSchema) {
    missing.push(
      'ownership of schema public (or superuser): the migrator needs CREATE on it, and only the ' +
        'owner may grant that',
    );
  }
  if (missing.length === 0) return;

  throw new TerminalError(
    'BOOTSTRAP_CAPABILITY_MISSING',
    `The bootstrap credential '${capabilities.currentUser}' cannot complete the bootstrap. ` +
      `Missing: ${missing.join('; ')}. See docs/DEPLOYMENT-BOOTSTRAP.md, "Managed PostgreSQL".`,
    { currentUser: capabilities.currentUser, database: capabilities.database },
  );
}

function requirePassword(passwords: ReadonlyMap<string, string>, entry: RoleModelEntry): string {
  const password = passwords.get(entry.loginRole);
  if (password === undefined || password.length === 0) {
    throw new TerminalError(
      'BOOTSTRAP_PASSWORD_MISSING',
      `${entry.loginRole} must be created but no password was supplied. Set ${entry.passwordEnvVar} ` +
        'in the environment, or pass every password as JSON on stdin with --passwords-stdin.',
      { role: entry.loginRole, variable: entry.passwordEnvVar },
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.trim() !== password) {
    throw new TerminalError(
      'BOOTSTRAP_PASSWORD_WEAK',
      `${entry.passwordEnvVar} must be at least ${String(MIN_PASSWORD_LENGTH)} characters with no ` +
        'surrounding whitespace. Generate one: openssl rand -hex 24',
      { role: entry.loginRole, variable: entry.passwordEnvVar },
    );
  }
  return password;
}

/**
 * `CREATE ROLE` and `ALTER ROLE` take no bind parameters, so the password has to appear as a
 * literal in the statement text. Rather than escape it here — where one missed edge case is a
 * privilege escalation — the statement is built by the server's own `format(%L)` with the password
 * passed as an ordinary parameter, and the resulting text is used once and never retained.
 *
 * The `catch` is not decoration. A `pg` error carries no statement text today, but a future driver
 * version, or a wrapper that decided to be helpful, would carry the password into a log;
 * re-raising a scrubbed error means that cannot happen regardless.
 */
async function createLoginRole(
  client: PgClient,
  entry: RoleModelEntry,
  password: string,
): Promise<void> {
  const attributes =
    'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION ' +
    (entry.inherit ? 'INHERIT' : 'NOINHERIT');
  await execWithSecret(
    client,
    `SELECT format('CREATE ROLE %I ${attributes} PASSWORD %L', $1::text, $2::text) AS statement`,
    [entry.loginRole, password],
    `bootstrap:create-login-role:${entry.loginRole}`,
  );
}

async function setPassword(
  client: PgClient,
  entry: RoleModelEntry,
  password: string,
): Promise<void> {
  await execWithSecret(
    client,
    `SELECT format('ALTER ROLE %I WITH PASSWORD %L', $1::text, $2::text) AS statement`,
    [entry.loginRole, password],
    `bootstrap:rotate-password:${entry.loginRole}`,
  );
}

async function execWithSecret(
  client: PgClient,
  builder: string,
  params: readonly unknown[],
  label: string,
): Promise<void> {
  let statement: string;
  try {
    const built = await client.query<{ statement: string }>(builder, [...params]);
    statement = built.rows[0]!.statement;
  } catch (error) {
    throw scrub(error, label);
  }
  try {
    await client.query(statement);
  } catch (error) {
    throw scrub(error, label);
  }
}

/** Never let an error carrying a generated statement escape: it would carry the password with it. */
function scrub(error: unknown, label: string): Error {
  const code = (error as { code?: unknown }).code;
  return new TerminalError(
    'BOOTSTRAP_STATEMENT_FAILED',
    `Bootstrap step '${label}' was refused by PostgreSQL`,
    { operation: label, ...(typeof code === 'string' ? { sqlstate: code } : {}) },
  );
}

async function exec(client: PgClient, sql: string, label: string): Promise<void> {
  try {
    await client.query(sql);
  } catch (error) {
    throw translatePgError(error, label);
  }
}

async function readRoles(client: PgClient): Promise<Map<string, RoleRow>> {
  const names = ROLE_MODEL.flatMap((entry) => [entry.privilegeRole, entry.loginRole]);
  const result = await client.query<RoleRow>(
    `SELECT rolname, rolcanlogin, rolbypassrls, rolsuper
       FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])`,
    [names],
  );
  return new Map(result.rows.map((row) => [row.rolname, row]));
}

async function readMemberships(client: PgClient): Promise<Map<string, Set<string>>> {
  const result = await client.query<{ member: string; role: string }>(
    `SELECT m.rolname AS member, r.rolname AS role
       FROM pg_catalog.pg_auth_members am
       JOIN pg_catalog.pg_roles m ON m.oid = am.member
       JOIN pg_catalog.pg_roles r ON r.oid = am.roleid`,
  );
  const out = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const set = out.get(row.member) ?? new Set<string>();
    set.add(row.role);
    out.set(row.member, set);
  }
  return out;
}

async function readExtensions(client: PgClient): Promise<Set<string>> {
  const result = await client.query<{ extname: string }>(
    'SELECT extname FROM pg_catalog.pg_extension',
  );
  return new Set(result.rows.map((row) => row.extname));
}

function buildTemplates(
  database: string,
  endpoint: { readonly host: string; readonly port: number } | undefined,
): Record<string, string> {
  const host = endpoint ? `${endpoint.host}:${String(endpoint.port)}` : '<host>:5432';
  const out: Record<string, string> = {};
  for (const entry of ROLE_MODEL) {
    out[entry.urlEnvVar] =
      `postgres://${entry.loginRole}:$${entry.passwordEnvVar}@${host}/${database}`;
  }
  return out;
}
