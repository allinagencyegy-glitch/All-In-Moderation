import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, decisionJson, metaMessageEnvelope } from '../support/harness.ts';
import { TransientError } from '../../src/platform/errors.ts';
import { asId } from '../../src/platform/ids.ts';
import type { TraceId } from '../../src/platform/ids.ts';

/**
 * Durability: the properties that make "zero silent failure" structural rather than aspirational
 * (F-10, F-11, F-20, ADR-004, ADR-006).
 */
describe('durability and crash recovery', () => {
  it('ingest is atomic: a failure between persisting and enqueueing rolls both back', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();

    // Break the enqueue, which happens *after* the ledger insert inside the same transaction.
    // Without a shared transaction this is exactly the dual-write that loses events silently.
    const realEnqueue = h.container.queue.enqueue.bind(h.container.queue);
    h.container.queue.enqueue = () =>
      Promise.reject(new TransientError('QUEUE_DOWN', 'simulated queue failure'));

    await assert.rejects(
      () =>
        h.postWebhook(
          seeded,
          metaMessageEnvelope(seeded.connection.externalId, [
            { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
          ]),
        ),
      /simulated queue failure/,
    );

    // Neither side committed: no orphan ledger row that nothing will ever process.
    assert.equal(h.container.db.tables.rawEvents.size, 0, 'the ledger insert rolled back');
    assert.equal(h.container.db.tables.jobs.size, 0);

    // The provider retries; once the queue recovers, the event lands normally.
    h.container.queue.enqueue = realEnqueue;
    const retry = await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    assert.equal(retry.status, 'ACCEPTED');
    assert.equal(h.container.db.tables.rawEvents.size, 1);
    assert.equal(h.container.db.tables.jobs.size, 1);
  });

  it('a moderator run commits atomically: decision, outbound and watermark move together', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['hello'] });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({ replyText: 'Hi.', knowledgeRefs: [knowledge.id] }),
    });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.drainTypes(['raw_event.normalize']);
    h.clock.advanceMs(3_000);

    // Fail the very last write in the commit block.
    const realSave = h.container.runs.save.bind(h.container.runs);
    let calls = 0;
    h.container.runs.save = (scope, run) => {
      calls += 1;
      // The first save is the RUNNING record before the model call; fail the terminal one.
      if (calls > 1 && run.state === 'COMPLETED') {
        return Promise.reject(new TransientError('DB_DOWN', 'simulated write failure'));
      }
      return realSave(scope, run);
    };

    await h.drain();

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    assert.equal(
      conversation.lastProcessedInboundSeq,
      0,
      'the watermark must not advance when the commit failed',
    );
    assert.equal(h.container.db.tables.outbound.size, 0, 'no half-committed outbound action');

    // The job is retryable, so the customer still gets an answer.
    const job = [...h.container.db.tables.jobs.values()].find((j) => j.type === 'moderator.run')!;
    assert.equal(job.state, 'READY');
  });

  it('F-11: an expired lease is reclaimed and the redelivered job is a safe no-op', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['hello'] });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({ replyText: 'Hi.', knowledgeRefs: [knowledge.id] }),
    });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );

    // Claim the normalize job and then "crash" — never complete it.
    const claimed = await h.container.queue.claim({
      workerId: 'crashy',
      leaseMs: 1_000,
      now: h.clock.now(),
    });
    assert.ok(claimed);
    assert.equal(claimed.state, 'RUNNING');

    // While the lease is live the partition is blocked.
    assert.equal(
      await h.container.queue.claim({ workerId: 'w2', leaseMs: 1_000, now: h.clock.now() }),
      null,
    );

    h.clock.advanceMs(2_000);
    const reclaimed = await h.container.queue.reapExpiredLeases(h.clock.now());
    assert.deepEqual(reclaimed, [claimed.id]);

    const after = await h.container.queue.findById(claimed.id);
    assert.equal(after!.state, 'READY');
    assert.equal(after!.attempt, 1, 'the attempt count survives, so retries stay bounded');

    // Redelivery completes normally, exactly once.
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();
    assert.equal(h.container.db.tables.messages.size, 1);
    assert.equal(h.container.db.tables.outbound.size, 1);
  });

  it('normalisation is idempotent, so redelivering the same job changes nothing', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.drainTypes(['raw_event.normalize']);

    const rawEvent = [...h.container.db.tables.rawEvents.values()][0]!;
    assert.equal(rawEvent.state, 'NORMALIZED');
    const before = h.container.db.tables.messages.size;

    // Run the handler again by hand, as an at-least-once queue eventually will.
    await h.container.normalize.normalize(rawEvent.id, seeded.scope);
    await h.container.normalize.normalize(rawEvent.id, seeded.scope);

    assert.equal(h.container.db.tables.messages.size, before, 'no duplicate messages');
    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    assert.equal(conversation.lastInboundSeq, 1);
    assert.equal(conversation.nextSeq, 2, 'sequence allocation is not consumed by a redelivery');
  });

  it('a lease that expires with no attempts left is recorded and escalated, not silently buried', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.drainTypes(['raw_event.normalize']);
    h.clock.advanceMs(3_000);

    const conversation = [...h.container.db.tables.conversations.values()][0]!;

    // A worker claims the moderator run on its final permitted attempt, then dies. Nothing calls
    // `fail`; only the lease lapses. This is the crash path, not the failure path.
    const moderatorJob = [...h.container.db.tables.jobs.values()].find(
      (job) => job.type === 'moderator.run' && job.state === 'READY',
    );
    assert.ok(moderatorJob);
    h.container.db.tables.jobs.set(moderatorJob.id, { ...moderatorJob, maxAttempts: 1 });

    const claimed = await h.container.queue.claim({
      workerId: 'crashy',
      leaseMs: 1_000,
      now: h.clock.now(),
    });
    assert.ok(claimed);
    assert.equal(claimed.attempt, 1, 'the claim consumed the only attempt');

    assert.equal(await h.container.deadLetters.count(), 0);
    assert.equal(h.container.db.tables.handoffs.size, 0);

    h.clock.advanceMs(2_000);
    const outcome = await h.container.reaper.reap();

    assert.deepEqual(outcome.deadLettered, [claimed.id]);
    assert.deepEqual(outcome.requeued, []);
    assert.equal(
      (await h.container.queue.findById(claimed.id))!.state,
      'DEAD_LETTERED',
      'no attempts left, so it must not loop',
    );

    // The two things a dead letter must never skip.
    assert.equal(await h.container.deadLetters.count(), 1, 'the operator can see it');
    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(handoffs.length, 1, 'a human was asked to take the conversation');
    assert.equal(handoffs[0]!.reasonCode, 'AI_UNAVAILABLE');

    const reopened = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(reopened!.ownership, 'PENDING_HUMAN');
  });

  it('a lease that expires with attempts left is requeued, not dead-lettered', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );

    const claimed = await h.container.queue.claim({
      workerId: 'crashy',
      leaseMs: 1_000,
      now: h.clock.now(),
    });
    assert.ok(claimed);

    h.clock.advanceMs(2_000);
    const outcome = await h.container.reaper.reap();

    assert.deepEqual(outcome.requeued, [claimed.id]);
    assert.deepEqual(outcome.deadLettered, []);
    assert.equal(
      await h.container.deadLetters.count(),
      0,
      'a recoverable crash is not a dead letter',
    );
    assert.equal((await h.container.queue.findById(claimed.id))!.state, 'READY');
  });

  it('the reaper does not stack handoffs when it runs repeatedly', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.drainTypes(['raw_event.normalize']);
    h.clock.advanceMs(3_000);

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const moderatorJob = [...h.container.db.tables.jobs.values()].find(
      (job) => job.type === 'moderator.run' && job.state === 'READY',
    );
    assert.ok(moderatorJob);
    h.container.db.tables.jobs.set(moderatorJob.id, { ...moderatorJob, maxAttempts: 1 });

    await h.container.queue.claim({ workerId: 'crashy', leaseMs: 1_000, now: h.clock.now() });
    h.clock.advanceMs(2_000);

    await h.container.reaper.reap();
    const second = await h.container.reaper.reap();

    assert.deepEqual(second.deadLettered, [], 'a terminal job is not reaped twice');
    assert.equal(await h.container.deadLetters.count(), 1);
    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(handoffs.length, 1, 'escalation is idempotent');
  });

  it('a job type with no registered handler dead-letters instead of vanishing', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();

    await h.container.queue.enqueue({
      accountId: seeded.account.id,
      type: 'outbound.dispatch',
      partitionKey: 'acct:x:conv:y',
      payload: {},
      runAt: h.clock.now(),
      traceId: asId<TraceId>('trc_no_handler'),
    });

    await h.drain();

    const deadLetters = await h.container.deadLetters.list();
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0]!.error.code, 'NO_HANDLER');
    const job = [...h.container.db.tables.jobs.values()].find(
      (j) => j.type === 'outbound.dispatch',
    )!;
    assert.equal(job.state, 'DEAD_LETTERED');
  });
});
