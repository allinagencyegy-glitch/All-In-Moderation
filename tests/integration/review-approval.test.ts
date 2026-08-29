import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { OutboundActionId, UserId } from '../../src/platform/ids.ts';
import { TerminalError } from '../../src/platform/errors.ts';
import { LIVE_OUTBOUND_STATES } from '../../src/moderation/domain/outbound-action.ts';
import type { AccountScope } from '../../src/core/account/index.ts';
import type { Harness } from '../support/harness.ts';
import { createHarness, decisionJson, metaCommentEnvelope } from '../support/harness.ts';

/**
 * The human review workflow (ADR-011): LIST, SHOW, APPROVE, EDIT, REJECT, ESCALATE.
 *
 * One assertion runs through every test in this file, and it is the reason the phase exists:
 * **approving does not send.** There is no dispatcher to hand an approved draft to, and approval
 * must not invent one. The final state is `APPROVED_FOR_MANUAL_SEND` — terminal, outside the live
 * set, and meaning only that a named person may now type the text into Meta Inbox themselves.
 */

const REVIEWER = asId<UserId>('usr_reviewer_1');
const OTHER_REVIEWER = asId<UserId>('usr_reviewer_2');
const DRAFT = 'We are open Monday to Friday, 9am to 5pm.';

interface Suggested {
  readonly h: Harness;
  readonly scope: AccountScope;
  readonly actionId: OutboundActionId;
  readonly conversationId: string;
}

