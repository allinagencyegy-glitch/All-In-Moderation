import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, decisionJson, metaMessageEnvelope } from '../support/harness.ts';
import { asId } from '../../src/platform/ids.ts';
import type { OutboundActionId, UserId } from '../../src/platform/ids.ts';
import { gateAction } from '../../src/policy/action-gate.ts';
import { createOutboundAction } from '../../src/moderation/domain/outbound-action.ts';
import { resolveAuthorityMatrix } from '../../src/moderation/application/routing-policy.ts';

const OPERATOR = asId<UserId>('usr_operator_1');

/**
 * The failure this platform most exists to prevent: a human and the AI both replying.
 *
 * Three distinct timing windows are covered — takeover *before* a run, *during* a run, and a
 * decision already queued when takeover happens.
 */
describe('human takeover (ADR-008, F-13, F-14)', () => {
  const seedConversation = async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['hello'] });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({ replyText: 'Hi there.', knowledgeRefs: [knowledge.id] }),
    });
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello there' },
      ]),
    );
    await h.drainTypes(['raw_event.normalize']);
    const conversation = [...h.container.db.tables.conversations.values()][0]!;
    return { h, seeded, conversation };
  };

  it('takeover before the run: the AI never speaks', async () => {
    const { h, seeded, conversation } = await seedConversation();

    await h.container.takeover.takeOver(
      seeded.scope,
      conversation.id,
      OPERATOR,
      'operator picked it up',
    );

    h.clock.advanceMs(3_000);
    await h.drain();

    const runs = await h.container.runs.listByConversation(seeded.scope, conversation.id);
    assert.equal(runs[0]!.state, 'SKIPPED');
    assert.equal(runs[0]!.skipReason, 'NOT_AI_OWNED');
    assert.equal(h.container.db.tables.outbound.size, 0);
    assert.equal(h.provider.callCount(), 0, 'no model call is even made');

    // The customer's message is still unprocessed, so nothing is lost if ownership returns.
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.lastProcessedInboundSeq, 0);
    assert.equal(after!.ownership, 'HUMAN_OWNED');
    assert.equal(after!.ownerUserId, OPERATOR);
  });

  it('F-13: takeover landing *after* the staleness guard is still caught, at commit', async () => {
    const { h, seeded, conversation } = await seedConversation();

    // The narrowest window there is. The guard re-reads the conversation *before* the commit
    // transaction opens, so a takeover committed in between leaves the run holding a snapshot that
    // was accurate when it was read and wrong by the time it is written. Only a compare-and-swap
    // on `ownershipVersion` closes this; a blind `save` would overwrite the takeover and the AI
    // would speak over the operator.
    const realFindById = h.container.conversations.findById.bind(h.container.conversations);
    let reads = 0;
    let reentrant = false;
    h.container.conversations.findById = async (scope, id) => {
      const found = await realFindById(scope, id);
      if (reentrant || id !== conversation.id) return found;
      reads += 1;
      // Read 1 is the run's initial load; read 2 is the staleness guard.
      if (reads === 2) {
        reentrant = true;
        await h.container.takeover.takeOver(seeded.scope, conversation.id, OPERATOR, 'urgent');
        reentrant = false;
      }
      // Deliberately hand back the pre-takeover snapshot: the guard cannot see what it did not
      // read, which is precisely why the commit has to check again.
      return found;
    };

    h.clock.advanceMs(3_000);
    await h.drain();

    const runs = await h.container.runs.listByConversation(seeded.scope, conversation.id);
    assert.equal(runs[0]!.state, 'SUPERSEDED', 'the run must not commit against a stale version');
    assert.equal(h.container.db.tables.outbound.size, 0, 'nothing was said to the customer');

    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.ownership, 'HUMAN_OWNED', 'the takeover survived the run');
    assert.equal(after!.ownerUserId, OPERATOR);
    assert.equal(
      after!.lastProcessedInboundSeq,
      0,
      'the watermark did not move, so the operator still sees the unanswered message',
    );
  });

  it('a losing compare-and-swap writes nothing at all', async () => {
    const { h, seeded, conversation } = await seedConversation();

    const applied = await h.container.conversations.saveIfUnchanged(
      seeded.scope,
      { ...conversation, engagement: 'AWAITING_CUSTOMER' },
      conversation.ownershipVersion + 1,
    );

    assert.equal(applied, false);
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.engagement, conversation.engagement, 'a lost CAS is not a partial write');
  });

  it('two operators taking over at once produce one winner, not a silent overwrite', async () => {
    const { h, seeded, conversation } = await seedConversation();
    const other = asId<UserId>('usr_operator_2');

    // Both read the same version, then both write. Without a CAS the second write wins silently
    // and the first operator keeps an inbox item they no longer own.
    const stale = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.ok(stale);
    await h.container.takeover.takeOver(seeded.scope, conversation.id, OPERATOR, 'first');

    const realFindById = h.container.conversations.findById.bind(h.container.conversations);
    h.container.conversations.findById = (scope, id) =>
      id === conversation.id ? Promise.resolve(stale) : realFindById(scope, id);

    await assert.rejects(
      () => h.container.takeover.takeOver(seeded.scope, conversation.id, other, 'second'),
      (error: unknown) => (error as { code?: string }).code === 'CONCURRENCY_CONFLICT',
    );

    h.container.conversations.findById = realFindById;
    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.ownerUserId, OPERATOR, 'the first writer keeps the conversation');
    assert.equal(after!.ownershipVersion, 1);
  });

  it('F-13: takeover *during* generation supersedes the run and sends nothing', async () => {
    const { h, seeded, conversation } = await seedConversation();

    // The takeover happens while the model is "thinking": the mock provider performs it from
    // inside the call, which is exactly the race the ownership version exists to catch.
    let takenOver = false;
    const scripted = h.provider.complete.bind(h.provider);
    h.provider.complete = async (request, options) => {
      if (!takenOver) {
        takenOver = true;
        await h.container.takeover.takeOver(seeded.scope, conversation.id, OPERATOR, 'urgent');
      }
      return scripted(request, options);
    };

    h.clock.advanceMs(3_000);
    await h.drain();

    const runs = await h.container.runs.listByConversation(seeded.scope, conversation.id);
    const moderatorRun = runs.find((r) => r.state === 'SUPERSEDED');
    assert.ok(moderatorRun, 'the run must be recorded as SUPERSEDED, not silently discarded');
    assert.equal(h.container.db.tables.outbound.size, 0, 'no outbound action may be created');

    const after = await h.container.conversations.findById(seeded.scope, conversation.id);
    assert.equal(after!.ownership, 'HUMAN_OWNED');
    // Critically: the watermark did NOT advance, so the human sees an unanswered message.
    assert.equal(after!.lastProcessedInboundSeq, 0);

    const audit = await h.container.audit.list(seeded.scope);
    assert.ok(audit.some((e) => e.action === 'moderator.run_superseded'));
  });

  it('F-14: an operator sending a message performs an implicit takeover first', async () => {
    const { h, seeded, conversation } = await seedConversation();

    const { conversation: after } = await h.container.takeover.sendAsHuman(
      seeded.scope,
      conversation.id,
      OPERATOR,
      'Hi, I can help with that.',
    );

    assert.equal(after.ownership, 'HUMAN_OWNED', 'sending IS taking over');
    assert.equal(after.ownershipVersion, 1);

    h.clock.advanceMs(3_000);
    await h.drain();
    assert.equal(h.container.db.tables.outbound.size, 0);
    assert.equal(h.provider.callCount(), 0);

    const audit = await h.container.audit.list(seeded.scope);
    assert.ok(audit.some((e) => e.action === 'conversation.human_message_sent'));
    assert.ok(audit.some((e) => e.action === 'conversation.ownership_changed'));
  });

  it('every ownership change bumps the version and is recorded with its actor', async () => {
    const { h, seeded, conversation } = await seedConversation();

    await h.container.takeover.takeOver(seeded.scope, conversation.id, OPERATOR, 'taking over');
    await h.container.takeover.release(seeded.scope, conversation.id, OPERATOR, 'handing back');

    const transitions = await h.container.conversations.listOwnershipTransitions(
      seeded.scope,
      conversation.id,
    );
    assert.deepEqual(
      transitions.map((t) => `${t.fromOwnership}->${t.toOwnership}@${t.version}`),
      ['AI_OWNED->HUMAN_OWNED@1', 'HUMAN_OWNED->AI_OWNED@2'],
    );
    assert.ok(transitions.every((t) => t.actorUserId === OPERATOR));
  });

  it('after release the AI resumes with the still-unprocessed messages', async () => {
    const { h, seeded, conversation } = await seedConversation();

    await h.container.takeover.takeOver(seeded.scope, conversation.id, OPERATOR, 'taking over');
    h.clock.advanceMs(3_000);
    await h.drain();
    assert.equal(h.container.db.tables.outbound.size, 0);

    await h.container.takeover.release(seeded.scope, conversation.id, OPERATOR, 'handing back');
    // A new customer message re-triggers the moderator; the earlier message is still above the
    // watermark, so it is answered too rather than being lost to the takeover window.
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_2', text: 'are you still there?' },
      ]),
    );
    await h.drainTypes(['raw_event.normalize']);
    h.clock.advanceMs(3_000);
    await h.drain();

    const run = (await h.container.runs.listByConversation(seeded.scope, conversation.id)).find(
      (r) => r.state === 'COMPLETED',
    );
    assert.ok(run, 'the AI resumes once ownership returns');
    assert.equal(run.inputWatermark, 2, 'both messages are considered');

    const prompt = h.provider.calls[0]!.request.turns[0]!.content;
    assert.ok(
      prompt.includes('hello there'),
      'the message received during human ownership is not lost',
    );
  });

  it('a queued outbound action is cancelled when a human takes over', async () => {
    const { h, seeded, conversation } = await seedConversation();

    // Phase 0 records SIMULATED actions, which are already terminal. To exercise the cancellation
    // path that matters once a real transport exists, an AUTONOMOUS action is built here through
    // the real policy gate — the only way to obtain the authorisation token — and then queued.
    const gate = gateAction({
      conversationId: conversation.id,
      surface: conversation.surface,
      ownership: conversation.ownership,
      lifecycle: conversation.lifecycle,
      ownershipVersion: conversation.ownershipVersion,
      accountCanActAutonomously: true,
      action: 'ASK_CLARIFICATION',
      requestedDeliveryMode: 'AUTONOMOUS',
      matrix: resolveAuthorityMatrix(await h.container.packs.findActive(seeded.scope)),
      knowledgeVerified: true,
      citationCount: 0,
      hasReplyText: true,
      now: h.clock.now(),
    });
    assert.equal(gate.outcome, 'ALLOWED');

    const queued = createOutboundAction(gate.authorization, {
      id: asId<OutboundActionId>('oba_pending_1'),
      accountId: seeded.scope.accountId,
      conversationId: conversation.id,
      moderatorRunId: null,
      ordinal: 0,
      payload: { text: 'Which model did you mean?' },
      createdAt: h.clock.now(),
      simulate: false,
    });
    assert.equal(queued.state, 'PENDING_DISPATCH');
    await h.container.outboundActions.save(seeded.scope, queued);

    await h.container.takeover.takeOver(seeded.scope, conversation.id, OPERATOR, 'taking over');

    const after = await h.container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(after[0]!.state, 'CANCELLED');
    assert.equal(after[0]!.cancelledReason, 'HUMAN_TOOK_OVER');
  });
});
