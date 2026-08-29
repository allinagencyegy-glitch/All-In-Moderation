import type { AccountScope } from '../../core/account/index.ts';
import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import { TerminalError } from '../../platform/errors.ts';
import type {
  ConversationId,
  HandoffId,
  IdFactory,
  KnowledgeEntryId,
  OutboundActionId,
  OutboundActionReviewId,
  UserId,
} from '../../platform/ids.ts';
import { ID_PREFIX, asId } from '../../platform/ids.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';
import type { AuditLog } from '../../operations/audit.ts';
import type { AccountPackRepository } from '../../knowledge/ports.ts';
import type { KnowledgeRepository } from '../../knowledge/ports.ts';
import type { KnowledgeEntry } from '../../knowledge/domain/knowledge-entry.ts';
import { isWithinValidity } from '../../knowledge/domain/knowledge-entry.ts';
import type { Conversation } from '../domain/conversation.ts';
import { transitionOwnership } from '../domain/conversation.ts';
import type { Handoff } from '../domain/handoff.ts';
import type { Message } from '../domain/message.ts';
import type { ModeratorRun } from '../domain/moderator-run.ts';
import type { OutboundAction } from '../domain/outbound-action.ts';
import { transitionOutboundAction } from '../domain/outbound-action.ts';
import type { OutboundActionReview, ReviewDecision } from '../domain/review.ts';
import {
  cancelledReasonForDecision,
  finalTextOf,
  outboundStateForDecision,
} from '../domain/review.ts';
import { resolveEscalationPolicy } from './routing-policy.ts';
import type {
  ConversationRepository,
  HandoffRepository,
  MessageRepository,
  ModeratorRunRepository,
  OutboundActionRepository,
  OutboundActionReviewRepository,
} from '../ports.ts';

/**
 * Human review of suggested replies (ADR-011).
 *
 * This is the surface Phase 02C exists to build, and the one thing it must never become is a
 * sender. Approval writes a state and a review row. It enqueues nothing, calls nothing, and
 * touches no transport — there is none to touch. The final state is named
 * `APPROVED_FOR_MANUAL_SEND` so that the absence is legible in a database dump rather than only
 * in a comment.
 *
 * Two rules keep a review honest:
 *
 *   1. **A reviewer is a person with a name.** `reviewerUserId` is NOT NULL in the port, in the
 *      domain and in the schema. The audit's fifteenth finding was that nobody owned the inbox.
 *   2. **The model's words survive the human's.** An edit is stored beside the original, never
 *      over it. Losing that pairing would destroy the only evidence that could ever justify
 *      giving this account more autonomy than it has.
 */

export interface ReviewQueueItem {
  readonly action: OutboundAction;
  readonly conversation: Conversation;
  /** The customer turns this draft is answering. */
  readonly pendingSince: Date;
}

/** Why a citation the draft named is no longer evidence a reviewer can rely on. */
export type UnusableCitationReason = 'MISSING' | 'NOT_APPROVED' | 'OUT_OF_VALIDITY';

export interface UnusableCitation {
  readonly ref: string;
  readonly reason: UnusableCitationReason;
}

export interface ReviewDetail extends ReviewQueueItem {
  readonly transcript: readonly Message[];
  readonly run: ModeratorRun | null;
  /** Only entries that are still usable. Anything else is reported as unresolved instead. */
  readonly citedKnowledge: readonly KnowledgeEntry[];
  /** Citations the draft named that can no longer be relied on — expired, archived or removed. */
  readonly unresolvedCitations: readonly UnusableCitation[];
  readonly history: readonly OutboundActionReview[];
  /**
   * The text a person is to send by hand, once one has accepted the draft. Derived from the
   * review log rather than stored on the action, so there is exactly one authority for it and it
   * is the append-only, attributed one.
   */
  readonly finalText: string | null;
}

export interface ReviewDecisionInput {
  readonly actionId: OutboundActionId;
  readonly decision: ReviewDecision;
  readonly reviewerUserId: UserId;
  readonly reason?: string;
  /** Required for `EDITED`, refused for every other decision. */
  readonly editedText?: string;
}

export interface ReviewDecisionResult {
  readonly review: OutboundActionReview;
  readonly action: OutboundAction;
  /** The text a person will now send by hand, or null when the draft was not accepted. */
  readonly textForManualSend: string | null;
  readonly handoffId: HandoffId | null;
}

export interface ReviewDeps {
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly runs: ModeratorRunRepository;
  readonly outbound: OutboundActionRepository;
  readonly reviews: OutboundActionReviewRepository;
  readonly handoffs: HandoffRepository;
  readonly knowledge: KnowledgeRepository;
  readonly packs: AccountPackRepository;
  readonly audit: AuditLog;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
}

export interface ReviewService {
  list(scope: AccountScope, limit?: number): Promise<readonly ReviewQueueItem[]>;
  show(scope: AccountScope, id: OutboundActionId): Promise<ReviewDetail>;
  decide(scope: AccountScope, input: ReviewDecisionInput): Promise<ReviewDecisionResult>;
}

