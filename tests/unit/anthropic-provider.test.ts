import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestClock } from '../../src/platform/clock.ts';
import { TerminalError, TransientError } from '../../src/platform/errors.ts';
import type { LlmCallOptions, LlmRequest, LlmRole } from '../../src/platform/llm/provider.ts';
import {
  ANTHROPIC_API_HOST,
  DEFAULT_ANTHROPIC_VERSION,
  createAnthropicProvider,
} from '../../src/integrations/llm/anthropic-provider.ts';
import type { HttpTransport } from '../../src/integrations/llm/anthropic-provider.ts';

/**
 * The provider adapter, exercised with an injected transport and **no network**.
 *
 * The rest of the suite runs with `LLM_PROVIDER` unset and the mock wired in, so this file is the
 * only place the real adapter's behaviour is pinned. It therefore pins the parts that are
 * expensive or dangerous to discover in production: the request body (three omissions that are
 * each a 400 on current models), the status taxonomy (retry versus give up), and the refusal path.
 *
 * Nothing here can reach `api.anthropic.com` — every test supplies its own transport, and the
 * assertions are about what the adapter *would* have sent.
 */

const MODELS: Readonly<Record<LlmRole, string>> = {
  CLASSIFY: 'claude-test-classify',
  REASON: 'claude-test-reason',
  VISION: 'claude-test-vision',
  TRANSCRIBE: 'claude-test-transcribe',
};

const REQUEST: LlmRequest = {
  systemPrompt: 'You are a moderator. Answer only from the supplied knowledge.',
  turns: [{ role: 'user', content: 'the customer asked about opening hours' }],
  responseSchema: { type: 'object', properties: { intent: { type: 'string' } } },
  maxOutputTokens: 512,
  temperature: 0.2,
};

const CALL: LlmCallOptions = { role: 'REASON', timeoutMs: 5_000, traceId: 'mrn_test' };

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

interface Reply {
  readonly status: number;
  readonly text: string;
}

