import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, UserId } from '../../src/platform/ids.ts';
import { TerminalError } from '../../src/platform/errors.ts';
import { validatePack } from '../../src/knowledge/domain/account-pack.ts';
import { COMMERCIAL_KINDS } from '../../src/knowledge/domain/knowledge-entry.ts';
import { loadKnowledgeFile, loadPackFile } from '../../src/runtime/admin/pack-authoring.ts';
import { normalizeTags, tokenize } from '../../src/platform/text/normalize-arabic.ts';

/**
 * The first real client pack, held to the rule the whole phase rests on:
 *
 *   NO APPROVED KNOWLEDGE = NO FACTUAL INVENTION.
 *
 * This file is not a schema test — `loadPackFile` already validates the shape. It is a test of
 * *editorial discipline*, run against the actual artefacts an operator will publish. The failure
 * it exists to catch is a well-meaning future edit: someone promotes the instalment terms out of
 * the draft file because a WhatsApp message said "yes we do instalments", and the assistant starts
 * quoting terms nobody at the client has signed off.
 *
 * The pack lives in `knowledge/`, deliberately outside `src/` — `module-boundaries.test.ts`
 * asserts no client identifier appears in the runtime, and that assertion has to keep holding.
 */

const PACK_DIR = resolve(import.meta.dirname, '..', '..', 'knowledge', 'dental-hub', 'pack');
const ACCOUNT = asId<AccountId>('acc_dental_hub_test');
const APPROVER = asId<UserId>('usr_test_approver');
const NOW = new Date('2026-08-28T00:00:00.000Z');

const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(PACK_DIR, name), 'utf8')) as Record<string, unknown>;

describe('the Dental Hub account pack', () => {
  const pack = loadPackFile(join(PACK_DIR, 'pack.json'), {
    accountId: ACCOUNT,
    version: 1,
    publishedBy: APPROVER,
    now: NOW,
  });

  it('validates as a publishable pack, with every required section present', () => {
    assert.deepEqual(validatePack(pack), []);
    for (const section of [
      'profile',
      'brand_voice',
      'intent_taxonomy',
      'routing',
      'authority_matrix',
      'escalation',
    ]) {
      assert.ok(pack.sections[section as keyof typeof pack.sections], `missing ${section}`);
    }
  });

  it('is content-hashed, so republishing an unchanged file is detectable', () => {
    const again = loadPackFile(join(PACK_DIR, 'pack.json'), {
      accountId: ACCOUNT,
      version: 2,
      publishedBy: APPROVER,
      now: new Date('2027-01-01T00:00:00.000Z'),
    });
    assert.equal(again.contentHash, pack.contentHash, 'the hash covers sections, not metadata');
  });

  describe('the authority matrix', () => {
    interface Rule {
      readonly surface: string;
      readonly action: string;
      readonly effect: string;
    }
    const rules = (pack.sections.authority_matrix as { readonly rules: readonly Rule[] }).rules;

    it('grants no customer-visible action to the AI, on any surface', () => {
      // The single most important line in the pack. Phase 02C drafts; it never speaks.
      const visible = [
        'ANSWER_FROM_KNOWLEDGE',
        'ASK_CLARIFICATION',
        'PUBLIC_REPLY',
        'MOVE_TO_DIRECT_MESSAGE',
      ];
      for (const rule of rules) {
        if (!visible.includes(rule.action)) continue;
        assert.notEqual(
          rule.effect,
          'ALLOW',
          `${rule.surface}/${rule.action} would let the AI speak without a human`,
        );
      }
    });

    it('allows only the three actions a customer never sees', () => {
      const allowed = rules.filter((rule) => rule.effect === 'ALLOW').map((rule) => rule.action);
      assert.deepEqual(allowed.sort(), ['ADD_TAG', 'NO_ACTION', 'REQUEST_HUMAN_HANDOFF']);
    });

    it('denies field capture and lead creation, because this phase has no CRM', () => {
      for (const action of ['CAPTURE_FIELD', 'CREATE_LEAD_CANDIDATE']) {
        const rule = rules.find((candidate) => candidate.action === action);
        assert.equal(rule?.effect, 'DENY', `${action} must stay denied`);
      }
    });

    it('denies every moderation action that removes a customer from view', () => {
      for (const action of ['HIDE_COMMENT', 'DELETE_COMMENT', 'BLOCK_USER']) {
        assert.equal(rules.find((rule) => rule.action === action)?.effect, 'DENY');
      }
    });
  });

  describe('routing and escalation', () => {
    it('routes only intents the taxonomy declares', () => {
      const codes = new Set(
        (
          pack.sections.intent_taxonomy as {
            readonly intents: readonly { readonly code: string }[];
          }
        ).intents.map((intent) => intent.code),
      );
      const routes = (
        pack.sections.routing as {
          readonly intent_routes: readonly { readonly intent: string }[];
        }
      ).intent_routes;
      const unknown = routes.map((route) => route.intent).filter((code) => !codes.has(code));
      assert.deepEqual(unknown, [], 'a route to an intent the model cannot emit is dead config');
    });

    it('asks for a human when knowledge is insufficient, rather than asking the customer', () => {
      // The alternative — ASK_CLARIFICATION — is how "we do not know" becomes a stalling reply.
      assert.equal(
        (pack.sections.escalation as { readonly insufficient_knowledge_action: string })
          .insufficient_knowledge_action,
        'REQUEST_HUMAN_HANDOFF',
      );
    });

    it('marks every commercial intent as requiring knowledge', () => {
      const intents = (
        pack.sections.intent_taxonomy as {
          readonly intents: readonly {
            readonly code: string;
            readonly requires_knowledge?: boolean;
          }[];
        }
      ).intents;
      for (const code of ['PRICE_INQUIRY', 'INSTALMENT_INQUIRY', 'WARRANTY_INQUIRY']) {
        const intent = intents.find((candidate) => candidate.code === code);
        assert.equal(intent?.requires_knowledge, true, `${code} must require knowledge`);
      }
    });

    it('keeps the proposed SLA marked as proposed, not as an agreed commitment', () => {
      // It came from our own audit, not from the client. Publishing it as fact would invent a
      // promise the client never made.
      assert.equal((pack.sections.sla as { readonly status: string }).status, 'PROPOSED');
    });
  });
});

