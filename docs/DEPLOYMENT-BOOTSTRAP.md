# PostgreSQL deployment bootstrap — runbook

**What this is for.** Taking an empty PostgreSQL cluster to a running receive-only deployment,
with four distinct credentials and no role holding more authority than its job needs.

**Read this before the Meta checklist.** `docs/META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md` starts by
assuming a migrated database exists. This is how one comes to exist.

---

## 0. The defect this replaced

Until Phase 02B.1 the documented procedure could not be followed on a fresh database. The
migrations create four roles — `app_runtime`, `app_migrator`, `app_worker`, `app_relay` — and every
one of them is `NOLOGIN`. Nothing in the repository ever created a role that could **connect**, and
the checklist told operators to use

```
PG_MIGRATOR_URL=postgres://app_migrator:...@host/db     # cannot ever work
```

which fails at the server: `app_migrator` has no `LOGIN` attribute and no password. The test
harness had quietly invented three login roles of its own and migrated as the superuser, so the
suite was green while proving a role model no documented procedure produced.

The fix is to say out loud what the schema always implied: **privilege roles and login identities
are different things.**

| Kind               | Example             | Has a password | Holds grants | Rotatable without touching a `GRANT` |
| ------------------ | ------------------- | -------------- | ------------ | ------------------------------------ |
| **Privilege role** | `app_runtime`       | no (`NOLOGIN`) | yes          | n/a                                  |
| **Login identity** | `app_runtime_login` | yes            | no           | yes                                  |

The application connects as an identity; the identity is a member of exactly one privilege role;
the privilege role is what the migrations grant to. Rotating a credential is then an `ALTER ROLE`
and nothing else.

---

## 1. The role model, in full

| Privilege role | Login identity       | Env var           | May do                                                                |
| -------------- | -------------------- | ----------------- | --------------------------------------------------------------------- |
| `app_migrator` | `app_migrator_login` | `PG_MIGRATOR_URL` | own and change the schema; `BYPASSRLS`. Never serves traffic.         |
| `app_runtime`  | `app_runtime_login`  | `PG_RUNTIME_URL`  | every tenant table, **under RLS**, inside `SET LOCAL app.account_id`. |
| `app_worker`   | `app_worker_login`   | `PG_WORKER_URL`   | `jobs` and `dead_letters` across tenants. Nothing else, at all.       |
| `app_relay`    | `app_relay_login`    | `PG_RELAY_URL`    | `SELECT` on `domain_event_outbox`, `UPDATE` on `relayed_at` alone.    |

None of the four login identities is a superuser and none has `BYPASSRLS`. That is asserted, not
asserted-in-prose: `tests/postgres/bootstrap.test.ts` reads `pg_roles` and fails the build if it
ever stops being true.

### The migrator, and the one thing everybody gets wrong

`app_migrator_login` is a member of `app_migrator`, and **that is not enough**. PostgreSQL does not
inherit role _attributes_ through membership: the identity's own `rolbypassrls` is `false` no
matter how many BYPASSRLS roles it belongs to. Only an explicit `SET ROLE` confers it, which is why
`src/runtime/cli/migrate.ts` issues `SET LOCAL ROLE app_migrator` for the duration of the run.

Two things depend on that `SET ROLE`, and both fail _silently_ without it:

1. **Ownership.** Objects belong to `current_user` at creation time. Without it the schema would be
   owned by a credential, and rotating that credential would mean an `ALTER ... OWNER TO` for every
   table, sequence and function.
2. **`BYPASSRLS`.** Every table declares `FORCE ROW LEVEL SECURITY`, and the two SECURITY DEFINER
   functions execute as their owner. If the owner cannot bypass RLS, `app_resolve_webhook_connection`
   returns no rows — and "no such connection" is a legitimate answer, so every webhook delivery
   would be quietly discarded rather than loudly failing.

`app_migrator_login` is deliberately created `NOINHERIT`, so connecting with it grants nothing until
the `SET ROLE` happens. The window in which schema authority is live is one transaction long.

---

## 2. Privilege you need, and for how long

The bootstrap **requires an authority greater than any role it creates.** There is no way around
that: creating roles needs `CREATEROLE`, creating a `BYPASSRLS` role needs `BYPASSRLS`, and granting
`CREATE ON SCHEMA public` needs to own that schema. Rather than pretend otherwise, the bootstrap
takes that credential in its own variable, uses it once, and hands back four credentials that are
each much smaller.

