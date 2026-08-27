import type {
  AccountId,
  ChannelConnectionId,
  ChannelIdentityId,
  ContactIdentityId,
  ConversationId,
  ModeratorRunId,
  UserId,
} from '../../platform/ids.ts';
import { InvalidTransitionError } from '../../platform/errors.ts';
import type { Surface } from '../../core/channel.ts';
import type {
  ConversationEngagement,
  ConversationLifecycle,
  ConversationOwnership,
} from '../../core/conversation-state.ts';
import { ownershipPermitsAutonomy } from '../../core/conversation-state.ts';

/**
 * Conversation state, decomposed into three orthogonal axes (ADR-008).
 *
 * The brief proposed a single flat enum. Analysed, that list answers three different questions —
 * "is this conversation active?", "who may speak?", and "whose turn is it?" — and squashing them
 * into one field forces either combinatorial states or lying about authority. When the lie is
 * about authority, the customer gets two replies. So: three fields, one derived label for humans.
 */

export type {
  ConversationEngagement,
  ConversationLifecycle,
  ConversationOwnership,
} from '../../core/conversation-state.ts';
export {
  ENGAGEMENT_STATES,
  LIFECYCLE_STATES,
  OWNERSHIP_STATES,
} from '../../core/conversation-state.ts';

export interface Conversation {
  readonly id: ConversationId;
  readonly accountId: AccountId;
  readonly channelConnectionId: ChannelConnectionId;
  readonly channelIdentityId: ChannelIdentityId;
  readonly contactIdentityId: ContactIdentityId | null;
  readonly surface: Surface;
  readonly threadRef: string | null;

  readonly lifecycle: ConversationLifecycle;
  readonly ownership: ConversationOwnership;
  /** Bumped on every ownership change. The guard that makes takeover-during-generation safe. */
  readonly ownershipVersion: number;
  readonly ownerUserId: UserId | null;
  readonly engagement: ConversationEngagement;

  /** Allocator for message `seq`. Always greater than `lastInboundSeq`. */
  readonly nextSeq: number;
  readonly lastInboundSeq: number;
  /** The watermark. Only advances inside the transaction that records a run's outcome. */
  readonly lastProcessedInboundSeq: number;

  readonly locale: string | null;
  readonly snoozedUntil: Date | null;
  readonly closedAt: Date | null;
  readonly firstMessageAt: Date | null;
  readonly lastMessageAt: Date | null;
  readonly createdAt: Date;
}

// --- invariants -------------------------------------------------------------------------------

export function assertConversationInvariants(c: Conversation): void {
  if (c.lastProcessedInboundSeq > c.lastInboundSeq) {
    throw new Error(
      `Conversation ${c.id}: watermark ${c.lastProcessedInboundSeq} exceeds last inbound ${c.lastInboundSeq}`,
    );
  }
  if (c.lastInboundSeq >= c.nextSeq) {
    throw new Error(
      `Conversation ${c.id}: lastInboundSeq ${c.lastInboundSeq} >= nextSeq ${c.nextSeq}`,
    );
  }
  const humanOwned = c.ownership === 'HUMAN_OWNED';
  if (humanOwned !== (c.ownerUserId !== null)) {
    throw new Error(`Conversation ${c.id}: ownerUserId must be set iff ownership is HUMAN_OWNED`);
  }
}

export function hasUnprocessedInbound(c: Conversation): boolean {
  return c.lastInboundSeq > c.lastProcessedInboundSeq;
}

// --- axis 1: lifecycle ------------------------------------------------------------------------

const LIFECYCLE_TRANSITIONS: Readonly<
  Record<ConversationLifecycle, readonly ConversationLifecycle[]>
> = {
  OPEN: ['SNOOZED', 'CLOSED'],
  SNOOZED: ['OPEN', 'CLOSED'],
  // CLOSED is not terminal: a customer replying to a "resolved" thread is the most ordinary
  // event in messaging, and treating it as terminal would drop that message.
  CLOSED: ['OPEN'],
};

export function transitionLifecycle(
  c: Conversation,
  to: ConversationLifecycle,
  at: Date,
  snoozedUntil?: Date,
): Conversation {
  if (c.lifecycle === to) return c;
  if (!LIFECYCLE_TRANSITIONS[c.lifecycle].includes(to)) {
    throw new InvalidTransitionError('Conversation.lifecycle', c.lifecycle, to);
  }
  if (to === 'SNOOZED') {
    if (!snoozedUntil || snoozedUntil <= at) {
      throw new InvalidTransitionError(
        'Conversation.lifecycle',
        c.lifecycle,
        to,
        'snoozedUntil must be in the future',
      );
    }
    return { ...c, lifecycle: to, snoozedUntil, closedAt: null };
  }
  if (to === 'CLOSED') {
    return { ...c, lifecycle: to, closedAt: at, snoozedUntil: null };
  }
  return { ...c, lifecycle: to, closedAt: null, snoozedUntil: null };
}

// --- axis 2: ownership (safety critical) ------------------------------------------------------

export type OwnershipActorKind = 'HUMAN' | 'POLICY' | 'SYSTEM';

export interface OwnershipTransitionInput {
  readonly to: ConversationOwnership;
  readonly actorKind: OwnershipActorKind;
  readonly actorUserId?: UserId;
  readonly reason: string;
  readonly moderatorRunId?: ModeratorRunId;
  readonly at: Date;
  /** Only `PENDING_HUMAN -> AI_OWNED` may be automatic, and only when the account opts in. */
  readonly allowPolicyFallbackToAi?: boolean;
}

