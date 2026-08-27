import type {
  AccountId,
  ConversationId,
  ModeratorRunId,
  OutboundActionId,
} from '../../platform/ids.ts';
import { InvalidTransitionError } from '../../platform/errors.ts';
import type { ActionType } from '../../policy/actions.ts';
import type { AuthorizedAction } from '../../policy/action-gate.ts';

export const OUTBOUND_ACTION_STATES = [
  'PENDING_DISPATCH',
  'DISPATCHING',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
  'SUPPRESSED',
  'SIMULATED',
  'PENDING_RECONCILIATION',
] as const;
export type OutboundActionState = (typeof OUTBOUND_ACTION_STATES)[number];

export type DeliveryMode = 'AUTONOMOUS' | 'SUGGESTED' | 'SIMULATED';

export interface OutboundActionPayload {
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly handoffReason?: string;
  readonly capturedFields?: Readonly<Record<string, string>>;
}

export interface OutboundAction {
  readonly id: OutboundActionId;
  readonly accountId: AccountId;
  readonly conversationId: ConversationId;
  readonly moderatorRunId: ModeratorRunId | null;
  readonly actionType: ActionType;
  readonly deliveryMode: DeliveryMode;
  readonly state: OutboundActionState;
  /** Stable and deterministic, so a retry after an ambiguous timeout is reconcilable (ADR-006). */
  readonly idempotencyKey: string;
  readonly payload: OutboundActionPayload;
  readonly providerMessageId: string | null;
  readonly attempt: number;
  readonly lastError: { readonly code: string; readonly message: string } | null;
  readonly cancelledReason: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
}

const TRANSITIONS: Readonly<Record<OutboundActionState, readonly OutboundActionState[]>> = {
  PENDING_DISPATCH: ['DISPATCHING', 'CANCELLED', 'SUPPRESSED', 'SIMULATED'],
  DISPATCHING: ['DELIVERED', 'FAILED', 'PENDING_RECONCILIATION'],
  FAILED: ['DISPATCHING', 'CANCELLED', 'PENDING_RECONCILIATION'],
  PENDING_RECONCILIATION: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
  SUPPRESSED: [],
  SIMULATED: [],
};

export function transitionOutboundAction(
  action: OutboundAction,
  to: OutboundActionState,
  patch: Partial<
    Pick<
      OutboundAction,
      'providerMessageId' | 'attempt' | 'lastError' | 'cancelledReason' | 'deliveredAt'
    >
  > = {},
): OutboundAction {
  if (!TRANSITIONS[action.state].includes(to)) {
    throw new InvalidTransitionError('OutboundAction', action.state, to);
  }
  return { ...action, ...patch, state: to };
}

/**
 * Deterministic idempotency key.
 *
 * Derived rather than random so that the *same* logical send always produces the same key, even
 * across a process crash and a job redelivery. A random key would make retries indistinguishable
 * from new messages, which is how customers receive the same reply twice.
 */
export function outboundIdempotencyKey(
  conversationId: ConversationId,
  runId: ModeratorRunId | null,
  ordinal: number,
): string {
  return `${conversationId}:${runId ?? 'operator'}:${ordinal}`;
}

export interface CreateOutboundActionInput {
  readonly id: OutboundActionId;
  readonly accountId: AccountId;
  readonly conversationId: ConversationId;
  readonly moderatorRunId: ModeratorRunId | null;
  readonly ordinal: number;
  readonly payload: OutboundActionPayload;
  readonly createdAt: Date;
  /** Phase 0 never sends to a real provider; the runtime injects SIMULATED. */
  readonly simulate: boolean;
}

/**
 * The **only** constructor for an outbound action, and it requires an `AuthorizedAction`.
 *
 * That token cannot be forged (module-private brand) and is only produced by `gateAction`
 * returning ALLOWED. So invariant I7 — "LLM output can never become an effect without policy
 * evaluation" — is enforced by the type system rather than by reviewer vigilance.
 */
export function createOutboundAction(
  authorization: AuthorizedAction,
  input: CreateOutboundActionInput,
): OutboundAction {
  if (authorization.conversationId !== input.conversationId) {
    throw new InvalidTransitionError(
      'OutboundAction',
      'unauthorized',
      'PENDING_DISPATCH',
      'authorization was granted for a different conversation',
    );
  }
  const deliveryMode: DeliveryMode = input.simulate ? 'SIMULATED' : authorization.deliveryMode;
  return {
    id: input.id,
    accountId: input.accountId,
    conversationId: input.conversationId,
    moderatorRunId: input.moderatorRunId,
    actionType: authorization.action,
    deliveryMode,
    // A suggestion is never queued for dispatch; it waits for a human to accept it.
    state:
      deliveryMode === 'SIMULATED'
        ? 'SIMULATED'
        : deliveryMode === 'SUGGESTED'
          ? 'SUPPRESSED'
          : 'PENDING_DISPATCH',
    idempotencyKey: outboundIdempotencyKey(
      input.conversationId,
      input.moderatorRunId,
      input.ordinal,
    ),
    payload: input.payload,
    providerMessageId: null,
    attempt: 0,
    lastError: null,
    cancelledReason: deliveryMode === 'SUGGESTED' ? 'AWAITING_HUMAN_APPROVAL' : null,
    createdAt: input.createdAt,
    deliveredAt: null,
  };
}
