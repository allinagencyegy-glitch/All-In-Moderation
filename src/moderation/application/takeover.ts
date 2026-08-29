import type { AccountScope } from '../../core/account/index.ts';
import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import { ConcurrencyConflictError, TerminalError } from '../../platform/errors.ts';
import type { ConversationId, IdFactory, MessageId, UserId } from '../../platform/ids.ts';
import { ID_PREFIX } from '../../platform/ids.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';
import type { AuditLog } from '../../operations/audit.ts';
import { transitionOwnership } from '../domain/conversation.ts';
import type { Conversation } from '../domain/conversation.ts';
import { transitionHandoff } from '../domain/handoff.ts';
import type { Message } from '../domain/message.ts';
import { transitionOutboundAction } from '../domain/outbound-action.ts';
import type {
  ConversationRepository,
  HandoffRepository,
  MessageRepository,
  OutboundActionRepository,
} from '../ports.ts';

/**
 * Human takeover and release (ADR-008).
 *
 * The safety property this file exists for: **an operator must never have to remember to click a
 * button to stop the AI talking over them.** Sending a message is itself a takeover.
 *
 * Two mechanisms do the work together:
 *   1. `ownershipVersion` is bumped here, which causes any in-flight moderator run to fail its
 *      staleness guard at commit and produce nothing (F-13).
 *   2. Outbound actions already queued but not yet delivered are cancelled with an explicit
 *      reason, so a decision made *before* the takeover cannot still reach the customer.
 */

export interface TakeoverDeps {
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly outbound: OutboundActionRepository;
  readonly handoffs: HandoffRepository;
  readonly audit: AuditLog;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
}

export interface TakeoverService {
  takeOver(
    scope: AccountScope,
    conversationId: ConversationId,
    userId: UserId,
    reason: string,
  ): Promise<Conversation>;
  release(
    scope: AccountScope,
    conversationId: ConversationId,
    userId: UserId,
    reason: string,
  ): Promise<Conversation>;
  /** Sending as a human implies takeover. There is no way to send without acquiring ownership. */
  sendAsHuman(
    scope: AccountScope,
    conversationId: ConversationId,
    userId: UserId,
    text: string,
  ): Promise<{ conversation: Conversation; message: Message }>;
}

