import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  META_SIGNATURE_HEADER,
  computeMetaSignature,
} from '../../src/integrations/meta/signature.ts';
import { createApplication } from '../../src/runtime/application.ts';
import type { Application } from '../../src/runtime/application.ts';
import { createTestClock } from '../../src/platform/clock.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { createMockLlmProvider } from '../../src/integrations/llm/mock-provider.ts';
import { createMemorySecretResolver } from '../../src/adapters/memory/repositories.ts';
import { createPostgresPersistence } from '../../src/adapters/postgres/index.ts';
import type { PostgresPersistence } from '../../src/adapters/postgres/index.ts';
import { createHarnessOver } from '../support/harness.ts';
import type { HarnessOver, SeededAccount } from '../support/harness.ts';
import {
  TEST_APP_SECRET,
  TEST_CONFIG,
  TEST_SECRETS,
  metaMessageEnvelope,
} from '../support/harness.ts';
import { createInstanceIdFactory } from '../support/postgres-harness.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import {
  acquirePostgres,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';
import { httpRequest, jsonBody } from '../support/http-client.ts';

/**
 * The webhook path end to end: a real socket, a real application, a real database.
 *
 * The in-memory HTTP suite proves the *contract*. This one proves the parts only a database can
 * decide — that the ledger's unique index, not a Map lookup, is what makes a duplicate delivery
 * idempotent, and that the ingest transaction really is one transaction when it spans a real
 * `INSERT` and a real `enqueue` on the runtime pool.
 *
 * The application is assembled here rather than through the shared harness because the harness
 * builds a container directly; the point of this file is to run the thing that ships.
 */

const available = postgresAvailable();

