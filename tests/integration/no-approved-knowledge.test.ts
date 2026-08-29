import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { KnowledgeEntryId } from '../../src/platform/ids.ts';
import { LIVE_OUTBOUND_STATES } from '../../src/moderation/domain/outbound-action.ts';
import type { Harness } from '../support/harness.ts';
import { createHarness, decisionJson, metaCommentEnvelope } from '../support/harness.ts';

/**
 * The hard invariant, exercised against the shape of a real conversation:
 *
 *   NO APPROVED KNOWLEDGE = NO FACTUAL INVENTION.
 *
 * This is the finding the client account was onboarded on. Someone asked what a chair costs; the
 * price was never confirmed by the client and so is not approved knowledge; five days later nobody
 * had answered. The failure mode this phase must not introduce is the *other* one — answering
 * quickly with a number the model produced.
 *
 * "Ask a human" is the correct output here, and these tests assert it is what actually happens
 * across four different routes to the same wrong answer: no knowledge at all, expired commercial
 * knowledge, a draft-status entry, and an outright invented citation.
 */

const ASKED = 'الكرسي ده بكام؟';

async function priceQuestion(): Promise<{
  h: Harness;
  seeded: Awaited<ReturnType<Harness['seedAccount']>>;
}> {
  const h = createHarness();
  const seeded = await h.seedAccount();
  return { h, seeded };
}

async function ask(
  h: Harness,
  seeded: Awaited<ReturnType<Harness['seedAccount']>>,
  index: number,
): Promise<string> {
  await h.postWebhook(
    seeded,
    metaCommentEnvelope(seeded.connection.externalId, {
      commentId: `c_${String(index)}`,
      postId: `p_${String(index)}`,
      fromId: `u_${String(index)}`,
      text: ASKED,
    }),
  );
  await h.drain();
  h.clock.advanceMs(3_000);
  await h.drain();
  return [...h.container.db.tables.conversations.values()][0]!.id;
}

/** No text ever left this process, in any state, by any route. */
function assertNothingSent(h: Harness): void {
  for (const action of h.container.db.tables.outbound.values()) {
    assert.ok(!LIVE_OUTBOUND_STATES.has(action.state), `${action.id} reached ${action.state}`);
    assert.notEqual(action.deliveryMode, 'AUTONOMOUS');
  }
}

