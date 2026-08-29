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
  /**
   * A human reviewed a suggested draft and accepted it — and that is the whole of what happened.
   *
   * It is terminal, and it means "a person may now send this text themselves". It is deliberately
   * **not** `PENDING_DISPATCH`: there is no dispatcher, no transport and no send capability
   * anywhere in `src/`, and routing approval into the dispatch queue would be the one edit that
   * silently converts human review into autonomous delivery. Sending remains an act a person
   * performs in Meta Inbox.
   */
  'APPROVED_FOR_MANUAL_SEND',
] as const;
export type OutboundActionState = (typeof OUTBOUND_ACTION_STATES)[number];

export type DeliveryMode = 'AUTONOMOUS' | 'SUGGESTED' | 'SIMULATED';

/**
 * Everything a reviewer needs to judge a draft, captured at the moment the decision was made.
 *
 * Snapshotted onto the action rather than looked up later, because the pack can be republished and
 * a knowledge entry can expire between the draft and the review. "What was true when the model
 * proposed this" is the question a reviewer is actually answering.
 */
export interface SuggestedReviewContext {
  readonly intentCode: string;
  readonly intentConfidence: number;
  readonly overallConfidence: number;
  readonly risk: string;
  readonly proposedAction: string;
  readonly policyReason: string;
  readonly knowledgeRefs: readonly string[];
  readonly packVersionId: string;
  readonly promptVersion: string;
  /** The highest inbound `seq` this draft answers — the customer input it is a reply to. */
  readonly inputWatermark: number;
  readonly moderatorRunId: string;
}

export interface OutboundActionPayload {
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly handoffReason?: string;
  readonly capturedFields?: Readonly<Record<string, string>>;
  /**
   * Present on SUGGESTED actions. The reviewer's evidence bundle.
   *
   * Written once, when the action is created, and never edited afterwards. What a human decided
   * lives in `outbound_action_reviews`, not here: the payload is immutable by construction —
   * `outbound:save` upserts state and delivery bookkeeping and deliberately does not touch
   * `payload` — and a second, mutable copy of the reply text is precisely how the two drift.
   */
  readonly review?: SuggestedReviewContext;
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
  // A suggested draft awaits a person. It is accepted, or it is cancelled — by a rejection, or by
  // a takeover that made it stale. There is deliberately no edge from here into the dispatch
  // states: acceptance is not delivery.
  SUPPRESSED: ['APPROVED_FOR_MANUAL_SEND', 'CANCELLED'],
  APPROVED_FOR_MANUAL_SEND: [],
  SIMULATED: [],
};

/** States from which nothing further can happen. Asserted by the state-machine suite. */
export function isTerminalOutboundState(state: OutboundActionState): boolean {
  return TRANSITIONS[state].length === 0;
}

/**
 * States that mean "this text reached, or is on its way to, a customer".
 *
 * The acceptance suite counts these and requires the count to be zero. `SUPPRESSED` and
 * `APPROVED_FOR_MANUAL_SEND` are absent on purpose: an approved draft has been read by a person
 * and is waiting for that person to send it by hand.
 */
export const LIVE_OUTBOUND_STATES: ReadonlySet<OutboundActionState> = new Set<OutboundActionState>([
  'PENDING_DISPATCH',
  'DISPATCHING',
  'DELIVERED',
  'PENDING_RECONCILIATION',
]);

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
  /*
   * Simulation replaces an *autonomous* send, and only that.
   *
   * `SIMULATED` and `SUGGESTED` answer different questions. Simulation is about transport — "this
   * system would have sent this, but it is not connected to send". Suggestion is about authority —
   * "this system deliberately did not try to send this, because a person must decide". Collapsing
   * the second into the first would empty the review queue on every deployment this phase can
   * legally run (`OUTBOUND_MODE=LIVE` is refused at boot, so `simulate` is always true), and the
   * drafted reply a human is waiting for would be filed as a pretend send.
   *
   * A suggestion is also strictly the safer of the two: it never enters the dispatch queue, and
   * there is no dispatcher for it to enter. Preserving it costs nothing and loses no information.
   */
  const deliveryMode: DeliveryMode =
    authorization.deliveryMode === 'SUGGESTED'
      ? 'SUGGESTED'
      : input.simulate
        ? 'SIMULATED'
        : authorization.deliveryMode;
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
