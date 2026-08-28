import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type {
  AccountId,
  AccountPackVersionId,
  ChannelConnectionId,
  ChannelIdentityId,
  ConversationId,
  ModeratorRunId,
  TraceId,
  UserId,
} from '../../src/platform/ids.ts';
import { InvalidTransitionError } from '../../src/platform/errors.ts';
import type { Conversation } from '../../src/moderation/domain/conversation.ts';
import {
  assertConversationInvariants,
  deriveEngagement,
  mayActAutonomously,
  operatorStatus,
  transitionLifecycle,
  transitionOwnership,
} from '../../src/moderation/domain/conversation.ts';
import { checkStalenessGuard, transitionRun } from '../../src/moderation/domain/moderator-run.ts';
import type { ModeratorRun } from '../../src/moderation/domain/moderator-run.ts';
import { transitionRawEvent } from '../../src/moderation/domain/raw-event.ts';
import type { RawInboundEvent } from '../../src/moderation/domain/raw-event.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const OPERATOR = asId<UserId>('usr_1');

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: asId<ConversationId>('cnv_1'),
    accountId: asId<AccountId>('acc_1'),
    channelConnectionId: asId<ChannelConnectionId>('chc_1'),
    channelIdentityId: asId<ChannelIdentityId>('chi_1'),
    contactIdentityId: null,
    surface: 'DIRECT_MESSAGE',
    threadRef: null,
    lifecycle: 'OPEN',
    ownership: 'AI_OWNED',
    ownershipVersion: 0,
    ownerUserId: null,
    engagement: 'IDLE',
    nextSeq: 2,
    lastInboundSeq: 1,
    lastProcessedInboundSeq: 1,
    locale: null,
    snoozedUntil: null,
    closedAt: null,
    firstMessageAt: null,
    lastMessageAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe('conversation lifecycle (axis 1)', () => {
  it('a closed conversation reopens on a new message rather than staying terminal', () => {
    const closed = transitionLifecycle(conversation(), 'CLOSED', NOW);
    assert.equal(closed.lifecycle, 'CLOSED');
    const reopened = transitionLifecycle(closed, 'OPEN', NOW);
    assert.equal(reopened.lifecycle, 'OPEN');
    assert.equal(reopened.closedAt, null);
  });

  it('snoozing requires a future wake time, so a conversation cannot sleep forever', () => {
    assert.throws(
      () => transitionLifecycle(conversation(), 'SNOOZED', NOW, new Date(NOW.getTime() - 1)),
      InvalidTransitionError,
    );
    const snoozed = transitionLifecycle(
      conversation(),
      'SNOOZED',
      NOW,
      new Date(NOW.getTime() + 1_000),
    );
    assert.ok(snoozed.snoozedUntil);
  });
});