describe('the Dental Hub knowledge files', () => {
  const approved = loadKnowledgeFile(join(PACK_DIR, 'knowledge.approved.json'), {
    accountId: ACCOUNT,
    now: NOW,
    approve: { approver: APPROVER },
  });
  const draft = loadKnowledgeFile(join(PACK_DIR, 'knowledge.draft.json'), {
    accountId: ACCOUNT,
    now: NOW,
  });

  it('approves a small, deliberate set and leaves the rest as draft', () => {
    assert.ok(approved.entries.length > 0, 'an empty approved set would make the pack untestable');
    assert.equal(approved.draft, 0);
    assert.equal(draft.approved, 0);
    assert.ok(
      draft.entries.length > approved.entries.length,
      'most of what the workbook contains is unconfirmed, and the split must show that',
    );
  });

  it('approves nothing commercial: no price, no offer, anywhere', () => {
    // The audit finding this answers: a five-day-old price question, and a price nobody could
    // confirm. Not knowing the price is fine; inventing it is not.
    for (const entry of approved.entries) {
      assert.ok(
        !COMMERCIAL_KINDS.has(entry.kind),
        `${entry.id} is a ${entry.kind} and must not be approved in this phase`,
      );
      assert.equal(entry.price, null, `${entry.id} carries a price`);
    }
  });

  it('records an approver and an approval time on every approved entry', () => {
    for (const entry of approved.entries) {
      assert.equal(entry.status, 'APPROVED');
      assert.equal(entry.approvedBy, APPROVER);
      assert.deepEqual(entry.approvedAt, NOW);
    }
  });

  it('leaves every draft entry unapproved and unattributed', () => {
    for (const entry of draft.entries) {
      assert.equal(entry.status, 'DRAFT');
      assert.equal(entry.approvedBy, null);
      assert.equal(entry.approvedAt, null);
    }
  });

  it('carries data confidence and source cells into the stored evidence', () => {
    for (const entry of [...approved.entries, ...draft.entries]) {
      assert.match(entry.evidence ?? '', /^\[[^\]]+\]/, `${entry.id} lost its confidence grade`);
      assert.ok(entry.sourceRef, `${entry.id} lost its source cells`);
    }
  });

  it('contains no unfilled placeholder in any approved body', () => {
    // A bracketed slot that reaches a customer reads as a broken mail merge, and a bracketed slot
    // the model is asked to fill reads as an invitation to invent.
    for (const entry of approved.entries) {
      assert.ok(!/[[\]]/.test(entry.body), `${entry.id} still contains a placeholder`);
      assert.ok(!/\{\{|\}\}/.test(entry.body), `${entry.id} still contains a template slot`);
    }
  });

  it('stores every tag in the normal form retrieval will produce from a message', () => {
    // Idempotence is the property that matters: re-importing must not change a stored tag, and a
    // tag the retriever could never generate is a tag that can never match.
    for (const entry of [...approved.entries, ...draft.entries]) {
      assert.deepEqual(
        normalizeTags(entry.tags),
        entry.tags,
        `${entry.id} has tags that are not in normal form`,
      );
    }
  });

  it('tags the approved entries in Arabic, because the customers write in Arabic', () => {
    const arabic = /[؀-ۿ]/;
    for (const entry of approved.entries) {
      assert.ok(
        entry.tags.some((tag) => arabic.test(tag)),
        `${entry.id} has no Arabic tag and is unreachable from a real message`,
      );
    }
  });

  it('is reachable from the customer wording the evaluation cases record', () => {
    // The end-to-end property, checked at the retrieval layer: the contact entry has to be found
    // from a message that asks how to get in touch, spelled the way a customer spells it.
    const contact = approved.entries.find((entry) => entry.id === 'kne_contact-whatsapp');
    assert.ok(contact, 'the contact entry is the one approved fact the assistant can offer');
    const asked = new Set(tokenize('ازاي اتواصل معاكم؟ الرقم كام'));
    assert.ok(
      contact.tags.some((tag) => asked.has(tag)),
      `none of ${contact.tags.join(', ')} is reachable from a contact question`,
    );
  });

  it('refuses to approve the draft file, because it holds an offer with no expiry', () => {
    // Not a workaround, a demonstration: the same guard that stops this import is the one the
    // database enforces. The Fomos discount stays draft until the client states its end date.
    assert.throws(
      () =>
        loadKnowledgeFile(join(PACK_DIR, 'knowledge.draft.json'), {
          accountId: ACCOUNT,
          now: NOW,
          approve: { approver: APPROVER },
        }),
      (error: unknown) => {
        assert.ok(error instanceof TerminalError);
        assert.equal(error.code, 'KNOWLEDGE_COMMERCIAL_NEEDS_EXPIRY');
        return true;
      },
    );
  });

  it('keeps the unverifiable marketing claims out of approved knowledge', () => {
    const draftKeys = new Set(draft.entries.map((entry) => entry.id as string));
    for (const key of [
      'kne_claim-roson-exclusive-agency',
      'kne_claim-roson-best-selling',
      'kne_instalments',
      'kne_warranty',
      'kne_delivery-installation',
      'kne_sla-response-commitments',
    ]) {
      assert.ok(draftKeys.has(key), `${key} must exist as a tracked draft`);
    }
    const approvedKeys = new Set(approved.entries.map((entry) => entry.id as string));
    for (const key of draftKeys) {
      assert.ok(!approvedKeys.has(key), `${key} appears in both files`);
    }
  });

  it('every draft entry says what is blocking it or what needs confirming', () => {
    const raw = readJson('knowledge.draft.json') as {
      readonly entries: readonly Record<string, unknown>[];
    };
    for (const entry of raw.entries) {
      assert.ok(
        entry['blockedBy'] !== undefined || entry['requiresConfirmation'] !== undefined,
        `${String(entry['key'])} is draft for no stated reason, which is how it gets promoted by accident`,
      );
    }
  });
});

