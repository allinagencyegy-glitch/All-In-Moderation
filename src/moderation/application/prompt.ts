import type { KnowledgeEntry } from '../../knowledge/domain/knowledge-entry.ts';
import type { LlmRequest } from '../../platform/llm/provider.ts';
import { MODERATOR_DECISION_JSON_SCHEMA } from '../domain/decision.ts';
import type { Message } from '../domain/message.ts';
import { renderTranscript } from '../domain/message.ts';
import type { Surface } from '../../core/channel.ts';
import type { IntentTaxonomy } from './routing-policy.ts';

/**
 * Prompt assembly.
 *
 * Two rules hold this file to a shape:
 *   1. **Structure only.** Every word of business substance — tone, intents, knowledge, what may
 *      not be said — is injected from the account's pack. Nothing here is client-specific, and an
 *      architecture test asserts that no client name appears anywhere in `src/`.
 *   2. **It lives in `moderation/`, not in a provider adapter.** The adapter must stay ignorant of
 *      what we are asking, so a vendor swap cannot change the question.
 *
 * The prompt version is pinned onto every run alongside the pack version, so any historical
 * decision can be explained with the exact inputs that produced it.
 */
export const MODERATOR_PROMPT_VERSION = 'moderator/2026-08-27.1';

export interface PromptInput {
  readonly brandTone: string;
  readonly mustNotSay: readonly string[];
  readonly taxonomy: IntentTaxonomy;
  readonly surface: Surface;
  readonly locale: string;
  readonly knowledge: readonly KnowledgeEntry[];
  readonly transcript: readonly Message[];
  readonly allowedActions: readonly string[];
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

export function buildModeratorRequest(input: PromptInput): LlmRequest {
  const systemPrompt = [
    'You are a moderation assistant for a business messaging account.',
    'You do not perform actions. You return a single JSON object describing what you believe the',
    'situation is and what you propose. The application decides what is actually permitted.',
    '',
    `Brand tone: ${input.brandTone}`,
    input.mustNotSay.length > 0
      ? `Never say or imply any of the following: ${input.mustNotSay.join(' | ')}`
      : '',
    `Conversation surface: ${input.surface}${
      input.surface === 'PUBLIC_COMMENT'
        ? ' (PUBLIC — anyone can read this. Never request or restate personal details here.)'
        : ' (private)'
    }`,
    `Reply language: ${input.locale}`,
    '',
    'Intent taxonomy — you MUST choose intent.code from exactly this list:',
    input.taxonomy.describe.length > 0
      ? input.taxonomy.describe.map((i) => `  - ${i.code}: ${i.description}`).join('\n')
      : '  (no taxonomy configured; use OTHER)',
    '',
    'Actions you may propose:',
    input.allowedActions.map((a) => `  - ${a}`).join('\n'),
    '',
    'Rules:',
    '  1. Only state facts that appear in the APPROVED KNOWLEDGE section below.',
    '  2. Cite every knowledge item you rely on by its id in knowledge_refs.',
    '  3. Never state a price, discount, or availability that is not in the knowledge section.',
    '  4. If the knowledge provided is not enough to answer, do NOT guess. Either ask one specific',
    '     clarifying question, or set needs_human to true.',
    '  5. Reply with a single JSON object and nothing else.',
    '',
    'Response JSON schema:',
    JSON.stringify(MODERATOR_DECISION_JSON_SCHEMA),
  ]
    .filter((line) => line !== '')
    .join('\n');

  const knowledgeBlock =
    input.knowledge.length > 0
      ? input.knowledge.map(renderKnowledgeEntry).join('\n\n')
      : '(no approved knowledge matched this conversation)';

  const userContent = [
    'APPROVED KNOWLEDGE (the only facts you may state):',
    knowledgeBlock,
    '',
    'CONVERSATION (oldest first):',
    renderTranscript(input.transcript),
    '',
    'Return the JSON object now.',
  ].join('\n');

  return {
    systemPrompt,
    turns: [{ role: 'user', content: userContent }],
    responseSchema: MODERATOR_DECISION_JSON_SCHEMA,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
  };
}

/**
 * Renders one knowledge entry.
 *
 * Validity dates are shown for context only. They are *not* what enforces expiry — the Knowledge
 * Gate has already filtered anything out of window before this point, precisely so that a
 * commercial claim never depends on a model reading a date correctly (ADR-010).
 */
function renderKnowledgeEntry(entry: KnowledgeEntry): string {
  const lines = [`[id: ${entry.id}] (${entry.kind}) ${entry.title}`, entry.body];
  if (entry.price) {
    lines.push(`Price: ${entry.price.amount} ${entry.price.currency}`);
    if (entry.paymentType) lines.push(`Payment type: ${entry.paymentType}`);
  }
  if (entry.validUntil) lines.push(`Valid until: ${entry.validUntil.toISOString().slice(0, 10)}`);
  return lines.join('\n');
}