export function createTakeoverService(deps: TakeoverDeps): TakeoverService {
  const load = async (
    scope: AccountScope,
    conversationId: ConversationId,
  ): Promise<Conversation> => {
    const conversation = await deps.conversations.findById(scope, conversationId);
    if (!conversation) {
      throw new TerminalError('CONVERSATION_NOT_FOUND', 'Conversation does not exist', {
        conversationId,
      });
    }
    return conversation;
  };

  const acquire = async (
    scope: AccountScope,
    conversation: Conversation,
    userId: UserId,
    reason: string,
  ): Promise<Conversation> => {
    if (conversation.ownership === 'HUMAN_OWNED') {
      if (conversation.ownerUserId === userId) return conversation;
      // A second operator taking over from the first is legitimate, but it is a real transition
      // and must be auditable — so it goes through release-then-acquire rather than a silent swap.
      const released = transitionOwnership(conversation, {
        to: 'AI_OWNED',
        actorKind: 'HUMAN',
        actorUserId: conversation.ownerUserId ?? userId,
        reason: `reassignment to ${userId}`,
        at: deps.clock.now(),
      });
      await deps.conversations.appendOwnershipTransition(scope, released.record);
      conversation = released.conversation;
    }

    const expectedVersion = conversation.ownershipVersion;
    const taken = transitionOwnership(conversation, {
      to: 'HUMAN_OWNED',
      actorKind: 'HUMAN',
      actorUserId: userId,
      reason,
      at: deps.clock.now(),
    });
    await deps.conversations.appendOwnershipTransition(scope, taken.record);
    // Compare-and-swap: two operators clicking at once, or an operator racing a moderator run's
    // commit, must produce one winner and one caller that re-reads — never two writes where the
    // last one silently wins.
    const applied = await deps.conversations.saveIfUnchanged(
      scope,
      taken.conversation,
      expectedVersion,
    );
    if (!applied) throw new ConcurrencyConflictError('conversation', expectedVersion);

    // Cancel anything the AI decided before the takeover but has not yet reached a customer.
    //
    // `SUPPRESSED` belongs here as much as `PENDING_DISPATCH` does. A suggested draft is an
    // answer to a conversation as it stood before a person picked it up; leaving it in the review
    // queue means someone can approve stale text hours later and send it by hand, which is the
    // same failure as the AI talking over a human, only slower and with a name attached to it.
    const pending = await deps.outbound.listByConversation(scope, conversation.id);
    for (const action of pending) {
      if (action.state !== 'PENDING_DISPATCH' && action.state !== 'SUPPRESSED') continue;
      await deps.outbound.save(
        scope,
        transitionOutboundAction(action, 'CANCELLED', { cancelledReason: 'HUMAN_TOOK_OVER' }),
      );
    }

    // Accepting an open handoff is the natural meaning of taking over.
    for (const handoff of await deps.handoffs.listOpenByConversation(scope, conversation.id)) {
      if (handoff.state === 'REQUESTED' || handoff.state === 'ASSIGNED') {
        await deps.handoffs.save(
          scope,
          transitionHandoff(handoff, 'ACCEPTED', {
            assignedUserId: userId,
            acceptedAt: deps.clock.now(),
          }),
        );
      }
    }

    await deps.audit.append(scope, {
      action: 'conversation.ownership_changed',
      subjectType: 'conversation',
      subjectId: conversation.id,
      actorKind: 'HUMAN',
      actorUserId: userId,
      detail: { to: 'HUMAN_OWNED', reason, version: taken.conversation.ownershipVersion },
      occurredAt: deps.clock.now(),
    });

    return taken.conversation;
  };

  return {
    async takeOver(scope, conversationId, userId, reason) {
      return await deps.transactions.run(async () => {
        const conversation = await load(scope, conversationId);
        const result = await acquire(scope, conversation, userId, reason);
        deps.logger.info('human took over conversation', {
          account_id: scope.accountId,
          conversation_id: conversationId,
          ownership_version: result.ownershipVersion,
        });
        return result;
      });
    },

    async release(scope, conversationId, userId, reason) {
      return await deps.transactions.run(async () => {
        const conversation = await load(scope, conversationId);
        if (conversation.ownership === 'AI_OWNED') return conversation;
        const released = transitionOwnership(conversation, {
          to: 'AI_OWNED',
          actorKind: 'HUMAN',
          actorUserId: userId,
          reason,
          at: deps.clock.now(),
        });
        await deps.conversations.appendOwnershipTransition(scope, released.record);
        await deps.conversations.save(scope, released.conversation);

        for (const handoff of await deps.handoffs.listOpenByConversation(scope, conversationId)) {
          if (handoff.state === 'ACCEPTED') {
            await deps.handoffs.save(
              scope,
              transitionHandoff(handoff, 'COMPLETED', { completedAt: deps.clock.now() }),
            );
          }
        }

        await deps.audit.append(scope, {
          action: 'conversation.ownership_changed',
          subjectType: 'conversation',
          subjectId: conversationId,
          actorKind: 'HUMAN',
          actorUserId: userId,
          detail: { to: 'AI_OWNED', reason, version: released.conversation.ownershipVersion },
          occurredAt: deps.clock.now(),
        });
        return released.conversation;
      });
    },

    async sendAsHuman(scope, conversationId, userId, text) {
      return await deps.transactions.run(async () => {
        const loaded = await load(scope, conversationId);
        // Implicit takeover, before the message exists. Ordering matters: acquiring ownership
        // first is what guarantees a concurrent AI run cannot commit between the two writes.
        const conversation = await acquire(scope, loaded, userId, 'operator sent a message');

        const seq = conversation.nextSeq;
        const message: Message = {
          id: deps.ids.next<MessageId>(ID_PREFIX.message),
          accountId: scope.accountId,
          conversationId,
          seq,
          direction: 'OUTBOUND',
          authorKind: 'HUMAN_AGENT',
          authorUserId: userId,
          channel: 'TEST',
          providerMessageId: null,
          dedupeKey: `human:${conversationId}:${seq}`,
          dedupeSource: 'DERIVED',
          contentType: 'TEXT',
          text,
          attachments: [],
          providerTs: deps.clock.now(),
          receivedAt: deps.clock.now(),
          rawInboundEventId: null,
          outboundActionId: null,
          // An operator's own message came from a person, not from a provider envelope. There is
          // no provenance to record, and inventing one would make it indistinguishable from an
          // inbound message that really did arrive over a transport.
          providerContext: {},
          redactedAt: null,
        };
        await deps.messages.insertIfNew(scope, message);
        await deps.conversations.save(scope, {
          ...conversation,
          nextSeq: seq + 1,
          engagement: 'AWAITING_CUSTOMER',
          lastMessageAt: deps.clock.now(),
        });

        await deps.audit.append(scope, {
          action: 'conversation.human_message_sent',
          subjectType: 'conversation',
          subjectId: conversationId,
          actorKind: 'HUMAN',
          actorUserId: userId,
          detail: { seq },
          occurredAt: deps.clock.now(),
        });

        return { conversation, message };
      });
    },
  };
}
