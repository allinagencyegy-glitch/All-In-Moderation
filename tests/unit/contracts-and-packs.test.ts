import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type {
  AccountId,
  AccountPackVersionId,
  DomainEventId,
  TraceId,
} from '../../src/platform/ids.ts';
import { ValidationError } from '../../src/platform/errors.ts';
import { hashJson } from '../../src/platform/hash.ts';
import {
  DOMAIN_EVENT_TYPES,
  eventJsonSchema,
  isKnownEventType,
  projectPayload,
  validateEventPayload,
} from '../../src/operations/events/contracts.ts';
import { assertPublishable, matchesSubscription } from '../../src/operations/events/outbox.ts';
import type { DomainEventEnvelope } from '../../src/operations/events/contracts.ts';
import type { EventSubscription } from '../../src/operations/events/outbox.ts';
import { PACK_SCHEMA_VERSION, validatePack } from '../../src/knowledge/domain/account-pack.ts';
import type { AccountPackVersion } from '../../src/knowledge/domain/account-pack.ts';
import {
  resolveAuthorityMatrix,
  resolveEscalationPolicy,
  resolveIntentTaxonomy,
  resolveRoutingPolicy,
} from '../../src/moderation/application/routing-policy.ts';
import { buildPack } from '../support/harness.ts';

const ACCOUNT = asId<AccountId>('acc_1');
const NOW = new Date('2026-06-01T00:00:00.000Z');

function envelope(overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    eventId: asId<DomainEventId>('evt_1'),
    type: 'intent.detected',
    version: 1,
    occurredAt: NOW,
    accountId: ACCOUNT,
    subject: { type: 'conversation', id: 'cnv_1' },
    traceId: asId<TraceId>('trc_1'),
    data: {
      conversation_id: 'cnv_1',
      moderator_run_id: 'run_1',
      intent_code: 'X',
      confidence: 0.5,
    },
    ...overrides,
  };
}

describe('domain event contracts (ADR-009)', () => {
  it('every registered type has a schema', () => {
    for (const type of DOMAIN_EVENT_TYPES) {
      assert.ok(eventJsonSchema(type), `${type} must have a schema`);
      assert.ok(isKnownEventType(type));
    }
  });

  it('publishing an unregistered type is a loud error, not a silent no-op', () => {
    assert.throws(
      () => assertPublishable(envelope({ type: 'made.up' as DomainEventEnvelope['type'] })),
      ValidationError,
    );
  });

  it('a payload that does not match its schema is refused', () => {
    assert.throws(
      () => assertPublishable(envelope({ data: { conversation_id: 'cnv_1' } })),
      ValidationError,
    );
  });

  it('faq.unanswered carries a question *shape*, never the raw customer text', () => {
    const issues = validateEventPayload('faq.unanswered', {
      conversation_id: 'cnv_1',
      knowledge_gap_id: 'kng_1',
      question_shape: 'PRICE_INQUIRY(product)',
      intent_code: 'PRICE_INQUIRY',
      locale: 'en',
      // A field nobody contracted for — including, hypothetically, the customer's own sentence.
      raw_text: 'how much is the big one',
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /unknown property/);
  });

  it('lead.candidate_created exposes field names but not their values', () => {
    assert.deepEqual(
      validateEventPayload('lead.candidate_created', {
        conversation_id: 'cnv_1',
        lead_candidate_id: 'lcd_1',
        captured_field_names: ['phone', 'city'],
      }),
      [],
    );
    assert.ok(
      validateEventPayload('lead.candidate_created', {
        conversation_id: 'cnv_1',
        lead_candidate_id: 'lcd_1',
        captured_field_names: ['phone'],
        captured_values: { phone: '555-0100' },
      }).length > 0,
    );
  });

  it('a subscription only matches its own account and declared types', () => {
    const subscription: EventSubscription = {
      id: 'sub_1',
      accountId: ACCOUNT,
      destination: 'https://example.test/hook',
      types: ['intent.detected'],
      active: true,
    };
    assert.equal(matchesSubscription(subscription, envelope()), true);
    assert.equal(
      matchesSubscription(subscription, envelope({ accountId: asId<AccountId>('acc_2') })),
      false,
    );
    assert.equal(matchesSubscription({ ...subscription, active: false }, envelope()), false);
    assert.equal(
      matchesSubscription(
        subscription,
        envelope({
          type: 'complaint.detected',
          data: { conversation_id: 'c', intent_code: 'X', severity: 'LOW' },
        }),
      ),
      false,
    );
  });

  it('field projection narrows a payload to what a consumer contracted for', () => {
    const data = { conversation_id: 'cnv_1', intent_code: 'X', confidence: 0.9 };
    assert.deepEqual(projectPayload(data, ['conversation_id']), { conversation_id: 'cnv_1' });
    assert.deepEqual(projectPayload(data, undefined), data);
    // Adding a field to an event later cannot widen an existing consumer's access.
    assert.deepEqual(projectPayload({ ...data, new_field: 'x' }, ['conversation_id']), {
      conversation_id: 'cnv_1',
    });
  });
});

describe('account pack validation (ADR-010)', () => {
  const base = buildPack(ACCOUNT, {
    debounceMs: 2_000,
    maxDelayMs: 6_000,
    insufficientKnowledgeAction: 'REQUEST_HUMAN_HANDOFF',
  });

  it('accepts a well-formed pack', () => {
    assert.deepEqual(validatePack(base), []);
    assert.equal(base.schemaVersion, PACK_SCHEMA_VERSION);
    assert.equal(base.contentHash, hashJson(base.sections), 'content addressing is stable');
  });

  it('requires the sections without which no safe decision can be made', () => {
    const stripped: AccountPackVersion = {
      ...base,
      sections: { profile: base.sections['profile'] },
    };
    const issues = validatePack(stripped);
    const missing = issues.map((i) => i.path);
    assert.ok(missing.includes('sections.brand_voice'));
    assert.ok(missing.includes('sections.intent_taxonomy'));
    assert.ok(missing.includes('sections.authority_matrix'));
  });

  it('F-17: rejects a route to an intent that does not exist', () => {
    const broken: AccountPackVersion = {
      ...base,
      sections: {
        ...base.sections,
        routing: {
          debounce_ms: 2_000,
          max_delay_ms: 6_000,
          intent_routes: [{ intent: 'NOT_A_REAL_INTENT', handoff_kind: 'SALES' }],
        },
      },
    };
    const issues = validatePack(broken);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /not defined in intent_taxonomy/);
  });

  it('rejects a debounce ceiling below the debounce window', () => {
    const broken: AccountPackVersion = {
      ...base,
      sections: { ...base.sections, routing: { debounce_ms: 9_000, max_delay_ms: 1_000 } },
    };
    const issues = validatePack(broken);
    assert.match(issues[0]!.message, /max_delay_ms must be >= debounce_ms/);
  });

  it('rejects an authority rule naming an action we do not implement', () => {
    const broken: AccountPackVersion = {
      ...base,
      sections: {
        ...base.sections,
        authority_matrix: { rules: [{ surface: '*', action: 'LAUNCH_MISSILES', effect: 'ALLOW' }] },
      },
    };
    assert.ok(validatePack(broken).length > 0);
  });

  it('rejects an unknown section key', () => {
    const broken: AccountPackVersion = {
      ...base,
      sections: { ...base.sections, mystery_section: {} } as AccountPackVersion['sections'],
    };
    assert.ok(validatePack(broken).some((i) => i.message === 'unknown section key'));
  });
});

