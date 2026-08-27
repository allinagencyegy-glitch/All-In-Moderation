/**
 * Shared conversation-state vocabulary.
 *
 * A deliberate shared-kernel split: the *vocabulary* of the three state axes lives here because
 * `policy` must reason about authority and cannot depend on `moderation` (ADR-001), while all the
 * *behaviour* — transitions, invariants, the derived operator label — stays in
 * `moderation/domain/conversation.ts`, which owns the aggregate.
 *
 * Types shared; behaviour owned. Nothing in this file makes a decision.
 */

export const LIFECYCLE_STATES = ['OPEN', 'SNOOZED', 'CLOSED'] as const;
export type ConversationLifecycle = (typeof LIFECYCLE_STATES)[number];

export const OWNERSHIP_STATES = ['AI_OWNED', 'PENDING_HUMAN', 'HUMAN_OWNED'] as const;
export type ConversationOwnership = (typeof OWNERSHIP_STATES)[number];

export const ENGAGEMENT_STATES = [
  'AWAITING_MODERATOR',
  'AWAITING_CUSTOMER',
  'AWAITING_EXTERNAL',
  'IDLE',
] as const;
export type ConversationEngagement = (typeof ENGAGEMENT_STATES)[number];

/**
 * The authority predicate, defined once so that every check in the system is checking the same
 * thing. Invariant I5 requires it to be evaluated at two independent points — run admission and
 * the action gate — but both must agree on what "may act" means.
 */
export function ownershipPermitsAutonomy(
  ownership: ConversationOwnership,
  lifecycle: ConversationLifecycle,
): boolean {
  return ownership === 'AI_OWNED' && lifecycle !== 'CLOSED';
}