const DEFAULT_LIMIT = 50;

/**
 * The text the most recent accepting decision left to be sent by hand.
 *
 * A draft can be reviewed more than once — rejected, reopened by a takeover release, decided
 * again — so the answer is the latest APPROVED or EDITED review, not the first.
 */
function acceptedTextOf(history: readonly OutboundActionReview[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const review = history[index]!;
    if (review.decision === 'APPROVED' || review.decision === 'EDITED') return finalTextOf(review);
  }
  return null;
}

export function createReviewService(deps: ReviewDeps): ReviewService {
  const loadAction = async (scope: AccountScope, id: OutboundActionId): Promise<OutboundAction> => {
    const action = await deps.outbound.findById(scope, id);
    if (!action) {
      throw new TerminalError('OUTBOUND_ACTION_NOT_FOUND', 'No such outbound action', {
        outboundActionId: id,
      });
    }
    return action;
  };

  const loadConversation = async (
    scope: AccountScope,
    id: ConversationId,
  ): Promise<Conversation> => {
    const conversation = await deps.conversations.findById(scope, id);
    if (!conversation) {
      throw new TerminalError('CONVERSATION_NOT_FOUND', 'Conversation does not exist', {
        conversationId: id,
      });
    }
    return conversation;
  };

  return {
    async list(scope, limit) {
      const actions = await deps.outbound.listAwaitingReview(scope, limit ?? DEFAULT_LIMIT);
      const items: ReviewQueueItem[] = [];
      for (const action of actions) {
        const conversation = await deps.conversations.findById(scope, action.conversationId);
        if (!conversation) continue;
        items.push({ action, conversation, pendingSince: action.createdAt });
      }
      return items;
    },

    async show(scope, id) {
      const action = await loadAction(scope, id);
      const conversation = await loadConversation(scope, action.conversationId);
      const transcript = await deps.messages.listByConversation(scope, action.conversationId);
      const run = action.moderatorRunId
        ? await deps.runs.findById(scope, action.moderatorRunId)
        : null;

      // Re-checked *now*, not as they were when the draft was written, and against the same
      // predicate the Knowledge Gate uses. A pack can be republished and an offer can expire
      // between the draft and the review; approving a draft whose evidence has since gone stale
      // would put an out-of-date claim in front of a customer over a human's signature, which is
      // strictly worse than the model having said it.
      const refs = action.payload.review?.knowledgeRefs ?? [];
      const resolved =
        refs.length > 0
          ? await deps.knowledge.findByIds(
              scope,
              refs.map((ref) => asId<KnowledgeEntryId>(ref)),
            )
          : [];
      const byId = new Map(resolved.map((entry) => [entry.id as string, entry]));
      const now = deps.clock.now();
      const history = await deps.reviews.listByAction(scope, id);

      const citedKnowledge: KnowledgeEntry[] = [];
      const unresolvedCitations: UnusableCitation[] = [];
      for (const ref of refs) {
        const entry = byId.get(ref);
        if (!entry) {
          unresolvedCitations.push({ ref, reason: 'MISSING' });
        } else if (entry.status !== 'APPROVED') {
          unresolvedCitations.push({ ref, reason: 'NOT_APPROVED' });
        } else if (!isWithinValidity(entry, now)) {
          unresolvedCitations.push({ ref, reason: 'OUT_OF_VALIDITY' });
        } else {
          citedKnowledge.push(entry);
        }
      }

      return {
        action,
        conversation,
        pendingSince: action.createdAt,
        transcript,
        run,
        citedKnowledge,
        unresolvedCitations,
        history,
        finalText: acceptedTextOf(history),
      };
    },

    async decide(scope, input) {
      if (input.decision === 'EDITED' && !input.editedText?.trim()) {
        throw new TerminalError('REVIEW_EDIT_EMPTY', 'An edited reply must have text', {
          outboundActionId: input.actionId,
        });
      }
      if (input.decision !== 'EDITED' && input.editedText !== undefined) {
        throw new TerminalError(
          'REVIEW_EDIT_NOT_APPLICABLE',
          'editedText is only meaningful for an EDITED decision',
          { decision: input.decision },
        );
      }
      if (
        (input.decision === 'REJECTED' || input.decision === 'ESCALATED') &&
        !input.reason?.trim()
      ) {
        // A rejection with no reason teaches nobody anything, and the knowledge backlog is built
        // out of exactly these sentences.
        throw new TerminalError(
          'REVIEW_REASON_REQUIRED',
          `A ${input.decision} decision must state a reason`,
          { outboundActionId: input.actionId },
        );
      }

      return await deps.transactions.run(async () => {
        const action = await loadAction(scope, input.actionId);

        if (action.deliveryMode !== 'SUGGESTED') {
          throw new TerminalError(
            'REVIEW_NOT_APPLICABLE',
            `Only a SUGGESTED action can be reviewed; this one is ${action.deliveryMode}`,
            { outboundActionId: action.id, deliveryMode: action.deliveryMode },
          );
        }
        if (action.state !== 'SUPPRESSED') {
          // Most often: a human took the conversation over and the takeover cancelled this draft.
          // Refusing here is what stops a stale reply being approved and sent by hand.
          throw new TerminalError(
            'REVIEW_ALREADY_DECIDED',
            `This draft is no longer awaiting review (state ${action.state}${
              action.cancelledReason ? `, ${action.cancelledReason}` : ''
            })`,
            { outboundActionId: action.id, state: action.state },
          );
        }

        const conversation = await loadConversation(scope, action.conversationId);

        // The second staleness check, and the one that matters when a takeover raced the review
        // rather than preceding it.
        if (
          (input.decision === 'APPROVED' || input.decision === 'EDITED') &&
          conversation.ownership === 'HUMAN_OWNED'
        ) {
          throw new TerminalError(
            'REVIEW_CONVERSATION_TAKEN_OVER',
            'A person owns this conversation; the draft is stale and cannot be approved',
            { conversationId: conversation.id, ownerUserId: conversation.ownerUserId },
          );
        }

        const now = deps.clock.now();
        const review: OutboundActionReview = {
          id: deps.ids.next<OutboundActionReviewId>(ID_PREFIX.outboundActionReview),
          accountId: scope.accountId,
          outboundActionId: action.id,
          conversationId: action.conversationId,
          decision: input.decision,
          reviewerUserId: input.reviewerUserId,
          reason: input.reason?.trim() ?? null,
          originalText: action.payload.text ?? null,
          editedText: input.decision === 'EDITED' ? input.editedText!.trim() : null,
          decidedAt: now,
        };
        await deps.reviews.save(scope, review);

        const nextState = outboundStateForDecision(input.decision);
        const cancelledReason = cancelledReasonForDecision(input.decision);
        const accepted = nextState === 'APPROVED_FOR_MANUAL_SEND';
        const textForManualSend = accepted ? (review.editedText ?? review.originalText) : null;

        // The payload is not touched at all. An edit lives in the review row beside the original
        // — one append-only, attributed record answering both "what did the model write" and
        // "what will actually be sent". Writing a second copy onto the action would also be
        // silently dropped: `outbound:save` upserts state and delivery bookkeeping only.
        const decidedAction = transitionOutboundAction(
          action,
          nextState,
          cancelledReason !== null ? { cancelledReason } : {},
        );
        await deps.outbound.save(scope, decidedAction);

        let handoffId: HandoffId | null = null;
        if (input.decision === 'ESCALATED') {
          const pack = await deps.packs.findActive(scope);
          const escalation = resolveEscalationPolicy(pack);
          const handoff: Handoff = {
            id: deps.ids.next<HandoffId>(ID_PREFIX.handoff),
            accountId: scope.accountId,
            conversationId: conversation.id,
            kind: 'HUMAN_AGENT',
            state: 'REQUESTED',
            reasonCode: (input.reason ?? 'escalated by reviewer').slice(0, 64),
            urgency: 'HIGH',
            targetQueue: null,
            assignedUserId: null,
            contextSummary: {
              surface: conversation.surface,
              reason: input.reason ?? 'escalated by reviewer',
              outbound_action_id: action.id,
            },
            triggeringRunId: action.moderatorRunId,
            requestedAt: now,
            assignedAt: null,
            acceptedAt: null,
            completedAt: null,
            slaDueAt: new Date(now.getTime() + escalation.handoffSlaMs),
          };
          await deps.handoffs.save(scope, handoff);
          handoffId = handoff.id;

          if (conversation.ownership === 'AI_OWNED') {
            const transitioned = transitionOwnership(conversation, {
              to: 'PENDING_HUMAN',
              actorKind: 'HUMAN',
              actorUserId: input.reviewerUserId,
              reason: input.reason ?? 'escalated by reviewer',
              at: now,
            });
            await deps.conversations.appendOwnershipTransition(scope, transitioned.record);
            await deps.conversations.save(scope, transitioned.conversation);
          }
        }

        await deps.audit.append(scope, {
          action: 'outbound_action.reviewed',
          subjectType: 'outbound_action',
          subjectId: action.id,
          actorKind: 'HUMAN',
          actorUserId: input.reviewerUserId,
          detail: {
            decision: input.decision,
            state: decidedAction.state,
            edited: review.editedText !== null,
            conversation_id: action.conversationId,
            moderator_run_id: action.moderatorRunId,
            reason: review.reason,
          },
          occurredAt: now,
        });

        deps.logger.info('suggested reply reviewed', {
          account_id: scope.accountId,
          outbound_action_id: action.id,
          decision: input.decision,
          state: decidedAction.state,
          reviewer: input.reviewerUserId,
        });

        return { review, action: decidedAction, textForManualSend, handoffId };
      });
    },
  };
}
