import type { AccountScope } from '../../core/account/index.ts';
import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import type {
  ConversationId,
  DomainEventId,
  HandoffId,
  IdFactory,
  TraceId,
} from '../../platform/ids.ts';
import { ID_PREFIX } from '../../platform/ids.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';
import type { AuditLog } from '../../operations/audit.ts';
import type { EventOutbox } from '../../operations/events/outbox.ts';
import { assertPublishable } from '../../operations/events/outbox.ts';
import type { AccountPackRepository } from '../../knowledge/ports.ts';
import { transitionOwnership } from '../domain/conversation.ts';
import type { Handoff } from '../domain/handoff.ts';
import type { ConversationRepository, HandoffRepository } from '../ports.ts';
import { resolveEscalationPolicy } from './routing-policy.ts';

/**
 * The last-resort escalation: when the moderator cannot work, a human is asked to.
 *
 * This closes the most important line in STATE-MACHINES.md — `ModeratorRun: FAILED ->
 * DEAD_LETTERED` must raise a handoff. Without it, a customer whose conversation hit an
 * unrecoverable model or infrastructure failure would sit in a queue that quietly ended, which is
 * precisely the silent failure this platform is built to eliminate.
 *
 * It is deliberately a separate service rather than logic inside the worker: the worker is
 * generic infrastructure and must not know what a conversation is.
 */

export const AI_UNAVAILABLE_REASON = 'AI_UNAVAILABLE';

export interface EscalationDeps {
  readonly conversations: ConversationRepository;
  readonly handoffs: HandoffRepository;
  readonly packs: AccountPackRepository;
  readonly outbox: EventOutbox;
  readonly audit: AuditLog;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
}

export interface EscalationService {
  escalateUnrecoverable(
    scope: AccountScope,
    conversationId: ConversationId,
    error: { code: string; message: string },
  ): Promise<Handoff | null>;
}

export function createEscalationService(deps: EscalationDeps): EscalationService {
  return {
    async escalateUnrecoverable(scope, conversationId, error) {
      return await deps.transactions.run(async () => {
        const conversation = await deps.conversations.findById(scope, conversationId);
        if (!conversation) {
          deps.logger.error('cannot escalate: conversation missing', {
            account_id: scope.accountId,
            conversation_id: conversationId,
          });
          return null;
        }

        // Idempotent: a redelivered dead-letter must not stack handoffs on one conversation.
        const open = await deps.handoffs.listOpenByConversation(scope, conversationId);
        if (open.some((h) => h.reasonCode === AI_UNAVAILABLE_REASON)) {
          return open.find((h) => h.reasonCode === AI_UNAVAILABLE_REASON) ?? null;
        }

        const now = deps.clock.now();
        const policy = resolveEscalationPolicy(await deps.packs.findActive(scope));
        const handoff: Handoff = {
          id: deps.ids.next<HandoffId>(ID_PREFIX.handoff),
          accountId: scope.accountId,
          conversationId,
          kind: 'HUMAN_AGENT',
          state: 'REQUESTED',
          reasonCode: AI_UNAVAILABLE_REASON,
          urgency: 'HIGH',
          targetQueue: null,
          assignedUserId: null,
          contextSummary: { failure: error.code, detail: error.message.slice(0, 500) },
          triggeringRunId: null,
          requestedAt: now,
          assignedAt: null,
          acceptedAt: null,
          completedAt: null,
          slaDueAt: new Date(now.getTime() + policy.handoffSlaMs),
        };
        await deps.handoffs.save(scope, handoff);

        // Only AI-owned conversations change ownership: if a human already holds it, they are
        // already handling it and re-transitioning would be a spurious audit entry.
        if (conversation.ownership === 'AI_OWNED') {
          const transitioned = transitionOwnership(conversation, {
            to: 'PENDING_HUMAN',
            actorKind: 'SYSTEM',
            reason: AI_UNAVAILABLE_REASON,
            at: now,
          });
          await deps.conversations.appendOwnershipTransition(scope, transitioned.record);
          await deps.conversations.save(scope, transitioned.conversation);
        }

        const envelope = {
          eventId: deps.ids.next<DomainEventId>(ID_PREFIX.domainEvent),
          type: 'handoff.failed' as const,
          version: 1,
          occurredAt: now,
          accountId: scope.accountId,
          subject: { type: 'conversation', id: conversationId },
          traceId: deps.ids.next<TraceId>(ID_PREFIX.trace),
          data: {
            conversation_id: conversationId,
            handoff_id: handoff.id,
            terminal_reason: `${error.code}: ${error.message}`.slice(0, 200),
          },
        };
        assertPublishable(envelope);
        await deps.outbox.append(scope, envelope);

        await deps.audit.append(scope, {
          action: 'moderator.run_skipped',
          subjectType: 'conversation',
          subjectId: conversationId,
          actorKind: 'SYSTEM',
          actorUserId: null,
          detail: { reason: AI_UNAVAILABLE_REASON, error: error.code },
          occurredAt: now,
        });

        deps.logger.error('moderator work dead-lettered; human escalation raised', {
          account_id: scope.accountId,
          conversation_id: conversationId,
          handoff_id: handoff.id,
          error_code: error.code,
        });

        return handoff;
      });
    },
  };
}
