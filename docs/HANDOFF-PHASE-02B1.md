# Phase 02B.1 — deployment bootstrap

**Branch:** `phase-02b1/deployment-bootstrap` · **Base:** `master` at the Phase 02B merge (29639f0)
**Scope:** one narrow hardening phase, before the first real Meta shadow connection.

**Nothing was connected to Meta.** No Meta credential was used or requested, no outbound capability
was added, no real language model was connected, and no client business rules were introduced.

---

## 1. The finding, audited independently

The brief described a suspected gap. It was checked against the tree rather than taken on trust,
and it is real — with two consequences the brief did not name, both of which turn out to matter
more than the original one.

### 1.1 Confirmed: nothing ever created a role that could connect

`db/migrations/0001_core.sql`, `0005_runtime_roles.sql` and `0007_relay_and_health.sql` create four
roles, and every one is `NOLOGIN`:

| Role           | Created in | Attributes          |
| -------------- | ---------- | ------------------- |
| `app_runtime`  | 0001       | `NOLOGIN`           |
| `app_migrator` | 0001       | `NOLOGIN BYPASSRLS` |
| `app_worker`   | 0005       | `NOLOGIN`           |
| `app_relay`    | 0007       | `NOLOGIN`           |

`tests/support/postgres.ts` separately invented `app_runtime_login`, `app_worker_login` and
`app_relay_login` with passwords hard-coded in the file, granted them membership, and **migrated as
the superuser**. Nothing outside the test tree created those identities, and no document told an
operator to.

`docs/META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md` §5 then said:

```
PG_MIGRATOR_URL=postgres://app_migrator:...@host:5432/all_in_moderation
```

That connection string can never succeed. `app_migrator` has no `LOGIN` attribute and no password;
the server refuses the connection before any of this code runs. **The documented procedure failed
at its first command on a fresh database.**

### 1.2 Not in the brief: `BYPASSRLS` is not inherited, and it is load-bearing

`BYPASSRLS` is a role _attribute_, and PostgreSQL does not inherit attributes through membership.
`GRANT app_migrator TO app_migrator_login` leaves the identity's own `rolbypassrls` as `false`.
Only an explicit `SET ROLE` confers it.

That would be a footnote if `BYPASSRLS` were decorative. It is not:

- every table declares `FORCE ROW LEVEL SECURITY`, so even the owner is subject to policy;
- `app_resolve_webhook_connection` and `app_inbound_backlog` are `SECURITY DEFINER` and execute as
  **their owner**.

Under the old harness the owner was `postgres`, and superusers bypass everything — so the functions
worked for a reason that would not exist on a real deployment. Migrate as a non-superuser without
`SET ROLE`, and `app_resolve_webhook_connection` returns zero rows. "No such connection" is a
legitimate answer, so **every webhook delivery would be discarded silently.** No error, no
rejection counter, no signature failure — just a page that appears to be sending nothing.

This is the most expensive thing this phase found, and it was invisible because the only thing that
had ever migrated this schema was a superuser.

### 1.3 Not in the brief: migrations needed cluster-level authority forever

`CREATE ROLE` requires `CREATEROLE`. Creating `app_migrator BYPASSRLS` requires the creator to hold
`BYPASSRLS` — PostgreSQL 16 tightened `CREATEROLE` so it can only grant attributes it has itself.
Leaving those statements in the migrations meant every migration run for the life of the system
needed cluster-level privilege.

Moving role creation into a one-off bootstrap makes the migrations' own `IF NOT EXISTS` guards
find the roles already present, so a routine deploy needs only schema ownership.

---

## 2. What was built

### 2.1 `src/adapters/postgres/bootstrap.ts` — the role model, as code

One exported constant (`ROLE_MODEL`) is now the single source of truth for the four pairs:

| Privilege role | Login identity       | Attributes of the identity                   | Env var           |
| -------------- | -------------------- | -------------------------------------------- | ----------------- |
| `app_migrator` | `app_migrator_login` | `LOGIN`, **`NOINHERIT`**, no role attributes | `PG_MIGRATOR_URL` |
| `app_runtime`  | `app_runtime_login`  | `LOGIN`, `INHERIT`, no role attributes       | `PG_RUNTIME_URL`  |
| `app_worker`   | `app_worker_login`   | `LOGIN`, `INHERIT`, no role attributes       | `PG_WORKER_URL`   |
| `app_relay`    | `app_relay_login`    | `LOGIN`, `INHERIT`, no role attributes       | `PG_RELAY_URL`    |

`bootstrapDatabase()` runs the whole thing in **one transaction** — role DDL is transactional in
PostgreSQL — so a failure anywhere leaves the cluster exactly as it was. There is no state in which
half the identities exist.