function providerWith(
  respond: () => Reply,
  overrides: { readonly structuredOutput?: boolean } = {},
): { provider: ReturnType<typeof createAnthropicProvider>; sent: Captured[] } {
  const sent: Captured[] = [];
  const transport: HttpTransport = (url, init) => {
    sent.push({
      url,
      headers: { ...init.headers },
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const reply = respond();
    return Promise.resolve({ status: reply.status, text: () => Promise.resolve(reply.text) });
  };
  const provider = createAnthropicProvider({
    apiKey: 'test-key',
    clock: createTestClock(),
    models: MODELS,
    transport,
    ...overrides,
  });
  return { provider, sent };
}

function ok(text: string): Reply {
  return {
    status: 200,
    text: JSON.stringify({
      model: 'claude-test-reason',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 7 },
    }),
  };
}

describe('anthropic provider adapter', () => {
  describe('the request it builds', () => {
    it('posts to exactly one endpoint, derived from the one allowed host', async () => {
      const { provider, sent } = providerWith(() => ok('{}'));
      await provider.complete(REQUEST, CALL);
      assert.equal(sent[0]!.url, `https://${ANTHROPIC_API_HOST}/v1/messages`);
    });

    it('sends the credential and the pinned version, and nothing else identifying', async () => {
      const { provider, sent } = providerWith(() => ok('{}'));
      await provider.complete(REQUEST, CALL);
      assert.deepEqual(Object.keys(sent[0]!.headers).sort(), [
        'anthropic-version',
        'content-type',
        'x-api-key',
      ]);
      assert.equal(sent[0]!.headers['anthropic-version'], DEFAULT_ANTHROPIC_VERSION);
      assert.equal(sent[0]!.headers['x-api-key'], 'test-key');
    });

    it('resolves the model from the role, never from the request', async () => {
      const { provider, sent } = providerWith(() => ok('{}'));
      await provider.complete(REQUEST, { ...CALL, role: 'CLASSIFY' });
      assert.equal(sent[0]!.body['model'], MODELS.CLASSIFY);
      assert.equal(sent[0]!.body['max_tokens'], REQUEST.maxOutputTokens);
    });

    it('omits temperature, thinking budget and prefill — each a 400 on current models', async () => {
      const { provider, sent } = providerWith(() => ok('{}'));
      // `LlmRequest.temperature` is 0.2 above, and it must not survive into the body.
      await provider.complete(REQUEST, CALL);
      const body = sent[0]!.body;
      assert.equal(body['temperature'], undefined);
      assert.equal(body['thinking'], undefined);
      assert.equal(body['top_p'], undefined);
      const messages = body['messages'] as { readonly role: string }[];
      assert.deepEqual(
        messages.map((message) => message.role),
        ['user'],
        'no assistant prefill: the repair turn is a user turn for this reason',
      );
    });

    it('sends no tools and no stream flag, so the model has no callable surface', async () => {
      const { provider, sent } = providerWith(() => ok('{}'));
      await provider.complete(REQUEST, CALL);
      assert.equal(sent[0]!.body['tools'], undefined);
      assert.equal(sent[0]!.body['tool_choice'], undefined);
      assert.equal(sent[0]!.body['stream'], undefined);
      assert.equal(sent[0]!.body['mcp_servers'], undefined);
    });

    it('marks the stable system prefix cacheable', async () => {
      const { provider, sent } = providerWith(() => ok('{}'));
      await provider.complete(REQUEST, CALL);
      assert.deepEqual(sent[0]!.body['system'], [
        { type: 'text', text: REQUEST.systemPrompt, cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('passes our schema as the structured-output constraint by default', async () => {
      const { provider, sent } = providerWith(() => ok('{}'));
      await provider.complete(REQUEST, CALL);
      assert.deepEqual(sent[0]!.body['output_config'], {
        format: { type: 'json_schema', schema: REQUEST.responseSchema },
      });
    });

    it('drops the constraint when structured output is off, and still sends the call', async () => {
      // The escape hatch has to keep the pipeline working: our own validator re-checks the
      // response either way (ADR-007).
      const { provider, sent } = providerWith(() => ok('{}'), { structuredOutput: false });
      await provider.complete(REQUEST, CALL);
      assert.equal(sent[0]!.body['output_config'], undefined);
      assert.equal(sent.length, 1);
    });

    it('omits the constraint when the caller supplied no schema', async () => {
      const { provider, sent } = providerWith(() => ok('{}'));
      const { responseSchema: _unused, ...noSchema } = REQUEST;
      await provider.complete(noSchema, CALL);
      assert.equal(sent[0]!.body['output_config'], undefined);
    });
  });

  describe('the response it returns', () => {
    it('concatenates text blocks and drops everything else', async () => {
      const { provider } = providerWith(() => ({
        status: 200,
        text: JSON.stringify({
          model: 'claude-test-reason',
          content: [
            { type: 'thinking', thinking: 'reasoning that is not the answer' },
            { type: 'text', text: '{"intent":' },
            { type: 'text', text: '"PRICE_INQUIRY"}' },
          ],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      }));
      const response = await provider.complete(REQUEST, CALL);
      assert.equal(response.text, '{"intent":"PRICE_INQUIRY"}');
      assert.equal(response.tokensIn, 3);
      assert.equal(response.tokensOut, 4);
      assert.equal(response.finishReason, 'STOP');
    });

    it('reports the model the provider actually served', async () => {
      const { provider } = providerWith(() => ({
        status: 200,
        text: JSON.stringify({
          model: 'claude-served-other',
          content: [],
          stop_reason: 'end_turn',
        }),
      }));
      assert.equal((await provider.complete(REQUEST, CALL)).model, 'claude-served-other');
    });

    it('maps every stop reason, and a refusal is never mistaken for an empty answer', async () => {
      const cases: readonly (readonly [string | null, string])[] = [
        ['end_turn', 'STOP'],
        ['stop_sequence', 'STOP'],
        ['max_tokens', 'MAX_TOKENS'],
        ['refusal', 'REFUSAL'],
        ['something_new', 'ERROR'],
        [null, 'ERROR'],
      ];
      for (const [stopReason, expected] of cases) {
        const { provider } = providerWith(() => ({
          status: 200,
          text: JSON.stringify({ content: [{ type: 'text', text: '' }], stop_reason: stopReason }),
        }));
        assert.equal(
          (await provider.complete(REQUEST, CALL)).finishReason,
          expected,
          `stop_reason ${String(stopReason)}`,
        );
      }
    });

    it('advertises structured output and no vision or audio capability', () => {
      const { provider } = providerWith(() => ok('{}'));
      assert.equal(provider.id, 'anthropic');
      assert.equal(provider.capabilities.structuredOutput, true);
      assert.equal(provider.capabilities.vision, false);
      assert.equal(provider.capabilities.audio, false);
    });
  });

  describe('the failure taxonomy', () => {
    const failing = async (
      status: number,
      body = '{"error":{"message":"nope"}}',
    ): Promise<Error> => {
      const { provider } = providerWith(() => ({ status, text: body }));
      try {
        await provider.complete(REQUEST, CALL);
        throw new Error(`status ${status} should not have succeeded`);
      } catch (error) {
        return error as Error;
      }
    };

    it('treats a bad credential as terminal: retrying cannot mint a new key', async () => {
      for (const status of [401, 403]) {
        const error = await failing(status);
        assert.ok(error instanceof TerminalError, `status ${status}`);
        assert.equal(error.code, 'LLM_UNAUTHORIZED');
      }
    });

    it('treats a rejected request as terminal: an identical body fails identically', async () => {
      for (const status of [400, 404, 413, 422]) {
        const error = await failing(status);
        assert.ok(error instanceof TerminalError, `status ${status}`);
        assert.equal(error.code, 'LLM_REQUEST_REJECTED');
      }
    });

    it('treats overload and server faults as transient, so the queue backoff applies', async () => {
      for (const status of [408, 409, 429, 500, 503, 529]) {
        const error = await failing(status);
        assert.ok(error instanceof TransientError, `status ${status}`);
        assert.equal(error.code, 'LLM_PROVIDER_UNAVAILABLE');
      }
    });

    it('treats an unrecognised status as transient rather than guessing', async () => {
      const error = await failing(418);
      assert.ok(error instanceof TransientError);
      assert.equal(error.code, 'LLM_UNEXPECTED_STATUS');
    });

    it('never echoes the whole error body into the message', async () => {
      const error = await failing(500, 'x'.repeat(5_000));
      assert.ok(error.message.length < 400, 'a provider body is long and is not ours to log');
    });

    it('turns a transport failure into a retryable error, not a crash', async () => {
      const provider = createAnthropicProvider({
        apiKey: 'test-key',
        clock: createTestClock(),
        models: MODELS,
        transport: () => Promise.reject(new Error('ECONNRESET')),
      });
      await assert.rejects(provider.complete(REQUEST, CALL), (error: unknown) => {
        assert.ok(error instanceof TransientError);
        assert.equal(error.code, 'LLM_TRANSPORT_FAILED');
        return true;
      });
    });

    it('treats an unparseable 200 as transient rather than as an empty decision', async () => {
      const { provider } = providerWith(() => ({ status: 200, text: 'not json at all' }));
      await assert.rejects(provider.complete(REQUEST, CALL), (error: unknown) => {
        assert.ok(error instanceof TransientError);
        assert.equal(error.code, 'LLM_RESPONSE_UNPARSEABLE');
        return true;
      });
    });

    it('does not leak the API key into any error it raises', async () => {
      const error = await failing(401, JSON.stringify({ error: { message: 'invalid x-api-key' } }));
      assert.ok(!JSON.stringify(error).includes('test-key'));
      assert.ok(!error.message.includes('test-key'));
    });
  });
});
