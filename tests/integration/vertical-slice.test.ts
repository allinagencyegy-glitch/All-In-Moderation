import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, decisionJson, metaMessageEnvelope } from '../support/harness.ts';

/**
 * The Phase 0 vertical slice, end to end:
 *
 *   simulated Meta-like webhook -> signature verified -> raw event persisted -> deduplicated
 *   -> normalised -> conversation created -> job enqueued -> processed under partition exclusivity
 *   -> mock LLM invoked -> structured output validated -> policy gate -> decision persisted
 *   -> outbound action record created (SIMULATED — nothing leaves the process)
 *
 * If this test passes, the architecture holds together. Nothing here touches a network.
 */
describe('vertical slice: webhook to outbound action record', () => {
  it('produces exactly one authorised, simulated outbound action', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, {
      title: 'Opening hours',
      body: 'Open Monday to Friday, 9am to 5pm.',
      tags: ['hours', 'open'],
      intentCodes: ['GENERAL_QUESTION'],
    });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'GENERAL_QUESTION',
        action: 'ANSWER_FROM_KNOWLEDGE',
        replyText: 'We are open Monday to Friday, 9am to 5pm.',
        knowledgeRefs: [knowledge.id],
      }),
    });

    const outcome = await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'what are your open hours?' },
      ]),
    );

    assert.equal(outcome.status, 'ACCEPTED');
    assert.equal(outcome.httpStatus, 200);

    // The raw event is durable *before* anything interprets it.
    const rawEvents = await h.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(rawEvents.length, 1);
    assert.equal(rawEvents[0]!.state, 'RECEIVED');
    assert.equal(rawEvents[0]!.signatureValid, true);
    // No model call has happened yet: ingest cannot reach the LLM.
    assert.equal(h.provider.callCount(), 0);

    // Normalisation.
    const normalized = await h.drain();
    assert.equal(normalized, 1, 'exactly the normalize job should be runnable before the debounce');

    const conversations = [...h.container.db.tables.conversations.values()];
    assert.equal(conversations.length, 1);
    const conversation = conversations[0]!;
    assert.equal(conversation.ownership, 'AI_OWNED');
    assert.equal(conversation.lastInboundSeq, 1);
    assert.equal(conversation.lastProcessedInboundSeq, 0, 'watermark must not move before a run');

    // The moderator run is debounced, so it is not yet claimable.
    assert.equal(await h.drain(), 0);

    h.clock.advanceMs(3_000);
    assert.equal(await h.drain(), 1);

    const runs = await h.container.runs.listByConversation(seeded.scope, conversation.id);
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.equal(run.state, 'COMPLETED');
    assert.equal(run.decision?.policyOutcome, 'ALLOWED');
    assert.equal(run.decision?.finalAction, 'ANSWER_FROM_KNOWLEDGE');
    // Reproducibility: the exact configuration that produced this decision is pinned to the run.
    assert.equal(run.packVersionId, seeded.packId);
    assert.ok(run.promptTemplateVersion.startsWith('moderator/'));
    assert.equal(run.llm?.provider, 'mock');

    const actions = await h.container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.actionType, 'ANSWER_FROM_KNOWLEDGE');
    assert.equal(actions[0]!.payload.text, 'We are open Monday to Friday, 9am to 5pm.');
    // Phase 0: nothing is dispatched anywhere.
    assert.equal(actions[0]!.deliveryMode, 'SIMULATED');
    assert.equal(actions[0]!.state, 'SIMULATED');
    assert.equal(actions[0]!.idempotencyKey, `${conversation.id}:${run.id}:0`);

    // The watermark advanced exactly once, in the same commit as the decision.
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.lastProcessedInboundSeq, 1);
    assert.equal(after!.engagement, 'AWAITING_CUSTOMER');

    // Business events were published to the outbox, not pushed anywhere synchronously.
    const events = await h.container.outbox.listAll(seeded.scope);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ['conversation.started', 'intent.detected']);

    // A second drain is a no-op: nothing re-runs, nothing re-sends.
    assert.equal(await h.drain(), 0);
    assert.equal(h.provider.callCount(), 1);
  });

  it('records a run as SKIPPED with a reason rather than doing nothing silently', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount({ withPack: false });

    h.provider.script({ kind: 'RESPOND', text: decisionJson() });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const runs = await h.container.runs.listByConversation(seeded.scope, conversation.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.state, 'SKIPPED');
    assert.equal(runs[0]!.skipReason, 'NO_ACTIVE_PACK');
    // The model was never consulted, and the customer's message is still unprocessed and safe.
    assert.equal(h.provider.callCount(), 0);
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.lastProcessedInboundSeq, 0);

    const audit = await h.container.audit.list(seeded.scope);
    assert.ok(audit.some((e) => e.action === 'moderator.run_skipped'));
  });
});
