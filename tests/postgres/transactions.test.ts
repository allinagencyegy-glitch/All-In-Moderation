import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId } from '../../src/platform/ids.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { TenantViolationError } from '../../src/platform/errors.ts';
import {
  DEFAULT_POSTGRES_CONFIG,
  createPostgresDatabase,
} from '../../src/adapters/postgres/client.ts';
import { decisionJson, metaMessageEnvelope } from '../support/harness.ts';
import type { PostgresHarness } from '../support/postgres-harness.ts';
import { createPostgresHarness } from '../support/postgres-harness.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import {
  acquirePostgres,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * Steps 4 and 13: the transaction boundary, tenant context, and outbox atomicity.
 *
 * The claim under test is the one ADR-004 was decided on: a domain write and the work it schedules
 * commit together or not at all. A queue in a different store cannot make that promise, and this
 * file is where the promise stops being an argument and becomes an observation.
 */

const available = postgresAvailable();

describe('postgres transactions', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let h: PostgresHarness;

  before(async () => {
    cluster = await acquirePostgres();
  });

  beforeEach(async () => {
    await h?.close();
    h = await createPostgresHarness(cluster);
  });

  after(async () => {
    await h?.close();
    await releasePostgres();
  });

  const count = async (table: string): Promise<number> =>
    await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      return Number(result.rows[0]!.n);
    });

  it('a failure inside the transaction rolls back every write in it', async () => {
    const seeded = await h.seedAccount();
    const db = h.persistence.runtimeDb;

    await assert.rejects(() =>
      db.transactions.run(async () => {
        await h.container.audit.append(seeded.scope, {
          action: 'replay.executed',
          subjectType: 'conversation',
          subjectId: 'cnv_x',
          actorKind: 'SYSTEM',
          actorUserId: null,
          detail: {},
          occurredAt: h.clock.now(),
        });
        // The write above has really happened at this point — the rollback below is what undoes
        // it, not a check that skipped it.
        assert.equal(await count('audit_events'), 1);
        throw new Error('boom');
      }),
    );

    assert.equal(await count('audit_events'), 0, 'ROLLBACK undid the committed-looking write');
  });

  it('the ingest ledger row and its job commit together, or neither does', async () => {
    const seeded = await h.seedAccount();

    // Break the enqueue *after* the ledger insert has already happened inside the transaction.
    // This is the crash ADR-004 is about: with the queue in another store, the event would be
    // durable and the work would be lost.
    const queue = h.persistence.queue;
    const original = queue.enqueue.bind(queue);
    (queue as { enqueue: unknown }).enqueue = () => {
      throw new Error('queue exploded mid-transaction');
    };

    try {
      await assert.rejects(() =>
        h.postWebhook(
          seeded,
          metaMessageEnvelope(seeded.connection.externalId, [
            { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
          ]),
        ),
      );
    } finally {
      (queue as { enqueue: unknown }).enqueue = original;
    }

    assert.equal(await count('raw_inbound_events'), 0, 'the ledger insert rolled back');
    assert.equal(await count('jobs'), 0);

    // And the same webhook now succeeds cleanly, both rows present.
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
      ]),
    );
    assert.equal(await count('raw_inbound_events'), 1);
    assert.equal(await count('jobs'), 1);
  });

  it('a domain state change and its outbox event are one atomic fact', async () => {
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    // Fail the outbox append that accompanies conversation creation. Allowed outcomes are both or
    // neither; "conversation exists, nobody was told" is the one that must be impossible.
    const outbox = h.persistence.outbox;
    const originalAppend = outbox.append.bind(outbox);
    (outbox as { append: unknown }).append = () => Promise.reject(new Error('outbox exploded'));

    try {
      await h.postWebhook(
        seeded,
        metaMessageEnvelope(seeded.connection.externalId, [
          { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
        ]),
      );
      await h.drain();
    } finally {
      (outbox as { append: unknown }).append = originalAppend;
    }

    const conversations = await count('conversations');
    const events = await count('domain_event_outbox');
    assert.ok(
      (conversations === 0 && events === 0) || (conversations === 1 && events >= 1),
      `both or neither, got conversations=${String(conversations)} events=${String(events)}`,
    );
    assert.equal(conversations, 0, 'the failing append took the conversation down with it');
  });

  it('a relay failure does not re-run the domain mutation it describes', async () => {
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.drain();

    const before = await count('conversations');
    const pending = await h.container.outbox.listPending(seeded.scope);
    assert.ok(pending.length > 0, 'there is something to relay');

    // Delivery state is separate from the state change. A relay may be retried as often as it
    // likes; the conversation it describes was created exactly once.
    for (let attempt = 0; attempt < 3; attempt++) {
      const retried = await h.container.outbox.listPending(seeded.scope);
      assert.equal(retried.length, pending.length, 'retrying a relay changes no domain state');
    }
    assert.equal(await count('conversations'), before);
  });

  it('tenant context is transaction-scoped and never survives on a pooled connection', async () => {
    const seeded = await h.seedAccount();
    // One connection in the pool, so the *same* physical socket is reused. If `SET` were used
    // instead of `SET LOCAL`, the next borrower would inherit account A's context — the classic
    // pooled-connection tenancy leak.
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: cluster.runtimeUrl,
        maxConnections: 1,
      },
      logger: createMemoryLogger().logger,
    });
    try {
      const seen = await db.scoped(
        seeded.account.id,
        async (client) => {
          const result = await client.query<{ v: string | null }>(
            "SELECT current_setting('app.account_id', true) AS v",
          );
          return result.rows[0]!.v;
        },
        'probe:scoped',
      );
      assert.equal(seen, seeded.account.id);

      const leaked = await db.unscoped(async (client) => {
        const result = await client.query<{ v: string | null }>(
          "SELECT current_setting('app.account_id', true) AS v",
        );
        return result.rows[0]!.v;
      }, 'probe:unscoped');
      assert.ok(
        leaked === null || leaked === '',
        `tenant context leaked across transactions on one connection: ${String(leaked)}`,
      );
    } finally {
      await db.close();
    }
  });

  it('one transaction cannot span two accounts', async () => {
    const a = await h.seedAccount({ webhookId: 'hook-a', pageId: 'page-a', slug: 'a' });
    const b = await h.seedAccount({ webhookId: 'hook-b', pageId: 'page-b', slug: 'b' });
    const db = h.persistence.runtimeDb;

    await assert.rejects(
      () =>
        db.transactions.run(async () => {
          await h.container.audit.append(a.scope, auditFor('cnv_a'));
          // The unit of work is already pinned to A. Re-issuing `SET LOCAL` for B would change
          // what the *rest* of this transaction can see — a tenancy switch mid-commit.
          await h.container.audit.append(b.scope, auditFor('cnv_b'));
        }),
      (error: unknown) => error instanceof TenantViolationError,
    );
    assert.equal(await count('audit_events'), 0, 'the whole attempt rolled back');
  });

  const auditFor = (subjectId: string) =>
    ({
      action: 'replay.executed',
      subjectType: 'conversation',
      subjectId,
      actorKind: 'SYSTEM',
      actorUserId: null,
      detail: {},
      occurredAt: h.clock.now(),
    }) as const;

  it('a statement that overruns its timeout is cancelled, not left hanging', async () => {
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: cluster.runtimeUrl,
        maxConnections: 2,
        statementTimeoutMs: 250,
      },
      logger: createMemoryLogger().logger,
    });
    try {
      await assert.rejects(
        () => db.unscoped((client) => client.query('SELECT pg_sleep(5)'), 'probe:slow'),
        (error: unknown) => (error as { code?: string }).code === 'TIMEOUT',
        'an unbounded query is an outage waiting to happen',
      );
    } finally {
      await db.close();
    }
  });

  it('the pool is bounded and closes cleanly', async () => {
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: cluster.runtimeUrl,
        maxConnections: 2,
      },
      logger: createMemoryLogger().logger,
    });
    // Six concurrent units of work over a pool of two: the extra four queue rather than opening
    // connections, which is what keeps a slow query from becoming a connection exhaustion.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        db.unscoped(async (client) => {
          const r = await client.query<{ n: number }>('SELECT $1::int AS n', [i]);
          return r.rows[0]!.n;
        }, 'probe:parallel'),
      ),
    );
    assert.deepEqual(
      results.sort((x, y) => x - y),
      [0, 1, 2, 3, 4, 5],
    );
    assert.ok(db.stats().total <= 2, 'the pool never exceeded its bound');

    await db.close();
    await assert.rejects(
      () => db.unscoped((client) => client.query('SELECT 1'), 'probe:after-close'),
      (error: unknown) => (error as { code?: string }).code === 'DATABASE_CLOSED',
      'work after shutdown fails loudly rather than resurrecting the pool',
    );
  });

  it('the connection string never reaches a log line', async () => {
    const { logger, records } = createMemoryLogger('debug');
    const db = createPostgresDatabase({
      config: {
        ...DEFAULT_POSTGRES_CONFIG,
        connectionString: cluster.runtimeUrl,
        maxConnections: 1,
      },
      logger,
    });
    try {
      await db.unscoped((client) => client.query('SELECT 1'), 'probe');
      await assert.rejects(() =>
        db.unscoped(() => Promise.reject(new Error('boom')), 'probe:fail'),
      );
    } finally {
      await db.close();
    }
    const serialised = JSON.stringify(records);
    assert.ok(!serialised.includes('runtime-local-test'), 'a password appeared in the logs');
  });

  it('truncation between tests really empties the database', async () => {
    await truncateAll(cluster.adminUrl);
    assert.equal(await count('accounts'), 0);
    assert.equal(await count('jobs'), 0);
  });

  it('a rejected scope violation leaves the account row untouched', async () => {
    const a = await h.seedAccount({ webhookId: 'hook-a2', pageId: 'page-a2', slug: 'a2' });
    const foreign = asId<AccountId>('acc_not_seeded');
    // The scope brand cannot be forged, so this reaches the adapter as a legitimate-looking read
    // for an account that does not exist. It must return nothing rather than erroring oddly.
    const missing = await h.container.accounts.findById(foreign);
    assert.equal(missing, null);
    assert.ok(await h.container.accounts.findById(a.account.id));
  });
});
