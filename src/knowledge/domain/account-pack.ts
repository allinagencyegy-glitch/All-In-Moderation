import type { AccountId, AccountPackVersionId, UserId } from '../../platform/ids.ts';
import * as s from '../../platform/schema.ts';
import type { ValidationIssue } from '../../platform/schema.ts';
import { ACTION_TYPES } from '../../policy/actions.ts';
import { SURFACES } from '../../core/channel.ts';

/**
 * The Moderator Account Pack (ADR-010).
 *
 * Everything client-specific lives here as *data*. The core runtime ships zero business content;
 * onboarding a client is authoring a pack, not writing code. Section schemas are enforced at
 * publish time, so an invalid pack can never reach the runtime — the previously active version
 * keeps serving traffic instead (failure F-17).
 *
 * The Phase 0 schemas below are intentionally structural. They will be tightened once the Dental
 * Hub research lands; what must not change is that they are validated *somewhere deterministic*.
 */

export const PACK_SECTION_KEYS = [
  'profile',
  'channels',
  'brand_voice',
  'intent_taxonomy',
  'faq',
  'knowledge',
  'products',
  'pricing',
  'qualification',
  'data_collection',
  'routing',
  'sla',
  'authority_matrix',
  'escalation',
  'public_comment_rules',
  'multimodal_rules',
  'handoff_contract',
  'knowledge_gaps',
  'evaluation_cases',
  'evidence_log',
] as const;
export type PackSectionKey = (typeof PACK_SECTION_KEYS)[number];

export const PACK_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'ACTIVE',
  'SUPERSEDED',
  'ROLLED_BACK',
] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

// --- section schemas --------------------------------------------------------------------------

const intentTaxonomySchema = s.object({
  intents: s.array(
    s.object({
      code: s.string({ minLength: 1, maxLength: 64, pattern: /^[A-Z][A-Z0-9_]*$/ }),
      description: s.string({ maxLength: 400 }),
      requires_knowledge: s.optional(s.boolean()),
      escalate: s.optional(s.boolean()),
    }),
    { minItems: 1, maxItems: 200 },
  ),
});

const routingSchema = s.object({
  /** Burst coalescing per account: a comment thread and a WhatsApp chat pace differently. */
  debounce_ms: s.number({ min: 0, max: 60_000, integer: true }),
  max_delay_ms: s.number({ min: 0, max: 300_000, integer: true }),
  intent_routes: s.optional(
    s.array(
      s.object({
        intent: s.string({ minLength: 1, maxLength: 64 }),
        handoff_kind: s.enumOf(['HUMAN_AGENT', 'SALES', 'SUPPORT', 'VENDOR', 'EXTERNAL_SYSTEM']),
        queue: s.optional(s.string({ maxLength: 64 })),
      }),
      { maxItems: 200 },
    ),
  ),
});

