import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { AccountPackVersionId, ConversationId } from '../../src/platform/ids.ts';
import { gateAction, fallbackActionFor } from '../../src/policy/action-gate.ts';
import type { ActionGateInput } from '../../src/policy/action-gate.ts';
import { ACTION_TYPES, PHASE0_FORBIDDEN_ACTIONS } from '../../src/policy/actions.ts';
import type { AuthorityMatrix } from '../../src/policy/authority-matrix.ts';
import { conservativeDefaultRules, evaluateMatrix } from '../../src/policy/authority-matrix.ts';

/**
 * The action gate is the boundary between "the model proposed something" and "the platform did
 * something" (invariants I5, I7, I12). Its evaluation *order* is the design: client configuration
 * is consulted last, so no pack can unlock a prohibited action.
 */

const NOW = new Date('2026-06-01T00:00:00.000Z');
const CONVERSATION = asId<ConversationId>('cnv_1');

const permissiveMatrix: AuthorityMatrix = {
  packVersionId: asId<AccountPackVersionId>('apv_1'),
  rules: ACTION_TYPES.map((action) => ({
    surface: '*' as const,
    action,
    effect: 'ALLOW' as const,
  })),
};

function input(overrides: Partial<ActionGateInput> = {}): ActionGateInput {
  return {
    conversationId: CONVERSATION,
    surface: 'DIRECT_MESSAGE',
    ownership: 'AI_OWNED',
    lifecycle: 'OPEN',
    ownershipVersion: 3,
    accountCanActAutonomously: true,
    action: 'ASK_CLARIFICATION',
    requestedDeliveryMode: 'AUTONOMOUS',
    matrix: permissiveMatrix,
    knowledgeVerified: true,
    citationCount: 1,
    hasReplyText: true,
    now: NOW,
    ...overrides,
  };
}

describe('action gate', () => {
  it('I12: destructive actions are denied even when the account matrix allows everything', () => {
    for (const action of PHASE0_FORBIDDEN_ACTIONS) {
      const result = gateAction(input({ action }));
      assert.equal(result.outcome, 'DENIED', `${action} must be denied`);
      assert.match(result.reason, /forbidden in this phase/);
    }
  });

  it('I5: autonomous delivery is refused unless the conversation is AI-owned and open', () => {
    for (const ownership of ['HUMAN_OWNED', 'PENDING_HUMAN'] as const) {
      const result = gateAction(input({ ownership, action: 'ANSWER_FROM_KNOWLEDGE' }));
      assert.equal(result.outcome, 'DENIED');
      assert.match(result.reason, /requires AI_OWNED/);
    }
    const closed = gateAction(input({ lifecycle: 'CLOSED', action: 'ANSWER_FROM_KNOWLEDGE' }));
    assert.equal(closed.outcome, 'DENIED');
  });

  it('a suspended account may not act, even on an AI-owned conversation', () => {
    const result = gateAction(input({ accountCanActAutonomously: false }));
    assert.equal(result.outcome, 'DENIED');
    assert.match(result.reason, /not permitted to act autonomously/);
  });

  it('personal data is never requested on a public surface (F-23)', () => {
    const capture = gateAction(input({ surface: 'PUBLIC_COMMENT', action: 'CAPTURE_FIELD' }));
    assert.equal(capture.outcome, 'DENIED');
    assert.match(capture.reason, /public surface/);

    const lead = gateAction(input({ surface: 'PUBLIC_COMMENT', action: 'CREATE_LEAD_CANDIDATE' }));
    assert.equal(lead.outcome, 'DENIED');
  });

  it('I8/I9: a knowledge-grounded answer requires verified citations and text', () => {
    const noCitations = gateAction(input({ action: 'ANSWER_FROM_KNOWLEDGE', citationCount: 0 }));
    assert.equal(noCitations.outcome, 'DENIED');
    assert.match(noCitations.reason, /at least one knowledge citation/);

    const unverified = gateAction(
      input({ action: 'ANSWER_FROM_KNOWLEDGE', knowledgeVerified: false }),
    );
    assert.equal(unverified.outcome, 'DENIED');
    assert.match(unverified.reason, /failed verification/);

    const noText = gateAction(input({ action: 'ANSWER_FROM_KNOWLEDGE', hasReplyText: false }));
    assert.equal(noText.outcome, 'DENIED');
  });

  it('allows a well-formed action and mints an authorisation bound to the ownership version', () => {
    const result = gateAction(input({ action: 'ANSWER_FROM_KNOWLEDGE' }));
    assert.equal(result.outcome, 'ALLOWED');
    assert.equal(result.authorization.action, 'ANSWER_FROM_KNOWLEDGE');
    assert.equal(result.authorization.ownershipVersion, 3);
    assert.equal(result.authorization.conversationId, CONVERSATION);
    assert.equal(result.authorization.deliveryMode, 'AUTONOMOUS');
  });

  it('surfaces REQUIRE_APPROVAL from the matrix without minting an authorisation', () => {
    const matrix: AuthorityMatrix = {
      packVersionId: asId<AccountPackVersionId>('apv_1'),
      rules: [{ surface: '*', action: 'PUBLIC_REPLY', effect: 'REQUIRE_APPROVAL' }],
    };
    const result = gateAction(input({ surface: 'PUBLIC_COMMENT', action: 'PUBLIC_REPLY', matrix }));
    assert.equal(result.outcome, 'REQUIRES_APPROVAL');
    assert.ok(!('authorization' in result));
  });

  it('SUGGESTED delivery bypasses the ownership check but not the prohibitions', () => {
    // Shadow mode may propose while a human owns the conversation; it may still never propose a
    // destructive action.
    const suggestion = gateAction(
      input({
        ownership: 'HUMAN_OWNED',
        requestedDeliveryMode: 'SUGGESTED',
        action: 'ASK_CLARIFICATION',
      }),
    );
    assert.equal(suggestion.outcome, 'ALLOWED');
    assert.equal(suggestion.authorization.deliveryMode, 'SUGGESTED');

    const destructive = gateAction(
      input({
        ownership: 'HUMAN_OWNED',
        requestedDeliveryMode: 'SUGGESTED',
        action: 'HIDE_COMMENT',
      }),
    );
    assert.equal(destructive.outcome, 'DENIED');
  });

  it('every denied action has a fallback, and customer-facing denials fall back to a human', () => {
    for (const action of ACTION_TYPES) {
      const fallback = fallbackActionFor(action);
      assert.ok(ACTION_TYPES.includes(fallback), `${action} must have a valid fallback`);
      assert.ok(!PHASE0_FORBIDDEN_ACTIONS.has(fallback), 'a fallback is never a forbidden action');
    }
    assert.equal(fallbackActionFor('ANSWER_FROM_KNOWLEDGE'), 'REQUEST_HUMAN_HANDOFF');
    assert.equal(fallbackActionFor('NO_ACTION'), 'NO_ACTION', 'inert actions do not escalate');
  });
});

