import type { Surface } from '../core/channel.ts';

/**
 * The complete vocabulary of effects this platform can perform.
 *
 * It is a closed list on purpose. The model proposes an element of this set; it cannot invent a
 * new one, because anything outside the set fails schema validation before policy is consulted.
 */
export const ACTION_TYPES = [
  'NO_ACTION',
  'ANSWER_FROM_KNOWLEDGE',
  'ASK_CLARIFICATION',
  'ADD_TAG',
  'CAPTURE_FIELD',
  'REQUEST_HUMAN_HANDOFF',
  'CREATE_LEAD_CANDIDATE',
  'PUBLIC_REPLY',
  'MOVE_TO_DIRECT_MESSAGE',
  // Destructive public-comment moderation. Modelled so the gate can *deny* them explicitly
  // rather than failing on an unknown value — but not implemented in Phase 0.
  'HIDE_COMMENT',
  'DELETE_COMMENT',
  'BLOCK_USER',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type RiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'DESTRUCTIVE';

export const ACTION_RISK: Readonly<Record<ActionType, RiskLevel>> = {
  NO_ACTION: 'NONE',
  ADD_TAG: 'NONE',
  CAPTURE_FIELD: 'LOW',
  ASK_CLARIFICATION: 'LOW',
  ANSWER_FROM_KNOWLEDGE: 'MEDIUM',
  MOVE_TO_DIRECT_MESSAGE: 'LOW',
  REQUEST_HUMAN_HANDOFF: 'LOW',
  CREATE_LEAD_CANDIDATE: 'MEDIUM',
  PUBLIC_REPLY: 'HIGH',
  HIDE_COMMENT: 'DESTRUCTIVE',
  DELETE_COMMENT: 'DESTRUCTIVE',
  BLOCK_USER: 'DESTRUCTIVE',
};

/**
 * Actions no account may perform in Phase 0, regardless of configuration.
 *
 * This is a *compile-time* constant checked before the account's authority matrix is consulted,
 * so a misconfigured or malicious pack cannot enable them. Hiding or deleting a customer's public
 * comment is materially riskier than replying to it: it is visible, it is often irreversible, and
 * getting it wrong in public is a reputational event.
 *
 * Enabling any of these later requires: an explicit account grant, a distinct high-risk
 * permission, human approval on each action, and a reversal window.
 */
export const PHASE0_FORBIDDEN_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'HIDE_COMMENT',
  'DELETE_COMMENT',
  'BLOCK_USER',
]);

/** Actions that put words in front of a customer. These require knowledge citations. */
export const CUSTOMER_VISIBLE_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'ANSWER_FROM_KNOWLEDGE',
  'ASK_CLARIFICATION',
  'PUBLIC_REPLY',
  'MOVE_TO_DIRECT_MESSAGE',
]);

/** Actions whose content must be grounded in approved knowledge (never improvised). */
export const KNOWLEDGE_GROUNDED_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'ANSWER_FROM_KNOWLEDGE',
  'PUBLIC_REPLY',
]);

export function isDestructive(action: ActionType): boolean {
  return ACTION_RISK[action] === 'DESTRUCTIVE';
}

/**
 * Surface-specific hard rules that exist independently of any account's configuration.
 *
 * Asking for personal details in a public comment thread is unsafe no matter what a client's
 * pack says, so it is refused here rather than left to prompt wording.
 */
export function surfaceForbids(action: ActionType, surface: Surface): string | null {
  if (surface === 'PUBLIC_COMMENT') {
    if (action === 'CAPTURE_FIELD') {
      return 'personal data must not be collected on a public surface';
    }
    if (action === 'CREATE_LEAD_CANDIDATE') {
      return 'lead capture requires a private surface';
    }
  }
  if (surface === 'DIRECT_MESSAGE' && action === 'PUBLIC_REPLY') {
    return 'public reply is not applicable to a direct message';
  }
  return null;
}