describe('conversation ownership (axis 2)', () => {
  it('every transition increments the version, which is the takeover guard', () => {
    const taken = transitionOwnership(conversation(), {
      to: 'HUMAN_OWNED',
      actorKind: 'HUMAN',
      actorUserId: OPERATOR,
      reason: 'takeover',
      at: NOW,
    });
    assert.equal(taken.conversation.ownershipVersion, 1);
    assert.equal(taken.record.version, 1);

    const released = transitionOwnership(taken.conversation, {
      to: 'AI_OWNED',
      actorKind: 'HUMAN',
      actorUserId: OPERATOR,
      reason: 'release',
      at: NOW,
    });
    assert.equal(released.conversation.ownershipVersion, 2);
  });

  it('HUMAN_OWNED requires an actor, and owner_user_id tracks it exactly', () => {
    assert.throws(
      () =>
        transitionOwnership(conversation(), {
          to: 'HUMAN_OWNED',
          actorKind: 'HUMAN',
          reason: 'no actor',
          at: NOW,
        }),
      InvalidTransitionError,
    );
    const taken = transitionOwnership(conversation(), {
      to: 'HUMAN_OWNED',
      actorKind: 'HUMAN',
      actorUserId: OPERATOR,
      reason: 'takeover',
      at: NOW,
    });
    assert.equal(taken.conversation.ownerUserId, OPERATOR);
    assertConversationInvariants(taken.conversation);
  });

  it('the AI cannot take a conversation back from a human on its own', () => {
    const human = transitionOwnership(conversation(), {
      to: 'HUMAN_OWNED',
      actorKind: 'HUMAN',
      actorUserId: OPERATOR,
      reason: 'takeover',
      at: NOW,
    }).conversation;

    assert.throws(
      () =>
        transitionOwnership(human, {
          to: 'AI_OWNED',
          actorKind: 'SYSTEM',
          reason: 'inactivity',
          at: NOW,
        }),
      InvalidTransitionError,
      'automatic return from HUMAN_OWNED is forbidden regardless of policy',
    );
  });

  it('the only automatic return is out of PENDING_HUMAN, and only when opted in', () => {
    const pending = transitionOwnership(conversation(), {
      to: 'PENDING_HUMAN',
      actorKind: 'POLICY',
      reason: 'handoff',
      at: NOW,
    }).conversation;

    assert.throws(
      () =>
        transitionOwnership(pending, {
          to: 'AI_OWNED',
          actorKind: 'POLICY',
          reason: 'sla',
          at: NOW,
        }),
      InvalidTransitionError,
      'not without the account opting in',
    );

    const fallback = transitionOwnership(pending, {
      to: 'AI_OWNED',
      actorKind: 'POLICY',
      reason: 'sla expired',
      at: NOW,
      allowPolicyFallbackToAi: true,
    });
    assert.equal(fallback.conversation.ownership, 'AI_OWNED');
  });

  it('autonomy requires AI ownership on an open conversation', () => {
    assert.equal(mayActAutonomously(conversation()), true);
    assert.equal(mayActAutonomously(conversation({ ownership: 'PENDING_HUMAN' })), false);
    assert.equal(mayActAutonomously(conversation({ lifecycle: 'CLOSED' })), false);
  });
});

describe('derived views (axis 3 and the operator label)', () => {
  it('engagement is derived from the watermark', () => {
    assert.equal(
      deriveEngagement(conversation({ lastInboundSeq: 3, lastProcessedInboundSeq: 1 })),
      'AWAITING_MODERATOR',
    );
    assert.equal(
      deriveEngagement(conversation({ engagement: 'AWAITING_CUSTOMER' })),
      'AWAITING_CUSTOMER',
    );
    assert.equal(
      deriveEngagement(conversation({ engagement: 'AWAITING_EXTERNAL' })),
      'AWAITING_EXTERNAL',
    );
  });

  it('the operator label preserves the original vocabulary without the original ambiguity', () => {
    assert.equal(operatorStatus(conversation()), 'AI_OWNED');
    assert.equal(
      operatorStatus(conversation({ engagement: 'AWAITING_CUSTOMER' })),
      'WAITING_CUSTOMER',
    );
    assert.equal(operatorStatus(conversation({ ownership: 'PENDING_HUMAN' })), 'WAITING_HUMAN');
    assert.equal(
      operatorStatus(conversation({ ownership: 'HUMAN_OWNED', ownerUserId: OPERATOR })),
      'HUMAN_OWNED',
    );
    assert.equal(
      operatorStatus(conversation({ engagement: 'AWAITING_EXTERNAL' })),
      'WAITING_EXTERNAL_SYSTEM',
    );
    assert.equal(operatorStatus(conversation(), true), 'QUALIFYING');
    assert.equal(operatorStatus(conversation({ lifecycle: 'CLOSED' })), 'CLOSED');

    // The combination that a single flat enum cannot express: a human owns it *and* we are
    // waiting on the customer. Ownership wins, because ownership is what governs who may speak.
    const both = conversation({
      ownership: 'HUMAN_OWNED',
      ownerUserId: OPERATOR,
      engagement: 'AWAITING_CUSTOMER',
    });
    assert.equal(operatorStatus(both), 'HUMAN_OWNED');
  });
});

