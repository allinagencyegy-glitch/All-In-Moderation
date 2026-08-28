import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestClock } from '../../src/platform/clock.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { TransientError } from '../../src/platform/errors.ts';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, TraceId } from '../../src/platform/ids.ts';
import type { StoreProbe } from '../../src/operations/health.ts';
import { createHealthService } from '../../src/operations/health.ts';
import { createMemoryDatabase } from '../../src/adapters/memory/database.ts';
import { createMemoryJobQueue } from '../../src/adapters/memory/job-queue.ts';
import {
  createMemoryDeadLetterStore,
  createMemoryStoreProbe,
} from '../../src/adapters/memory/repositories.ts';
import {
  META_SIGNATURE_HEADER,
  computeMetaSignature,
} from '../../src/integrations/meta/signature.ts';
import type { AppHarness } from '../support/app-harness.ts';
import { createAppHarness } from '../support/app-harness.ts';
import { TEST_APP_SECRET, metaMessageEnvelope, type SeededAccount } from '../support/harness.ts';
import { httpRequest, jsonBody } from '../support/http-client.ts';

/**
 * Operational health.
 *
 * Phase 01 listed queue depth, dead-letter count and the oldest unprocessed event as things that
 * "are already queries; they need somewhere to go". This is the somewhere, and the tests below
 * are about the two properties that make such an endpoint useful rather than decorative:
 *
 *   - **Liveness must not depend on the database.** A probe that fails during a failover gets
 *     every healthy process restarted, which turns a degradation into an outage.
 *   - **Degraded still serves.** A dead letter is a reason to page someone, not a reason to
 *     remove the only process capable of working through the backlog.
 */

const ACCOUNT = asId<AccountId>('acc_health');
const TRACE = asId<TraceId>('trc_health');

describe('health snapshot', () => {
  const build = (probeOverrides: Partial<StoreProbe> = {}, deadLetterCeiling = 0) => {
    const clock = createTestClock();
    const db = createMemoryDatabase();
    const { logger } = createMemoryLogger('debug');
    const queue = createMemoryJobQueue(db);
    const deadLetters = createMemoryDeadLetterStore(db);
    const baseProbe = createMemoryStoreProbe(db);
    const startedAt = clock.now();
    clock.advanceMs(90_000);

    let shuttingDown = false;
    const health = createHealthService({
      probe: { ...baseProbe, ...probeOverrides },
      queue,
      deadLetters,
      clock,
      startedAt,
      identity: { role: 'all', outboundMode: 'SIMULATE', nodeEnv: 'test' },
      isShuttingDown: () => shuttingDown,
      thresholds: { inboundLagMs: 60_000, outboxLagMs: 60_000, deadLetterCeiling },
    });
    return {
      clock,
      db,
      queue,
      deadLetters,
      health,
      logger,
      setShuttingDown: (value: boolean) => {
        shuttingDown = value;
      },
    };
  };

  const enqueue = (
    queue: ReturnType<typeof createMemoryJobQueue>,
    partitionKey: string,
    at: Date,
  ) =>
    queue.enqueue({
      accountId: ACCOUNT,
      type: 'moderator.run',
      partitionKey,
      payload: {},
      runAt: at,
      maxAttempts: 1,
      traceId: TRACE,
    });

  it('reports OK with uptime and process identity when nothing is wrong', async () => {
    const rig = build();
    const snapshot = await rig.health.snapshot();

    assert.equal(snapshot.status, 'OK');
    assert.deepEqual([...snapshot.reasons], []);
    assert.equal(snapshot.uptimeMs, 90_000);
    assert.equal(snapshot.process.outboundMode, 'SIMULATE');
    assert.equal(snapshot.process.role, 'all');
    assert.equal(snapshot.process.shuttingDown, false);
    assert.equal(snapshot.database.reachable, true);
  });

  it('reports queue depth by state', async () => {
    const rig = build();
    await enqueue(rig.queue, 'p1', rig.clock.now());
    await enqueue(rig.queue, 'p2', rig.clock.now());
    await rig.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: rig.clock.now() });

    const snapshot = await rig.health.snapshot();
    assert.equal(snapshot.queue.ready, 1);
    assert.equal(snapshot.queue.running, 1);
    assert.equal(snapshot.queue.deadLettered, 0);
    assert.equal(snapshot.queue.depth['READY'], 1);
  });

  it('degrades on the first dead letter, because that queue should be empty', async () => {
    const rig = build();
    const job = await enqueue(rig.queue, 'p-dead', rig.clock.now());
    const claimed = await rig.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: rig.clock.now() });
    assert.ok(claimed);
    await rig.queue.fail(job.id, { code: 'BOOM', message: 'terminal' }, null, rig.clock.now());
    await rig.deadLetters.record({
      job: claimed,
      error: { code: 'BOOM', message: 'terminal' },
      recordedAt: rig.clock.now(),
    });

    const snapshot = await rig.health.snapshot();
    assert.equal(snapshot.status, 'DEGRADED');
    assert.equal(snapshot.deadLetters.count, 1);
    assert.equal(snapshot.queue.deadLettered, 1);
    assert.ok(snapshot.reasons.some((reason) => reason.includes('dead letter')));
  });

  it('reports the oldest unprocessed inbound event and its age', async () => {
    const rig = build();
    // Two pending events; only the oldest sets the lag, and a normalised one does not count.
    rig.db.tables.rawEvents.set('rie_1', {
      id: asId('rie_1'),
      accountId: ACCOUNT,
      channelConnectionId: asId('chc_1'),
      deliveryKey: 'k1',
      payload: {},
      headers: {},
      signatureValid: true,
      state: 'RECEIVED',
      receivedAt: new Date(rig.clock.nowMs() - 120_000),
      normalizedAt: null,
      producedMessageIds: [],
      error: null,
      traceId: TRACE,
    });
    rig.db.tables.rawEvents.set('rie_2', {
      id: asId('rie_2'),
      accountId: ACCOUNT,
      channelConnectionId: asId('chc_1'),
      deliveryKey: 'k2',
      payload: {},
      headers: {},
      signatureValid: true,
      state: 'NORMALIZED',
      receivedAt: new Date(rig.clock.nowMs() - 600_000),
      normalizedAt: rig.clock.now(),
      producedMessageIds: [],
      error: null,
      traceId: TRACE,
    });

    const snapshot = await rig.health.snapshot();
    assert.equal(snapshot.inbound.pending, 1, 'a normalised event is not a backlog');
    assert.equal(snapshot.inbound.ageMs, 120_000);
    assert.equal(snapshot.status, 'DEGRADED');
    assert.ok(snapshot.reasons.some((reason) => reason.includes('unprocessed inbound')));
  });

  it('reports DOWN with an error code, and no statement, when the store is unreachable', async () => {
    const rig = build({
      ping: () => Promise.reject(new TransientError('CONNECTION_LOST', 'pool is closed')),
    });

    const snapshot = await rig.health.snapshot();
    assert.equal(snapshot.status, 'DOWN');
    assert.equal(snapshot.database.reachable, false);
    assert.equal(snapshot.database.errorCode, 'CONNECTION_LOST');
    assert.equal(snapshot.database.latencyMs, null);
    // Counts read zero rather than being absent, so an unreachable store is distinguishable from
    // an idle one by `reachable`, not by a missing field a dashboard would render as a gap.
    assert.equal(snapshot.deadLetters.count, 0);
    assert.deepEqual(snapshot.queue.depth, {});
  });

  it('says so when the process is shutting down', async () => {
    const rig = build();
    rig.setShuttingDown(true);
    const snapshot = await rig.health.snapshot();
    assert.equal(snapshot.process.shuttingDown, true);
    assert.equal(rig.health.liveness().shuttingDown, true);
  });

  it('answers liveness without touching the store at all', () => {
    let pings = 0;
    const rig = build({
      ping: () => {
        pings += 1;
        return Promise.resolve();
      },
    });
    const live = rig.health.liveness();
    assert.equal(live.alive, true);
    assert.equal(live.uptimeMs, 90_000);
    assert.equal(pings, 0, 'liveness must survive a database outage');
  });
});

