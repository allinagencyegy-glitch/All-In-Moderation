import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  decisionJson,
  metaCommentEnvelope,
  metaMessageEnvelope,
} from '../support/harness.ts';

/**
 * `REQUIRE_APPROVAL` used to throw the reply away (ADR-011).
 *
 * The matrix said "a human must approve this", the gate refused the action, and the moderator fell
 * back to raising a handoff — which is safe, and which discards the one artefact the whole phase
 * exists to produce. An operator opening the queue saw "the AI wants a human to look at this" and
 * no draft, so there was nothing to approve, nothing to measure, and no evidence that could ever
 * justify granting more autonomy.
 *
 * These tests pin the corrected behaviour and, just as importantly, pin what did *not* change: a
 * suggestion is re-gated from scratch, and every other refusal still refuses.
 */
describe('REQUIRE_APPROVAL preserves the draft', () => {
  it('produces a suppressed suggestion carrying the reply and its evidence', async () => {
    const h = createHarness();
    // The seeded pack maps PUBLIC_COMMENT/PUBLIC_REPLY to REQUIRE_APPROVAL.
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, {
      title: 'Opening hours',
      body: 'Open Monday to Friday, 9am to 5pm.',
      tags: ['hours'],
      intentCodes: ['GENERAL_QUESTION'],
    });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'GENERAL_QUESTION',
        action: 'PUBLIC_REPLY',
        replyText: 'We are open Monday to Friday, 9am to 5pm.',
        knowledgeRefs: [knowledge.id],
        confidence: 0.84,
      }),
    });

    await h.postWebhook(
      seeded,
      metaCommentEnvelope(seeded.connection.externalId, {
        commentId: 'c_1',
        postId: 'p_1',
        fromId: 'u_1',
        text: 'what are your hours?',
      }),
    );
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const runs = await h.container.runs.listByConversation(seeded.scope, conversation.id);
    const run = runs[0]!;
    assert.equal(run.state, 'COMPLETED');
    assert.equal(run.decision?.policyOutcome, 'REQUIRES_APPROVAL');
    assert.equal(run.decision?.finalAction, 'PUBLIC_REPLY', 'the action is preserved, not swapped');

    const actions = await h.container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(actions.length, 1);
    const action = actions[0]!;

    assert.equal(action.deliveryMode, 'SUGGESTED');
    assert.equal(action.state, 'SUPPRESSED', 'a suggestion is never queued for dispatch');
    assert.equal(action.cancelledReason, 'AWAITING_HUMAN_APPROVAL');
    // The whole point: the drafted words survive.
    assert.equal(action.payload.text, 'We are open Monday to Friday, 9am to 5pm.');
    assert.equal(
      (await h.container.review.show(seeded.scope, action.id)).finalText,
      null,
      'nothing final until a person decides',
    );

    // Everything a reviewer needs, snapshotted at decision time.
    const review = action.payload.review!;
    assert.equal(review.intentCode, 'GENERAL_QUESTION');
    assert.equal(review.intentConfidence, 0.84);
    assert.equal(review.overallConfidence, 0.84);
    assert.equal(review.proposedAction, 'PUBLIC_REPLY');
    assert.equal(review.risk, 'HIGH', 'a public reply is the highest-risk surface');
    assert.deepEqual(review.knowledgeRefs, [knowledge.id]);
    assert.ok(review.policyReason.length > 0);
    assert.equal(review.packVersionId, seeded.packId);
    assert.ok(review.promptVersion.startsWith('moderator/'));
    assert.equal(review.moderatorRunId, run.id);
    assert.equal(review.inputWatermark, 1, 'the customer turn this draft answers');
  });

  it('leaves the conversation awaiting the moderator, not awaiting the customer', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['hours'] });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        action: 'PUBLIC_REPLY',
        replyText: 'We are open Monday to Friday.',
        knowledgeRefs: [knowledge.id],
      }),
    });

    await h.postWebhook(
      seeded,
      metaCommentEnvelope(seeded.connection.externalId, {
        commentId: 'c_2',
        postId: 'p_2',
        fromId: 'u_2',
        text: 'hours?',
      }),
    );
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    // Reporting AWAITING_CUSTOMER here would tell an operator the customer had been answered when
    // the reply is still sitting unread in a queue — the exact misreading this account is being
    // onboarded to fix.
    assert.equal(after!.engagement, 'AWAITING_MODERATOR');
    // The watermark still advances: the run did happen and must not be repeated.
    assert.equal(after!.lastProcessedInboundSeq, 1);
    assert.equal(after!.ownership, 'AI_OWNED');
  });

  it('re-gates the suggestion from scratch: an ungrounded draft is still refused', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();

    // A reply with no citation. The matrix would say REQUIRE_APPROVAL; grounding says no.
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        action: 'PUBLIC_REPLY',
        replyText: 'Yes, we are open all week!',
        knowledgeRefs: [],
      }),
    });

    await h.postWebhook(
      seeded,
      metaCommentEnvelope(seeded.connection.externalId, {
        commentId: 'c_3',
        postId: 'p_3',
        fromId: 'u_3',
        text: 'are you open?',
      }),
    );
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const actions = await h.container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    // Falls through to the handoff, exactly as before. Human review is a narrower gate outcome,
    // not a bypass of the grounding rules.
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.actionType, 'REQUEST_HUMAN_HANDOFF');
    assert.notEqual(actions[0]!.deliveryMode, 'SUGGESTED');
    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(handoffs.length, 1);
  });

  it('does not turn an ALLOWED action into a suggestion', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['hours'] });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        action: 'ANSWER_FROM_KNOWLEDGE',
        replyText: 'We are open Monday to Friday.',
        knowledgeRefs: [knowledge.id],
      }),
    });

    // DIRECT_MESSAGE/ANSWER_FROM_KNOWLEDGE is ALLOW in the seeded pack.
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-4', mid: 'm_4', text: 'what are your hours?' },
      ]),
    );
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const actions = await h.container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(actions[0]!.deliveryMode, 'SIMULATED');
    assert.equal(actions[0]!.state, 'SIMULATED');
    assert.equal(actions[0]!.payload.review, undefined, 'nothing to review: nobody was asked');
  });

  it('keeps SUGGESTED distinct from SIMULATED even though this deployment never sends', async () => {
    // The bug this pins: `createOutboundAction` used to collapse every mode to SIMULATED whenever
    // the runtime was simulating — and `OUTBOUND_MODE=LIVE` is refused at boot, so it always is.
    // The review queue would have been permanently, silently empty.
    const h = createHarness();
    assert.equal(h.container.config.outboundMode, 'SIMULATE');

    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['hours'] });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        action: 'PUBLIC_REPLY',
        replyText: 'We are open Monday to Friday.',
        knowledgeRefs: [knowledge.id],
      }),
    });

    await h.postWebhook(
      seeded,
      metaCommentEnvelope(seeded.connection.externalId, {
        commentId: 'c_5',
        postId: 'p_5',
        fromId: 'u_5',
        text: 'hours?',
      }),
    );
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const queue = await h.container.review.list(seeded.scope);
    assert.equal(queue.length, 1, 'the queue must not be empty on a deployment that simulates');
    assert.equal(queue[0]!.action.deliveryMode, 'SUGGESTED');
  });

  it('lists the queue oldest first, with the wait a reviewer needs to see', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['hours'] });

    for (const index of [1, 2]) {
      h.provider.script({
        kind: 'RESPOND',
        text: decisionJson({
          action: 'PUBLIC_REPLY',
          replyText: `Reply number ${String(index)}.`,
          knowledgeRefs: [knowledge.id],
        }),
      });
      await h.postWebhook(
        seeded,
        metaCommentEnvelope(seeded.connection.externalId, {
          commentId: `c_q${String(index)}`,
          postId: `p_q${String(index)}`,
          fromId: `u_q${String(index)}`,
          text: 'hours?',
        }),
      );
      await h.drain();
      h.clock.advanceMs(3_000);
      await h.drain();
      h.clock.advanceMs(3_600_000);
    }

    const queue = await h.container.review.list(seeded.scope);
    assert.equal(queue.length, 2);
    assert.deepEqual(
      queue.map((item) => item.action.payload.text),
      ['Reply number 1.', 'Reply number 2.'],
      'the oldest draft is the one a customer has been waiting on longest',
    );
    assert.ok(queue[0]!.pendingSince.getTime() < queue[1]!.pendingSince.getTime());
  });
});