describe('pack projection into runtime policy', () => {
  const pack = buildPack(ACCOUNT, {
    debounceMs: 1_500,
    maxDelayMs: 4_000,
    insufficientKnowledgeAction: 'ASK_CLARIFICATION',
  });

  it('projects routing, escalation, taxonomy and the matrix', () => {
    assert.deepEqual(resolveRoutingPolicy(pack), { debounceMs: 1_500, maxDelayMs: 4_000 });
    assert.equal(resolveEscalationPolicy(pack).insufficientKnowledgeAction, 'ASK_CLARIFICATION');
    assert.equal(resolveEscalationPolicy(pack).handoffFallbackToAi, false);

    const taxonomy = resolveIntentTaxonomy(pack);
    assert.ok(taxonomy.codes.has('PRICE_INQUIRY'));
    assert.ok(taxonomy.requiresKnowledge.has('PRICE_INQUIRY'));
    assert.ok(taxonomy.escalates.has('COMPLAINT'));

    assert.equal(resolveAuthorityMatrix(pack).packVersionId, pack.id);
  });

  it('degrades to conservative defaults when a pack is missing or malformed', () => {
    assert.deepEqual(resolveRoutingPolicy(null), { debounceMs: 2_500, maxDelayMs: 8_000 });
    assert.equal(
      resolveEscalationPolicy(null).handoffFallbackToAi,
      false,
      'never auto-return by default',
    );

    const malformed: AccountPackVersion = {
      ...pack,
      id: asId<AccountPackVersionId>('apv_bad'),
      sections: { authority_matrix: { rules: 'not an array' } },
    };
    const matrix = resolveAuthorityMatrix(malformed);
    // Falls back to rules that can ask or escalate but never answer, rather than to a crash or to
    // an empty matrix that would silently deny everything including escalation.
    assert.ok(
      matrix.rules.some((r) => r.action === 'REQUEST_HUMAN_HANDOFF' && r.effect === 'ALLOW'),
    );
    assert.ok(
      !matrix.rules.some((r) => r.action === 'ANSWER_FROM_KNOWLEDGE' && r.effect === 'ALLOW'),
    );
  });

  it('never lets a ceiling below the window through, even if a pack slipped past validation', () => {
    const bad: AccountPackVersion = {
      ...pack,
      sections: { ...pack.sections, routing: { debounce_ms: 9_000, max_delay_ms: 1_000 } },
    };
    const routing = resolveRoutingPolicy(bad);
    assert.ok(routing.maxDelayMs >= routing.debounceMs);
  });
});