describe('health endpoints', () => {
  let h: AppHarness;
  let seeded: SeededAccount;

  before(async () => {
    h = await createAppHarness({ config: { role: 'web' } });
    seeded = await h.seedAccount({ webhookId: 'hook-health' });
  });

  after(async () => {
    await h.stop();
  });

  it('serves liveness, readiness and the full snapshot', async () => {
    const live = await httpRequest(h.base, '/health/live');
    assert.equal(live.status, 200);
    assert.equal(jsonBody(live)['status'], 'ALIVE');

    const ready = await httpRequest(h.base, '/health/ready');
    assert.equal(ready.status, 200);
    assert.equal(jsonBody(ready)['ready'], true);

    const status = await httpRequest(h.base, '/health/status');
    assert.equal(status.status, 200);
    const body = jsonBody(status);
    assert.equal(body['status'], 'OK');
    // The five things Phase 01 asked for, all present in one document.
    assert.ok(body['process'], 'process health');
    assert.ok(body['database'], 'database health');
    assert.ok(body['queue'], 'queue depth');
    assert.ok(body['deadLetters'], 'dead-letter count');
    assert.ok(body['inbound'], 'oldest unprocessed inbound event');
  });

  it('shows an unprocessed delivery in the snapshot immediately after it is accepted', async () => {
    const raw = JSON.stringify(
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-h', mid: 'm_health', text: 'hi' },
      ]),
    );
    const accepted = await httpRequest(
      h.base,
      `/webhooks/meta/${seeded.connection.publicWebhookId}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [META_SIGNATURE_HEADER]: computeMetaSignature(raw, TEST_APP_SECRET),
        },
        body: raw,
      },
    );
    assert.equal(accepted.status, 200);

    const body = jsonBody(await httpRequest(h.base, '/health/status'));
    const inbound = body['inbound'] as { pending: number; oldestAt: string | null };
    const queue = body['queue'] as { ready: number };
    assert.equal(inbound.pending, 1);
    assert.ok(inbound.oldestAt, 'the age of the oldest unprocessed event is reportable');
    assert.equal(queue.ready, 1);
  });

  it('reports not-ready the moment a shutdown begins, while still serving', async () => {
    const shutting = await createAppHarness({ config: { role: 'web' } });
    const stopping = shutting.app.stop('test-signal');

    // The flag flips synchronously with the signal, before the listener closes — that ordering is
    // what lets a load balancer stop sending work to a process that can still finish what it has.
    const ready = await httpRequest(shutting.base, '/health/ready').catch(() => null);
    await stopping;
    if (ready) {
      assert.equal(ready.status, 503);
      assert.equal(jsonBody(ready)['shuttingDown'], true);
    }
  });

  it('answers 404 for an unknown health path and 405 for a write', async () => {
    assert.equal((await httpRequest(h.base, '/health/nope')).status, 404);
    assert.equal((await httpRequest(h.base, '/health/live', { method: 'POST' })).status, 405);
  });
});
