import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, decisionJson, metaMessageEnvelope } from '../support/harness.ts';

/**
 * Model failure handling (F-05, F-06, F-07, F-20).
 *
 * The property under test throughout: when the AI cannot produce a safe answer, a human is asked
 * to — the customer is never left with silence and no owner, and never with a wrong answer.
 */
describe('LLM failure handling', () => {
  const seedPending = async (options: Parameters<typeof createHarness>[0] = {}) => {
    const h = createHarness(options);
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['hours', 'open'] });
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'what are your open hours' },
      ]),
    );
    await h.drainTypes(['raw_event.normalize']);
    h.clock.advanceMs(3_000);
    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    return { h, seeded, conversation, knowledge };
  };

  it('F-06: malformed output is repaired once, and the repaired answer is used', async () => {
    const { h, seeded, conversation, knowledge } = await seedPending();
    h.provider.script(
      { kind: 'RESPOND', text: 'Sure! Here you go: { not valid json' },
      {
        kind: 'RESPOND',
        text: decisionJson({ replyText: 'We are open 9-5.', knowledgeRefs: [knowledge.id] }),
      },
    );

    await h.drain();

    assert.equal(h.provider.callCount(), 2, 'exactly one repair attempt');
    const run = (await h.container.runs.listByConversation(seeded.scope, conversation.id))[0]!;
    assert.equal(run.state, 'COMPLETED');
    assert.equal(run.llm?.attempts, 2);
    assert.equal(h.container.db.tables.outbound.size, 1);
  });

  it('F-06: output that stays invalid after repair fails the run rather than being coerced', async () => {
    const { h, seeded, conversation } = await seedPending();
    // Schema-shaped but semantically invalid: an action outside the closed vocabulary.
    h.provider.script({
      kind: 'RESPOND',
      text: JSON.stringify({
        intent: { code: 'GENERAL_QUESTION', confidence: 0.9 },
        proposed_action: 'DELETE_EVERYTHING',
        knowledge_refs: [],
        needs_human: false,
        confidence: 0.9,
      }),
    });

    await h.drain();

    const run = (await h.container.runs.listByConversation(seeded.scope, conversation.id))[0]!;
    assert.equal(run.state, 'RUNNING', 'the run never reaches a terminal success state');
    assert.equal(h.container.db.tables.outbound.size, 0, 'nothing is sent');

    // The job was retried rather than lost.
    const job = [...h.container.db.tables.jobs.values()].find((j) => j.type === 'moderator.run')!;
    assert.equal(job.state, 'READY');
    assert.equal(job.attempt, 1);
    assert.equal(job.lastError?.code, 'LLM_SCHEMA_INVALID');
    assert.ok(job.runAt.getTime() > h.clock.nowMs(), 'the retry is backed off, not immediate');
  });

  it('F-05 / F-20: a persistently failing model exhausts retries, dead-letters, and asks a human', async () => {
    const { h, seeded, conversation } = await seedPending();
    h.provider.script({ kind: 'TIMEOUT' });

    // maxAttempts is 3 in the test config; each drain runs one attempt, then backs off.
    for (let attempt = 0; attempt < 5; attempt++) {
      await h.drain();
      h.clock.advanceMs(600_000);
    }

    const job = [...h.container.db.tables.jobs.values()].find((j) => j.type === 'moderator.run')!;
    assert.equal(job.state, 'DEAD_LETTERED', 'retries are bounded');
    assert.equal(job.attempt, 3);

    const deadLetters = await h.container.deadLetters.list();
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0]!.error.code, 'TIMEOUT');
    assert.equal(
      h.container.db.tables.outbound.size,
      0,
      'no partial or guessed reply is ever sent',
    );

    // The most important assertion in this file: exhaustion is not where the customer's problem
    // ends. A human is explicitly asked to take over.
    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]!.reasonCode, 'AI_UNAVAILABLE');
    assert.equal(handoffs[0]!.urgency, 'HIGH');
    assert.ok(handoffs[0]!.slaDueAt, 'the escalation carries an SLA so it cannot sit unnoticed');

    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.ownership, 'PENDING_HUMAN');
    assert.equal(after!.lastProcessedInboundSeq, 0, 'the message remains unanswered, not consumed');

    const events = await h.container.outbox.listAll(seeded.scope);
    assert.ok(
      events.some((e) => e.type === 'handoff.failed'),
      'downstream systems are told',
    );
  });

  it('a redelivered dead-letter does not stack duplicate handoffs', async () => {
    const { h, seeded, conversation } = await seedPending();
    h.provider.script({ kind: 'TIMEOUT' });

    for (let attempt = 0; attempt < 5; attempt++) {
      await h.drain();
      h.clock.advanceMs(600_000);
    }
    await h.container.escalation.escalateUnrecoverable(seeded.scope, conversation.id, {
      code: 'TIMEOUT',
      message: 'again',
    });

    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(handoffs.length, 1, 'escalation is idempotent per conversation');
  });

  it('F-05: a provider outage is retryable, a refusal is retryable, and neither invents an answer', async () => {
    const { h, seeded, conversation } = await seedPending();
    h.provider.script({ kind: 'TRANSIENT_ERROR', code: 'PROVIDER_UNAVAILABLE' });

    await h.drain();

    const job = [...h.container.db.tables.jobs.values()].find((j) => j.type === 'moderator.run')!;
    assert.equal(job.state, 'READY');
    assert.equal(job.lastError?.code, 'PROVIDER_UNAVAILABLE');

    const runs = await h.container.runs.listByConversation(seeded.scope, conversation.id);
    assert.ok(runs.every((r) => r.decision === null));
    assert.equal(h.container.db.tables.outbound.size, 0);

    // The customer's message is still unprocessed and will be answered when the provider returns.
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.lastProcessedInboundSeq, 0);
  });

  it('F-07: an invented knowledge citation is denied and escalated, never sent', async () => {
    const { h, seeded, conversation } = await seedPending();
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        replyText: 'The price is 500.',
        knowledgeRefs: ['kne_this_was_never_supplied'],
      }),
    });

    await h.drain();

    const run = (await h.container.runs.listByConversation(seeded.scope, conversation.id))[0]!;
    assert.equal(run.state, 'COMPLETED');
    assert.notEqual(run.decision?.finalAction, 'ANSWER_FROM_KNOWLEDGE');
    assert.equal(run.decision?.finalAction, 'REQUEST_HUMAN_HANDOFF');
    // Both the proposal and the verdict are retained — that is what makes AI behaviour auditable.
    assert.equal(run.decision?.proposal.proposed_action, 'ANSWER_FROM_KNOWLEDGE');
    assert.ok((run.decision?.policyReason.length ?? 0) > 0);

    const actions = await h.container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.actionType, 'REQUEST_HUMAN_HANDOFF');
    assert.notEqual(actions[0]!.payload.text, 'The price is 500.');

    // A human was actually asked, and the conversation stopped being AI-owned.
    const handoffs = await h.container.handoffs.listOpenByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0]!.state, 'REQUESTED');
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(
      after!.ownership,
      'PENDING_HUMAN',
      'the AI stops the moment a handoff is requested',
    );

    const gaps = await h.container.knowledgeGaps.list(seeded.scope);
    assert.equal(gaps.length, 1, 'the failure is recorded as a content gap, not just an error');
  });

  it('an intent outside the account taxonomy is treated as a hallucination', async () => {
    const { h, seeded, conversation } = await seedPending();
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({ intentCode: 'INVENTED_INTENT', replyText: 'Certainly.' }),
    });

    await h.drain();

    const run = (await h.container.runs.listByConversation(seeded.scope, conversation.id))[0]!;
    assert.equal(run.decision?.finalAction, 'REQUEST_HUMAN_HANDOFF');
    assert.equal(run.decision?.policyOutcome, 'DOWNGRADED');
    assert.match(run.decision?.policyReason ?? '', /taxonomy/);
  });
});
