import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestClock } from '../../src/platform/clock.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { TransientError } from '../../src/platform/errors.ts';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, DomainEventId, TraceId } from '../../src/platform/ids.ts';
import { scopeForAccount } from '../../src/core/account/index.ts';
import type { Account } from '../../src/core/account/index.ts';
import type { DomainEventEnvelope } from '../../src/operations/events/contracts.ts';
import type { RelayTarget } from '../../src/operations/events/relay.ts';
import {
  createOutboxRelay,
  createSimulatedRelayTarget,
} from '../../src/operations/events/relay.ts';
import {
  createPostgresEventOutbox,
  createPostgresOutboxRelayStore,
} from '../../src/adapters/postgres/repositories.ts';
import type { PostgresTestCluster, PostgresTestDatabases } from '../support/postgres.ts';
import {
  acquirePostgres,
  createTestDatabases,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * The outbox relay on PostgreSQL, and the role that makes it possible.
 *
 * Phase 01 closed with `EventOutbox.markRelayed` throwing `NotImplementedError` and a precise
 * diagnosis: the signature carries no `AccountScope`, so under RLS the update matches zero rows,
 * the watermark never moves, and the relay redelivers forever. It named the two acceptable fixes
 * — a relay role, or a scoped signature — and refused to fake either.
 *
 * This suite asserts the chosen one. Two halves, and the second matters as much as the first:
 *
 *   1. The relay works: it reads across tenants, delivers, moves the watermark exactly once, and
 *      retries what failed.
 *   2. The role it works *with* can do nothing else. `app_relay` gets one table, and on that
 *      table one writable column. An RLS suite that proves visibility without proving the limits
 *      of that visibility has proved the easy half.
 */

const available = postgresAvailable();
const clock = createTestClock();

function account(id: string): Account {
  return {
    id: asId<AccountId>(id),
    slug: id,
    name: id,
    status: 'ACTIVE',
    defaultLocale: 'en',
    timezone: 'UTC',
    createdAt: clock.now(),
  };
}

const A = account('acc_relay_pg_a');
const B = account('acc_relay_pg_b');

function envelope(
  accountId: AccountId,
  eventId: string,
  occurredAtMs: number,
): DomainEventEnvelope {
  return {
    eventId: asId<DomainEventId>(eventId),
    type: 'conversation.started',
    version: 1,
    occurredAt: new Date(occurredAtMs),
    accountId,
    subject: { type: 'conversation', id: 'cnv_relay' },
    traceId: asId<TraceId>('trc_relay_pg'),
    data: {
      conversation_id: 'cnv_relay',
      channel: 'FACEBOOK',
      surface: 'DIRECT_MESSAGE',
      started_at: new Date(occurredAtMs).toISOString(),
    },
  };
}

describe('postgres outbox relay', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let dbs: PostgresTestDatabases;

  const seedAccounts = () =>
    withAdminClient(cluster.adminUrl, async (client) => {
      for (const a of [A, B]) {
        await client.query(
          `INSERT INTO accounts (id, slug, name, status) VALUES ($1,$1,$1,'ACTIVE')
           ON CONFLICT (id) DO NOTHING`,
          [a.id],
        );
      }
    });

  before(async () => {
    cluster = await acquirePostgres();
    dbs = createTestDatabases(cluster, { maxConnections: 4 });
  });

  after(async () => {
    await dbs.close();
    await releasePostgres();
  });

  const rig = async () => {
    await truncateAll(cluster.adminUrl);
    await seedAccounts();
    const { logger, records } = createMemoryLogger('debug');
    return {
      logger,
      records,
      // The write side runs on the runtime pool, inside a tenant context, exactly as the
      // repositories do; the read side runs on the relay pool. That split is the fix.
      outbox: createPostgresEventOutbox(dbs.runtime, dbs.relay),
      store: createPostgresOutboxRelayStore(dbs.relay),
    };
  };

  it('markRelayed works — the Phase 01 NotImplementedError is closed', async () => {
    const r = await rig();
    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_pg_1', 1_000));

    // Phase 01: this call rejected with NOT_IMPLEMENTED. It is the single assertion the gap was
    // about.
    await r.outbox.markRelayed(asId<DomainEventId>('evt_pg_1'));

    const relayedAt = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ relayed_at: Date | null }>(
        'SELECT relayed_at FROM domain_event_outbox WHERE id = $1',
        ['evt_pg_1'],
      );
      return result.rows[0]?.relayed_at ?? null;
    });
    assert.ok(relayedAt instanceof Date, 'the watermark moved');
  });

  it('reads pending events across tenants, oldest first', async () => {
    const r = await rig();
    await r.outbox.append(scopeForAccount(B), envelope(B.id, 'evt_pg_b', 2_000));
    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_pg_a', 1_000));

    const pending = await r.store.listPending(10);
    // Two tenants, one read. This is the query that returns nothing on the runtime pool, and it
    // is why the relay needs a role rather than a policy exception.
    assert.deepEqual(
      pending.map((e) => e.eventId),
      ['evt_pg_a', 'evt_pg_b'],
    );
  });

  it('moves the watermark exactly once under a concurrent relay', async () => {
    const r = await rig();
    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_pg_race', 1_000));

    // Two relays racing on the same row. `relayed_at IS NULL` in the UPDATE is the arbiter, so
    // exactly one must win — anything else is a double delivery nobody can detect afterwards.
    const [first, second] = await Promise.all([
      r.store.markRelayed(asId<DomainEventId>('evt_pg_race'), clock.now()),
      r.store.markRelayed(asId<DomainEventId>('evt_pg_race'), clock.now()),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1, 'exactly one relay won');
  });

  it('delivers, marks and does not redeliver across rounds', async () => {
    const r = await rig();
    const target = createSimulatedRelayTarget(r.logger);
    const relay = createOutboxRelay({ store: r.store, target, clock, logger: r.logger });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_pg_x', 1_000));
    await r.outbox.append(scopeForAccount(B), envelope(B.id, 'evt_pg_y', 2_000));

    const first = await relay.relayOnce();
    assert.deepEqual([...first.delivered], ['evt_pg_x', 'evt_pg_y']);

    const second = await relay.relayOnce();
    assert.deepEqual([...second.delivered], []);
    assert.equal(target.delivered().length, 2, 'each event was handed over exactly once');
    assert.equal((await r.store.backlog()).pending, 0);
  });

  it('leaves a failed delivery pending, and relays it on a later round', async () => {
    const r = await rig();
    let fail = true;
    const flaky: RelayTarget = {
      id: 'flaky',
      deliver: () =>
        fail ? Promise.reject(new TransientError('DOWN', 'consumer offline')) : Promise.resolve(),
    };
    const relay = createOutboxRelay({ store: r.store, target: flaky, clock, logger: r.logger });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_pg_retry', 1_000));

    const failed = await relay.relayOnce();
    assert.deepEqual([...failed.deferred], ['evt_pg_retry']);
    // Unmoved in the database, not merely unmoved in memory. Delivery precedes the watermark, so
    // a crash costs a duplicate rather than the event.
    const stillPending = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ relayed_at: Date | null }>(
        'SELECT relayed_at FROM domain_event_outbox WHERE id = $1',
        ['evt_pg_retry'],
      );
      return result.rows[0]!.relayed_at;
    });
    assert.equal(stillPending, null);

    fail = false;
    assert.deepEqual([...(await relay.relayOnce()).delivered], ['evt_pg_retry']);
  });

  it('reports a backlog an operator can act on', async () => {
    const r = await rig();
    assert.deepEqual(await r.store.backlog(), { pending: 0, oldestAt: null });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_pg_l2', 2_000));
    await r.outbox.append(scopeForAccount(B), envelope(B.id, 'evt_pg_l1', 1_000));

    const backlog = await r.store.backlog();
    assert.equal(backlog.pending, 2);
    assert.equal(backlog.oldestAt?.getTime(), 1_000);
  });

  describe('the app_relay role is as narrow as it claims', () => {
    let relayClient: pg.Client;

    before(async () => {
      await rig();
      // A direct connection as the relay login role. Going through the adapter would only prove
      // the adapter is careful; the point is what the *role* can do with a hand-written query.
      relayClient = new pg.Client({ connectionString: cluster.relayUrl });
      await relayClient.connect();
    });

    after(async () => {
      await relayClient.end();
    });

    it('is not a superuser and does not bypass RLS', async () => {
      const result = await relayClient.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      assert.equal(result.rows[0]?.rolsuper, false);
      assert.equal(result.rows[0]?.rolbypassrls, false);
      // Cross-tenant visibility comes from a policy scoped TO app_relay, not from a role
      // attribute — which is what keeps the reach bounded by the grants below.
      const member = await relayClient.query<{ ok: boolean }>(
        "SELECT pg_has_role(current_user, 'app_relay', 'member') AS ok",
      );
      assert.equal(member.rows[0]?.ok, true);
    });

    it('can read the outbox and set relayed_at', async () => {
      const readable = await relayClient.query('SELECT id, type, data FROM domain_event_outbox');
      assert.ok(readable.rowCount !== null);
      await relayClient.query('UPDATE domain_event_outbox SET relayed_at = now() WHERE false');
    });

    it('cannot rewrite an event on its way out of the platform', async () => {
      // Column-level UPDATE, not table-level. A relay bug must not be able to change what a
      // consumer receives — the delivery watermark is the only thing it may write.
      for (const column of ['data', 'type', 'account_id', 'subject_id']) {
        await assert.rejects(
          () => relayClient.query(`UPDATE domain_event_outbox SET ${column} = NULL WHERE false`),
          (error: unknown) => (error as { code?: string }).code === '42501',
          `app_relay must not be able to write ${column}`,
        );
      }
    });

    it('cannot insert or delete an event', async () => {
      await assert.rejects(
        () =>
          relayClient.query(
            `INSERT INTO domain_event_outbox (id, account_id, type, version, subject_type,
               subject_id, data, trace_id, occurred_at)
             VALUES ('x','y','z',1,'a','b','{}'::jsonb,'t',now())`,
          ),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
      await assert.rejects(
        () => relayClient.query('DELETE FROM domain_event_outbox WHERE false'),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
    });

    it('is granted nothing outside the outbox', async () => {
      // The blast-radius assertion. `app_worker` gets the same treatment in the security suite;
      // a role whose limits are untested is a role whose limits are aspirational.
      for (const table of [
        'conversations',
        'messages',
        'raw_inbound_events',
        'knowledge_entries',
        'jobs',
        'dead_letters',
        'audit_events',
        'channel_connections',
      ]) {
        await assert.rejects(
          () => relayClient.query(`SELECT 1 FROM ${table} LIMIT 1`),
          (error: unknown) => (error as { code?: string }).code === '42501',
          `app_relay must not be able to read ${table}`,
        );
      }
    });

    it('cannot call the inbound-backlog function it was never granted', async () => {
      await assert.rejects(
        () => relayClient.query('SELECT * FROM app_inbound_backlog()'),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
    });
  });
});
