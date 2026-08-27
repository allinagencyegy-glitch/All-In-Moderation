import type { AccountScope } from '../../core/account/index.ts';
import type { DomainEventId } from '../../platform/ids.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { JsonValue } from '../../platform/schema.ts';
import type { DomainEventEnvelope, DomainEventType } from './contracts.ts';
import { isKnownEventType, validateEventPayload } from './contracts.ts';

export const DELIVERY_STATES = [
  'PENDING',
  'IN_FLIGHT',
  'DELIVERED',
  'RETRY_SCHEDULED',
  'FAILED_PERMANENT',
  'DEAD_LETTERED',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export interface EventSubscription {
  readonly id: string;
  readonly accountId: string;
  readonly destination: string;
  readonly types: readonly DomainEventType[];
  /** Undefined means "the whole payload"; a list narrows it (data minimisation, ADR-009). */
  readonly allowedFields?: Readonly<Partial<Record<DomainEventType, readonly string[]>>>;
  readonly active: boolean;
}

export interface EventDelivery {
  readonly id: string;
  readonly accountId: string;
  readonly eventId: DomainEventId;
  readonly subscriptionId: string;
  readonly state: DeliveryState;
  readonly attempt: number;
  readonly lastError: string | null;
  readonly deliveredAt: Date | null;
}

/**
 * The transactional outbox (ADR-009).
 *
 * `append` must run inside the same transaction as the state change it describes. That is the
 * whole mechanism: an event is never emitted for a change that rolled back, and never lost for a
 * change that committed. Delivery happens later, per subscription, with independent retry state —
 * so one slow consumer cannot block another.
 */
export interface EventOutbox {
  append(scope: AccountScope, event: DomainEventEnvelope): Promise<void>;
  listPending(scope: AccountScope): Promise<readonly DomainEventEnvelope[]>;
  listAll(scope: AccountScope): Promise<readonly DomainEventEnvelope[]>;
  markRelayed(eventId: DomainEventId): Promise<void>;
}

/**
 * Validates an envelope before it can be appended.
 *
 * Publishing an unregistered type, or a payload that fails its schema, is a programming error.
 * Failing loudly here keeps the promise we make to consumers honest — a contract nobody validates
 * is a contract nobody has.
 */
export function assertPublishable(event: DomainEventEnvelope): void {
  if (!isKnownEventType(event.type)) {
    throw new ValidationError(`Unknown domain event type '${String(event.type)}'`);
  }
  const issues = validateEventPayload(event.type, event.data);
  if (issues.length > 0) {
    throw new ValidationError(`Invalid payload for ${event.type}`, issues);
  }
}

export function matchesSubscription(
  subscription: EventSubscription,
  event: DomainEventEnvelope,
): boolean {
  if (!subscription.active) return false;
  // Belt and braces on tenancy: the publisher never trusts routing alone (ADR-002).
  if (subscription.accountId !== event.accountId) return false;
  return subscription.types.includes(event.type);
}

export function allowedFieldsFor(
  subscription: EventSubscription,
  type: DomainEventType,
): readonly string[] | undefined {
  return subscription.allowedFields?.[type];
}

export function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
