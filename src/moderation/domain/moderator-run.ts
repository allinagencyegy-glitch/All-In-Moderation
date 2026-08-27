import type {
  AccountId,
  AccountPackVersionId,
  ConversationId,
  JobId,
  ModeratorRunId,
  TraceId,
} from '../../platform/ids.ts';
import { InvalidTransitionError } from '../../platform/errors.ts';
import type { ModeratorDecision } from './decision.ts';

export const MODERATOR_RUN_STATES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'SKIPPED',
  'SUPERSEDED',
  'FAILED',
  'DEAD_LETTERED',
] as const;
export type ModeratorRunState = (typeof MODERATOR_RUN_STATES)[number];

export type ModeratorRunTrigger = 'INBOUND_MESSAGE' | 'TIMER' | 'OPERATOR' | 'REPLAY';

/**
 * Why a run produced nothing. Every one of these is recorded — "the AI did nothing" must always
 * have a stated reason, because an unexplained absence is indistinguishable from a bug.
 */
export const SKIP_REASONS = [
  'NO_UNPROCESSED_INPUT',
  'NOT_AI_OWNED',
  'ACCOUNT_SUSPENDED',
  'NO_ACTIVE_PACK',
  'CONVERSATION_CLOSED',
  'CONNECTION_DISABLED',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface LlmCallStats {
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly costEstimate: number | null;
  readonly attempts: number;
}

export interface ModeratorRun {
  readonly id: ModeratorRunId;
  readonly accountId: AccountId;
  readonly conversationId: ConversationId;
  readonly state: ModeratorRunState;
  readonly trigger: ModeratorRunTrigger;

  /** Highest inbound `seq` this run considered. The watermark it will publish if it completes. */
  readonly inputWatermark: number;
  /** The ownership version observed at admission. The staleness guard (ADR-005 §4). */
  readonly observedOwnershipVersion: number;

  /** Non-null: reproducibility of any historical decision depends on it (ADR-010). */
  readonly packVersionId: AccountPackVersionId;
  readonly promptTemplateVersion: string;

  readonly decision: ModeratorDecision | null;
  readonly llm: LlmCallStats | null;
  readonly rawResponse: string | null;

  readonly skipReason: SkipReason | null;
  readonly error: { readonly code: string; readonly message: string } | null;

  readonly jobId: JobId | null;
  readonly traceId: TraceId;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

const TRANSITIONS: Readonly<Record<ModeratorRunState, readonly ModeratorRunState[]>> = {
  PENDING: ['RUNNING', 'SKIPPED'],
  RUNNING: ['COMPLETED', 'SKIPPED', 'SUPERSEDED', 'FAILED'],
  // A retry re-enters RUNNING; exhaustion dead-letters.
  FAILED: ['RUNNING', 'DEAD_LETTERED'],
  COMPLETED: [],
  SKIPPED: [],
  SUPERSEDED: [],
  DEAD_LETTERED: [],
};

export function isTerminalRunState(state: ModeratorRunState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function transitionRun(
  run: ModeratorRun,
  to: ModeratorRunState,
  patch: Partial<
    Pick<ModeratorRun, 'decision' | 'llm' | 'rawResponse' | 'skipReason' | 'error' | 'finishedAt'>
  > = {},
): ModeratorRun {
  if (!TRANSITIONS[run.state].includes(to)) {
    throw new InvalidTransitionError('ModeratorRun', run.state, to);
  }
  if (to === 'SKIPPED' && !patch.skipReason && !run.skipReason) {
    throw new InvalidTransitionError(
      'ModeratorRun',
      run.state,
      to,
      'SKIPPED requires a skipReason',
    );
  }
  if (to === 'FAILED' && !patch.error && !run.error) {
    throw new InvalidTransitionError('ModeratorRun', run.state, to, 'FAILED requires an error');
  }
  if (to === 'COMPLETED' && !patch.decision && !run.decision) {
    throw new InvalidTransitionError(
      'ModeratorRun',
      run.state,
      to,
      'COMPLETED requires a decision',
    );
  }
  return { ...run, ...patch, state: to };
}

/**
 * The staleness guard (invariant I4).
 *
 * Re-evaluated at the commit boundary against freshly read conversation state. If either the
 * ownership version or the inbound high-water mark moved while the model was thinking, the run's
 * conclusion is about a conversation that no longer exists in that form, and delivering it would
 * mean talking over a human or answering a superseded question.
 */
export interface ObservedConversationState {
  readonly ownershipVersion: number;
  readonly lastInboundSeq: number;
}

export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'OWNERSHIP_CHANGED' | 'NEW_INPUT_ARRIVED' };

export function checkStalenessGuard(
  run: Pick<ModeratorRun, 'observedOwnershipVersion' | 'inputWatermark'>,
  current: ObservedConversationState,
): GuardResult {
  if (current.ownershipVersion !== run.observedOwnershipVersion) {
    return { ok: false, reason: 'OWNERSHIP_CHANGED' };
  }
  if (current.lastInboundSeq !== run.inputWatermark) {
    return { ok: false, reason: 'NEW_INPUT_ARRIVED' };
  }
  return { ok: true };
}
