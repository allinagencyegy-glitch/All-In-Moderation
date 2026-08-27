import type { JsonValue } from '../schema.ts';

/**
 * The provider boundary (ADR-007).
 *
 * Nothing vendor-shaped crosses this line: no Anthropic content blocks, no OpenAI tool-call
 * objects, no SDK types in any signature. Swapping vendors is an adapter plus a config entry.
 *
 * Note what is deliberately absent: **tools / function calling**. The model is given no callable
 * surface at all. It is not a policy that the model has no database access — it is a fact about
 * the interface. Every effect is chosen by application code from the model's declarative proposal.
 */

export type LlmRole = 'CLASSIFY' | 'REASON' | 'VISION' | 'TRANSCRIBE';

export interface LlmTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface LlmRequest {
  readonly systemPrompt: string;
  readonly turns: readonly LlmTurn[];
  /** JSON Schema the response must satisfy. Always re-validated by us regardless of the vendor. */
  readonly responseSchema?: JsonValue;
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

export interface LlmCallOptions {
  readonly role: LlmRole;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Correlates the call with the moderator run that made it. */
  readonly traceId: string;
}

export type FinishReason = 'STOP' | 'MAX_TOKENS' | 'REFUSAL' | 'ERROR';

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly finishReason: FinishReason;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
}

export interface ProviderCapabilities {
  readonly structuredOutput: boolean;
  readonly vision: boolean;
  readonly audio: boolean;
  readonly maxContextTokens: number;
}

export interface LlmProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: LlmRequest, options: LlmCallOptions): Promise<LlmResponse>;
}

/**
 * Role-to-model resolution.
 *
 * Operations name a *role*, never a model, so nothing in the domain knows which vendor is in use.
 * This is deliberately not a router: no cost optimisation, no quality fallback chain. Those are a
 * product of their own, and a "cheap model first, escalate if unsure" strategy doubles the
 * evaluation surface for a saving we cannot yet measure.
 */
export interface ModelBinding {
  readonly providerId: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface ModelResolver {
  resolve(role: LlmRole): ModelBinding;
}

export function createStaticModelResolver(
  bindings: Readonly<Record<LlmRole, ModelBinding>>,
): ModelResolver {
  return { resolve: (role) => bindings[role] };
}
