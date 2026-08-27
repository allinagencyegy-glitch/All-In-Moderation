import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, decisionJson, metaMessageEnvelope } from '../support/harness.ts';
import { TenantViolationError } from '../../src/platform/errors.ts';
import { scopedCacheKey, scopedPartitionKey } from '../../src/core/account/index.ts';
import { asId } from '../../src/platform/ids.ts';
import type { TraceId } from '../../src/platform/ids.ts';

/**
 * Account isolation (F-19, ADR-002).
 *
 * Cross-tenant leakage is the most damaging failure this platform can produce: it is public, it is
 * irreversible, and there is no good recovery. So it is defended in three independent layers, and
 * this file tests the two that exist in Phase 0 (the third, Postgres RLS, ships with the Postgres
 * adapters and is asserted by migration `0002`).
 */
describe('tenant isolation', () => {
  it('two accounts process concurrent traffic without seeing each other', async () => {
    const h = createHarness();
    const alpha = await h.seedAccount({
      slug: 'alpha',
      pageId: 'page-alpha',
      webhookId: 'hook-alpha',
    });
    const beta = await h.seedAccount({ slug: 'beta', pageId: 'page-beta', webhookId: 'hook-beta' });

    const alphaKnowledge = await h.seedKnowledge(alpha.scope, {
      title: 'Alpha hours',
      body: 'Alpha is open on weekdays.',
      tags: ['hours'],
    });
    await h.seedKnowledge(beta.scope, {
      title: 'Beta hours',
      body: 'Beta is open at weekends.',
      tags: ['hours'],
    });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({ replyText: 'Answer.', knowledgeRefs: [alphaKnowledge.id] }),
    });

    // Deliberately the same sender id on both accounts: a shared PSID must not merge identities.
    await h.postWebhook(
      alpha,
      metaMessageEnvelope('page-alpha', [{ senderId: 'psid-shared', mid: 'm_a', text: 'hours?' }]),
    );
    await h.postWebhook(
      beta,
      metaMessageEnvelope('page-beta', [{ senderId: 'psid-shared', mid: 'm_b', text: 'hours?' }]),
    );
    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const alphaConversations = [...h.container.db.tables.conversations.values()].filter(
      (c) => c.accountId === alpha.account.id,
    );
    const betaConversations = [...h.container.db.tables.conversations.values()].filter(
      (c) => c.accountId === beta.account.id,
    );
    assert.equal(alphaConversations.length, 1);
    assert.equal(betaConversations.length, 1);
    assert.notEqual(
      alphaConversations[0]!.channelIdentityId,
      betaConversations[0]!.channelIdentityId,
    );

    // Beta's model call must never have been shown alpha's knowledge.
    const betaPrompt = h.provider.calls.find((c) => c.request.turns[0]!.content.includes('Beta'));
    const alphaPrompt = h.provider.calls.find((c) => c.request.turns[0]!.content.includes('Alpha'));
    assert.ok(alphaPrompt && betaPrompt, 'both accounts were processed');
    assert.ok(!alphaPrompt.request.turns[0]!.content.includes('Beta is open'));
    assert.ok(!betaPrompt.request.turns[0]!.content.includes('Alpha is open'));
  });

  it('a repository refuses to return another account rows, loudly', async () => {
    const h = createHarness();
    const alpha = await h.seedAccount({ pageId: 'page-alpha', webhookId: 'hook-alpha' });
    const beta = await h.seedAccount({ pageId: 'page-beta', webhookId: 'hook-beta' });

    await h.postWebhook(
      alpha,
      metaMessageEnvelope('page-alpha', [{ senderId: 'psid-1', mid: 'm_1', text: 'hello' }]),
    );
    await h.drainTypes(['raw_event.normalize']);
    const alphaConversation = [...h.container.db.tables.conversations.values()][0]!;

    // Reading alpha's conversation with beta's scope is a hard error, not an empty result and not
    // — critically — a successful read.
    await assert.rejects(
      () => h.container.conversations.findById(beta.scope, alphaConversation.id),
      TenantViolationError,
    );
    await assert.rejects(
      () =>
        h.container.rawEvents.findById(
          beta.scope,
          [...h.container.db.tables.rawEvents.values()][0]!.id,
        ),
      TenantViolationError,
    );
  });

  it('knowledge retrieval is scoped even when the entry ids are known', async () => {
    const h = createHarness();
    const alpha = await h.seedAccount({ pageId: 'page-alpha', webhookId: 'hook-alpha' });
    const beta = await h.seedAccount({ pageId: 'page-beta', webhookId: 'hook-beta' });
    const alphaEntry = await h.seedKnowledge(alpha.scope, { tags: ['secret'] });

    const found = await h.container.knowledge.findByIds(beta.scope, [alphaEntry.id]);
    assert.deepEqual(found, [], "another account's entry is invisible even by direct id");

    const searched = await h.container.knowledge.findApproved(beta.scope, {
      locale: 'en',
      intentCodes: ['GENERAL_QUESTION'],
      tags: ['secret'],
      limit: 10,
    });
    assert.deepEqual(searched, []);
  });

  it('a job handler re-resolves tenancy from the job row, not from the payload', async () => {
    const h = createHarness();
    const alpha = await h.seedAccount({ pageId: 'page-alpha', webhookId: 'hook-alpha' });
    const beta = await h.seedAccount({ pageId: 'page-beta', webhookId: 'hook-beta' });

    await h.postWebhook(
      alpha,
      metaMessageEnvelope('page-alpha', [{ senderId: 'psid-1', mid: 'm_1', text: 'hello' }]),
    );
    await h.drainTypes(['raw_event.normalize']);
    const alphaConversation = [...h.container.db.tables.conversations.values()][0]!;

    // Forge a job that claims beta's account but points at alpha's conversation — the shape a
    // payload-trusting handler would happily process.
    await h.container.queue.enqueue({
      accountId: beta.account.id,
      type: 'moderator.run',
      partitionKey: scopedPartitionKey(beta.scope, 'conv', alphaConversation.id),
      payload: { conversationId: alphaConversation.id },
      runAt: h.clock.now(),
      traceId: asId<TraceId>('trc_forged'),
    });

    await h.drain();

    const job = [...h.container.db.tables.jobs.values()].find((j) => j.traceId === 'trc_forged')!;
    assert.notEqual(job.state, 'SUCCEEDED', 'the forged cross-tenant job must not succeed');
    assert.equal(h.container.db.tables.outbound.size, 0);
    const deadLetters = await h.container.deadLetters.list();
    assert.ok(
      job.state === 'DEAD_LETTERED' || deadLetters.length > 0 || job.lastError !== null,
      'the attempt is visible rather than silent',
    );
  });

  it('cache keys and job partitions are tenant-prefixed by construction', async () => {
    const h = createHarness();
    const alpha = await h.seedAccount();
    const beta = await h.seedAccount();

    assert.notEqual(
      scopedCacheKey(alpha.scope, 'pack', 'v1'),
      scopedCacheKey(beta.scope, 'pack', 'v1'),
    );
    assert.notEqual(
      scopedPartitionKey(alpha.scope, 'conv', 'same-id'),
      scopedPartitionKey(beta.scope, 'conv', 'same-id'),
    );
    assert.ok(scopedCacheKey(alpha.scope, 'pack').startsWith(`acct:${alpha.account.id}:`));
  });

  it('every log line carries the account, and message text never appears in one', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'my phone number is 555-0100' },
      ]),
    );
    await h.drain();

    const accountLogs = h.logs.filter((r) => r.fields['account_id'] !== undefined);
    assert.ok(accountLogs.length > 0, 'ingest and normalisation log with an account bound');
    const serialised = JSON.stringify(h.logs);
    assert.ok(!serialised.includes('555-0100'), 'customer content must never reach a log');
    assert.ok(!serialised.includes('psid-1'), 'contact identifiers are redacted');
  });
});