export interface OwnershipTransitionRecord {
  readonly conversationId: ConversationId;
  readonly accountId: AccountId;
  readonly fromOwnership: ConversationOwnership;
  readonly toOwnership: ConversationOwnership;
  readonly version: number;
  readonly actorKind: OwnershipActorKind;
  readonly actorUserId: UserId | null;
  readonly reason: string;
  readonly moderatorRunId: ModeratorRunId | null;
  readonly createdAt: Date;
}

const OWNERSHIP_TRANSITIONS: Readonly<
  Record<ConversationOwnership, readonly ConversationOwnership[]>
> = {
  AI_OWNED: ['PENDING_HUMAN', 'HUMAN_OWNED'],
  PENDING_HUMAN: ['HUMAN_OWNED', 'AI_OWNED'],
  HUMAN_OWNED: ['AI_OWNED'],
};

export function transitionOwnership(
  c: Conversation,
  input: OwnershipTransitionInput,
): { conversation: Conversation; record: OwnershipTransitionRecord } {
  const from = c.ownership;
  if (from === input.to) {
    throw new InvalidTransitionError('Conversation.ownership', from, input.to, 'already in state');
  }
  if (!OWNERSHIP_TRANSITIONS[from].includes(input.to)) {
    throw new InvalidTransitionError('Conversation.ownership', from, input.to);
  }
  if (input.to === 'HUMAN_OWNED' && !input.actorUserId) {
    throw new InvalidTransitionError(
      'Conversation.ownership',
      from,
      input.to,
      'HUMAN_OWNED requires an actorUserId',
    );
  }
  // The only automatic return of authority to the AI is out of PENDING_HUMAN, and only when the
  // account has opted in. Silently resuming autonomous replies in a conversation a human was
  // handling is the failure operators do not forgive.
  if (input.to === 'AI_OWNED' && input.actorKind !== 'HUMAN') {
    if (from !== 'PENDING_HUMAN' || input.allowPolicyFallbackToAi !== true) {
      throw new InvalidTransitionError(
        'Conversation.ownership',
        from,
        input.to,
        'returning ownership to AI requires an explicit human actor, or an opted-in PENDING_HUMAN fallback',
      );
    }
  }

  const version = c.ownershipVersion + 1;
  const conversation: Conversation = {
    ...c,
    ownership: input.to,
    ownershipVersion: version,
    ownerUserId: input.to === 'HUMAN_OWNED' ? (input.actorUserId ?? null) : null,
  };
  const record: OwnershipTransitionRecord = {
    conversationId: c.id,
    accountId: c.accountId,
    fromOwnership: from,
    toOwnership: input.to,
    version,
    actorKind: input.actorKind,
    actorUserId: input.actorUserId ?? null,
    reason: input.reason,
    moderatorRunId: input.moderatorRunId ?? null,
    createdAt: input.at,
  };
  return { conversation, record };
}

/**
 * The single predicate that authorises autonomous outbound. Checked twice — at run admission and
 * again inside the action gate — because this is invariant I5.
 */
export function mayActAutonomously(c: Conversation): boolean {
  return ownershipPermitsAutonomy(c.ownership, c.lifecycle);
}

// --- axis 3: engagement -----------------------------------------------------------------------

export function withEngagement(c: Conversation, engagement: ConversationEngagement): Conversation {
  return c.engagement === engagement ? c : { ...c, engagement };
}

/** Recomputes engagement from facts. Derived, never authoritative. */
export function deriveEngagement(c: Conversation): ConversationEngagement {
  if (c.engagement === 'AWAITING_EXTERNAL') return 'AWAITING_EXTERNAL';
  if (hasUnprocessedInbound(c)) return 'AWAITING_MODERATOR';
  return c.engagement === 'AWAITING_CUSTOMER' ? 'AWAITING_CUSTOMER' : 'IDLE';
}

// --- derived operator label -------------------------------------------------------------------

export const OPERATOR_STATUSES = [
  'AI_OWNED',
  'WAITING_CUSTOMER',
  'QUALIFYING',
  'WAITING_HUMAN',
  'HUMAN_OWNED',
  'WAITING_EXTERNAL_SYSTEM',
  'SNOOZED',
  'CLOSED',
] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];

/**
 * The vocabulary from the brief, preserved for humans and reporting — computed, never stored.
 *
 * Keeping it as a pure function is the point: operators keep familiar words, while the machine
 * keeps unambiguous state.
 */
export function operatorStatus(c: Conversation, hasActiveQualification = false): OperatorStatus {
  if (c.lifecycle === 'CLOSED') return 'CLOSED';
  if (c.lifecycle === 'SNOOZED') return 'SNOOZED';
  if (c.ownership === 'PENDING_HUMAN') return 'WAITING_HUMAN';
  if (c.ownership === 'HUMAN_OWNED') return 'HUMAN_OWNED';
  if (c.engagement === 'AWAITING_EXTERNAL') return 'WAITING_EXTERNAL_SYSTEM';
  if (hasActiveQualification) return 'QUALIFYING';
  if (c.engagement === 'AWAITING_CUSTOMER') return 'WAITING_CUSTOMER';
  return 'AI_OWNED';
}
