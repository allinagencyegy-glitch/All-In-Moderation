import * as s from '../../platform/schema.ts';
import type { JsonValue, ValidationIssue } from '../../platform/schema.ts';
import type { AccountId, DomainEventId, TraceId } from '../../platform/ids.ts';

/**
 * The published event contract (ADR-009).
 *
 * Two rules are enforced here rather than left to reviewer diligence:
 *   - **Ids over content.** Payloads carry references and derived facts. Consumers that need
 *     message text call back through an authorised, scoped, audited read.
 *   - **Derived over raw.** `faq.unanswered` carries a normalised question shape and a gap id,
 *     never the customer's sentence.
 *
 * A type that is not in this registry cannot be published. That is a programming error which
 * fails loudly in development, not a silent no-op in production.
 */

export const DOMAIN_EVENT_TYPES = [
  'conversation.started',
  'intent.detected',
  'product_interest.detected',
  'faq.unanswered',
  'complaint.detected',
  'lead.candidate_created',
  'lead.qualified',
  'sales.handoff_requested',
  'sales.handoff_failed',
  'handoff.failed',
  'moderation.degraded',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEventEnvelope {
  readonly eventId: DomainEventId;
  readonly type: DomainEventType;
  readonly version: number;
  readonly occurredAt: Date;
  readonly accountId: AccountId;
  readonly subject: { readonly type: string; readonly id: string };
  readonly traceId: TraceId;
  readonly data: JsonValue;
}

const idRef = s.string({ minLength: 1, maxLength: 64 });
const confidence = s.number({ min: 0, max: 1 });

const SCHEMAS: Readonly<Record<DomainEventType, s.Schema<unknown>>> = {
  'conversation.started': s.object({
    conversation_id: idRef,
    channel: s.string({ maxLength: 32 }),
    surface: s.string({ maxLength: 32 }),
    started_at: s.string({ maxLength: 32 }),
  }),
  'intent.detected': s.object({
    conversation_id: idRef,
    moderator_run_id: idRef,
    intent_code: s.string({ maxLength: 64 }),
    confidence,
  }),
  'product_interest.detected': s.object({
    conversation_id: idRef,
    product_ref: s.string({ maxLength: 128 }),
    confidence,
  }),
  'faq.unanswered': s.object({
    conversation_id: idRef,
    knowledge_gap_id: idRef,
    // The *shape* of the question, not the question. Minimisation is structural.
    question_shape: s.string({ maxLength: 200 }),
    intent_code: s.string({ maxLength: 64 }),
    locale: s.string({ maxLength: 16 }),
  }),
  'complaint.detected': s.object({
    conversation_id: idRef,
    intent_code: s.string({ maxLength: 64 }),
    severity: s.enumOf(['LOW', 'MEDIUM', 'HIGH']),
  }),
  'lead.candidate_created': s.object({
    conversation_id: idRef,
    lead_candidate_id: idRef,
    // Field *names* only. Values cross the boundary at qualification, under contract.
    captured_field_names: s.array(s.string({ maxLength: 64 }), { maxItems: 40 }),
  }),
  'lead.qualified': s.object({
    conversation_id: idRef,
    lead_candidate_id: idRef,
    qualification_rule_version: s.string({ maxLength: 64 }),
    fields: s.record(s.string({ maxLength: 240 }), { maxEntries: 40 }),
  }),
  'sales.handoff_requested': s.object({
    conversation_id: idRef,
    handoff_id: idRef,
    reason_code: s.string({ maxLength: 64 }),
    urgency: s.enumOf(['LOW', 'NORMAL', 'HIGH']),
  }),
  'sales.handoff_failed': s.object({
    conversation_id: idRef,
    handoff_id: idRef,
    reason_code: s.string({ maxLength: 64 }),
    elapsed_ms: s.number({ min: 0, integer: true }),
  }),
  'handoff.failed': s.object({
    conversation_id: idRef,
    handoff_id: idRef,
    terminal_reason: s.string({ maxLength: 200 }),
  }),
  'moderation.degraded': s.object({
    component: s.string({ maxLength: 64 }),
    detail: s.string({ maxLength: 200 }),
    count: s.number({ min: 0, integer: true }),
  }),
};

export function isKnownEventType(type: string): type is DomainEventType {
  return (DOMAIN_EVENT_TYPES as readonly string[]).includes(type);
}

export function validateEventPayload(type: DomainEventType, data: unknown): ValidationIssue[] {
  return s.validate(SCHEMAS[type], data);
}

export function eventJsonSchema(type: DomainEventType): JsonValue {
  return SCHEMAS[type].toJsonSchema();
}

/**
 * A subscription's field projection.
 *
 * A consumer receives only fields it contracted for. Adding a field to an event later therefore
 * cannot widen an existing consumer's data access by accident — the projection, not the producer,
 * decides what leaves the platform.
 */
export function projectPayload(
  data: Readonly<Record<string, JsonValue>>,
  allowedFields: readonly string[] | undefined,
): Record<string, JsonValue> {
  if (!allowedFields) return { ...data };
  const out: Record<string, JsonValue> = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) out[field] = data[field]!;
  }
  return out;
}
