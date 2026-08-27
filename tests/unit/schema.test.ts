import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as s from '../../src/platform/schema.ts';
import { extractJson } from '../../src/platform/llm/structured.ts';
import { moderatorDecisionSchema } from '../../src/moderation/domain/decision.ts';

/**
 * The schema layer is what stands between a probabilistic text generator and the platform's state
 * (ADR-007). Its strictness is the feature, so the strictness is what is tested.
 */
describe('schema validation', () => {
  it('rejects unknown properties rather than stripping them', () => {
    const schema = s.object({ a: s.string() });
    const issues = s.validate(schema, { a: 'x', surprise: true });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /unknown property/);
  });

  it('treats a missing key and an explicit undefined as the same absence', () => {
    const schema = s.object({ a: s.string(), b: s.optional(s.number()) });
    assert.deepEqual(s.validate(schema, { a: 'x' }), []);
    assert.deepEqual(s.validate(schema, { a: 'x', b: undefined }), []);
    // null is a value, not an absence.
    assert.equal(s.validate(schema, { a: 'x', b: null }).length, 1);
  });

  it('reports the full path of a nested failure', () => {
    const schema = s.object({ outer: s.object({ items: s.array(s.object({ n: s.number() })) }) });
    const issues = s.validate(schema, { outer: { items: [{ n: 1 }, { n: 'two' }] } });
    assert.equal(issues[0]!.path, 'outer.items[1].n');
  });

  it('enforces string, number and enum constraints', () => {
    assert.equal(s.validate(s.string({ maxLength: 3 }), 'abcd').length, 1);
    assert.equal(s.validate(s.string({ pattern: /^[A-Z]+$/ }), 'abc').length, 1);
    assert.equal(s.validate(s.number({ min: 0, max: 1 }), 1.5).length, 1);
    assert.equal(s.validate(s.number({ integer: true }), 1.5).length, 1);
    assert.equal(s.validate(s.number(), Number.NaN).length, 1);
    assert.equal(s.validate(s.enumOf(['A', 'B']), 'C').length, 1);
  });

  it('emits JSON Schema that describes the same shape it validates', () => {
    const schema = s.object({ a: s.string(), b: s.optional(s.number({ min: 0 })) });
    const json = schema.toJsonSchema() as Record<string, unknown>;
    assert.equal(json['type'], 'object');
    assert.deepEqual(json['required'], ['a']);
    assert.equal(json['additionalProperties'], false);
  });

  it('parse returns a typed value or the issues, never a half-valid object', () => {
    const schema = s.object({ a: s.string() });
    const good = s.parse(schema, { a: 'x' });
    assert.equal(good.ok, true);
    const bad = s.parse(schema, { a: 1 });
    assert.equal(bad.ok, false);
  });
});

describe('model output extraction', () => {
  it('accepts bare JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });

  it('accepts fenced JSON, with or without a language tag', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
  });

  it('accepts JSON preceded by conversational preamble', () => {
    assert.deepEqual(extractJson('Sure! Here is the result:\n{"a":1}'), { a: 1 });
  });

  it('returns undefined for text that is not JSON at all, rather than guessing', () => {
    assert.equal(extractJson('I am not going to answer that.'), undefined);
    assert.equal(extractJson('{"a": '), undefined, 'truncated JSON is not repaired by hand');
  });
});

describe('moderator decision contract', () => {
  const valid = {
    intent: { code: 'PRICE_INQUIRY', confidence: 0.9 },
    proposed_action: 'ANSWER_FROM_KNOWLEDGE',
    reply_text: 'Here is the price.',
    knowledge_refs: ['kne_1'],
    needs_human: false,
    confidence: 0.8,
  };

  it('accepts a well-formed decision', () => {
    assert.deepEqual(s.validate(moderatorDecisionSchema, valid), []);
  });

  it('rejects an action outside the closed vocabulary', () => {
    const issues = s.validate(moderatorDecisionSchema, {
      ...valid,
      proposed_action: 'DROP_TABLES',
    });
    assert.equal(issues.length, 1);
  });

  it('rejects a malformed intent code', () => {
    const issues = s.validate(moderatorDecisionSchema, {
      ...valid,
      intent: { code: 'lower case', confidence: 0.5 },
    });
    assert.equal(issues.length, 1);
  });

  it('rejects a confidence outside [0, 1]', () => {
    assert.equal(s.validate(moderatorDecisionSchema, { ...valid, confidence: 1.4 }).length, 1);
  });

  it('rejects extra fields, which is how an invented capability is caught', () => {
    const issues = s.validate(moderatorDecisionSchema, {
      ...valid,
      execute_sql: 'SELECT * FROM accounts',
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /unknown property/);
  });

  it('caps citation and reply sizes so one response cannot flood a conversation', () => {
    assert.equal(
      s.validate(moderatorDecisionSchema, { ...valid, reply_text: 'x'.repeat(2_001) }).length,
      1,
    );
    assert.equal(
      s.validate(moderatorDecisionSchema, {
        ...valid,
        knowledge_refs: Array.from({ length: 13 }, (_, i) => `kne_${i}`),
      }).length,
      1,
    );
  });
});