describe('a price nobody approved is never invented', () => {
  it('with no approved knowledge at all, the run asks for a human and drafts nothing', async () => {
    const { h, seeded } = await priceQuestion();
    // The model does the plausible, wrong thing: answers confidently with no citation.
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'PRICE_INQUIRY',
        action: 'PUBLIC_REPLY',
        replyText: 'سعر الكرسي 85,000 جنيه.',
        knowledgeRefs: [],
        confidence: 0.93,
      }),
    });

    const conversationId = await ask(h, seeded, 1);
    const run = (await h.container.runs.listByConversation(seeded.scope, asId(conversationId)))[0]!;
    assert.equal(run.state, 'COMPLETED');
    // DOWNGRADED, not DENIED: with nothing retrieved, the pack's
    // `insufficient_knowledge_action` replaces the proposal before the gate is even reached.
    assert.equal(run.decision?.policyOutcome, 'DOWNGRADED');
    assert.equal(run.decision?.finalAction, 'REQUEST_HUMAN_HANDOFF');

    const actions = await h.container.outboundActions.listByConversation(
      seeded.scope,
      asId(conversationId),
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.actionType, 'REQUEST_HUMAN_HANDOFF');
    // The number never becomes a draft a reviewer could approve by reflex.
    assert.equal(actions[0]!.payload.text, undefined);
    assert.equal((await h.container.review.list(seeded.scope)).length, 0);
    assertNothingSent(h);

    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      asId(conversationId),
    );
    assert.equal(handoffs.length, 1);
    const after = await h.container.conversations.findById(seeded.scope, asId(conversationId));
    assert.equal(after!.ownership, 'PENDING_HUMAN');
  });

  it('an expired price cannot be used, even though it is approved and cited correctly', async () => {
    const { h, seeded } = await priceQuestion();
    const expired = await h.seedKnowledge(seeded.scope, {
      kind: 'PRICE',
      title: 'Chair price',
      body: 'The chair is 85,000 EGP.',
      price: { amount: '85000', currency: 'EGP' },
      tags: ['price'],
      intentCodes: ['PRICE_INQUIRY'],
      validUntil: new Date(h.clock.now().getTime() - 86_400_000),
    });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'PRICE_INQUIRY',
        action: 'PUBLIC_REPLY',
        replyText: 'The chair is 85,000 EGP.',
        knowledgeRefs: [expired.id],
      }),
    });

    const conversationId = await ask(h, seeded, 2);
    const run = (await h.container.runs.listByConversation(seeded.scope, asId(conversationId)))[0]!;
    // Last spring's promotion presented as this week's price is the single most expensive thing a
    // commercial assistant can do, so the gate re-validates every citation at commit time.
    assert.equal(run.decision?.finalAction, 'REQUEST_HUMAN_HANDOFF');
    assert.deepEqual(run.decision?.knowledgeRefsUsed, []);
    assert.equal((await h.container.review.list(seeded.scope)).length, 0);
    assertNothingSent(h);
  });

  it('a draft entry is invisible: an unapproved price cannot be reached at all', async () => {
    const { h, seeded } = await priceQuestion();
    const unapproved = await h.seedKnowledge(seeded.scope, {
      kind: 'PRICE',
      title: 'Chair price (unconfirmed)',
      body: 'The chair is 85,000 EGP.',
      price: { amount: '85000', currency: 'EGP' },
      tags: ['price'],
      intentCodes: ['PRICE_INQUIRY'],
      status: 'DRAFT',
      approvedBy: null,
      approvedAt: null,
    });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'PRICE_INQUIRY',
        action: 'PUBLIC_REPLY',
        replyText: 'The chair is 85,000 EGP.',
        knowledgeRefs: [unapproved.id],
      }),
    });

    const conversationId = await ask(h, seeded, 3);
    const run = (await h.container.runs.listByConversation(seeded.scope, asId(conversationId)))[0]!;
    // The pre-filter never supplied it, so citing it is indistinguishable from inventing it —
    // which is exactly the right treatment.
    assert.equal(run.decision?.finalAction, 'REQUEST_HUMAN_HANDOFF');
    assert.ok(
      run.decision?.policyReason.length,
      'the refusal states a reason, so the gap is reportable',
    );
    assertNothingSent(h);
  });

  it('a citation to an entry that does not exist is caught structurally', async () => {
    const { h, seeded } = await priceQuestion();
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'PRICE_INQUIRY',
        action: 'PUBLIC_REPLY',
        replyText: 'The chair is 85,000 EGP.',
        knowledgeRefs: [asId<KnowledgeEntryId>('kne_does_not_exist')],
      }),
    });

    const conversationId = await ask(h, seeded, 4);
    const run = (await h.container.runs.listByConversation(seeded.scope, asId(conversationId)))[0]!;
    assert.equal(run.decision?.finalAction, 'REQUEST_HUMAN_HANDOFF');
    assertNothingSent(h);
  });

  it('records the gap, so an unanswerable question becomes a task rather than a silence', async () => {
    const { h, seeded } = await priceQuestion();
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'PRICE_INQUIRY',
        action: 'PUBLIC_REPLY',
        replyText: 'سعر الكرسي 85,000 جنيه.',
        knowledgeRefs: [],
      }),
    });

    await ask(h, seeded, 5);
    // The audit's actual complaint was not that the AI could not answer. It was that nobody ever
    // found out it could not.
    assert.ok(
      h.container.db.tables.knowledgeGaps.length > 0,
      'a question with no approved answer must leave a trace someone can work',
    );
  });

  it('a refusal from the model ends with a human, never with a suggested draft', async () => {
    const { h, seeded } = await priceQuestion();
    h.provider.script({ kind: 'REFUSAL' });

    await h.postWebhook(
      seeded,
      metaCommentEnvelope(seeded.connection.externalId, {
        commentId: 'c_6',
        postId: 'p_6',
        fromId: 'u_6',
        text: ASKED,
      }),
    );
    await h.drain();
    for (let attempt = 0; attempt < 5; attempt++) {
      h.clock.advanceMs(600_000);
      await h.drain();
    }

    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(handoffs.length, 1, 'exhaustion reaches a person');
    assert.equal((await h.container.review.list(seeded.scope)).length, 0, 'and leaves no draft');
    assert.equal(h.container.db.tables.outbound.size, 0);
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.lastProcessedInboundSeq, 0, 'the message stays unanswered, not consumed');
  });

  it('a grounded answer is still permitted: the rule is about evidence, not silence', async () => {
    // The control. A rule that refused everything would pass every test above and be useless.
    const { h, seeded } = await priceQuestion();
    const contact = await h.seedKnowledge(seeded.scope, {
      kind: 'FAQ',
      title: 'Contact',
      body: 'You can reach us on WhatsApp.',
      tags: ['contact'],
      intentCodes: ['GENERAL_QUESTION'],
    });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'GENERAL_QUESTION',
        action: 'PUBLIC_REPLY',
        replyText: 'You can reach us on WhatsApp.',
        knowledgeRefs: [contact.id],
      }),
    });

    const conversationId = await ask(h, seeded, 7);
    const queue = await h.container.review.list(seeded.scope);
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.action.payload.text, 'You can reach us on WhatsApp.');
    assert.deepEqual(queue[0]!.action.payload.review?.knowledgeRefs, [contact.id]);
    assert.equal(queue[0]!.conversation.id, conversationId);
    assertNothingSent(h);
  });
});