It creates the privilege roles, creates the identities, grants memberships, installs `pgcrypto`,
grants `USAGE, CREATE ON SCHEMA public` to `app_migrator`, revokes `CREATE ON SCHEMA public` from
`PUBLIC` (which matters on PostgreSQL 13 and 14, where `public` was writable by everyone and
`app_runtime` would therefore have been able to create tables), and grants `CONNECT` to the four
identities.

### 2.2 `src/runtime/cli/bootstrap.ts` — the operator command

```
PG_BOOTSTRAP_URL=<privileged url> node src/runtime/cli/bootstrap.ts [--check] [--rotate-passwords] [--passwords-stdin]
```

- `--check` reports the delta and changes nothing; exits `1` while anything is missing, so it can
  gate a deploy script. It needs no passwords.
- Passwords come from four environment variables or from a JSON object on stdin. `--password` on the
  command line is **refused with an error explaining why** — `argv` is readable by every process on
  a Linux host — rather than silently ignored, because an operator who tries it once and sees
  nothing will assume it worked.
- Minimum password length is enforced (12), as is "no surrounding whitespace".

### 2.3 The migrator ambiguity, resolved

**The supported model, stated once:** `app_migrator` is a privilege role and is never logged into.
`app_migrator_login` is the identity, is `NOINHERIT` so connecting confers nothing, and
`src/runtime/cli/migrate.ts` issues `SET LOCAL ROLE app_migrator` for the length of the run. That
`SET ROLE` is what makes object ownership land on the privilege role and what makes `BYPASSRLS`
apply.

`createMigrator` takes a new `assumeRole` option; failing to assume it is
`MIGRATION_ROLE_UNAVAILABLE` with a message naming the bootstrap, not a confusing permission error
three statements later.

**Initial bootstrap does require a privileged database owner/admin, and this phase says so
plainly.** Creating roles needs `CREATEROLE`; creating a `BYPASSRLS` role needs `BYPASSRLS`;
granting `CREATE ON SCHEMA public` needs to own that schema. There is no way to construct this role
model from inside it. What the phase does instead is minimise the window: the credential lives in
`PG_BOOTSTRAP_URL`, which no runtime code path reads, is used by exactly one command, and can be
put away permanently once that command succeeds. Every deploy afterwards runs on
`app_migrator_login`; every process runs on the three narrow identities.

### 2.4 The test harness now proves the production path

`tests/support/postgres.ts` no longer invents roles or migrates as the superuser. It runs the same
`bootstrapDatabase` an operator runs, with **freshly generated random passwords** (the hard-coded
ones are gone), and migrates through `app_migrator_login` → `SET ROLE app_migrator`. The superuser
survives for two jobs the application never does: `CREATE DATABASE`, and reading rows RLS would
hide from an assertion.

The consequence is the point: a privilege the deployment procedure forgets to grant is now a red
test, not a surprise on a deployment. All 452 pre-existing tests pass unchanged against the new
path — including the RLS suite, the security posture suite and the two `SECURITY DEFINER`
assertions, which now pass because `app_migrator` really has `BYPASSRLS` rather than because the
owner happened to be a superuser.

### 2.5 A small fix found on the way

`migrate --status` ran `applied()` and `pending()` through `Promise.all`. Both open their own
transaction and both begin with `CREATE TABLE IF NOT EXISTS schema_migrations`; against a database
that does not have it yet, the two racing creates produce a duplicate-object error instead of a
status report. It surfaced once in roughly ten runs of the operator sequence — the worst possible
frequency for a command whose only job is to tell you the truth. Now sequential.

---

## 3. The proof

`tests/postgres/bootstrap.test.ts` — 21 tests, on a **second, entirely separate embedded cluster**.
It has to be separate: PostgreSQL roles are cluster-wide, so a second database on the shared
harness cluster would find every role already present and prove nothing about creating them.

The chain, in the order the objective asked for:

```
CREATE DATABASE (privileged, cannot be transactional — the operator's step)
  -> bootstrap --check reports 13 pending actions and creates nothing
  -> bootstrap creates 4 privilege roles, 4 identities, 4 memberships, pgcrypto, schema grants
  -> migrations 0001..0008 as app_migrator_login assuming app_migrator
  -> runtime, worker and relay logins connect
  -> each does exactly its intended work
  -> forbidden cross-role operations fail with 42501
  -> the application boots and takes a webhook off a real socket
  -> shadow acceptance traces the delivery end to end
  -> every outbound action is SIMULATED
```

Every item the brief asked to be tested explicitly, and where:

