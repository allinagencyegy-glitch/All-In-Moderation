import type { AccountPackVersion } from '../../knowledge/domain/account-pack.ts';
import type { AuthorityMatrix, AuthorityRule } from '../../policy/authority-matrix.ts';
import { conservativeDefaultRules } from '../../policy/authority-matrix.ts';
import { ACTION_TYPES } from '../../policy/actions.ts';
import type { ActionType } from '../../policy/actions.ts';
import { asId } from '../../platform/ids.ts';
import type { AccountPackVersionId } from '../../platform/ids.ts';

/**
 * Projects an Account Pack into the typed policies the runtime needs.
 *
 * Packs are schema-validated at publish time (ADR-010), but this layer still re-checks shapes and
 * falls back to conservative defaults. A pack published under an older schema version, or a
 * migration in flight, must degrade to "safe and slightly less capable" rather than to a crash on
 * a customer's message.
 */

export interface RoutingPolicy {
  readonly debounceMs: number;
  readonly maxDelayMs: number;
}

export interface EscalationPolicy {
  readonly handoffSlaMs: number;
  /** Default false. Silently resuming AI in a conversation a human handled is unforgiving. */
  readonly handoffFallbackToAi: boolean;
  readonly insufficientKnowledgeAction: 'ASK_CLARIFICATION' | 'REQUEST_HUMAN_HANDOFF';
}

export interface IntentTaxonomy {
  readonly codes: ReadonlySet<string>;
  readonly requiresKnowledge: ReadonlySet<string>;
  readonly escalates: ReadonlySet<string>;
  readonly describe: readonly { readonly code: string; readonly description: string }[];
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = { debounceMs: 2_500, maxDelayMs: 8_000 };

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  handoffSlaMs: 900_000,
  handoffFallbackToAi: false,
  insufficientKnowledgeAction: 'REQUEST_HUMAN_HANDOFF',
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const int = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

export function resolveRoutingPolicy(pack: AccountPackVersion | null): RoutingPolicy {
  const section = record(pack?.sections['routing']);
  if (!section) return DEFAULT_ROUTING_POLICY;
  const debounceMs = int(section['debounce_ms'], DEFAULT_ROUTING_POLICY.debounceMs);
  const maxDelayMs = int(section['max_delay_ms'], DEFAULT_ROUTING_POLICY.maxDelayMs);
  // The ceiling must not be below the window, or the anti-starvation guarantee is unreachable.
  return { debounceMs, maxDelayMs: Math.max(debounceMs, maxDelayMs) };
}

export function resolveEscalationPolicy(pack: AccountPackVersion | null): EscalationPolicy {
  const section = record(pack?.sections['escalation']);
  if (!section) return DEFAULT_ESCALATION_POLICY;
  const action = section['insufficient_knowledge_action'];
  return {
    handoffSlaMs: int(section['handoff_sla_ms'], DEFAULT_ESCALATION_POLICY.handoffSlaMs),
    handoffFallbackToAi: section['handoff_fallback_to_ai'] === true,
    insufficientKnowledgeAction:
      action === 'ASK_CLARIFICATION' || action === 'REQUEST_HUMAN_HANDOFF'
        ? action
        : DEFAULT_ESCALATION_POLICY.insufficientKnowledgeAction,
  };
}

export function resolveAuthorityMatrix(pack: AccountPackVersion | null): AuthorityMatrix {
  const packVersionId = pack?.id ?? asId<AccountPackVersionId>('apv_none');
  const section = record(pack?.sections['authority_matrix']);
  const rawRules = section?.['rules'];
  if (!Array.isArray(rawRules)) {
    return { packVersionId, rules: conservativeDefaultRules() };
  }
  const rules: AuthorityRule[] = [];
  for (const raw of rawRules) {
    const rule = record(raw);
    if (!rule) continue;
    const action = rule['action'];
    const surface = rule['surface'];
    const effect = rule['effect'];
    if (typeof action !== 'string' || !(ACTION_TYPES as readonly string[]).includes(action))
      continue;
    if (surface !== '*' && surface !== 'DIRECT_MESSAGE' && surface !== 'PUBLIC_COMMENT') continue;
    if (effect !== 'ALLOW' && effect !== 'REQUIRE_APPROVAL' && effect !== 'DENY') continue;
    const note = rule['note'];
    rules.push({
      surface,
      action: action as ActionType,
      effect,
      ...(typeof note === 'string' ? { note } : {}),
    });
  }
  return { packVersionId, rules: rules.length > 0 ? rules : conservativeDefaultRules() };
}

export function resolveIntentTaxonomy(pack: AccountPackVersion | null): IntentTaxonomy {
  const section = record(pack?.sections['intent_taxonomy']);
  const rawIntents = section?.['intents'];
  const codes = new Set<string>();
  const requiresKnowledge = new Set<string>();
  const escalates = new Set<string>();
  const describe: { code: string; description: string }[] = [];
  if (Array.isArray(rawIntents)) {
    for (const raw of rawIntents) {
      const intent = record(raw);
      const code = intent?.['code'];
      if (typeof code !== 'string') continue;
      codes.add(code);
      if (intent?.['requires_knowledge'] === true) requiresKnowledge.add(code);
      if (intent?.['escalate'] === true) escalates.add(code);
      const description = intent?.['description'];
      describe.push({ code, description: typeof description === 'string' ? description : '' });
    }
  }
  return { codes, requiresKnowledge, escalates, describe };
}

export function resolveBrandVoice(pack: AccountPackVersion | null): {
  tone: string;
  mustNotSay: readonly string[];
} {
  const section = record(pack?.sections['brand_voice']);
  const tone = section?.['tone'];
  const mustNotSay = section?.['must_not_say'];
  return {
    tone: typeof tone === 'string' ? tone : 'Professional, concise, helpful.',
    mustNotSay: Array.isArray(mustNotSay)
      ? mustNotSay.filter((v): v is string => typeof v === 'string')
      : [],
  };
}
