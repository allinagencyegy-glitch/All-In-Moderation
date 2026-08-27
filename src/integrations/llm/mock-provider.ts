import { TimeoutError, TransientError } from '../../platform/errors.ts';
import type { Clock } from '../../platform/clock.ts';
import type {
  LlmCallOptions,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ProviderCapabilities,
} from '../../platform/llm/provider.ts';

/**
 * A scriptable, deterministic provider.
 *
 * This is architecture, not test scaffolding. Every model-related failure in the register — a
 * timeout, malformed JSON, a hallucinated citation, a refusal, an unrecoverable 5xx — is
 * reproduced through this provider with no network and no non-determinism. A failure mode you
 * cannot reproduce on demand is one you will meet for the first time in production.
 */

export type MockScript =
  | {
      readonly kind: 'RESPOND';
      readonly text: string;
      readonly finishReason?: 'STOP' | 'MAX_TOKENS';
    }
  | { readonly kind: 'TIMEOUT' }
  | { readonly kind: 'TRANSIENT_ERROR'; readonly code?: string }
  | { readonly kind: 'REFUSAL' };

export interface MockCall {
  readonly request: LlmRequest;
  readonly options: LlmCallOptions;
}

export interface MockLlmProvider extends LlmProvider {
  /** Queues responses, consumed in order. The last entry repeats once the queue is exhausted. */
  script(...steps: readonly MockScript[]): void;
  readonly calls: readonly MockCall[];
  callCount(): number;
  reset(): void;
}

const CAPABILITIES: ProviderCapabilities = {
  structuredOutput: true,
  vision: false,
  audio: false,
  maxContextTokens: 100_000,
};

export function createMockLlmProvider(options: {
  clock: Clock;
  model?: string;
  latencyMs?: number;
}): MockLlmProvider {
  const model = options.model ?? 'mock-model-1';
  const latencyMs = options.latencyMs ?? 5;
  let steps: MockScript[] = [];
  const calls: MockCall[] = [];

  return {
    id: 'mock',
    capabilities: CAPABILITIES,
    calls,
    callCount: () => calls.length,
    script(...next) {
      steps = [...next];
    },
    reset() {
      steps = [];
      calls.length = 0;
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- port is async; this stub is not
    async complete(request: LlmRequest, callOptions: LlmCallOptions): Promise<LlmResponse> {
      calls.push({ request, options: callOptions });
      const step =
        steps.length > 1 ? steps.shift()! : (steps[0] ?? { kind: 'RESPOND', text: '{}' });

      switch (step.kind) {
        case 'TIMEOUT':
          // Surfaced as the same error the real timeout wrapper produces, so the retry path under
          // test is the production retry path.
          throw new TimeoutError(`llm.${callOptions.role}`, callOptions.timeoutMs);
        case 'TRANSIENT_ERROR':
          throw new TransientError(step.code ?? 'PROVIDER_UNAVAILABLE', 'mock provider failure', {
            role: callOptions.role,
          });
        case 'REFUSAL':
          return {
            text: '',
            model,
            finishReason: 'REFUSAL',
            tokensIn: 100,
            tokensOut: 0,
            latencyMs,
          };
        case 'RESPOND':
          return {
            text: step.text,
            model,
            finishReason: step.finishReason ?? 'STOP',
            tokensIn: estimateTokens(request),
            tokensOut: Math.ceil(step.text.length / 4),
            latencyMs,
          };
      }
    },
  };
}

function estimateTokens(request: LlmRequest): number {
  const chars =
    request.systemPrompt.length + request.turns.reduce((sum, turn) => sum + turn.content.length, 0);
  return Math.ceil(chars / 4);
}