```
PG_BOOTSTRAP_URL     used ONLY by src/runtime/cli/bootstrap.ts. Nothing in src/runtime/main.ts
                     reads it. After step 3 below it can be put away.
```

Everything afterwards — every deploy, every migration, every process — runs on the four narrow
credentials. If your platform can issue a short-lived admin credential, this is the place to use
one.

---

## 3. The bootstrap, end to end

### Step 1 — create the database (privileged; cannot be done by the tool)

`CREATE DATABASE` cannot run inside a transaction, and the bootstrap is deliberately one
transaction so that a half-built role model is impossible. So this one step is yours:

```bash
createdb --host "$PGHOST" --username "$PGADMIN" all_in_moderation
# or:  psql "$PG_BOOTSTRAP_ADMIN_URL" -c 'CREATE DATABASE all_in_moderation'
```

The bootstrap refuses to run against `postgres`, `template0` or `template1`. Roles are cluster-wide
but `CONNECT` and schema privileges are not, so bootstrapping a maintenance database half-works and
the mistake only surfaces later, as a migration failure.

### Step 2 — check what the credential can actually do (changes nothing)

```bash
export PG_BOOTSTRAP_URL='postgres://admin:...@host:5432/all_in_moderation'
node src/runtime/cli/bootstrap.ts --check
```

It exits `1` while anything is missing, which makes it usable as a deploy gate, and prints a
`capabilities` block that is the definitive answer to "will this managed PostgreSQL work?":

```json
"capabilities": {
  "database": "all_in_moderation",
  "currentUser": "admin",
  "serverVersionNum": 170010,
  "superuser": true,
  "createRole": true,
  "bypassRls": true,
  "ownsPublicSchema": true
}
```

### Step 3 — generate four passwords and run the bootstrap

Passwords are never accepted as command-line arguments — `argv` is readable by every process on a
Linux host, and `--password` is refused with an error saying so. Use the environment:

```bash
export PG_MIGRATOR_PASSWORD="$(openssl rand -hex 24)"
export PG_RUNTIME_PASSWORD="$(openssl rand -hex 24)"
export PG_WORKER_PASSWORD="$(openssl rand -hex 24)"
export PG_RELAY_PASSWORD="$(openssl rand -hex 24)"

node src/runtime/cli/bootstrap.ts
```

or pipe them from a secret manager, with no temporary file anywhere:

```bash
vault kv get -format=json secret/moderation/db | jq -c '.data.data' \
  | node src/runtime/cli/bootstrap.ts --passwords-stdin
```

Store all four in your secret manager **now**. Nothing prints them, and nothing can recover them.

What it does, all inside one transaction:

- creates the four privilege roles (`app_migrator` with `BYPASSRLS`, the rest without);
- creates the four login identities — `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, and
  `NOINHERIT` for the migrator;
- grants each identity membership of its privilege role;
- installs `pgcrypto`;
- `GRANT USAGE, CREATE ON SCHEMA public TO app_migrator`;
- `REVOKE CREATE ON SCHEMA public FROM PUBLIC` — on PostgreSQL 13 and 14 `public` was writable by
  `PUBLIC`, which would hand `app_runtime` the ability to create tables. This makes the posture
  identical on every supported major version instead of accidentally version-dependent;
- `GRANT CONNECT ON DATABASE` to the four identities.

**It is idempotent, and specifically it does not rotate passwords.** Re-running it reports every
role as `present`, grants nothing, and needs no passwords at all. A tool that re-credentialed a
running deployment every time somebody ran it to check something would be a tool nobody could
safely run twice.

To rotate deliberately, supply new passwords and ask for it:

```bash
PG_RUNTIME_PASSWORD=... node src/runtime/cli/bootstrap.ts --rotate-passwords
```

### Step 4 — migrate, as the migrator identity

```bash
export PG_MIGRATOR_URL="postgres://app_migrator_login:${PG_MIGRATOR_PASSWORD}@host:5432/all_in_moderation"