describe('invariants', () => {
  it('rejects a watermark ahead of the last inbound message', () => {
    assert.throws(() => assertConversationInvariants(conversation({ lastProcessedInboundSeq: 5 })));
  });

  it('rejects an owner on a conversation that is not human-owned', () => {
    assert.throws(() => assertConversationInvariants(conversation({ ownerUserId: OPERATOR })));
  });
});

describe('moderator run lifecycle', () => {
  const run: ModeratorRun = {
    id: asId<ModeratorRunId>('run_1'),
    accountId: asId<AccountId>('acc_1'),
    conversationId: asId<ConversationId>('cnv_1'),
    state: 'RUNNING',
    trigger: 'INBOUND_MESSAGE',
    inputWatermark: 3,
    observedOwnershipVersion: 2,
    packVersionId: asId<AccountPackVersionId>('apv_1'),
    promptTemplateVersion: 'v1',
    decision: null,
    llm: null,
    rawResponse: null,
    skipReason: null,
    error: null,
    jobId: null,
    traceId: asId<TraceId>('trc_1'),
    startedAt: NOW,
    finishedAt: null,
  };

  it('terminal states must carry their reason', () => {
    assert.throws(() => transitionRun(run, 'SKIPPED'), InvalidTransitionError);
    assert.throws(() => transitionRun(run, 'FAILED'), InvalidTransitionError);
    assert.throws(() => transitionRun(run, 'COMPLETED'), InvalidTransitionError);
    assert.equal(
      transitionRun(run, 'SKIPPED', { skipReason: 'NO_UNPROCESSED_INPUT' }).state,
      'SKIPPED',
    );
  });

  it('a completed run is terminal and cannot be reopened', () => {
    const done = transitionRun(run, 'SUPERSEDED');
    assert.throws(() => transitionRun(done, 'COMPLETED'), InvalidTransitionError);
  });

  it('the staleness guard fires on ownership change and on new input', () => {
    assert.deepEqual(checkStalenessGuard(run, { ownershipVersion: 2, lastInboundSeq: 3 }), {
      ok: true,
    });
    assert.deepEqual(checkStalenessGuard(run, { ownershipVersion: 3, lastInboundSeq: 3 }), {
      ok: false,
      reason: 'OWNERSHIP_CHANGED',
    });
    assert.deepEqual(checkStalenessGuard(run, { ownershipVersion: 2, lastInboundSeq: 4 }), {
      ok: false,
      reason: 'NEW_INPUT_ARRIVED',
    });
  });
});

describe('raw event lifecycle', () => {
  const event: RawInboundEvent = {
    id: asId('rie_1'),
    accountId: asId<AccountId>('acc_1'),
    channelConnectionId: asId<ChannelConnectionId>('chc_1'),
    deliveryKey: 'abc',
    payload: {},
    headers: {},
    signatureValid: true,
    state: 'RECEIVED',
    receivedAt: NOW,
    normalizedAt: null,
    producedMessageIds: [],
    error: null,
    normalization: null,
    traceId: asId<TraceId>('trc_1'),
  };

  it('a rejected event can never be normalised', () => {
    const rejected = transitionRawEvent(event, 'REJECTED');
    assert.throws(() => transitionRawEvent(rejected, 'NORMALIZING'), InvalidTransitionError);
  });

  it('NORMALIZING can return to RECEIVED, which is how the reaper recovers a crash', () => {
    const normalizing = transitionRawEvent(event, 'NORMALIZING');
    assert.equal(transitionRawEvent(normalizing, 'RECEIVED').state, 'RECEIVED');
  });

  it('IGNORED and NORMALIZED are terminal', () => {
    const ignored = transitionRawEvent(transitionRawEvent(event, 'NORMALIZING'), 'IGNORED');
    assert.throws(() => transitionRawEvent(ignored, 'NORMALIZED'), InvalidTransitionError);
  });
});
