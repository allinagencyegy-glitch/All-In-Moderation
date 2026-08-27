import type { AccountScope } from '../core/account/index.ts';
import type { AuditEventId, UserId } from '../platform/ids.ts';

/**
 * Internal accountability, distinct from the domain events published to other systems (ADR-009).
 *
 * Audit answers "who or what did this, to what, and when" for consequential internal actions.
 * Domain events are an external contract; audit is the record we keep for ourselves and for the
 * client whose data it is.
 */
export const AUDIT_ACTIONS = [
  'conversation.ownership_changed',
  'conversation.human_message_sent',
  'moderator.action_denied',
  'moderator.run_skipped',
  'moderator.run_superseded',
  'knowledge.entry_approved',
  'pack.published',
  'account.impersonated',
  'ingest.signature_rejected',
  'ingest.duplicate_delivery',
  'retention.redacted',
  'replay.executed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEvent {
  readonly id: AuditEventId;
  readonly accountId: string;
  readonly action: AuditAction;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly actorKind: 'HUMAN' | 'SYSTEM' | 'POLICY' | 'AI';
  readonly actorUserId: UserId | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: Date;
}

export interface AuditLog {
  append(scope: AccountScope, event: Omit<AuditEvent, 'id' | 'accountId'>): Promise<void>;
  list(scope: AccountScope): Promise<readonly AuditEvent[]>;
}