describe('authority matrix', () => {
  it('is closed by default: an action with no rule is denied', () => {
    const matrix: AuthorityMatrix = {
      packVersionId: asId<AccountPackVersionId>('apv_1'),
      rules: [],
    };
    const result = evaluateMatrix(matrix, 'ANSWER_FROM_KNOWLEDGE', 'DIRECT_MESSAGE');
    assert.equal(result.effect, 'DENY');
    assert.match(result.reason, /default deny/);
  });

  it('prefers a surface-specific rule over the wildcard', () => {
    const matrix: AuthorityMatrix = {
      packVersionId: asId<AccountPackVersionId>('apv_1'),
      rules: [
        { surface: '*', action: 'ANSWER_FROM_KNOWLEDGE', effect: 'ALLOW' },
        { surface: 'PUBLIC_COMMENT', action: 'ANSWER_FROM_KNOWLEDGE', effect: 'DENY' },
      ],
    };
    assert.equal(evaluateMatrix(matrix, 'ANSWER_FROM_KNOWLEDGE', 'PUBLIC_COMMENT').effect, 'DENY');
    assert.equal(evaluateMatrix(matrix, 'ANSWER_FROM_KNOWLEDGE', 'DIRECT_MESSAGE').effect, 'ALLOW');
  });

  it('the conservative default cannot answer, only ask or escalate', () => {
    const matrix: AuthorityMatrix = {
      packVersionId: asId<AccountPackVersionId>('apv_none'),
      rules: conservativeDefaultRules(),
    };
    assert.equal(evaluateMatrix(matrix, 'ANSWER_FROM_KNOWLEDGE', 'DIRECT_MESSAGE').effect, 'DENY');
    assert.equal(evaluateMatrix(matrix, 'PUBLIC_REPLY', 'PUBLIC_COMMENT').effect, 'DENY');
    assert.equal(evaluateMatrix(matrix, 'ASK_CLARIFICATION', 'DIRECT_MESSAGE').effect, 'ALLOW');
    assert.equal(evaluateMatrix(matrix, 'REQUEST_HUMAN_HANDOFF', 'DIRECT_MESSAGE').effect, 'ALLOW');
  });
});
