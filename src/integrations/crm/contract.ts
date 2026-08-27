import { NotImplementedError } from '../../platform/errors.ts';

/**
 * The CRM handoff contract (ADR-009). Types only — there is no CRM to call yet, and building one
 * was explicitly out of scope for this phase.
 *
 * The important property is the direction of dependency: the moderation platform never *reads*
 * from the CRM in the request path, and never blocks on it. A qualified lead is persisted locally
 * first, published as an event second, and delivered by this adapter third. A CRM outage
 * therefore costs latency, never customer context.
 */

export interface CrmLeadPayload {
  /** Our id. The CRM stores it so the two sides can be reconciled after any ambiguous failure. */
  readonly sourceLeadCandidateId: string;
  readonly accountRef: string;
  readonly channel: string;
  readonly conversationRef: string;
  readonly contact: {
    readonly displayName: string | null;
    readonly locale: string | null;
    /** Only fields the account's data-collection policy authorised for export. */
    readonly fields: Readonly<Record<string, string>>;
  };
  readonly productInterest: readonly { readonly ref: string; readonly confidence: number }[];
  readonly qualificationRuleVersion: string;
  readonly capturedAt: string;
}

export interface CrmDeliveryResult {
  readonly externalRef: string;
  readonly deduplicated: boolean;
}

export interface CrmAdapter {
  /**
   * `idempotencyKey` is derived from the lead candidate id, so a retry after an ambiguous timeout
   * cannot create a second lead. A CRM that ignores the key must be reconciled by lookup before
   * a resend — never blind-retried.
   */
  deliverLead(payload: CrmLeadPayload, idempotencyKey: string): Promise<CrmDeliveryResult>;
}

/**
 * The Phase 0 adapter: fails loudly rather than pretending to succeed.
 *
 * A stub that silently returns success would make the delivery pipeline look healthy while leads
 * went nowhere — a silent failure introduced by a placeholder, which is exactly the class of bug
 * this platform is built to avoid.
 */
export function createUnavailableCrmAdapter(): CrmAdapter {
  return {
    deliverLead(): Promise<CrmDeliveryResult> {
      return Promise.reject(new NotImplementedError('CRM delivery', 'Phase 2'));
    },
  };
}
