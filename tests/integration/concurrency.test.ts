import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, decisionJson, metaMessageEnvelope } from '../support/harness.ts';

describe('conversation serialisation and burst handling (ADR-005)', () => {
  it('F-04: a burst of three messages produces exactly one run and one reply', async () => {
    const h = createHarness({});
    const seeded = await h.seedAccount({ debounceMs: 2_500, maxDelayMs: 8_000 });
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['price', 'installment'] });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'PRICE_INQUIRY',
        replyText: 'Here is the price and the instalment options.',
        knowledgeRefs: [knowledge.id],
      }),
    });

    // Three webhooks arriving seconds apart — the scenario from the brief.
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'price?' },
      ]),
    );
    await h.drain();
    h.clock.advanceMs(800);

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_2', text: 'the small one' },
      ]),
    );
    await h.drain();
    h.clock.advanceMs(800);

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_3', text: 'installment please' },
      ]),
    );
    await h.drain();

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    assert.equal(conversation.lastInboundSeq, 3);

    // One coalesced moderator job, not three.
    const moderatorJobs = [...h.container.db.tables.jobs.values()].filter(
      (j) => j.type === 'moderator.run',
    );
    assert.equal(moderatorJobs.length, 1, 'the burst must coalesce onto a single job');

    h.clock.advanceMs(3_000);
    assert.equal(await h.drain(), 1);

    const runs = await h.container.runs.listByConversation(seeded.scope, conversation.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.state, 'COMPLETED');
    assert.equal(runs[0]!.inputWatermark, 3, 'one run must consider all three messages');

    const actions = await h.container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(actions.length, 1, 'three messages, one reply');
    assert.equal(h.provider.callCount(), 1);

    // And the model actually saw all three messages.
    const prompt = h.provider.calls[0]!.request.turns[0]!.content;
    assert.ok(prompt.includes('price?'));
    assert.ok(prompt.includes('the small one'));
    assert.ok(prompt.includes('installment please'));
  });

  it('F-21: debounce cannot starve a continuously typing customer', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount({ debounceMs: 2_500, maxDelayMs: 5_000 });
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    const start = h.clock.nowMs();
    // Only normalisation is drained inside the loop, so the moderator job stays queued and its
    // scheduled time can be observed. Draining everything would let it fire mid-loop.
    for (let i = 1; i <= 6; i++) {
      await h.postWebhook(
        seeded,
        metaMessageEnvelope(seeded.connection.externalId, [
          { senderId: 'psid-1', mid: `m_${i}`, text: `chunk ${i}` },
        ]),
      );
      await h.drainTypes(['raw_event.normalize']);
      h.clock.advanceMs(1_000);
    }

    const job = [...h.container.db.tables.jobs.values()].find((j) => j.type === 'moderator.run')!;
    // Without the ceiling, every new message would push run_at another 2.5s into the future and
    // the customer would never be answered.
    assert.equal(job.state, 'READY');
    assert.ok(
      job.runAt.getTime() <= start + 5_000,
      `run_at ${job.runAt.toISOString()} must be capped at first_enqueued_at + maxDelayMs`,
    );
    assert.ok(job.runAt.getTime() <= h.clock.nowMs(), 'the ceiling has already elapsed');
    assert.equal(await h.drain(), 1, 'the ceiling makes the run claimable');
  });

  it('F-12: two workers never process the same conversation concurrently', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.drain();
    h.clock.advanceMs(3_000);

    const now = h.clock.now();
    const first = await h.container.queue.claim({ workerId: 'w1', leaseMs: 30_000, now });
    const second = await h.container.queue.claim({ workerId: 'w2', leaseMs: 30_000, now });

    assert.ok(first, 'the first worker claims the job');
    assert.equal(second, null, 'the partition is exclusive: the second worker gets nothing');
  });

  it('different conversations run in parallel, including within one account', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
        { senderId: 'psid-2', mid: 'm_2', text: 'hi there' },
      ]),
    );
    await h.drain();
    h.clock.advanceMs(3_000);

    assert.equal(h.container.db.tables.conversations.size, 2);

    const now = h.clock.now();
    const first = await h.container.queue.claim({ workerId: 'w1', leaseMs: 30_000, now });
    const second = await h.container.queue.claim({ workerId: 'w2', leaseMs: 30_000, now });

    assert.ok(first, 'worker one claims a conversation');
    assert.ok(second, 'worker two claims the *other* conversation concurrently');
    assert.notEqual(first.partitionKey, second.partitionKey);
  });

  it('two simultaneous events for one conversation are ordered and answered once', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    // Both webhooks land before any processing happens — the "simultaneous arrival" case.
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'first' },
      ]),
    );
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_2', text: 'second' },
      ]),
    );

    assert.equal(h.container.db.tables.rawEvents.size, 2);
    // Both normalize jobs share a connection partition, so they cannot interleave.
    const normalizeJobs = [...h.container.db.tables.jobs.values()].filter(
      (j) => j.type === 'raw_event.normalize',
    );
    assert.equal(new Set(normalizeJobs.map((j) => j.partitionKey)).size, 1);

    await h.drain();
    const messages = [...h.container.db.tables.messages.values()].sort((a, b) => a.seq - b.seq);
    assert.deepEqual(
      messages.map((m) => m.text),
      ['first', 'second'],
      'sequence numbers must reflect arrival order',
    );
    assert.deepEqual(
      messages.map((m) => m.seq),
      [1, 2],
      'seq is gapless',
    );

    h.clock.advanceMs(3_000);
    await h.drain();
    assert.equal(h.container.db.tables.outbound.size, 1);
  });

  it('F-03: a late message still gets the next seq, so it can never fall below the watermark', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    const base = 1_767_225_600_000;
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        {
          senderId: 'psid-1',
          mid: 'm_late',
          text: 'sent second, arrived first',
          timestampMs: base + 5_000,
        },
      ]),
    );
    await h.drain();
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        {
          senderId: 'psid-1',
          mid: 'm_early',
          text: 'sent first, arrived second',
          timestampMs: base,
        },
      ]),
    );
    await h.drain();

    const messages = [...h.container.db.tables.messages.values()].sort((a, b) => a.seq - b.seq);
    assert.deepEqual(
      messages.map((m) => m.providerMessageId),
      ['m_late', 'm_early'],
    );

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    assert.equal(conversation.lastInboundSeq, 2, 'the out-of-order message is above the watermark');

    h.clock.advanceMs(3_000);
    await h.drain();

    // Presentation order follows provider time, so the model reads the customer's intended order.
    const prompt = h.provider.calls[0]!.request.turns[0]!.content;
    assert.ok(
      prompt.indexOf('sent first, arrived second') < prompt.indexOf('sent second, arrived first'),
      'the transcript must be rendered in provider-timestamp order',
    );
    // But processing consumed both.
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.lastProcessedInboundSeq, 2);
  });
});