| Requirement                                   | Test                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| runtime login is subject to RLS               | `runtime: connects, is bound by RLS, and sees nothing without a tenant context`                                               |
| worker cannot read conversations/messages     | `worker: reads the queue across tenants and cannot reach a conversation`                                                      |
| relay cannot read conversations/messages/jobs | `relay: reads the outbox, writes only relayed_at, and reaches nothing else`                                                   |
| runtime/worker/relay cannot alter schema      | `none of the three can alter the schema`                                                                                      |
| no application role is superuser              | `gives the migrator BYPASSRLS and gives no login identity any role attribute at all`                                          |
| no runtime/worker/relay role has BYPASSRLS    | same test                                                                                                                     |
| migration authority is not used by the app    | `the running application never holds migration authority`                                                                     |
| bootstrap is idempotent                       | `is idempotent: a second run grants nothing, creates nothing and rotates nothing`                                             |
| incorrect/missing credentials fail closed     | `an incorrect or unknown credential fails closed`; `refuses to create an identity without a password, and refuses a weak one` |
| secrets never appear in logs                  | `never puts a password in its report or its log`                                                                              |

Plus four the brief did not ask for and that turned out to be the interesting ones:

- `BYPASSRLS is not inherited through membership — only SET ROLE confers it`, which pins the fact
  §1.2 describes so nobody has to rediscover it;
- `leaves every object owned by app_migrator, not by the identity that connected`, which also
  asserts both `SECURITY DEFINER` functions are owned by the `BYPASSRLS` role;
- `refuses to bootstrap a maintenance database`, because roles are cluster-wide but schema and
  `CONNECT` privileges are not, so the mistake half-works;
- `--rotate-passwords replaces every credential, and only when asked`, which proves the old password
  stops working — rotation that leaves the previous credential valid is not rotation.

The four CLI commands were additionally driven end to end against a throwaway cluster (bootstrap
`--check`, bootstrap, bootstrap again, `--check` clean, `migrate --status`, `migrate`, `migrate`
again, `migrate` as the runtime identity, `--passwords-stdin`), and no password appeared in any
output.

### CI

`MIN_TESTS` raised 452 → **473**. `postgres deployment bootstrap` added to the named-suite list, so
the suite cannot silently skip itself. One new named step asserts, at the command level, that
`migrate` names the login identity when it fails and that `--password` is refused.

Nothing was weakened. No test is skipped, no assertion was relaxed, no floor was lowered.

---

## 4. Managed PostgreSQL — what is required, and what is not claimed

**No managed provider has been tested, and none is claimed to work.** `docs/DEPLOYMENT-BOOTSTRAP.md`
§5 has the full table; the summary:

| Capability                      | Required?                      | Workaround                                                    |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `CREATEROLE` (or superuser)     | Yes, to create the eight roles | Have a DBA create them; bootstrap then reports them `present` |
| Role membership                 | Yes                            | None — this is the model                                      |
| **`BYPASSRLS` on the migrator** | **Yes, and load-bearing**      | **None. See below.**                                          |
| Ownership of schema `public`    | Yes, to grant `CREATE` on it   | A dedicated schema would work; no migration uses one today    |
| `CREATE EXTENSION pgcrypto`     | Declared by 0001               | Probably removable — see below                                |
| PostgreSQL ≥ 13                 | `pgcrypto` is trusted from 13  | Below 13 the extension needs a superuser                      |

**`BYPASSRLS` is surfaced now, as asked, rather than worked around.** Since PostgreSQL 16 a
`CREATEROLE` role can only grant attributes it holds itself, so a provider whose admin role lacks
`BYPASSRLS` cannot create `app_migrator` — and `app_migrator` needs it because the two
`SECURITY DEFINER` resolvers run as their owner against `FORCE`d RLS. The bootstrap refuses with
`BOOTSTRAP_CAPABILITY_MISSING` naming the exact missing capability rather than proceeding to a
deployment that discards webhooks silently.

The runbook explicitly forbids the tempting fixes — dropping `FORCE ROW LEVEL SECURITY`, making the
resolvers `SECURITY INVOKER`, or granting `app_runtime` a cross-tenant read of
`channel_connections` — because every one of them trades the tenancy guarantee for a deployment
target, and the failure mode is a client reading another client's customer conversations.

**One honest note that may unblock a provider:** migration 0001 declares
`CREATE EXTENSION IF NOT EXISTS pgcrypto`, and **nothing in the schema uses it.** No column default,
no function, no index — `gen_random_uuid()` has been in core since 13 and every identifier here is
an application-minted ULID. It is listed as a requirement because a migration declares one, not
because a query depends on one. If a provider forbids it, dropping it is a one-line future
migration.

`bootstrap --check` prints a `capabilities` block that answers the whole question for a given
provider in one command, without changing anything.

---

## 5. Meta operator documentation — the credential correction

