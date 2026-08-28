import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { asId } from '../../src/platform/ids.ts';
import type { KnowledgeEntryId, UserId } from '../../src/platform/ids.ts';
import { decisionJson, metaMessageEnvelope } from '../support/harness.ts';
import type { PostgresHarness } from '../support/postgres-harness.ts';
import { createPostgresHarness } from '../support/postgres-harness.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import {
  acquirePostgres,
  postgresAvailable,
  releasePostgres,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * Step 20: the security posture, asserted rather than described.
 *
 * The recommended role model — migrator, runtime, worker — is documented in
 * `docs/HANDOFF-PHASE-01.md`. This file is the part that can go red: the runtime role really
 * cannot change the schema, really cannot delete history, really cannot read another tenant, and
 * the things that must never reach a log really do not.
 */

const available = postgresAvailable();

describe('postgres security posture', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let h: PostgresHarness;
  let runtime: pg.Client;

  before(async () => {
    cluster = await acquirePostgres();
    runtime = new pg.Client({ connectionString: cluster.runtimeUrl });
    await runtime.connect();
  });

  beforeEach(async () => {
    await h?.close();
    h = await createPostgresHarness(cluster);
  });

  after(async () => {
    await h?.close();
    await runtime.end();
    await releasePostgres();
  });

  const asRuntime = async <T>(
    accountId: string | null,
    fn: (client: pg.Client) => Promise<T>,
  ): Promise<T> => {
    await runtime.query('BEGIN');
    try {
      if (accountId) {
        await runtime.query('SELECT set_config($1,$2,true)', ['app.account_id', accountId]);
      }
      return await fn(runtime);
    } finally {
      await runtime.query('ROLLBACK');
    }
  };

  const refused = async (sql: string, params: unknown[] = []): Promise<string | null> =>
    await asRuntime('acc_probe', async (client) => {
      try {
        await client.query(sql, params);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      }
    });

  it('the runtime role cannot change the schema', async () => {
    // Migrations run as a different role. A runtime that can `CREATE TABLE` can also `DROP` one,
    // and an application compromise becomes a data-loss event rather than a data-exposure one.
    assert.equal(await refused('CREATE TABLE evil (id text)'), '42501');
    assert.equal(await refused('DROP TABLE messages'), '42501');
    assert.equal(await refused('ALTER TABLE conversations ADD COLUMN evil text'), '42501');
    assert.equal(
      await refused('ALTER TABLE conversations DISABLE ROW LEVEL SECURITY'),
      '42501',
      'the runtime must not be able to switch off its own isolation',
    );
  });

  it('the runtime role cannot rewrite or delete append-only history', async () => {
    assert.equal(await refused('DELETE FROM messages'), '42501');
    assert.equal(await refused('DELETE FROM audit_events'), '42501');
    assert.equal(
      await refused('UPDATE audit_events SET action = $1', ['replay.executed']),
      '42501',
    );
    assert.equal(
      await refused('DELETE FROM conversation_ownership_transitions'),
      '42501',
      'the ownership audit trail is the record of who was responsible',
    );
    assert.equal(
      await refused('DELETE FROM domain_event_outbox'),
      '42501',
      'deleting an unrelayed event is losing it',
    );
  });

  it('the raw ledger is immutable except for the four lifecycle columns', async () => {
    assert.equal(
      await refused('UPDATE raw_inbound_events SET payload = $1', ['{}']),
      '42501',
      'rewriting the payload would destroy the only faithful record of what arrived',
    );
    assert.equal(await refused('UPDATE raw_inbound_events SET signature_valid = true'), '42501');
    assert.equal(await refused('DELETE FROM raw_inbound_events'), '42501');
    // But the state machine the normalizer drives *is* permitted.
    assert.equal(
      await refused("UPDATE raw_inbound_events SET state = 'NORMALIZED' WHERE id = 'nope'"),
      null,
    );
  });

  it('the worker role cannot reach customer data at all', async () => {
    const worker = new pg.Client({ connectionString: cluster.workerUrl });
    await worker.connect();
    try {
      for (const table of [
        'conversations',
        'messages',
        'raw_inbound_events',
        'knowledge_entries',
      ]) {
        const code = await worker
          .query(`SELECT count(*) FROM ${table}`)
          .then(() => null)
          .catch((error: unknown) => (error as { code?: string }).code);
        assert.equal(
          code,
          '42501',
          `app_worker can read ${table}; its permissive queue policy must not extend past jobs`,
        );
      }
      // And it can do its actual job.
      const jobs = await worker.query('SELECT count(*) FROM jobs');
      assert.ok(jobs.rows.length === 1);
    } finally {
      await worker.end();
    }
  });

  it('a hostile identifier in customer data is a value, never SQL', async () => {
    const seeded = await h.seedAccount();
    const hostile = "'; DROP TABLE messages; --";
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: hostile, mid: `mid${hostile}`, text: hostile },
      ]),
    );
    await h.drain();

    const stored = await withAdminClient(cluster.adminUrl, async (client) => {
      const messages = await client.query<{ text: string }>('SELECT text FROM messages');
      const exists = await client.query("SELECT to_regclass('public.messages') AS oid");
      return { messages: messages.rows, tableExists: (exists.rows[0] as { oid: string }).oid };
    });
    assert.equal(stored.tableExists, 'messages', 'the table is still there');
    assert.equal(stored.messages[0]?.text, hostile, 'stored verbatim, interpreted as data');
  });

  it('a hostile account id cannot escape the tenant context', async () => {
    // `SET LOCAL app.account_id` is set through `set_config($1,$2,true)` with a bound parameter,
    // not string interpolation. An id crafted to close the quote would otherwise become SQL that
    // runs with the runtime's privileges.
    const hostile = "acc_x'; SET app.account_id = 'acc_victim";
    const seen = await h.persistence.runtimeDb.scoped(
      asId(hostile),
      async (client) => {
        const result = await client.query<{ v: string | null }>(
          "SELECT current_setting('app.account_id', true) AS v",
        );
        return result.rows[0]!.v;
      },
      'probe:hostile-account',
    );
    assert.equal(seen, hostile, 'the whole string is the value; nothing was executed');
  });

  it('customer message text never reaches a log record', async () => {
    const seeded = await h.seedAccount();
    const secret = 'my-phone-number-is-0700000000';
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_1', text: secret },
      ]),
    );
    await h.drain();
    h.clock.advanceMs(10_000);
    await h.drain();

    const serialised = JSON.stringify(h.logs);
    assert.ok(
      !serialised.includes(secret),
      'a message body in a log line is customer data in a place nobody applies retention to',
    );
  });

  it('a database error never carries the statement or its parameters', async () => {
    const seeded = await h.seedAccount();
    const secret = 'sensitive-value-in-a-parameter';
    const failure = await h.container.knowledge
      .save(seeded.scope, {
        id: asId<KnowledgeEntryId>('kne_bad_sec'),
        accountId: seeded.account.id,
        kind: 'PRICE',
        title: secret,
        body: secret,
        locale: 'en',
        status: 'APPROVED',
        validFrom: null,
        validUntil: null,
        sourceRef: null,
        evidence: null,
        approvedBy: asId<UserId>('usr_test'),
        approvedAt: h.clock.now(),
        productRef: null,
        paymentType: null,
        price: null,
        tags: [],
        intentCodes: [],
        supersedesId: null,
        updatedAt: h.clock.now(),
      })
      .then(
        () => null,
        (error: unknown) => error as Error & { context?: Record<string, unknown> },
      );

    assert.ok(failure, 'the constraint really did reject it');
    const rendered = `${failure.message} ${JSON.stringify(failure.context ?? {})}`;
    assert.ok(!rendered.includes(secret), 'parameters routinely contain customer content');
    // What an operator actually needs is the SQLSTATE and the constraint name — and it is there.
    assert.equal(failure.context?.['sqlstate'], '23514');
    assert.ok(String(failure.context?.['constraint']).length > 0);
  });

  it('no secret is stored in the database; connections hold a reference', async () => {
    const seeded = await h.seedAccount();
    const row = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ credentials_ref: string }>(
        'SELECT credentials_ref FROM channel_connections WHERE id = $1',
        [seeded.connection.id],
      );
      return result.rows[0]!;
    });
    assert.match(row.credentials_ref, /^secret:\/\//, 'a pointer, not the secret');

    // Whatever ends up in a database dump, an app secret must not be in it.
    const columns = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (column_name LIKE '%secret%' OR column_name LIKE '%password%'
                 OR column_name LIKE '%token%')`,
      );
      return result.rows.map((r) => `${r.table_name}.${r.column_name}`);
    });
    assert.deepEqual(
      columns.filter((c) => !c.endsWith('_ref')),
      [],
      'every secret-ish column must be a reference, resolved through the SecretResolver port',
    );
  });

  it('the tenancy-resolution function exposes two identifiers and nothing else', async () => {
    const seeded = await h.seedAccount();
    // Its whole justification is that it is narrow: an unguessable id in, two ids out. No
    // credentials_ref, no settings, no payload.
    const returned = await asRuntime(null, async (client) => {
      const result = await client.query('SELECT * FROM app_resolve_webhook_connection($1)', [
        seeded.connection.publicWebhookId,
      ]);
      return result.fields.map((f) => f.name);
    });
    assert.deepEqual(returned, ['connection_id', 'account_id']);
  });

  it('the inbound-backlog function returns an aggregate and cannot return a row', async () => {
    // The second, and last, hole in RLS. "Oldest unprocessed inbound event" is a cross-tenant
    // question asked by the least-authenticated surface in the system, so the alternative — a
    // cross-tenant grant on `raw_inbound_events` — would be far worse. There is no row to leak
    // because the function never selects one, and a later edit that tried to return one would
    // have to change this signature and this test.
    const returned = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query('SELECT * FROM app_inbound_backlog()');
      return result.fields.map((f) => f.name);
    });
    assert.deepEqual(returned, ['pending', 'oldest_received_at']);

    // Granted to the queue-facing role alone. The runtime role serves tenant traffic and has no
    // business asking a cross-tenant question.
    await assert.rejects(
      () => asRuntime(null, (client) => client.query('SELECT * FROM app_inbound_backlog()')),
      (error: unknown) => (error as { code?: string }).code === '42501',
      'only app_worker may execute the backlog aggregate',
    );
  });

  it('every SECURITY DEFINER function is enumerated, justified and search_path-pinned', async () => {
    const definers = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ proname: string; proconfig: string[] | null }>(
        `SELECT p.proname, p.proconfig FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.prosecdef
          ORDER BY p.proname`,
      );
      return result.rows;
    });

    // Each of these is a deliberate hole in RLS, and this list is the review gate: adding one
    // means editing this test, and somebody has to review that edit.
    //
    //   app_resolve_webhook_connection  ingest must resolve tenancy *before* it has tenancy
    //                                   (ADR-006). Opaque id in, two ids out.
    //   app_inbound_backlog             a count and a timestamp, for the health endpoint.
    assert.deepEqual(
      definers.map((d) => d.proname),
      ['app_inbound_backlog', 'app_resolve_webhook_connection'],
      'every SECURITY DEFINER function is a hole in RLS and must be justified one at a time',
    );
    for (const definer of definers) {
      assert.ok(
        definer.proconfig?.some((c) => c.startsWith('search_path=')),
        `${definer.proname}: an unpinned search_path in a SECURITY DEFINER function is a privilege-escalation bug`,
      );
    }
  });

  it('the runtime, worker and relay roles are distinct and none is a superuser', async () => {
    const roles = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
      }>(
        `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb FROM pg_roles
          WHERE rolname IN ('app_runtime','app_worker','app_relay','app_migrator',
                            'app_runtime_login','app_worker_login','app_relay_login')
          ORDER BY rolname`,
      );
      return result.rows;
    });

    const byName = new Map(roles.map((r) => [r.rolname, r]));
    for (const name of [
      'app_runtime',
      'app_worker',
      'app_relay',
      'app_runtime_login',
      'app_worker_login',
      'app_relay_login',
    ]) {
      const role = byName.get(name);
      assert.ok(role, `${name} should exist`);
      assert.equal(role.rolsuper, false, `${name} must not be a superuser`);
      assert.equal(role.rolbypassrls, false, `${name} must not bypass RLS`);
    }
    // The migrator is the only role allowed to sidestep policies, and it does not serve traffic.
    assert.equal(byName.get('app_migrator')?.rolbypassrls, true);
  });
});
