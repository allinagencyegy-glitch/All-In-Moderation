import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestClock } from '../../src/platform/clock.ts';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, KnowledgeEntryId, UserId } from '../../src/platform/ids.ts';
import { scopeForAccount } from '../../src/core/account/index.ts';
import type { Account } from '../../src/core/account/index.ts';
import { createKnowledgeGate } from '../../src/knowledge/application/knowledge-gate.ts';
import type { KnowledgeEntry } from '../../src/knowledge/domain/knowledge-entry.ts';
import type { KnowledgeRepository } from '../../src/knowledge/ports.ts';

/**
 * The Knowledge Gate is the mechanism that makes "never present an expired or unapproved price as
 * current" a property of the code rather than a hope about the model (ADR-010, F-07, F-08).
 */

const ACCOUNT: Account = {
  id: asId<AccountId>('acc_1'),
  slug: 'demo',
  name: 'Demo',
  status: 'ACTIVE',
  defaultLocale: 'en',
  timezone: 'UTC',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};
const SCOPE = scopeForAccount(ACCOUNT);
const NOW = new Date('2026-06-01T00:00:00.000Z');

function entry(overrides: Omit<Partial<KnowledgeEntry>, 'id'> & { id: string }): KnowledgeEntry {
  return {
    id: asId<KnowledgeEntryId>(overrides.id),
    accountId: overrides.accountId ?? ACCOUNT.id,
    kind: overrides.kind ?? 'FAQ',
    title: overrides.title ?? 'Title',
    body: overrides.body ?? 'Body',
    locale: overrides.locale ?? 'en',
    status: overrides.status ?? 'APPROVED',
    validFrom: overrides.validFrom ?? null,
    validUntil: overrides.validUntil ?? null,
    sourceRef: null,
    evidence: null,
    approvedBy: asId<UserId>('usr_1'),
    approvedAt: NOW,
    productRef: overrides.productRef ?? null,
    paymentType: null,
    price: overrides.price ?? null,
    tags: overrides.tags ?? ['tag'],
    intentCodes: overrides.intentCodes ?? ['GENERAL_QUESTION'],
    supersedesId: null,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

/**
 * A deliberately *permissive* repository: it returns everything, including rows a correct adapter
 * would have filtered out. That is the point — the gate must not depend on the repository being
 * right, because a bug in one adapter must never become a wrong price in front of a customer.
 */
function leakyRepository(entries: readonly KnowledgeEntry[]): KnowledgeRepository {
  return {
    findApproved: () => Promise.resolve(entries),
    findByIds: (_scope, ids) =>
      Promise.resolve(entries.filter((e) => (ids as readonly string[]).includes(e.id))),
    save: () => Promise.resolve(),
  };
}

describe('knowledge gate', () => {
  it('never shows the model an expired entry', async () => {
    const expired = entry({
      id: 'kne_expired',
      kind: 'PRICE',
      validUntil: new Date('2026-05-01T00:00:00.000Z'),
      price: { amount: '100.00', currency: 'EUR' },
    });
    const gate = createKnowledgeGate(leakyRepository([expired]));

    const candidates = await gate.retrieve(
      SCOPE,
      { locale: 'en', intentCodes: [], tags: ['tag'] },
      NOW,
    );

    assert.deepEqual(candidates.entries, []);
    assert.deepEqual(candidates.rejected, [
      { id: 'kne_expired', reason: 'OUTSIDE_VALIDITY_WINDOW' },
    ]);
  });

  it('never shows the model an entry that is not yet valid', async () => {
    const future = entry({ id: 'kne_future', validFrom: new Date('2026-07-01T00:00:00.000Z') });
    const gate = createKnowledgeGate(leakyRepository([future]));

    const candidates = await gate.retrieve(
      SCOPE,
      { locale: 'en', intentCodes: [], tags: ['tag'] },
      NOW,
    );
    assert.deepEqual(candidates.entries, []);
  });

  it('never shows the model an unapproved entry', async () => {
    const draft = entry({ id: 'kne_draft', status: 'DRAFT' });
    const gate = createKnowledgeGate(leakyRepository([draft]));

    const candidates = await gate.retrieve(
      SCOPE,
      { locale: 'en', intentCodes: [], tags: ['tag'] },
      NOW,
    );
    assert.deepEqual(candidates.rejected, [{ id: 'kne_draft', reason: 'NOT_APPROVED' }]);
  });

  it('never shows the model another account entry, even if the repository returns it', async () => {
    const foreign = entry({ id: 'kne_foreign', accountId: asId<AccountId>('acc_other') });
    const gate = createKnowledgeGate(leakyRepository([foreign]));

    const candidates = await gate.retrieve(
      SCOPE,
      { locale: 'en', intentCodes: [], tags: ['tag'] },
      NOW,
    );
    assert.deepEqual(candidates.rejected, [{ id: 'kne_foreign', reason: 'CROSS_ACCOUNT' }]);
  });

  it('rejects a citation that was never supplied (containment, invariant I9)', async () => {
    const supplied = entry({ id: 'kne_ok' });
    const gate = createKnowledgeGate(leakyRepository([supplied]));
    const candidates = await gate.retrieve(
      SCOPE,
      { locale: 'en', intentCodes: [], tags: ['tag'] },
      NOW,
    );

    const verdict = gate.verifyCitations(candidates, ['kne_invented'], NOW);
    assert.equal(verdict.verified, false);
    assert.match(verdict.reason, /not supplied/);
  });

  it('rejects a citation whose price expired between run start and commit', async () => {
    const clock = createTestClock(NOW);
    const price = entry({
      id: 'kne_price',
      kind: 'PRICE',
      price: { amount: '100.00', currency: 'EUR' },
      validUntil: new Date(NOW.getTime() + 60_000),
    });
    const gate = createKnowledgeGate(leakyRepository([price]));

    const candidates = await gate.retrieve(
      SCOPE,
      { locale: 'en', intentCodes: [], tags: ['tag'] },
      clock.now(),
    );
    assert.equal(candidates.entries.length, 1, 'valid at the moment of retrieval');

    // The model took two minutes; the offer expired in the meantime.
    clock.advanceMs(120_000);
    const verdict = gate.verifyCitations(candidates, ['kne_price'], clock.now());
    assert.equal(verdict.verified, false);
    assert.match(verdict.reason, /no longer approved or in validity/);
  });

  it('accepts citations that were supplied and are still valid', async () => {
    const supplied = entry({ id: 'kne_ok' });
    const gate = createKnowledgeGate(leakyRepository([supplied]));
    const candidates = await gate.retrieve(
      SCOPE,
      { locale: 'en', intentCodes: [], tags: ['tag'] },
      NOW,
    );

    const verdict = gate.verifyCitations(candidates, ['kne_ok'], NOW);
    assert.equal(verdict.verified, true);
    assert.deepEqual(verdict.usedIds, ['kne_ok']);
  });

  it('ranks intent matches above tag matches, and commercial entries above prose', async () => {
    const byTag = entry({ id: 'kne_tag', tags: ['hours'], intentCodes: [] });
    const byIntent = entry({ id: 'kne_intent', tags: [], intentCodes: ['PRICE_INQUIRY'] });
    const commercial = entry({
      id: 'kne_price',
      kind: 'PRICE',
      tags: ['hours'],
      intentCodes: [],
      price: { amount: '10.00', currency: 'EUR' },
    });
    const gate = createKnowledgeGate(leakyRepository([byTag, commercial, byIntent]));

    const candidates = await gate.retrieve(
      SCOPE,
      { locale: 'en', intentCodes: ['PRICE_INQUIRY'], tags: ['hours'] },
      NOW,
    );
    assert.deepEqual(
      candidates.entries.map((e) => e.id),
      ['kne_intent', 'kne_price', 'kne_tag'],
    );
  });
});
