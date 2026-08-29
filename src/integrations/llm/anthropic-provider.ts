import { TerminalError, TransientError } from '../../platform/errors.ts';
import type { Clock } from '../../platform/clock.ts';
import type { JsonValue } from '../../platform/schema.ts';
import type {
  FinishReason,
  LlmCallOptions,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmRole,
  ProviderCapabilities,
} from '../../platform/llm/provider.ts';

/**
 * The Anthropic Messages adapter — and the **only** file in `src/` permitted to reach a network.
 *
 * ## Why this file is allowed to exist, and nothing else is
 *
 * Until Phase 02C this repository had no outbound HTTP capability at all. Not disabled, not
 * feature-flagged: absent. That absence is what let us promise a client whose real Facebook Page
 * is attached that the connection is one-way, and it was enforced by a textual scan over `src/`
 * (`tests/architecture/no-outbound-meta.test.ts`) plus the same scan repeated as its own CI step.
 *
 * A moderator that calls a real model needs exactly one exception. The exception is granted here,
 * to this file, by name, and it is enforced by `tests/architecture/llm-egress.test.ts`:
 *
 *   * `fetch(` may appear in this file and in no other file under `src/`.
 *   * This file may name exactly one host, `api.anthropic.com`.
 *   * The Meta host ban stays global and unconditional — no allowlist, no exception, here least
 *     of all.
 *   * No module in `moderation/`, `knowledge/`, `policy/` or `core/` may import this file. It is
 *     reachable from the composition root and from nowhere else.
 *
 * This was deliberately built on `fetch` rather than on `@anthropic-ai/sdk`. An SDK would put the
 * socket in `node_modules`, where the scan cannot see it — the existing assertions would keep
 * passing while egress quietly existed, and the guarantee would decay from "structurally
 * impossible" to "nobody has grepped for the right string yet". Keeping the call visible in `src/`
 * is what keeps the rule that polices it honest. The cost is that we own the wire format for one
 * endpoint with no tools, no streaming and no files; the request below is a single POST.
 *
 * ## What this adapter is not allowed to know
 *
 * Nothing vendor-shaped crosses back over the port (ADR-007). No content blocks, no SDK types, no
 * knowledge of what is being asked — the prompt is assembled in `moderation/application/prompt.ts`
 * precisely so that swapping vendors cannot change the question. And no tools are sent, ever:
 * the model is given no callable surface, so "the model cannot reach our database" is a fact
 * about the request body rather than a policy someone has to keep enforcing.
 */

/** The one host this system may contact. Asserted by the egress test. */
export const ANTHROPIC_API_HOST = 'api.anthropic.com';
const ANTHROPIC_MESSAGES_URL = `https://${ANTHROPIC_API_HOST}/v1/messages`;

/** The stable Messages API version. Overridable, because pinning it is the caller's business. */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

const CAPABILITIES: ProviderCapabilities = {
  structuredOutput: true,
  vision: false,
  audio: false,
  maxContextTokens: 200_000,
};

/**
 * The HTTP boundary, isolated so the unit suite can exercise every mapping with no network.
 *
 * A test injects a function; production gets the `fetch` below. This is not a convenience — a
 * provider adapter whose failure modes can only be reproduced by making real paid calls is one
 * whose failure modes are never tested.
 */
export interface HttpTransport {
  (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<{ readonly status: number; text(): Promise<string> }>;
}

const fetchTransport: HttpTransport = (url, init) =>
  // The single outbound call in this repository.
  fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
    ...(init.signal ? { signal: init.signal } : {}),
  });

export interface AnthropicProviderOptions {
  /**
   * Resolved through the `SecretResolver` port by the composition root, never read from config
   * here. `runtime/config.ts` states that secrets are never read there, and an API key must not
   * become the first exception.
   */
  readonly apiKey: string;
  readonly clock: Clock;
  /**
   * Role to model id, mirroring the `ModelResolver` the composition root builds.
   *
   * The port passes a *role*, never a model, so operations can rebind `REASON` without any domain
   * code learning a vendor's model names. The adapter is told the mapping at construction and
   * still never chooses one for itself.
   */
  readonly models: Readonly<Record<LlmRole, string>>;
  readonly anthropicVersion?: string;
  /**
   * Send the JSON Schema as a vendor structured-output constraint.
   *
   * On by default, and still only an optimisation: `platform/llm/structured.ts` re-validates every
   * response against our own schema regardless (ADR-007). Turn it off with
   * `LLM_STRUCTURED_OUTPUT=off` if a schema shape is ever rejected by the API — the pipeline keeps
   * working, one repair attempt more often.
   */
  readonly structuredOutput?: boolean;
  readonly transport?: HttpTransport;
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
}

interface AnthropicResponseBody {
  readonly model?: string;
  readonly content?: readonly AnthropicContentBlock[];
  readonly stop_reason?: string | null;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly error?: { readonly type?: string; readonly message?: string };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  const transport = options.transport ?? fetchTransport;
  const version = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  const useStructuredOutput = options.structuredOutput ?? true;