node src/runtime/cli/migrate.ts --status     # what is applied, what is pending
node src/runtime/cli/migrate.ts              # apply
```

The command reports the role it assumed:

```json
{ "ok": true, "role": "app_migrator", "applied": ["0001_core.sql", ...], "alreadyCurrent": false }
```

Pointing this at `PG_RUNTIME_URL` fails with `MIGRATION_ROLE_UNAVAILABLE`, because
`app_runtime_login` is not a member of `app_migrator` and cannot assume it. That is the boundary
being enforced rather than described.

### Step 5 — hand the runtime its three credentials

```bash
export PG_RUNTIME_URL="postgres://app_runtime_login:${PG_RUNTIME_PASSWORD}@host:5432/all_in_moderation"
export PG_WORKER_URL="postgres://app_worker_login:${PG_WORKER_PASSWORD}@host:5432/all_in_moderation"
export PG_RELAY_URL="postgres://app_relay_login:${PG_RELAY_PASSWORD}@host:5432/all_in_moderation"
```

`PG_MIGRATOR_URL` and `PG_BOOTSTRAP_URL` must **not** be in the running process's environment.
There is no single-URL fallback and there never will be: collapsing them would merge four privilege
boundaries into one.

---

## 4. The whole sequence, from an empty database to a running service

Copy-pasteable. Steps 1–4 need the privileged credential; nothing after step 4 does.

```bash
# --- 0. the code ---------------------------------------------------------------------------------
npm ci

# --- 1. the database (privileged) ----------------------------------------------------------------
psql "$PG_ADMIN_URL" -c 'CREATE DATABASE all_in_moderation'

# --- 2. see what the credential can do (changes nothing) -----------------------------------------
export PG_BOOTSTRAP_URL="${PG_ADMIN_URL%/*}/all_in_moderation"
node src/runtime/cli/bootstrap.ts --check || true    # exits 1 until step 3 has run

# --- 3. roles and identities (privileged; the last step that needs it) ---------------------------
export PG_MIGRATOR_PASSWORD="$(openssl rand -hex 24)"
export PG_RUNTIME_PASSWORD="$(openssl rand -hex 24)"
export PG_WORKER_PASSWORD="$(openssl rand -hex 24)"
export PG_RELAY_PASSWORD="$(openssl rand -hex 24)"
node src/runtime/cli/bootstrap.ts
#   -> store all four passwords in your secret manager now
unset PG_BOOTSTRAP_URL

# --- 4. schema ------------------------------------------------------------------------------------
export PG_MIGRATOR_URL="postgres://app_migrator_login:${PG_MIGRATOR_PASSWORD}@$PG_HOST/all_in_moderation"
node src/runtime/cli/migrate.ts
unset PG_MIGRATOR_URL PG_MIGRATOR_PASSWORD

# --- 5. the runtime's three credentials -----------------------------------------------------------
export PG_RUNTIME_URL="postgres://app_runtime_login:${PG_RUNTIME_PASSWORD}@$PG_HOST/all_in_moderation"
export PG_WORKER_URL="postgres://app_worker_login:${PG_WORKER_PASSWORD}@$PG_HOST/all_in_moderation"
export PG_RELAY_URL="postgres://app_relay_login:${PG_RELAY_PASSWORD}@$PG_HOST/all_in_moderation"

# --- 6. safety and secrets ------------------------------------------------------------------------
export OUTBOUND_MODE=SIMULATE           # LIVE is refused at boot: OUTBOUND_LIVE_NOT_AUTHORIZED
export APP_ROLE=all                     # or run `web` and `worker` as separate processes
export WEBHOOK_SECRETS='{"secret://<client>/meta":{"appSecret":"...","verifyToken":"..."}}'

# --- 7. prove the chain with no Meta account and no network --------------------------------------
node src/runtime/cli/shadow-acceptance.ts --self-test     # exits 0, "ok": true

# --- 8. run ---------------------------------------------------------------------------------------
npm start

