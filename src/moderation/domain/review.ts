import type {
  AccountId,
  ConversationId,
  OutboundActionId,
  OutboundActionReviewId,
  UserId,
} from '../../platform/ids.ts';
import type { OutboundActionState } from './outbound-action.ts';

/**
 * Human review of a suggested reply (ADR-011).
 *
 * The moderator drafts; a named person decides. This module is the record of that decision, and
 * it is append-only for a reason: "the model proposed X, the reviewer sent Y" is the only dataset
 * that can ever tell us whether this account is ready for more autonomy than it has. Overwriting
 * a review would destroy exactly the evidence the next phase needs.
 *
 * Note what a decision *is not*: it is not a dispatch. `APPROVED` and `EDITED` both move the
 * action to `APPROVED_FOR_MANUAL_SEND`, which is terminal. A person then sends the text
 * themselves from Meta Inbox, because this system has no transport that could do it for them.
 */

export const REVIEW_DECISIONS = ['APPROVED', 'EDITED', 'REJECTED', 'ESCALATED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface OutboundActionReview {
  readonly id: OutboundActionReviewId;
  readonly accountId: AccountId;
  readonly outboundActionId: OutboundActionId;
  readonly conversationId: ConversationId;
  readonly decision: ReviewDecision;
  /** NOT NULL. An anonymous approval is not an approval — issue #15 in the audit was ownership. */
  readonly reviewerUserId: UserId;
  readonly reason: string | null;
  /** Exactly what the model proposed. Never rewritten. */
  readonly originalText: string | null;
  /** What the reviewer intends to send, when they changed it. Null when they did not. */
  readonly editedText: string | null;
  readonly decidedAt: Date;
}

/**
 * Where a decision leaves the action.
 *
 * `ESCALATED` cancels the draft rather than approving it: the reviewer is saying "this needs a
 * person to handle the conversation", not "send this text".
 */
export function outboundStateForDecision(decision: ReviewDecision): OutboundActionState {
  switch (decision) {
    case 'APPROVED':
    case 'EDITED':
      return 'APPROVED_FOR_MANUAL_SEND';
    case 'REJECTED':
    case 'ESCALATED':
      return 'CANCELLED';
  }
}

/** The `cancelledReason` recorded when a decision cancels the draft. */
export function cancelledReasonForDecision(decision: ReviewDecision): string | null {
  switch (decision) {
    case 'REJECTED':
      return 'REJECTED_BY_REVIEWER';
    case 'ESCALATED':
      return 'ESCALATED_BY_REVIEWER';
    case 'APPROVED':
    case 'EDITED':
      return null;
  }
}

/** The text a person will actually send: their edit if they made one, otherwise the draft. */
export function finalTextOf(review: OutboundActionReview): string | null {
  return review.editedText ?? review.originalText;
}
