import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  decisionJson,
  metaEchoEnvelope,
  metaMessageEnvelope,
  TEST_APP_SECRET,
} from '../support/harness.ts';
import { computeMetaSignature } from '../../src/integrations/meta/signature.ts';

describe('ingest deduplication and persist-first (F-01, F-02, ADR-006)', () => {
  it('F-01: an identical webhook delivered twice yields one ledger row, one message, one reply', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    const knowledge = await h.seedKnowledge(seeded.scope, { tags: ['price'] });
    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({ replyText: 'Sure.', knowledgeRefs: [knowledge.id] }),
    });

    const envelope = metaMessageEnvelope(seeded.connection.externalId, [
      { senderId: 'psid-1', mid: 'm_1', text: 'price please' },
    ]);

    const first = await h.postWebhook(seeded, envelope);
    const second = await h.postWebhook(seeded, envelope);

    assert.equal(first.status, 'ACCEPTED');
    assert.equal(second.status, 'DUPLICATE');
    // A duplicate is acknowledged, not rejected: providers treat 4xx/5xx as a reason to retry harder.
    assert.equal(second.httpStatus, 200);
    assert.ok('rawEventId' in first && 'rawEventId' in second);
    assert.equal(first.rawEventId, second.rawEventId, 'the duplicate resolves to the original row');

    assert.equal(h.container.db.tables.rawEvents.size, 1);
    // Exactly one normalize job: the duplicate created no work.
    assert.equal(h.container.db.tables.jobs.size, 1);

    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    assert.equal(h.container.db.tables.messages.size, 1);
    assert.equal(h.container.db.tables.outbound.size, 1);
    assert.equal(h.provider.callCount(), 1);
  });

  it('F-02: the same message inside a re-batched envelope does not create a second message', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();
    h.provider.script({ kind: 'RESPOND', text: decisionJson({ action: 'NO_ACTION' }) });

    // Different envelope bodies, so delivery-level dedupe cannot catch this — item-level must.
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
        { senderId: 'psid-1', mid: 'm_2', text: 'still there?' },
      ]),
    );

    assert.equal(h.container.db.tables.rawEvents.size, 2, 'two genuinely distinct deliveries');
    await h.drain();

    const messages = [...h.container.db.tables.messages.values()];
    assert.equal(messages.length, 2, 'm_1 must not be inserted twice');
    assert.deepEqual(messages.map((m) => m.providerMessageId).sort(), ['m_1', 'm_2']);
    // Sequence numbers stay gapless: a skipped duplicate must not consume a seq.
    assert.deepEqual(messages.map((m) => m.seq).sort(), [1, 2]);
  });

  it('stores a bad signature for forensics but never normalises it', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();

    const outcome = await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
      { signature: computeMetaSignature('{"different":"body"}', TEST_APP_SECRET) },
    );

    assert.equal(outcome.status, 'REJECTED_SIGNATURE');
    const events = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.state, 'REJECTED');
    assert.equal(events[0]!.signatureValid, false);
    // Crucially: no work was scheduled for it.
    assert.equal(h.container.db.tables.jobs.size, 0);

    await h.drain();
    assert.equal(h.container.db.tables.messages.size, 0);
  });

  it('ignores echoes of our own outbound messages instead of replying to itself', async () => {
    const h = createHarness();
    const seeded = await h.seedAccount();

    await h.postWebhook(seeded, metaEchoEnvelope(seeded.connection.externalId, 'psid-1', 'm_echo'));
    await h.drain();

    assert.equal(h.container.db.tables.messages.size, 0);
    const events = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    assert.equal(events[0]!.state, 'IGNORED', 'an echo is terminal and normal, not a failure');
    assert.equal(h.provider.callCount(), 0);
  });

  it('rejects a webhook for an unknown connection without inventing a tenant', async () => {
    const h = createHarness();
    const outcome = await h.container.ingest.ingest({
      publicWebhookId: 'hook-that-does-not-exist',
      rawBody: '{}',
      headers: {},
    });
    assert.equal(outcome.status, 'UNKNOWN_CONNECTION');
    assert.equal(outcome.httpStatus, 404);
    assert.equal(h.container.db.tables.rawEvents.size, 0);
  });

  it('an archived account still refuses to act, and a suspended one still ingests', async () => {
    const h = createHarness();
    const suspended = await h.seedAccount({ accountStatus: 'SUSPENDED' });
    const archived = await h.seedAccount({ accountStatus: 'ARCHIVED' });

    const suspendedOutcome = await h.postWebhook(
      suspended,
      metaMessageEnvelope(suspended.connection.externalId, [
        { senderId: 'psid-1', mid: 'm_1', text: 'hello' },
      ]),
    );
    const archivedOutcome = await h.postWebhook(
      archived,
      metaMessageEnvelope(archived.connection.externalId, [
        { senderId: 'psid-2', mid: 'm_2', text: 'hello' },
      ]),
    );

    // Dropping a suspended client's inbound messages would be silent data loss (F-18).
    assert.equal(suspendedOutcome.status, 'ACCEPTED');
    assert.equal(archivedOutcome.status, 'CONNECTION_DISABLED');

    await h.drain();
    h.clock.advanceMs(3_000);
    await h.drain();

    const conversation = [...h.container.db.tables.conversations.values()].find(
      (c) => c.accountId === suspended.account.id,
    )!;
    const runs = await h.container.runs.listByConversation(suspended.scope, conversation.id);
    assert.equal(runs[0]!.state, 'SKIPPED');
    assert.equal(runs[0]!.skipReason, 'ACCOUNT_SUSPENDED');
    assert.equal(h.container.db.tables.outbound.size, 0);
  });
});