/** Drives a comment through to a suppressed suggestion awaiting review. */
async function suggestOne(replyText = DRAFT, index = 1): Promise<Suggested> {
  const h = createHarness();
  const seeded = await h.seedAccount();
  const knowledge = await h.seedKnowledge(seeded.scope, {
    title: 'Opening hours',
    body: 'Open Monday to Friday, 9am to 5pm.',
    tags: ['hours'],
  });
  h.provider.script({
    kind: 'RESPOND',
    text: decisionJson({
      action: 'PUBLIC_REPLY',
      replyText,
      knowledgeRefs: [knowledge.id],
    }),
  });
  await h.postWebhook(
    seeded,
    metaCommentEnvelope(seeded.connection.externalId, {
      commentId: `c_${String(index)}`,
      postId: `p_${String(index)}`,
      fromId: `u_${String(index)}`,
      text: 'what are your hours?',
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
  assert.equal(actions.length, 1, 'the fixture must produce exactly one suggestion');
  assert.equal(actions[0]!.state, 'SUPPRESSED');
  return {
    h,
    scope: seeded.scope,
    actionId: actions[0]!.id,
    conversationId: conversation.id,
  };
}

/** The invariant every test in this file re-checks. */
async function assertNothingDispatched(fixture: Suggested): Promise<void> {
  const actions = [...fixture.h.container.db.tables.outbound.values()];
  for (const action of actions) {
    assert.ok(
      !LIVE_OUTBOUND_STATES.has(action.state),
      `${action.id} reached live state ${action.state}`,
    );
    assert.notEqual(action.deliveryMode, 'AUTONOMOUS');
  }
  // And nothing was queued for anyone to pick up either.
  assert.equal(await fixture.h.drain(), 0, 'a review must not enqueue work');
}

describe('human review of a suggested reply', () => {
  describe('SHOW', () => {
    it('returns the draft, its evidence, the transcript and the cited knowledge', async () => {
      const fixture = await suggestOne();
      const detail = await fixture.h.container.review.show(fixture.scope, fixture.actionId);

      assert.equal(detail.action.payload.text, DRAFT);
      assert.equal(detail.action.state, 'SUPPRESSED');
      assert.equal(detail.conversation.id, fixture.conversationId);
      assert.equal(detail.transcript.length, 1);
      assert.equal(detail.transcript[0]!.text, 'what are your hours?');
      assert.equal(detail.citedKnowledge.length, 1);
      assert.deepEqual(detail.unresolvedCitations, []);
      assert.ok(detail.run, 'a draft with no run is unreviewable');
      assert.equal(detail.run.llm?.provider, 'mock');
      assert.deepEqual(detail.history, []);
    });

    it('flags a citation that has expired since the draft was written', async () => {
      const fixture = await suggestOne();
      // Approving a draft whose evidence has gone stale would put an out-of-date claim in front
      // of a customer under a human's signature. The reviewer has to see it.
      const cited = (await fixture.h.container.review.show(fixture.scope, fixture.actionId))
        .citedKnowledge[0]!;
      await fixture.h.container.knowledge.save(fixture.scope, {
        ...cited,
        validUntil: new Date(fixture.h.clock.now().getTime() - 1),
      });

      const detail = await fixture.h.container.review.show(fixture.scope, fixture.actionId);
      assert.deepEqual(detail.unresolvedCitations, [{ ref: cited.id, reason: 'OUT_OF_VALIDITY' }]);
      assert.equal(detail.citedKnowledge.length, 0, 'stale evidence is not shown as evidence');
    });

    it('refuses to show an action from another account', async () => {
      const fixture = await suggestOne();
      const other = await fixture.h.seedAccount({ slug: 'other-tenant' });
      await assert.rejects(
        fixture.h.container.review.show(other.scope, fixture.actionId),
        (error: unknown) => {
          assert.ok(error instanceof TerminalError);
          assert.equal(error.code, 'TENANT_VIOLATION');
          return true;
        },
      );
    });
  });

  describe('APPROVE', () => {
    it('moves the draft to APPROVED_FOR_MANUAL_SEND and dispatches nothing', async () => {
      const fixture = await suggestOne();
      const result = await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'APPROVED',
        reviewerUserId: REVIEWER,
      });

      assert.equal(result.action.state, 'APPROVED_FOR_MANUAL_SEND');
      assert.equal(result.action.deliveryMode, 'SUGGESTED');
      assert.equal(result.textForManualSend, DRAFT);
      assert.equal(result.handoffId, null);
      assert.equal(result.action.providerMessageId, null, 'nothing was ever sent');
      assert.equal(result.action.deliveredAt, null);
      await assertNothingDispatched(fixture);
    });

    it('records who decided, when, and what the model had written', async () => {
      const fixture = await suggestOne();
      const { review } = await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'APPROVED',
        reviewerUserId: REVIEWER,
      });

      assert.equal(review.decision, 'APPROVED');
      assert.equal(review.reviewerUserId, REVIEWER);
      assert.equal(review.originalText, DRAFT);
      assert.equal(review.editedText, null);
      assert.deepEqual(review.decidedAt, fixture.h.clock.now());
      assert.equal(review.outboundActionId, fixture.actionId);
    });

    it('writes an audit entry naming the reviewer', async () => {
      const fixture = await suggestOne();
      await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'APPROVED',
        reviewerUserId: REVIEWER,
      });

      const entries = [...fixture.h.container.db.tables.audit].filter(
        (entry) => entry.action === 'outbound_action.reviewed',
      );
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.actorKind, 'HUMAN');
      assert.equal(entries[0]!.actorUserId, REVIEWER);
      assert.equal(entries[0]!.subjectId, fixture.actionId);
      assert.equal(entries[0]!.detail['decision'], 'APPROVED');
      assert.equal(entries[0]!.detail['state'], 'APPROVED_FOR_MANUAL_SEND');
    });

    it('leaves the queue empty afterwards, so nothing is reviewed twice', async () => {
      const fixture = await suggestOne();
      assert.equal((await fixture.h.container.review.list(fixture.scope)).length, 1);
      await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'APPROVED',
        reviewerUserId: REVIEWER,
      });
      assert.equal((await fixture.h.container.review.list(fixture.scope)).length, 0);
    });

    it('refuses a second decision on an already-decided draft', async () => {
      const fixture = await suggestOne();
      await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'APPROVED',
        reviewerUserId: REVIEWER,
      });
      await assert.rejects(
        fixture.h.container.review.decide(fixture.scope, {
          actionId: fixture.actionId,
          decision: 'REJECTED',
          reviewerUserId: OTHER_REVIEWER,
          reason: 'changed my mind',
        }),
        (error: unknown) => {
          assert.ok(error instanceof TerminalError);
          assert.equal(error.code, 'REVIEW_ALREADY_DECIDED');
          return true;
        },
      );
    });

    it('refuses to review an action that was never a suggestion', async () => {
      const fixture = await suggestOne();
      const simulated = [...fixture.h.container.db.tables.outbound.values()][0]!;
      await fixture.h.container.outboundActions.save(fixture.scope, {
        ...simulated,
        deliveryMode: 'SIMULATED',
        state: 'SIMULATED',
      });
      await assert.rejects(
        fixture.h.container.review.decide(fixture.scope, {
          actionId: fixture.actionId,
          decision: 'APPROVED',
          reviewerUserId: REVIEWER,
        }),
        (error: unknown) => {
          assert.ok(error instanceof TerminalError);
          assert.equal(error.code, 'REVIEW_NOT_APPLICABLE');
          return true;
        },
      );
    });
  });

  describe('EDIT', () => {
    it('preserves the original AI draft beside the human text', async () => {
      // Losing this pairing would destroy the only evidence that could ever justify granting this
      // account more autonomy than it has: how much a person had to change.
      const fixture = await suggestOne();
      const edited = 'We are open Monday to Friday, 9am to 5pm. Happy to help.';
      const result = await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'EDITED',
        reviewerUserId: REVIEWER,
        editedText: edited,
      });

      assert.equal(result.review.originalText, DRAFT, 'the model’s words survive');
      assert.equal(result.review.editedText, edited);
      assert.equal(result.action.payload.text, DRAFT, 'payload.text is never overwritten');
      assert.equal(result.textForManualSend, edited);
      // Derived from the review log, which is the one append-only, attributed record of it.
      const detail = await fixture.h.container.review.show(fixture.scope, fixture.actionId);
      assert.equal(detail.finalText, edited);
      assert.equal(result.action.state, 'APPROVED_FOR_MANUAL_SEND');
      await assertNothingDispatched(fixture);
    });

    it('refuses an edit with no text, and refuses text on any other decision', async () => {
      const fixture = await suggestOne();
      await assert.rejects(
        fixture.h.container.review.decide(fixture.scope, {
          actionId: fixture.actionId,
          decision: 'EDITED',
          reviewerUserId: REVIEWER,
          editedText: '   ',
        }),
        (error: unknown) => {
          assert.equal((error as TerminalError).code, 'REVIEW_EDIT_EMPTY');
          return true;
        },
      );
      await assert.rejects(
        fixture.h.container.review.decide(fixture.scope, {
          actionId: fixture.actionId,
          decision: 'APPROVED',
          reviewerUserId: REVIEWER,
          editedText: 'sneaking a rewrite past the record',
        }),
        (error: unknown) => {
          assert.equal((error as TerminalError).code, 'REVIEW_EDIT_NOT_APPLICABLE');
          return true;
        },
      );
      // Neither attempt moved anything.
      const action = await fixture.h.container.outboundActions.findById(
        fixture.scope,
        fixture.actionId,
      );
      assert.equal(action!.state, 'SUPPRESSED');
    });
  });

  describe('REJECT', () => {
    it('cancels the draft with an attributed reason, and sends nothing', async () => {
      const fixture = await suggestOne();
      const result = await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'REJECTED',
        reviewerUserId: REVIEWER,
        reason: 'The hours are wrong; we now close at 6pm.',
      });

      assert.equal(result.action.state, 'CANCELLED');
      assert.equal(result.action.cancelledReason, 'REJECTED_BY_REVIEWER');
      assert.equal(result.textForManualSend, null);
      assert.equal(result.review.reason, 'The hours are wrong; we now close at 6pm.');
      assert.equal(
        result.review.originalText,
        DRAFT,
        'a rejection is only auditable with the text',
      );
      await assertNothingDispatched(fixture);
    });

    it('is readable afterwards as a permanent record on the action', async () => {
      const fixture = await suggestOne();
      await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'REJECTED',
        reviewerUserId: REVIEWER,
        reason: 'wrong hours',
      });
      const detail = await fixture.h.container.review.show(fixture.scope, fixture.actionId);
      assert.equal(detail.history.length, 1);
      assert.equal(detail.history[0]!.decision, 'REJECTED');
      assert.equal(detail.history[0]!.reviewerUserId, REVIEWER);
      assert.equal(detail.history[0]!.reason, 'wrong hours');
    });

    it('demands a reason: a silent rejection teaches nobody anything', async () => {
      const fixture = await suggestOne();
      for (const decision of ['REJECTED', 'ESCALATED'] as const) {
        await assert.rejects(
          fixture.h.container.review.decide(fixture.scope, {
            actionId: fixture.actionId,
            decision,
            reviewerUserId: REVIEWER,
          }),
          (error: unknown) => {
            assert.equal((error as TerminalError).code, 'REVIEW_REASON_REQUIRED');
            return true;
          },
        );
      }
    });
  });

  describe('ESCALATE', () => {
    it('cancels the draft, raises a high-urgency handoff and hands the conversation over', async () => {
      const fixture = await suggestOne();
      const result = await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'ESCALATED',
        reviewerUserId: REVIEWER,
        reason: 'Customer is a supplier, not a patient. Needs the account manager.',
      });

      assert.equal(result.action.state, 'CANCELLED');
      assert.equal(result.action.cancelledReason, 'ESCALATED_BY_REVIEWER');
      assert.equal(result.textForManualSend, null);
      assert.ok(result.handoffId);

      const handoffs = await fixture.h.container.handoffs.listOpenByConversation(
        fixture.scope,
        asId(fixture.conversationId),
      );
      assert.equal(handoffs.length, 1);
      assert.equal(handoffs[0]!.urgency, 'HIGH');
      assert.equal(handoffs[0]!.contextSummary['outbound_action_id'], fixture.actionId);

      const conversation = await fixture.h.container.conversations.findById(
        fixture.scope,
        asId(fixture.conversationId),
      );
      assert.equal(conversation!.ownership, 'PENDING_HUMAN');
      await assertNothingDispatched(fixture);
    });
  });

  describe('staleness', () => {
    it('a takeover cancels the pending draft outright', async () => {
      const fixture = await suggestOne();
      await fixture.h.container.takeover.takeOver(
        fixture.scope,
        asId(fixture.conversationId),
        OTHER_REVIEWER,
        'answering this one myself',
      );

      const action = await fixture.h.container.outboundActions.findById(
        fixture.scope,
        fixture.actionId,
      );
      assert.equal(action!.state, 'CANCELLED');
      assert.equal(action!.cancelledReason, 'HUMAN_TOOK_OVER');
      assert.equal((await fixture.h.container.review.list(fixture.scope)).length, 0);
    });

    it('refuses to approve a draft in a conversation a person now owns', async () => {
      // The race a takeover cannot win on its own: the reviewer already had the draft open.
      const fixture = await suggestOne();
      const action = await fixture.h.container.outboundActions.findById(
        fixture.scope,
        fixture.actionId,
      );
      const conversation = await fixture.h.container.conversations.findById(
        fixture.scope,
        asId(fixture.conversationId),
      );
      // Hand the conversation over without cancelling the draft, so the second guard is the only
      // thing standing between a stale reply and a human signature on it.
      await fixture.h.container.conversations.save(fixture.scope, {
        ...conversation!,
        ownership: 'HUMAN_OWNED',
        ownerUserId: OTHER_REVIEWER,
      });
      assert.equal(action!.state, 'SUPPRESSED');

      await assert.rejects(
        fixture.h.container.review.decide(fixture.scope, {
          actionId: fixture.actionId,
          decision: 'APPROVED',
          reviewerUserId: REVIEWER,
        }),
        (error: unknown) => {
          assert.equal((error as TerminalError).code, 'REVIEW_CONVERSATION_TAKEN_OVER');
          return true;
        },
      );
      // Rejecting it, however, is always allowed: clearing a stale draft is housekeeping.
      const rejected = await fixture.h.container.review.decide(fixture.scope, {
        actionId: fixture.actionId,
        decision: 'REJECTED',
        reviewerUserId: REVIEWER,
        reason: 'superseded by the human reply',
      });
      assert.equal(rejected.action.state, 'CANCELLED');
    });
  });

  describe('tenant isolation', () => {
    it('one account cannot see or decide another account’s queue', async () => {
      const fixture = await suggestOne();
      const other = await fixture.h.seedAccount({ slug: 'other-tenant' });

      assert.equal((await fixture.h.container.review.list(other.scope)).length, 0);
      await assert.rejects(
        fixture.h.container.review.decide(other.scope, {
          actionId: fixture.actionId,
          decision: 'APPROVED',
          reviewerUserId: REVIEWER,
        }),
        (error: unknown) => {
          // The repository refuses before the service ever sees the row.
          assert.equal((error as TerminalError).code, 'TENANT_VIOLATION');
          return true;
        },
      );
      // And the draft is untouched.
      const action = await fixture.h.container.outboundActions.findById(
        fixture.scope,
        fixture.actionId,
      );
      assert.equal(action!.state, 'SUPPRESSED');
    });
  });
});
