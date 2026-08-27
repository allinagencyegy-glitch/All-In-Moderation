import type {
  AccountId,
  ContactIdentityId,
  ConversationId,
  LeadCandidateId,
} from '../../platform/ids.ts';
import { InvalidTransitionError } from '../../platform/errors.ts';

export const LEAD_CANDIDATE_STATES = [
  'DRAFT',
  'QUALIFIED',
  'DELIVERED',
  'REJECTED',
  'FAILED',
] as const;
export type LeadCandidateState = (typeof LEAD_CANDIDATE_STATES)[number];

export interface CapturedField {
  readonly value: string;
  readonly sourceMessageSeq: number;
  readonly capturedAt: Date;
}

/**
 * The only commercial artefact the moderation platform owns.
 *
 * It exists so the CRM boundary is crossable before a CRM exists, and so a CRM outage loses
 * nothing (ADR-009). Note the fields that are deliberately absent: no stage, no probability, no
 * close date, no monetary value. Those belong to the CRM permanently — adding one here is how a
 * moderation platform quietly becomes a second CRM.
 */
export interface LeadCandidate {
  readonly id: LeadCandidateId;
  readonly accountId: AccountId;
  readonly conversationId: ConversationId;
  readonly contactIdentityId: ContactIdentityId | null;
  readonly state: LeadCandidateState;
  readonly qualificationRuleVersion: string;
  readonly capturedFields: Readonly<Record<string, CapturedField>>;
  readonly productInterest: readonly { readonly ref: string; readonly confidence: number }[];
  readonly externalRef: string | null;
  readonly deliveredAt: Date | null;
  readonly deliveryError: { readonly code: string; readonly message: string } | null;
  readonly createdAt: Date;
}

const TRANSITIONS: Readonly<Record<LeadCandidateState, readonly LeadCandidateState[]>> = {
  DRAFT: ['QUALIFIED', 'REJECTED'],
  QUALIFIED: ['DELIVERED', 'FAILED', 'REJECTED'],
  // FAILED is retryable by design: a CRM outage must never be terminal for a qualified lead.
  FAILED: ['DELIVERED', 'REJECTED'],
  DELIVERED: [],
  REJECTED: [],
};

export function transitionLeadCandidate(
  candidate: LeadCandidate,
  to: LeadCandidateState,
  patch: Partial<Pick<LeadCandidate, 'externalRef' | 'deliveredAt' | 'deliveryError'>> = {},
): LeadCandidate {
  if (!TRANSITIONS[candidate.state].includes(to)) {
    throw new InvalidTransitionError('LeadCandidate', candidate.state, to);
  }
  return { ...candidate, ...patch, state: to };
}