const authorityMatrixSchema = s.object({
  rules: s.array(
    s.object({
      surface: s.enumOf(['DIRECT_MESSAGE', 'PUBLIC_COMMENT', '*']),
      action: s.enumOf(ACTION_TYPES),
      effect: s.enumOf(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']),
      note: s.optional(s.string({ maxLength: 200 })),
    }),
    { maxItems: 400 },
  ),
});

const brandVoiceSchema = s.object({
  tone: s.string({ maxLength: 400 }),
  language_policy: s.optional(s.string({ maxLength: 400 })),
  must_not_say: s.optional(s.array(s.string({ maxLength: 200 }), { maxItems: 100 })),
});

const escalationSchema = s.object({
  handoff_sla_ms: s.number({ min: 0, max: 86_400_000, integer: true }),
  /** Default false. Silently resuming AI in a conversation a human was handling is unforgiving. */
  handoff_fallback_to_ai: s.boolean(),
  insufficient_knowledge_action: s.enumOf(['ASK_CLARIFICATION', 'REQUEST_HUMAN_HANDOFF']),
});

const openSectionSchema = s.record(s.jsonValue(), { maxEntries: 500 });

const SECTION_SCHEMAS: Readonly<Record<PackSectionKey, s.Schema<unknown>>> = {
  profile: openSectionSchema,
  channels: openSectionSchema,
  brand_voice: brandVoiceSchema,
  intent_taxonomy: intentTaxonomySchema,
  faq: openSectionSchema,
  knowledge: openSectionSchema,
  products: openSectionSchema,
  pricing: openSectionSchema,
  qualification: openSectionSchema,
  data_collection: openSectionSchema,
  routing: routingSchema,
  sla: openSectionSchema,
  authority_matrix: authorityMatrixSchema,
  escalation: escalationSchema,
  public_comment_rules: openSectionSchema,
  multimodal_rules: openSectionSchema,
  handoff_contract: openSectionSchema,
  knowledge_gaps: openSectionSchema,
  evaluation_cases: openSectionSchema,
  evidence_log: openSectionSchema,
};

/** Sections without which the moderator cannot make a safe decision. */
export const REQUIRED_SECTIONS: readonly PackSectionKey[] = [
  'profile',
  'brand_voice',
  'intent_taxonomy',
  'routing',
  'authority_matrix',
  'escalation',
];

export interface AccountPackVersion {
  readonly id: AccountPackVersionId;
  readonly accountId: AccountId;
  readonly version: number;
  readonly status: PackStatus;
  readonly contentHash: string;
  readonly sections: Readonly<Partial<Record<PackSectionKey, unknown>>>;
  readonly publishedBy: UserId | null;
  readonly publishedAt: Date | null;
  readonly schemaVersion: string;
  readonly notes: string | null;
}

export const PACK_SCHEMA_VERSION = '2026-08-27';

// --- validation -------------------------------------------------------------------------------

/**
 * Validates a pack for publication: per-section schemas first, then cross-section coherence.
 *
 * Cross-section checks are the ones that actually catch real mistakes — a route to an intent that
 * does not exist, or an authority rule naming an action we do not implement. Each of those would
 * otherwise surface as a confusing runtime denial months later.
 */
export function validatePack(pack: AccountPackVersion): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const key of REQUIRED_SECTIONS) {
    if (pack.sections[key] === undefined) {
      issues.push({ path: `sections.${key}`, message: 'required section is missing' });
    }
  }

  for (const [key, document] of Object.entries(pack.sections)) {
    if (!(PACK_SECTION_KEYS as readonly string[]).includes(key)) {
      issues.push({ path: `sections.${key}`, message: 'unknown section key' });
      continue;
    }
    const schema = SECTION_SCHEMAS[key as PackSectionKey];
    schema.check(document, `sections.${key}`, issues);
  }

  if (issues.length > 0) return issues;

  const taxonomy = pack.sections['intent_taxonomy'] as
    | s.Infer<typeof intentTaxonomySchema>
    | undefined;
  const routing = pack.sections['routing'] as s.Infer<typeof routingSchema> | undefined;
  const matrix = pack.sections['authority_matrix'] as
    | s.Infer<typeof authorityMatrixSchema>
    | undefined;

  const intentCodes = new Set(taxonomy?.intents.map((i) => i.code) ?? []);
  for (const [index, route] of (routing?.intent_routes ?? []).entries()) {
    if (!intentCodes.has(route.intent)) {
      issues.push({
        path: `sections.routing.intent_routes[${index}].intent`,
        message: `intent '${route.intent}' is not defined in intent_taxonomy`,
      });
    }
  }

  if (routing && routing.max_delay_ms < routing.debounce_ms) {
    issues.push({
      path: 'sections.routing.max_delay_ms',
      message:
        'max_delay_ms must be >= debounce_ms, otherwise the anti-starvation ceiling is unreachable',
    });
  }

  for (const [index, rule] of (matrix?.rules ?? []).entries()) {
    if (rule.surface !== '*' && !(SURFACES as readonly string[]).includes(rule.surface)) {
      issues.push({
        path: `sections.authority_matrix.rules[${index}].surface`,
        message: `unknown surface '${rule.surface}'`,
      });
    }
  }

  return issues;
}

export function isServable(pack: AccountPackVersion): boolean {
  return pack.status === 'ACTIVE';
}
