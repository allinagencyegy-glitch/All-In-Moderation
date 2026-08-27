import type {
  AccountId,
  ConversationId,
  HandoffId,
  ModeratorRunId,
  UserId,
} from '../../platform/ids.ts';
import { InvalidTransitionError } from '../../platform/errors.ts';

export const HANDOFF_STATES = [
  'REQUESTED',
  'ASSIGNED',
  'ACCEPTED',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

export type HandoffKind = 'HUMAN_AGENT' | 'SALES' | 'SUPPORT' | 'VENDOR' | 'EXTERNAL_SYSTEM';

/**
 * A first-class escalation record rather than a boolean on the conversation.
 *
 * "Why did the AI hand this over, and how long did a human take to pick it up?" is a core
 * operational metric and is unanswerable from a flag. It also lets handoff *failure* be an event
 * in its own right — the case where nobody accepts is exactly the one that must not be silent.
 */
export interface Handoff {
  readonly id: HandoffId;
  readonly accountId: AccountId;
  readonly conversationId: ConversationId;
  readonly kind: HandoffKind;
  readonly state: HandoffState;
  readonly reasonCode: string;
  readonly urgency: 'LOW' | 'NORMAL' | 'HIGH';
  readonly targetQueue: string | null;
  readonly assignedUserId: UserId | null;
  readonly contextSummary: Readonly<Record<string, unknown>>;
  readonly triggeringRunId: ModeratorRunId | null;
  readonly requestedAt: Date;
  readonly assignedAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly completedAt: Date | null;
  readonly slaDueAt: Date | null;
}

const TRANSITIONS: Readonly<Record<HandoffState, readonly HandoffState[]>> = {
  REQUESTED: ['ASSIGNED', 'ACCEPTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  ASSIGNED: ['ASSIGNED', 'ACCEPTED', 'EXPIRED', 'CANCELLED', 'FAILED'],
  ACCEPTED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  EXPIRED: [],
  CANCELLED: [],
  FAILED: [],
};

export function isOpenHandoff(state: HandoffState): boolean {
  return state === 'REQUESTED' || state === 'ASSIGNED' || state === 'ACCEPTED';
}

export function transitionHandoff(
  handoff: Handoff,
  to: HandoffState,
  patch: Partial<
    Pick<Handoff, 'assignedUserId' | 'targetQueue' | 'assignedAt' | 'acceptedAt' | 'completedAt'>
  > = {},
): Handoff {
  if (!TRANSITIONS[handoff.state].includes(to)) {
    throw new InvalidTransitionError('Handoff', handoff.state, to);
  }
  if (to === 'ACCEPTED' && !(patch.assignedUserId ?? handoff.assignedUserId)) {
    throw new InvalidTransitionError('Handoff', handoff.state, to, 'ACCEPTED requires an assignee');
  }
  return { ...handoff, ...patch, state: to };
}

/**
 * An escalation chain must always terminate at a human, never at a system that might be down.
 * When an external target fails permanently, the fallback is a HUMAN_AGENT handoff.
 */
export function fallbackKindFor(kind: HandoffKind): HandoffKind | null {
  return kind === 'HUMAN_AGENT' ? null : 'HUMAN_AGENT';
}
