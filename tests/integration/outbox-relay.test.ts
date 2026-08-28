import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestClock } from '../../src/platform/clock.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { TransientError } from '../../src/platform/errors.ts';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, DomainEventId, TraceId } from '../../src/platform/ids.ts';
import type { DomainEventEnvelope } from '../../src/operations/events/contracts.ts';
import type { RelayTarget } from '../../src/operations/events/relay.ts';
import {
  createOutboxRelay,
  createSimulatedRelayTarget,
} from '../../src/operations/events/relay.ts';
import { createMemoryDatabase } from '../../src/adapters/memory/database.ts';
import {
  createMemoryEventOutbox,
  createMemoryOutboxRelayStore,
} from '../../src/adapters/memory/repositories.ts';
import { scopeForAccount } from '../../src/core/account/index.ts';
import type { Account } from '../../src/core/account/index.ts';

/**
 * The outbox relay — the second of the two gaps Phase 01 named and refused to fake.
 *
 * Phase 01 proved the *write* half: an event and the state change it describes commit together,
 * or neither does. It could not prove the read half at all, because `markRelayed` had no way to
 * work under RLS and the Postgres adapter threw rather than silently succeed. This suite asserts
 * the behaviour; `tests/postgres/outbox-relay.test.ts` asserts that the same behaviour survives a
 * real database and a role granted one table and one column.
 *
 * What is *not* proven here, and is stated plainly in the handoff: the destination. There is no
 * authorised consumer in this phase, so the target is a simulated sink that reaches no network.
 * The mechanism is real; the far end is not.
 */

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

const A = account('acc_relay_a');
const B = account('acc_relay_b');

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
    subject: { type: 'conversation', id: 'cnv_1' },
    traceId: asId<TraceId>('trc_relay'),
    data: {
      conversation_id: 'cnv_1',
      channel: 'FACEBOOK',
      surface: 'DIRECT_MESSAGE',
      started_at: new Date(occurredAtMs).toISOString(),
    },
  };
}

function rig() {
  const db = createMemoryDatabase();
  const { logger, records } = createMemoryLogger('debug');
  return {
    db,
    logger,
    records,
    outbox: createMemoryEventOutbox(db),
    store: createMemoryOutboxRelayStore(db),
  };
}

