import * as s from '../../platform/schema.ts';
import { ACTION_TYPES } from '../../policy/actions.ts';
import type { ActionType } from '../../policy/actions.ts';

/**
 * The structured proposal contract between the model and the application (ADR-007).
 *
 * Everything here is a *proposal*. The model names an action from a closed set and cites the
 * knowledge it used; the application decides whether that action is permitted, and composes the
 * effect. There is no field through which the model can authorise itself, and no field that maps
 * to a side effect without passing the policy gate first.
 */
export const moderatorDecisionSchema = s.object({
  intent: s.object({
    code: s.string({
      minLength: 1,
      maxLength: 64,
      pattern: /^[A-Z][A-Z0-9_]*$/,
      description: 'Intent code. MUST be one of the codes listed in the provided taxonomy.',
    }),
    confidence: s.number({ min: 0, max: 1 }),
  }),
  entities: s.optional(
    s.record(s.string({ maxLength: 240 }), {
      maxEntries: 24,
      description: 'Extracted entities as flat key/value pairs, e.g. product, quantity, city.',
    }),
  ),
  detected_locale: s.optional(s.string({ maxLength: 16 })),
  sentiment: s.optional(s.enumOf(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'ABUSIVE'])),
  proposed_action: s.enumOf(ACTION_TYPES, 'The single action being proposed.'),
  /** Present only for actions that put words in front of a customer. */
  reply_text: s.optional(s.string({ maxLength: 2000 })),
  /**
   * Citations. Every id here must be one that was supplied to this run; anything else is a
   * hallucination and is rejected by containment checking, not by judging plausibility.
   */
  knowledge_refs: s.array(s.string({ minLength: 1, maxLength: 64 }), { maxItems: 12 }),
  capture_fields: s.optional(
    s.array(
      s.object({
        field: s.string({ minLength: 1, maxLength: 64 }),
        value: s.string({ maxLength: 240 }),
      }),
      { maxItems: 12 },
    ),
  ),
  tags: s.optional(s.array(s.string({ minLength: 1, maxLength: 48 }), { maxItems: 8 })),
  needs_human: s.boolean('True when a human should take over.'),
  handoff_reason: s.optional(s.string({ maxLength: 200 })),
  confidence: s.number({ min: 0, max: 1, description: 'Overall confidence in this decision.' }),
} as const);

export type ModeratorDecisionProposal = s.Infer<typeof moderatorDecisionSchema>;

export const MODERATOR_DECISION_JSON_SCHEMA = moderatorDecisionSchema.toJsonSchema();

export type PolicyOutcome = 'ALLOWED' | 'DOWNGRADED' | 'REQUIRES_APPROVAL' | 'DENIED';

/**
 * The persisted decision: what the model proposed *and* what the application decided.
 *
 * Storing both is deliberate. "The model wanted X, policy allowed Y, because Z" is the record
 * that makes AI behaviour auditable — and it is the only way to notice a model drifting towards
 * actions it is never allowed to take.
 */
export interface ModeratorDecision {
  readonly proposal: ModeratorDecisionProposal;
  readonly policyOutcome: PolicyOutcome;
  readonly policyReason: string;
  readonly finalAction: ActionType;
  readonly knowledgeRefsUsed: readonly string[];
}