  return {
    id: 'anthropic',
    capabilities: CAPABILITIES,

    async complete(request: LlmRequest, callOptions: LlmCallOptions): Promise<LlmResponse> {
      const startedAt = options.clock.nowMs();
      const model = options.models[callOptions.role];

      const body = buildRequestBody(request, model, useStructuredOutput);

      let status: number;
      let raw: string;
      try {
        const response = await transport(ANTHROPIC_MESSAGES_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': version,
          },
          body: JSON.stringify(body),
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        });
        status = response.status;
        raw = await response.text();
      } catch (error) {
        // A socket failure, a DNS failure or an abort. Retryable: the job queue's backoff applies
        // and, on exhaustion, a human is asked to take the conversation (F-05, F-20).
        throw new TransientError(
          'LLM_TRANSPORT_FAILED',
          `Could not reach the model provider: ${error instanceof Error ? error.message : 'unknown'}`,
          { role: callOptions.role, model },
        );
      }

      if (status !== 200) throw errorForStatus(status, raw, model, callOptions.role);

      let parsed: AnthropicResponseBody;
      try {
        parsed = JSON.parse(raw) as AnthropicResponseBody;
      } catch {
        throw new TransientError('LLM_RESPONSE_UNPARSEABLE', 'Provider returned malformed JSON', {
          role: callOptions.role,
          model,
        });
      }

      return {
        // Thinking blocks are dropped: adaptive thinking is on by default for current models and
        // the reasoning is not the answer. Only `text` blocks carry the decision.
        text: (parsed.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text!)
          .join(''),
        model: parsed.model ?? model,
        finishReason: mapFinishReason(parsed.stop_reason),
        tokensIn: parsed.usage?.input_tokens ?? 0,
        tokensOut: parsed.usage?.output_tokens ?? 0,
        latencyMs: options.clock.nowMs() - startedAt,
      };
    },
  };
}

/**
 * Builds the request body.
 *
 * Three deliberate omissions, each of which is a 400 on current models rather than a preference:
 *
 *   * **No `temperature`.** `LlmRequest` carries one because the port predates the models that
 *     removed it; sampling parameters are rejected outright by Opus 5 and its siblings. It is
 *     dropped here rather than in the port, so an older model behind the same interface would
 *     still work.
 *   * **No `thinking.budget_tokens`.** Adaptive thinking is the default and an explicit budget is
 *     rejected. Thinking is also not *disabled*: disabling it on these models can leak reasoning
 *     text into the visible response, which for a JSON-only contract means schema failures.
 *   * **No assistant prefill.** Also rejected, and `structured.ts`'s repair turn is a user turn
 *     for exactly that reason.
 *
 * And one deliberate inclusion: `cache_control` on the system prefix. The system prompt is
 * pack-derived and stable for the life of a pack version, while knowledge and transcript are
 * per-run and sit in the user turn after the breakpoint. With no tools in the request, that prefix
 * is genuinely stable — check `cache_read_input_tokens` if you ever doubt it.
 */
function buildRequestBody(
  request: LlmRequest,
  model: string,
  useStructuredOutput: boolean,
): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {
    model,
    max_tokens: request.maxOutputTokens,
    system: [
      {
        type: 'text',
        text: request.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: request.turns.map((turn) => ({ role: turn.role, content: turn.content })),
  };

  if (useStructuredOutput && request.responseSchema !== undefined) {
    body['output_config'] = {
      format: { type: 'json_schema', schema: request.responseSchema },
    };
  }

  return body;
}

/**
 * `stop_reason` to the port's vocabulary.
 *
 * `refusal` becomes `REFUSAL`, which `structured.ts` converts into a retryable error that ends, on
 * exhaustion, in a human handoff. A refusal is never treated as an empty answer.
 */
function mapFinishReason(stopReason: string | null | undefined): FinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'STOP';
    case 'max_tokens':
      return 'MAX_TOKENS';
    case 'refusal':
      return 'REFUSAL';
    // A missing `stop_reason` is a malformed response, not a completed one, and lands in the same
    // place as an unrecognised value: an error the pipeline treats as "no decision was produced".
    case null:
    case undefined:
    default:
      return 'ERROR';
  }
}

/**
 * HTTP status to our error taxonomy.
 *
 * The split is the whole point: a `TransientError` rides the queue's bounded retry, a
 * `TerminalError` does not. Retrying a 400 five times is five paid calls and a conversation that
 * dead-letters several minutes later than it needed to; treating a 429 as terminal throws away a
 * conversation that would have succeeded a second later.
 */
function errorForStatus(
  status: number,
  raw: string,
  model: string,
  role: string,
): TerminalError | TransientError {
  const detail = { role, model, status };
  const message = extractErrorMessage(raw);

  if (status === 401 || status === 403) {
    return new TerminalError('LLM_UNAUTHORIZED', `Provider rejected the credential: ${message}`, {
      ...detail,
    });
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    // Our request is wrong. Retrying an identical body cannot fix it.
    return new TerminalError('LLM_REQUEST_REJECTED', `Provider rejected the request: ${message}`, {
      ...detail,
    });
  }
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return new TransientError('LLM_PROVIDER_UNAVAILABLE', `Provider is unavailable: ${message}`, {
      ...detail,
    });
  }
  return new TransientError('LLM_UNEXPECTED_STATUS', `Unexpected provider status: ${message}`, {
    ...detail,
  });
}

/** Never returns the raw body: it can be long, and it is not ours to log wholesale. */
function extractErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as AnthropicResponseBody;
    return parsed.error?.message ?? parsed.error?.type ?? 'no message';
  } catch {
    return raw.slice(0, 200);
  }
}
