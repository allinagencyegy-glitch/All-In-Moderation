import { TransientError } from '../errors.ts';
import { withTimeout } from '../async.ts';
import type { Schema } from '../schema.ts';
import { formatIssues, validate } from '../schema.ts';
import type { Infer } from '../schema.ts';
import type { LlmCallOptions, LlmProvider, LlmRequest, LlmResponse } from './provider.ts';

export interface StructuredResult<T> {
  readonly value: T;
  readonly response: LlmResponse;
  readonly attempts: number;
  readonly repaired: boolean;
}

/**
 * Extracts a JSON object from model output.
 *
 * Tolerant of the artefacts models actually emit — fenced code blocks, a sentence of preamble —
 * and strict about everything else. Being lenient here and strict in validation is the right
 * split: reformatting is a presentation quirk, whereas a missing or invented field is a semantic
 * error we must not paper over.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  const candidate = fenced?.[1] ?? sliceToOutermostObject(trimmed);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

function sliceToOutermostObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 1);
}

export interface StructuredCallDeps {
  readonly provider: LlmProvider;
}

/**
 * Calls the model and validates the result against **our** schema.
 *
 * A vendor's structured-output feature is treated as an optimisation, never as a contract: we
 * re-validate regardless. On failure there is exactly one repair attempt, with the validation
 * errors fed back at a lower temperature. A second failure raises a retryable error so the job
 * queue's normal backoff applies and, on exhaustion, a human is asked to take over.
 *
 * What deliberately does not happen: no coercion, no "fixing up" partial output, no accepting a
 * response because it looks close enough. A half-valid decision is a wrong decision with extra
 * steps.
 */
export async function completeStructured<S extends Schema<unknown>>(
  deps: StructuredCallDeps,
  schema: S,
  request: LlmRequest,
  options: LlmCallOptions,
): Promise<StructuredResult<Infer<S>>> {
  const first = await callOnce(deps, request, options);
  const firstParsed = extractJson(first.text);
  const firstIssues =
    firstParsed === undefined
      ? [{ path: '', message: 'response was not valid JSON' }]
      : validate(schema, firstParsed);

  if (firstIssues.length === 0) {
    return { value: firstParsed as Infer<S>, response: first, attempts: 1, repaired: false };
  }

  const repairRequest: LlmRequest = {
    ...request,
    temperature: 0,
    turns: [
      ...request.turns,
      { role: 'assistant', content: first.text },
      {
        role: 'user',
        content:
          'Your previous response did not satisfy the required schema. ' +
          `Problems: ${formatIssues(firstIssues)}. ` +
          'Reply with corrected JSON only — no prose, no code fences, no extra properties.',
      },
    ],
  };

  const second = await callOnce(deps, repairRequest, options);
  const secondParsed = extractJson(second.text);
  const secondIssues =
    secondParsed === undefined
      ? [{ path: '', message: 'response was not valid JSON' }]
      : validate(schema, secondParsed);

  if (secondIssues.length === 0) {
    return { value: secondParsed as Infer<S>, response: second, attempts: 2, repaired: true };
  }

  throw new TransientError(
    'LLM_SCHEMA_INVALID',
    `Model output failed schema validation after repair: ${formatIssues(secondIssues, 5)}`,
    { role: options.role, model: second.model },
  );
}

async function callOnce(
  deps: StructuredCallDeps,
  request: LlmRequest,
  options: LlmCallOptions,
): Promise<LlmResponse> {
  const response = await withTimeout(
    `llm.${options.role}`,
    options.timeoutMs,
    (signal) => deps.provider.complete(request, { ...options, signal }),
    options.signal,
  );
  if (response.finishReason === 'REFUSAL') {
    throw new TransientError('LLM_REFUSAL', 'Model refused to produce a decision', {
      role: options.role,
      model: response.model,
    });
  }
  if (response.finishReason === 'MAX_TOKENS') {
    // Truncated JSON is malformed JSON. Treated as a schema failure rather than parsed leniently.
    throw new TransientError('LLM_TRUNCATED', 'Model output was truncated at the token limit', {
      role: options.role,
      model: response.model,
    });
  }
  return response;
}