describe('the Dental Hub evaluation cases', () => {
  const cases = (
    readJson('evaluation-cases.json') as {
      readonly cases: readonly Record<string, unknown>[];
    }
  ).cases;

  it('exist, and are evaluation-only rather than knowledge', () => {
    assert.ok(cases.length >= 8);
    // They are not loaded by `loadKnowledgeFile` and cannot become an approved fact — a real
    // customer message quoted as evidence is not a statement the brand has verified.
    assert.throws(() =>
      loadKnowledgeFile(join(PACK_DIR, 'evaluation-cases.json'), { accountId: ACCOUNT, now: NOW }),
    );
  });

  it('cover the two failures this phase must not repeat', () => {
    const priceCases = cases.filter((c) => c['expectNoInventedPrice'] === true);
    const handoffCases = cases.filter((c) => c['expectHandoff'] === true);
    assert.ok(priceCases.length > 0, 'a price question with no approved price must be a case');
    assert.ok(handoffCases.length > 0, 'a service failure must be a case');
  });

  it('names a source for every case, so none is a fabricated example', () => {
    for (const testCase of cases) {
      assert.ok(
        typeof testCase['source'] === 'string' && testCase['source'].length > 0,
        `${String(testCase['id'])} has no provenance`,
      );
    }
  });
});