describe('postgres http ingest', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let persistence: PostgresPersistence;
  let app: Application;
  let h: HarnessOver<Application['container']>;
  let base: { port: number; host: string };
  let seeded: SeededAccount;

  before(async () => {
    cluster = await acquirePostgres();
    await truncateAll(cluster.adminUrl);

    const clock = createTestClock();
    const ids = createInstanceIdFactory('http');
    const { logger, records } = createMemoryLogger('debug');
    const provider = createMockLlmProvider({ clock });

    persistence = createPostgresPersistence({
      runtimeConnectionString: cluster.runtimeUrl,
      workerConnectionString: cluster.workerUrl,
      relayConnectionString: cluster.relayUrl,
      ids,
      logger,
      secrets: createMemorySecretResolver(TEST_SECRETS),
      pool: { maxConnections: 6, applicationName: 'moderation-test-http' },
    });

    app = createApplication({
      persistence,
      // `web` only: the fast-acknowledgement assertions must not race a worker.
      config: { ...TEST_CONFIG, role: 'web', ingest: { maxBodyBytes: 4_096 } },
      clock,
      ids,
      logger,
      provider,
    });
    const started = await app.start();
    base = started.http!;
    h = createHarnessOver(app.container, clock, provider, records);
    seeded = await h.seedAccount({ webhookId: 'pg-hook-1', pageId: 'pg-page-1' });
  });

  after(async () => {
    await app.stop('test');
    await persistence.close();
    await releasePostgres();
  });

  const url = `/webhooks/meta/pg-hook-1`;

  const post = (body: string, signature?: string) =>
    httpRequest(base, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [META_SIGNATURE_HEADER]: signature ?? computeMetaSignature(body, TEST_APP_SECRET),
      },
      body,
    });

  const envelope = (mid: string): string =>
    JSON.stringify(
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-pg', mid, text: 'hello' },
      ]),
    );

  it('persists a signed delivery and its job in one committed transaction', async () => {
    const response = await post(envelope('m_pg_1'));
    assert.equal(response.status, 200);
    assert.equal(jsonBody(response)['status'], 'ACCEPTED');

    // Read back through the superuser, which sees what RLS would hide — so this asserts the row
    // exists, not that a scoped query is well written.
    const rows = await withAdminClient(cluster.adminUrl, async (client) => {
      const events = await client.query<{ id: string; state: string; signature_valid: boolean }>(
        `SELECT id, state, signature_valid FROM raw_inbound_events
          WHERE payload::text LIKE '%m_pg_1%'`,
      );
      const jobs = await client.query<{
        id: string;
        state: string;
        payload: { rawEventId: string };
      }>(`SELECT id, state, payload FROM jobs WHERE type = 'raw_event.normalize'`);
      return { events: events.rows, jobs: jobs.rows };
    });

    assert.equal(rows.events.length, 1);
    assert.equal(rows.events[0]!.signature_valid, true);
    assert.equal(rows.events[0]!.state, 'RECEIVED');
    // ADR-004's central claim, observed: the ledger row and the promise to process it are both
    // committed by the time the acknowledgement is written.
    assert.equal(rows.jobs.length, 1);
    assert.equal(rows.jobs[0]!.payload.rawEventId, rows.events[0]!.id);
    assert.equal(rows.jobs[0]!.state, 'READY');
  });

  it('is idempotent across duplicate deliveries, arbitrated by the unique index', async () => {
    const body = envelope('m_pg_dupe');
    const responses = await Promise.all([post(body), post(body), post(body)]);

    // Concurrent, not sequential. A read-then-write dedupe passes the sequential version of this
    // test and loses the concurrent one — the unique index is the arbiter (F-01).
    for (const response of responses) assert.equal(response.status, 200);
    const statuses = responses.map((r) => jsonBody(r)['status']).sort();
    assert.deepEqual(statuses, ['ACCEPTED', 'DUPLICATE', 'DUPLICATE']);

    const counts = await withAdminClient(cluster.adminUrl, async (client) => {
      const events = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM raw_inbound_events WHERE payload::text LIKE '%m_pg_dupe%'`,
      );
      const jobs = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM jobs j
          WHERE j.payload->>'rawEventId' IN (
            SELECT id FROM raw_inbound_events WHERE payload::text LIKE '%m_pg_dupe%')`,
      );
      return { events: Number(events.rows[0]!.n), jobs: Number(jobs.rows[0]!.n) };
    });
    assert.equal(counts.events, 1, 'one ledger row for three concurrent deliveries');
    assert.equal(counts.jobs, 1, 'one job for three concurrent deliveries');
  });

  it('acknowledges before any work has been done', async () => {
    const response = await post(envelope('m_pg_fast'));
    assert.equal(response.status, 200);

    const state = await withAdminClient(cluster.adminUrl, async (client) => {
      const event = await client.query<{ state: string; normalized_at: Date | null }>(
        `SELECT state, normalized_at FROM raw_inbound_events WHERE payload::text LIKE '%m_pg_fast%'`,
      );
      const conversations = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM conversations',
      );
      return { event: event.rows[0]!, conversations: Number(conversations.rows[0]!.n) };
    });

    assert.equal(state.event.state, 'RECEIVED');
    assert.equal(state.event.normalized_at, null);
    assert.equal(state.conversations, 0, 'nothing interpretive ran on the request path');
    assert.ok(response.durationMs < 2_000, `ack took ${String(response.durationMs)}ms`);
  });

  it('stores an invalid signature without enqueueing work for it', async () => {
    const response = await post(envelope('m_pg_bad'), `sha256=${'1'.repeat(64)}`);
    assert.equal(response.status, 200);
    assert.equal(jsonBody(response)['status'], 'REJECTED_SIGNATURE');

    const row = await withAdminClient(cluster.adminUrl, async (client) => {
      const event = await client.query<{ id: string; state: string; signature_valid: boolean }>(
        `SELECT id, state, signature_valid FROM raw_inbound_events
          WHERE payload::text LIKE '%m_pg_bad%'`,
      );
      const jobs = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM jobs WHERE payload->>'rawEventId' = $1`,
        [event.rows[0]!.id],
      );
      return { event: event.rows[0]!, jobs: Number(jobs.rows[0]!.n) };
    });

    assert.equal(row.event.signature_valid, false);
    assert.equal(row.event.state, 'REJECTED');
    assert.equal(row.jobs, 0);
  });

  it('refuses an oversized body without writing anything', async () => {
    const before = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM raw_inbound_events',
      );
      return Number(result.rows[0]!.n);
    });

    const response = await post(`{"pad":"${'x'.repeat(9_000)}"}`);
    assert.equal(response.status, 413);

    const afterCount = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM raw_inbound_events',
      );
      return Number(result.rows[0]!.n);
    });
    assert.equal(afterCount, before, 'the cap runs before the database is touched');
  });

  it('a worker started afterwards picks the delivery up and completes the slice', async () => {
    const response = await post(envelope('m_pg_worked'));
    assert.equal(jsonBody(response)['status'], 'ACCEPTED');

    // The webhook and the work are decoupled: a worker that did not exist when the request was
    // acknowledged still finds the job, because the job is a row rather than a callback.
    await app.container.createWorker('pg-http-worker').drain();

    const done = await withAdminClient(cluster.adminUrl, async (client) => {
      const event = await client.query<{ state: string }>(
        `SELECT state FROM raw_inbound_events WHERE payload::text LIKE '%m_pg_worked%'`,
      );
      const messages = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM messages',
      );
      return { state: event.rows[0]!.state, messages: Number(messages.rows[0]!.n) };
    });
    assert.equal(done.state, 'NORMALIZED');
    assert.ok(done.messages >= 1, 'the delivery became a message');
  });
});