Phase 02B's checklist said a Page/IG/WhatsApp access token was "not needed. Do not obtain one." That
is right about the **runtime** and wrong about the **setup**: step 8 subscribes a Page or WABA
through an authenticated Graph API write, and Meta offers no unauthenticated way to do it. An
operator following the old text literally gets stuck with no explanation, and the natural next move
— pasting a token into an environment file to get past it — is exactly what the sentence existed to
prevent.

§3 of the checklist now separates three things by name:

|                                                                          | Lifetime   | Held by      | Allowed to live in                                                                                    |
| ------------------------------------------------------------------------ | ---------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| **A. SETUP CREDENTIAL** — a send-capable token, to subscribe the surface | minutes    | the operator | Graph API Explorer, or one shell command. **Never** `WEBHOOK_SECRETS`, `.env`, or any database column |
| **B. RUNTIME WEBHOOK SECRETS** — app secret + verify token               | long-lived | the service  | `WEBHOOK_SECRETS`, behind a `secret://` reference                                                     |
| **C. FUTURE OUTBOUND CREDENTIAL** — a stored access token                | n/a        | nobody       | does not exist; out of scope by design                                                                |

> **A** authorises Meta to start calling us, and is yours for five minutes.
> **B** proves the calls are really from Meta, and is the service's forever.
> **C** would authorise us to call Meta, and does not exist.

**No access-token field was added to PostgreSQL**, and the security suite still fails the build if
any column matching `%secret%`, `%token%` or `%password%` appears without a `_ref` suffix.

Also corrected: §0 statement 2 (which claimed no token is ever requested), §1's database row, §4's
environment block (`PG_MIGRATOR_URL` and `PG_BOOTSTRAP_URL` explicitly excluded from the running
process), §5 (the impossible connection string, replaced with the real procedure), §8 (the setup
credential named where it is actually used) and §12 (C distinguished from A).

A new §13 gives the complete command sequence from an empty database to a shadowed Page.

---

## 6. Files

**New**

```
src/adapters/postgres/bootstrap.ts     the role model and the idempotent bootstrap
src/runtime/cli/bootstrap.ts           the operator command
tests/postgres/bootstrap.test.ts       21 tests on a fresh cluster
docs/DEPLOYMENT-BOOTSTRAP.md           the runbook, incl. managed-PostgreSQL requirements
docs/HANDOFF-PHASE-02B1.md             this document
```

**Changed**

```
src/adapters/postgres/migrator.ts      assumeRole: SET LOCAL ROLE for the run
src/adapters/postgres/index.ts         exports the bootstrap surface
src/runtime/cli/migrate.ts             names the identity, assumes the role, --status race fixed
tests/support/postgres.ts              real bootstrap + migrator identity; random passwords
docs/META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md   credential classes, real §5, new §13
.env.example                           four credentials; deploy-time-only variables
README.md                              bootstrap in the run instructions; docs index
.github/workflows/verify.yml           floor 452 -> 473; new suite; new named step
```

**Deliberately unchanged: `db/migrations/`.** Applied migrations are checksummed and editing one is
a hard failure by design, so the entire bootstrap lives outside them. The migrations' existing
`IF NOT EXISTS` role guards make them no-ops on a bootstrapped database.

---

## 7. Verification

```
git diff --check      clean
npm run verify        format:check, lint, typecheck, 473 tests: pass 473, fail 0, skipped 0
npm run demo          "All outbound actions are SIMULATED."
```

- No credential is committed. The test harness generates random passwords per run; the hard-coded
  ones that were in `tests/support/postgres.ts` are gone.
- No Meta network call. No outbound HTTP capability: `tests/architecture/no-outbound-meta.test.ts`
  and the CI grep both still pass.
- No skipped tests.

---

## 8. What is still not true

- **Nothing has been deployed.** This phase makes a deployment _possible and honest_; it has not
  been performed. No production database exists.
- **No managed provider has been verified.** §4 says what to check and how, and refuses rather than
  guessing.
- **Backups and restore are not designed.** A `pg_dump` of one database restores objects owned by
  roles that must already exist; the cluster globals (`pg_dumpall --globals-only`) are a separate
  artefact nobody has specified a procedure for. This is the largest remaining operational gap.
- **PgBouncer is untested.** `SET LOCAL app.account_id` is transaction-scoped and should be
  compatible with transaction pooling, but "should be" is not a proof.
- **Nothing can be sent.** Unchanged, and asserted three ways.

---

## 9. Recommended next

1. **Backup and restore procedure**, including cluster globals, and a test that restores into a
   fresh cluster and re-runs `bootstrap --check`. It is the one operational gap that could lose
   data rather than merely block a deploy.
2. **Run `bootstrap --check` against whichever managed provider is actually being considered**,
   before the first shadow connection rather than after. It is a one-command answer and it changes
   nothing.
3. Then Phase 02C, or the first real shadow connection, per
   `docs/META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md`.
