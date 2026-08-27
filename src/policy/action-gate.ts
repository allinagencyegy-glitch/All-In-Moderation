import type { Surface } from '../core/channel.ts';
import type { ConversationLifecycle, ConversationOwnership } from '../core/conversation-state.ts';
import { ownershipPermitsAutonomy } from '../core/conversation-state.ts';
import type { ConversationId } from '../platform/ids.ts';
import type { ActionType } from './actions.ts';
import { KNOWLEDGE_GROUNDED_ACTIONS, PHASE0_FORBIDDEN_ACTIONS, surfaceForbids } from './actions.ts';
import type { AuthorityMatrix } from './authority-matrix.ts';
import { evaluateMatrix } from './authority-matrix.ts';

declare const authorizationBrand: unique symbol;

/**
 * The capability token that authorises an effect (invariant I7).
 *
 * It can only be produced by `gateAction` returning `ALLOWED`. `createOutboundAction` demands one,
 * so there is no code path from a model's raw proposal to a customer-visible effect that skips
 * this evaluation — not by mistake, and not by a future contributor taking a shortcut.
 */
export interface AuthorizedAction {
  readonly [authorizationBrand]: true;
  readonly action: ActionType;
  readonly surface: Surface;
  readonly conversationId: ConversationId;
  /** The ownership version this authorisation was granted against. */
  readonly ownershipVersion: number;
  readonly deliveryMode: 'AUTONOMOUS' | 'SUGGESTED';
  readonly reason: string;
  readonly evaluatedAt: Date;
}

export type RequestedDeliveryMode = 'AUTONOMOUS' | 'SUGGESTED';

export interface ActionGateInput {
  readonly conversationId: ConversationId;
  readonly surface: Surface;
  readonly ownership: ConversationOwnership;
  readonly lifecycle: ConversationLifecycle;
  readonly ownershipVersion: number;
  readonly accountCanActAutonomously: boolean;
  readonly action: ActionType;
  readonly requestedDeliveryMode: RequestedDeliveryMode;
  readonly matrix: AuthorityMatrix;
  /** Result of the knowledge module's post-decision verification (ADR-010). */
  readonly knowledgeVerified: boolean;
  readonly citationCount: number;
  readonly hasReplyText: boolean;
  readonly now: Date;
}

export type ActionGateResult =
  | {
      readonly outcome: 'ALLOWED';
      readonly authorization: AuthorizedAction;
      readonly reason: string;
    }
  | { readonly outcome: 'REQUIRES_APPROVAL'; readonly reason: string }
  | { readonly outcome: 'DENIED'; readonly reason: string };

/**
 * Evaluates a proposed action against, in order:
 *   1. Phase 0 hard prohibitions   (cannot be overridden by any configuration)
 *   2. Surface invariants          (cannot be overridden by any configuration)
 *   3. Ownership / authority       (invariant I5 — the competing-reply guard)
 *   4. Account status
 *   5. Grounding requirements      (invariants I8/I9)
 *   6. The account's authority matrix
 *
 * The order is the design. Client configuration is consulted **last**, so no pack — however
 * misconfigured, however adversarial — can unlock a destructive action, request personal data in
 * public, or let the AI talk over a human.
 */
export function gateAction(input: ActionGateInput): ActionGateResult {
  const { action, surface } = input;

  // 1. Compile-time prohibitions, checked before any account data is consulted.
  if (PHASE0_FORBIDDEN_ACTIONS.has(action)) {
    return {
      outcome: 'DENIED',
      reason: `action ${action} is forbidden in this phase and cannot be enabled by configuration`,
    };
  }

  // 2. Surface invariants.
  const surfaceProblem = surfaceForbids(action, surface);
  if (surfaceProblem) {
    return { outcome: 'DENIED', reason: `surface constraint: ${surfaceProblem}` };
  }

  // 3. Authority. The second of the two independent checks required by I5.
  if (input.requestedDeliveryMode === 'AUTONOMOUS') {
    if (!ownershipPermitsAutonomy(input.ownership, input.lifecycle)) {
      return {
        outcome: 'DENIED',
        reason: `autonomous delivery requires AI_OWNED on an open conversation (ownership=${input.ownership}, lifecycle=${input.lifecycle})`,
      };
    }
    // 4. A suspended account keeps ingesting and keeps its data; it simply stops acting.
    if (!input.accountCanActAutonomously) {
      return { outcome: 'DENIED', reason: 'account is not permitted to act autonomously' };
    }
  }

  // 5. Grounding. A customer-visible claim must cite approved knowledge that survived
  //    re-verification; the model's confidence is not evidence.
  if (KNOWLEDGE_GROUNDED_ACTIONS.has(action)) {
    if (input.citationCount === 0) {
      return { outcome: 'DENIED', reason: `${action} requires at least one knowledge citation` };
    }
    if (!input.knowledgeVerified) {
      return {
        outcome: 'DENIED',
        reason: 'cited knowledge failed verification (unknown, unapproved, or expired)',
      };
    }
    if (!input.hasReplyText) {
      return { outcome: 'DENIED', reason: `${action} requires reply text` };
    }
  }
  if (action === 'ASK_CLARIFICATION' && !input.hasReplyText) {
    return { outcome: 'DENIED', reason: 'ASK_CLARIFICATION requires a question to ask' };
  }

  // 6. Account configuration, last.
  const matrix = evaluateMatrix(input.matrix, action, surface);
  if (matrix.effect === 'DENY') {
    return { outcome: 'DENIED', reason: matrix.reason };
  }
  if (matrix.effect === 'REQUIRE_APPROVAL') {
    return { outcome: 'REQUIRES_APPROVAL', reason: matrix.reason };
  }

  const authorization: AuthorizedAction = {
    action,
    surface,
    conversationId: input.conversationId,
    ownershipVersion: input.ownershipVersion,
    deliveryMode: input.requestedDeliveryMode,
    reason: matrix.reason,
    evaluatedAt: input.now,
  } as AuthorizedAction;

  return { outcome: 'ALLOWED', authorization, reason: matrix.reason };
}

/**
 * The safe replacement for a denied action.
 *
 * A denial must never mean "do nothing and say nothing". Where the customer is waiting for an
 * answer, the fallback is to ask a human; only genuinely inert actions fall back to nothing.
 */
export function fallbackActionFor(denied: ActionType): ActionType {
  switch (denied) {
    case 'ANSWER_FROM_KNOWLEDGE':
    case 'PUBLIC_REPLY':
    case 'CREATE_LEAD_CANDIDATE':
    case 'CAPTURE_FIELD':
    case 'HIDE_COMMENT':
    case 'DELETE_COMMENT':
    case 'BLOCK_USER':
      return 'REQUEST_HUMAN_HANDOFF';
    case 'ASK_CLARIFICATION':
    case 'MOVE_TO_DIRECT_MESSAGE':
      return 'REQUEST_HUMAN_HANDOFF';
    case 'ADD_TAG':
    case 'NO_ACTION':
    case 'REQUEST_HUMAN_HANDOFF':
      return 'NO_ACTION';
  }
}
