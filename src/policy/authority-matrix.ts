import type { Surface } from '../core/channel.ts';
import type { AccountPackVersionId } from '../platform/ids.ts';
import type { ActionType } from './actions.ts';

export type PolicyEffect = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';

export interface AuthorityRule {
  /** `'*'` matches any surface. Specific surfaces win over the wildcard. */
  readonly surface: Surface | '*';
  readonly action: ActionType;
  readonly effect: PolicyEffect;
  readonly note?: string;
}

/**
 * An account's authority matrix, materialised from its Account Pack and pinned to the pack
 * version that produced it (ADR-010). Pinning matters: "what was this account allowed to do in
 * March?" must be answerable from the run record alone.
 */
export interface AuthorityMatrix {
  readonly packVersionId: AccountPackVersionId;
  readonly rules: readonly AuthorityRule[];
}

/**
 * Evaluation is **total and closed**: an action with no matching rule is DENIED.
 *
 * Default-allow in an authority system means every future action type is silently permitted the
 * moment it is added to the enum. Default-deny means adding a capability is a deliberate act.
 */
export function evaluateMatrix(
  matrix: AuthorityMatrix,
  action: ActionType,
  surface: Surface,
): { effect: PolicyEffect; reason: string } {
  const exact = matrix.rules.find((r) => r.action === action && r.surface === surface);
  if (exact) {
    return { effect: exact.effect, reason: exact.note ?? `matrix rule for ${action}/${surface}` };
  }
  const wildcard = matrix.rules.find((r) => r.action === action && r.surface === '*');
  if (wildcard) {
    return { effect: wildcard.effect, reason: wildcard.note ?? `matrix rule for ${action}/*` };
  }
  return { effect: 'DENY', reason: `no authority rule for ${action} on ${surface} (default deny)` };
}

/**
 * The minimum viable matrix used when an account pack does not define one.
 *
 * Note what is absent: every customer-visible action other than clarification. A misconfigured
 * account should fall back to being useful and safe (it can ask a question or escalate), never to
 * being confidently wrong in public.
 */
export function conservativeDefaultRules(): readonly AuthorityRule[] {
  return [
    { surface: '*', action: 'NO_ACTION', effect: 'ALLOW' },
    { surface: '*', action: 'ADD_TAG', effect: 'ALLOW' },
    { surface: '*', action: 'REQUEST_HUMAN_HANDOFF', effect: 'ALLOW' },
    { surface: 'DIRECT_MESSAGE', action: 'ASK_CLARIFICATION', effect: 'ALLOW' },
    {
      surface: 'PUBLIC_COMMENT',
      action: 'MOVE_TO_DIRECT_MESSAGE',
      effect: 'ALLOW',
      note: 'public threads should move private before any detail is exchanged',
    },
  ];
}