describe('outbox relay', () => {
  it('delivers pending events oldest first and moves the watermark', async () => {
    const r = rig();
    const target = createSimulatedRelayTarget(r.logger);
    const relay = createOutboxRelay({ store: r.store, target, clock, logger: r.logger });

    // Appended out of order on purpose: ordering must come from `occurredAt`, not from insertion.
    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_2', 2_000));
    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_1', 1_000));
    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_3', 3_000));

    const outcome = await relay.relayOnce();

    assert.deepEqual([...outcome.delivered], ['evt_1', 'evt_2', 'evt_3']);
    assert.deepEqual(
      target.delivered().map((e) => e.eventId),
      ['evt_1', 'evt_2', 'evt_3'],
    );
    assert.deepEqual(await r.store.listPending(10), []);
  });

  it('relays each event exactly once across repeated rounds', async () => {
    const r = rig();
    const target = createSimulatedRelayTarget(r.logger);
    const relay = createOutboxRelay({ store: r.store, target, clock, logger: r.logger });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_once', 1_000));
    await relay.relayOnce();
    const second = await relay.relayOnce();
    const third = await relay.relayOnce();

    assert.equal(target.delivered().length, 1, 'a relayed event is never redelivered');
    assert.deepEqual([...second.delivered], []);
    assert.deepEqual([...third.delivered], []);
  });

  it('reports a lost race as already-relayed rather than as a failure', async () => {
    const r = rig();
    // A rival relay that wins the watermark *between* our read and our write — the only window
    // in which the race exists, and the reason `markRelayed` returns a boolean at all.
    const racing: RelayTarget = {
      id: 'racing',
      deliver: async (event) => {
        await r.store.markRelayed(event.eventId, clock.now());
      },
    };
    const relay = createOutboxRelay({ store: r.store, target: racing, clock, logger: r.logger });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_raced', 1_000));

    const outcome = await relay.relayOnce();
    assert.deepEqual([...outcome.delivered], [], 'we did not move the watermark');
    assert.deepEqual([...outcome.alreadyRelayed], ['evt_raced']);
    assert.deepEqual([...outcome.deferred], [], 'a lost race is not a failure');
    // And it is not relayed twice on the next round either.
    assert.deepEqual([...(await relay.relayOnce()).alreadyRelayed], []);
  });

  it('leaves a failed delivery pending and retries it on the next round', async () => {
    const r = rig();
    let attempts = 0;
    const flaky: RelayTarget = {
      id: 'flaky',
      deliver: () => {
        attempts += 1;
        if (attempts <= 2) return Promise.reject(new TransientError('DOWN', 'consumer offline'));
        return Promise.resolve();
      },
    };
    const relay = createOutboxRelay({ store: r.store, target: flaky, clock, logger: r.logger });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_retry', 1_000));

    const first = await relay.relayOnce();
    assert.deepEqual([...first.deferred], ['evt_retry']);
    // Still pending. Delivery happens before the watermark moves, so a failure cannot lose it.
    assert.equal((await r.store.backlog()).pending, 1);

    await relay.relayOnce();
    const third = await relay.relayOnce();
    assert.deepEqual([...third.delivered], ['evt_retry']);
    assert.equal((await r.store.backlog()).pending, 0);
  });

  it('halts one account behind a failure without stalling another', async () => {
    const r = rig();
    const delivered: string[] = [];
    const target: RelayTarget = {
      id: 'selective',
      deliver: (event) => {
        if (event.eventId === 'evt_a1') {
          return Promise.reject(new TransientError('DOWN', 'consumer offline'));
        }
        delivered.push(event.eventId);
        return Promise.resolve();
      },
    };
    const relay = createOutboxRelay({ store: r.store, target, clock, logger: r.logger });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_a1', 1_000));
    await r.outbox.append(scopeForAccount(B), envelope(B.id, 'evt_b1', 2_000));
    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_a2', 3_000));

    const outcome = await relay.relayOnce();

    // A's stream stops at the failure — a consumer must never see an effect before its cause.
    assert.deepEqual([...outcome.deferred].sort(), ['evt_a1', 'evt_a2']);
    // B is a different tenant with a different consumer and is unaffected.
    assert.deepEqual(delivered, ['evt_b1']);
    assert.deepEqual([...outcome.delivered], ['evt_b1']);
  });

  it('honours the batch size rather than reading the whole backlog', async () => {
    const r = rig();
    const target = createSimulatedRelayTarget(r.logger);
    const relay = createOutboxRelay({
      store: r.store,
      target,
      clock,
      logger: r.logger,
      batchSize: 2,
    });

    for (let i = 1; i <= 5; i++) {
      await r.outbox.append(scopeForAccount(A), envelope(A.id, `evt_b${String(i)}`, i * 1_000));
    }

    assert.equal((await relay.relayOnce()).delivered.length, 2);
    assert.equal((await relay.relayOnce()).delivered.length, 2);
    assert.equal((await relay.relayOnce()).delivered.length, 1);
    assert.equal((await r.store.backlog()).pending, 0);
  });

  it('reports the backlog age, which is the lag signal an operator watches', async () => {
    const r = rig();
    assert.deepEqual(await r.store.backlog(), { pending: 0, oldestAt: null });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_lag_2', 2_000));
    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_lag_1', 1_000));

    const backlog = await r.store.backlog();
    assert.equal(backlog.pending, 2);
    assert.equal(backlog.oldestAt?.getTime(), 1_000, 'the oldest, not the newest');
  });

  it('never writes customer-derived payload content into a log line', async () => {
    const r = rig();
    const target = createSimulatedRelayTarget(r.logger);
    const relay = createOutboxRelay({ store: r.store, target, clock, logger: r.logger });

    await r.outbox.append(scopeForAccount(A), envelope(A.id, 'evt_log', 1_000));
    await relay.relayOnce();

    const line = r.records.find((record) => record.message.includes('relayed (SIMULATED)'));
    assert.ok(line, 'the delivery was logged');
    assert.equal(line.fields['event_id'], 'evt_log');
    assert.equal(line.fields['data'], undefined, 'the envelope body never reaches a log field');
  });
});