# --- 9. confirm ------------------------------------------------------------------------------------
curl -s localhost:8080/health/status | jq '{status, process, database, inbound}'
#   process.outboundMode must read SIMULATE
#   database.reachable must be true
```

At this point the service is running receive-only against a database whose role model is the one
this document describes. Attaching a real Meta surface is
`docs/META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md`, starting at its step 6.

---

## 5. Managed PostgreSQL compatibility

**Nothing here has been tested on a managed provider.** The suite runs against a real PostgreSQL 17
started from `node_modules`, as an ordinary non-superuser for everything the application does — but
the bootstrap step runs as that cluster's superuser, and a managed provider does not give you one.
Rather than guess, the table below states what the bootstrap actually requires, and
`bootstrap --check` answers the question for your provider in one command.

| Capability                             | Needed for                                                                           | Can it be worked around?                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `CREATEROLE` (or superuser)            | Creating the four privilege roles and four login identities.                         | Yes — have your provider or DBA create the eight roles by hand; the bootstrap then reports them `present` and grants memberships. |
| Role membership (`GRANT role TO role`) | Every identity's authority.                                                          | No. This is the model.                                                                                                            |
| **`BYPASSRLS` on `app_migrator`**      | The two SECURITY DEFINER resolvers, which execute as the owner against `FORCE`d RLS. | **No — and this is the requirement most likely to block a provider. See below.**                                                  |
| Ownership of schema `public`           | `GRANT CREATE ... TO app_migrator`, and `REVOKE CREATE ... FROM PUBLIC`.             | Partly — a dedicated schema owned by `app_migrator` would work, but no migration uses one today.                                  |
| `CREATE EXTENSION pgcrypto`            | Declared by migration 0001.                                                          | Yes, most likely. See the note below.                                                                                             |
| PostgreSQL ≥ 13                        | `pgcrypto` is a _trusted_ extension from 13, so a database owner can install it.     | Below 13 it needs a superuser.                                                                                                    |

### `BYPASSRLS` is the one to check first

Since PostgreSQL 16, a `CREATEROLE` role may only grant role attributes it holds itself, so creating
`app_migrator BYPASSRLS` requires the bootstrap credential to _have_ `BYPASSRLS`. Many managed
providers hand you an admin role that is deliberately not a superuser; whether it carries
`BYPASSRLS` varies by provider and by plan, and we have verified none of them.

Run `bootstrap --check` and read `capabilities.bypassRls`. If it is `false` and `superuser` is also
`false`, this schema cannot be deployed there **as written**, and the bootstrap says so by name
rather than proceeding:

```
BOOTSTRAP_CAPABILITY_MISSING: ... Missing: BYPASSRLS: app_migrator must be created with it, and
since PostgreSQL 16 a CREATEROLE role can only grant attributes it holds itself.
```

Do not respond by dropping `FORCE ROW LEVEL SECURITY`, by making the resolvers `SECURITY INVOKER`,
or by granting `app_runtime` a cross-tenant read of `channel_connections`. Every one of those trades
the tenancy guarantee for a deployment target, and the failure would be a client reading another
client's customer conversations. The supported responses are: use a provider or plan that grants
`BYPASSRLS`; ask the provider to create `app_migrator` for you with it; or run PostgreSQL yourself.

### The `pgcrypto` note

Migration 0001 declares `CREATE EXTENSION IF NOT EXISTS pgcrypto`, and **nothing in the schema
currently uses it** — no column default, no function, no index. `gen_random_uuid()` has been in core
PostgreSQL since 13, and every identifier this system generates is a ULID minted in the application.
If a provider forbids the extension, dropping the requirement is a one-line future migration rather
than a redesign. It is listed as a requirement because the migration declares one, not because a
query depends on one.

---

## 6. Verifying a deployment you did not build

```bash
# The role model is what this document describes.
PG_BOOTSTRAP_URL=... node src/runtime/cli/bootstrap.ts --check      # exits 0 when complete

# The schema is current.
PG_MIGRATOR_URL=... node src/runtime/cli/migrate.ts --status        # "upToDate": true

# The runtime credential really is bound by RLS. Expect zero rows: no tenant context is set.
psql "$PG_RUNTIME_URL" -c 'SELECT count(*) FROM conversations'

# The runtime credential really cannot change the schema. Expect: permission denied.
psql "$PG_RUNTIME_URL" -c 'CREATE TABLE probe (id text)'

# No application role is privileged.
psql "$PG_RUNTIME_URL" -c \
  "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'app\\_%_login'"
```

The last one should print `f | f` on every row. If any application identity reports `t` in either
column, the tenancy model described in ADR-002 is not the tenancy model in force, and no `GRANT`
will put it back — fix the role, then re-check.

---

## 7. What this does not cover

- **Backups, restore and PITR.** Out of scope for this phase and not yet designed. A restored
  database keeps its roles only if the cluster's globals were dumped too (`pg_dumpall --globals-only`);
  a `pg_dump` of one database restores objects owned by roles that must already exist.
- **Connection pooling in front of PostgreSQL.** `SET LOCAL app.account_id` is transaction-scoped,
  which is compatible with transaction pooling, but nothing here has been tested behind PgBouncer.
- **Certificate/TLS configuration.** Add `?sslmode=require` (or stricter) to the connection strings;
  none of the tooling forbids or requires it.
- **Anything outbound.** No credential here authorises sending. See the Meta checklist, §3.
