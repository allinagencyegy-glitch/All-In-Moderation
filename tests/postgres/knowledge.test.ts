import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { KnowledgeEntryId, UserId } from '../../src/platform/ids.ts';
import { createKnowledgeGate } from '../../src/knowledge/application/knowledge-gate.ts';
import { decisionJson, metaMessageEnvelope } from '../support/harness.ts';
import type { PostgresHarness } from '../support/postgres-harness.ts';
import { createPostgresHarness } from '../support/postgres-harness.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import {
  acquirePostgres,
  postgresAvailable,
  releasePostgres,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * Step 14: knowledge validity against real persistence.
 *
 * The rule is narrow and the consequence is commercial: a price the client has not approved, or
 * has allowed to expire, must never reach a customer. Validity lives in `valid_from`/`valid_until`
 * columns precisely so expiry is a `WHERE` clause rather than an instruction a language model is
 * trusted to follow.
 *
 * The interesting case is the one at the end: a price that expires *between* retrieval and the
 * model's answer. That is why the gate runs twice.
 */

const available = postgresAvailable();

describe('postgres knowledge validity', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let h: PostgresHarness;

  before(async () => {
    cluster = await acquirePostgres();
  });

  beforeEach(async () => {
    await h?.close();
    h = await createPostgresHarness(cluster);
  });

  after(async () => {
    await h?.close();
    await releasePostgres();
  });

  it('only approved, in-validity entries survive the gate', async () => {
    const seeded = await h.seedAccount();
    const now = h.clock.now();
    const hour = 3_600_000;

    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_good'),
      title: 'current',
      status: 'APPROVED',
      validFrom: new Date(now.getTime() - hour),
      validUntil: new Date(now.getTime() + hour),
      intentCodes: ['PRICE_INQUIRY'],
    });
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_expired'),
      title: 'expired',
      status: 'APPROVED',
      validFrom: new Date(now.getTime() - 2 * hour),
      validUntil: new Date(now.getTime() - hour),
      intentCodes: ['PRICE_INQUIRY'],
    });
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_future'),
      title: 'not yet',
      status: 'APPROVED',
      validFrom: new Date(now.getTime() + hour),
      validUntil: new Date(now.getTime() + 2 * hour),
      intentCodes: ['PRICE_INQUIRY'],
    });
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_draft'),
      title: 'draft',
      status: 'DRAFT',
      approvedBy: null,
      approvedAt: null,
      intentCodes: ['PRICE_INQUIRY'],
    });
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_archived'),
      title: 'superseded',
      status: 'ARCHIVED',
      intentCodes: ['PRICE_INQUIRY'],
    });

    const gate = createKnowledgeGate(h.container.knowledge);
    const candidates = await gate.retrieve(
      seeded.scope,
      { locale: 'en', intentCodes: ['PRICE_INQUIRY'], tags: [] },
      now,
    );

    assert.deepEqual(
      candidates.entries.map((e) => e.id),
      ['kne_good'],
      'expired, future, draft and archived entries are all withheld from the model',
    );
    // The rejections are reported rather than swallowed: this is what makes "why did the AI not
    // answer?" a question with an answer.
    assert.ok(candidates.rejected.some((r) => r.id === 'kne_expired'));
  });

  it('a DRAFT entry cannot be approved without an approver — the database refuses', async () => {
    const seeded = await h.seedAccount();
    await assert.rejects(
      () =>
        h.container.knowledge.save(seeded.scope, {
          id: asId<KnowledgeEntryId>('kne_bad'),
          accountId: seeded.account.id,
          kind: 'FAQ',
          title: 'unapproved',
          body: 'body',
          locale: 'en',
          status: 'APPROVED',
          validFrom: null,
          validUntil: null,
          sourceRef: null,
          evidence: null,
          approvedBy: null,
          approvedAt: null,
          productRef: null,
          paymentType: null,
          price: null,
          tags: [],
          intentCodes: [],
          supersedesId: null,
          updatedAt: h.clock.now(),
        }),
      (error: unknown) =>
        (error as { context?: { constraint?: string } }).context?.constraint ===
        'knowledge_approved_requires_approver',
    );
  });

  it('an approved commercial claim must state when it stops being true', async () => {
    const seeded = await h.seedAccount();
    await assert.rejects(
      () =>
        h.container.knowledge.save(seeded.scope, {
          id: asId<KnowledgeEntryId>('kne_price_forever'),
          accountId: seeded.account.id,
          kind: 'PRICE',
          title: 'a price with no expiry',
          body: 'it costs 100',
          locale: 'en',
          status: 'APPROVED',
          validFrom: null,
          validUntil: null,
          sourceRef: null,
          evidence: null,
          approvedBy: asId<UserId>('usr_test'),
          approvedAt: h.clock.now(),
          productRef: null,
          paymentType: null,
          price: { amount: '100.00', currency: 'EUR' },
          tags: [],
          intentCodes: [],
          supersedesId: null,
          updatedAt: h.clock.now(),
        }),
      (error: unknown) =>
        (error as { context?: { constraint?: string } }).context?.constraint ===
        'knowledge_commercial_requires_expiry',
      'a price that never expires is a price nobody is accountable for',
    );
  });

  it('money round-trips as a decimal string, never through a float', async () => {
    const seeded = await h.seedAccount();
    const entry = await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_price'),
      kind: 'PRICE',
      title: 'awkward price',
      status: 'APPROVED',
      validUntil: new Date(h.clock.nowMs() + 3_600_000),
      // A value that is not exactly representable in binary floating point.
      price: { amount: '1234567.89', currency: 'EUR' },
    });
    assert.equal(entry.price?.amount, '1234567.89');

    const [stored] = await h.container.knowledge.findByIds(seeded.scope, [entry.id]);
    assert.equal(stored?.price?.amount, '1234567.89', 'no drift, and no cent to explain away');
    assert.equal(stored?.price?.currency, 'EUR');
    assert.equal(typeof stored?.price?.amount, 'string');
  });

  it('a price that expires mid-run is caught by the second pass, after the model answers', async () => {
    const seeded = await h.seedAccount();
    const validUntil = new Date(h.clock.nowMs() + 5_000);
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_flash'),
      kind: 'PRICE',
      title: 'flash offer',
      body: 'The price is 100 EUR.',
      status: 'APPROVED',
      validUntil,
      price: { amount: '100.00', currency: 'EUR' },
      intentCodes: ['PRICE_INQUIRY'],
      tags: ['price'],
    });

    const gate = createKnowledgeGate(h.container.knowledge);
    const before = await gate.retrieve(
      seeded.scope,
      { locale: 'en', intentCodes: ['PRICE_INQUIRY'], tags: ['price'] },
      h.clock.now(),
    );
    assert.deepEqual(
      before.entries.map((e) => e.id),
      ['kne_flash'],
      'the model is shown a price that is valid at the moment it is asked',
    );

    // The model thinks for six seconds. The offer lapses while it does.
    h.clock.advanceMs(6_000);

    const verified = gate.verifyCitations(before, ['kne_flash'], h.clock.now());
    assert.equal(
      verified.verified,
      false,
      're-validation after the model call is what stops an expired price being quoted',
    );
    assert.match(verified.reason, /valid/i);
  });

  it('a citation the model invented is refused, even if it names a real entry', async () => {
    const seeded = await h.seedAccount();
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_shown'),
      title: 'shown',
      intentCodes: ['GENERAL_QUESTION'],
    });
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_hidden'),
      title: 'never retrieved',
      intentCodes: ['COMPLAINT'],
    });

    const gate = createKnowledgeGate(h.container.knowledge);
    const candidates = await gate.retrieve(
      seeded.scope,
      { locale: 'en', intentCodes: ['GENERAL_QUESTION'], tags: [] },
      h.clock.now(),
    );
    // Containment, not existence: citing a real row that was never in the prompt means the model
    // did not read it there.
    const verified = gate.verifyCitations(candidates, ['kne_hidden'], h.clock.now());
    assert.equal(verified.verified, false);
  });

  it('the full run refuses to answer from expired knowledge and asks for a human', async () => {
    const seeded = await h.seedAccount();
    await h.seedKnowledge(seeded.scope, {
      id: asId<KnowledgeEntryId>('kne_stale'),
      kind: 'PRICE',
      title: 'last month price',
      body: 'It was 90 EUR.',
      status: 'APPROVED',
      validFrom: new Date(h.clock.nowMs() - 7_200_000),
      validUntil: new Date(h.clock.nowMs() - 3_600_000),
      price: { amount: '90.00', currency: 'EUR' },
      intentCodes: ['PRICE_INQUIRY'],
      tags: ['price'],
    });

    h.provider.script({
      kind: 'RESPOND',
      text: decisionJson({
        intentCode: 'PRICE_INQUIRY',
        action: 'ANSWER_FROM_KNOWLEDGE',
        replyText: 'It is 90 EUR.',
        knowledgeRefs: ['kne_stale'],
      }),
    });

    await h.postWebhook(
      seeded,
      metaMessageEnvelope(seeded.connection.externalId, [
        { senderId: 'psid_1', mid: 'm_1', text: 'how much?' },
      ]),
    );
    await h.drain();
    h.clock.advanceMs(10_000);
    await h.drain();

    const outbound = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ action_type: string; payload: { text?: string } }>(
        'SELECT action_type, payload FROM outbound_actions',
      );
      return result.rows;
    });

    for (const action of outbound) {
      assert.notEqual(
        action.action_type,
        'ANSWER_FROM_KNOWLEDGE',
        'an expired price must never be quoted, whatever the model proposed',
      );
      assert.ok(
        !(action.payload.text ?? '').includes('90'),
        'and the stale figure must not appear in any reply text',
      );
    }

    const handoffs = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM handoffs');
      return Number(result.rows[0]!.n);
    });
    assert.equal(handoffs, 1, 'a person is asked instead — the customer is not left unanswered');
  });

  it('exactly one account pack may be ACTIVE, enforced by the database', async () => {
    const seeded = await h.seedAccount();
    const active = await h.container.packs.findActive(seeded.scope);
    assert.ok(active, 'the fixture published one');

    // Publishing a second version supersedes the first in the same transaction. The partial
    // unique index is what makes "we always deactivate the old one first" true rather than a habit.
    await h.container.packs.save(seeded.scope, {
      ...active,
      id: asId('apv_second'),
      version: 2,
      status: 'ACTIVE',
    });

    const rows = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM account_pack_versions ORDER BY version',
      );
      return result.rows;
    });
    assert.deepEqual(
      rows.map((r) => r.status),
      ['SUPERSEDED', 'ACTIVE'],
    );
  });

  it('a published pack version is immutable — the trigger refuses to rewrite history', async () => {
    const seeded = await h.seedAccount();
    const active = await h.container.packs.findActive(seeded.scope);
    assert.ok(active);

    await assert.rejects(
      () =>
        withAdminClient(cluster.adminUrl, async (client) => {
          await client.query(
            `UPDATE account_pack_versions SET sections = '{"profile":{"tampered":true}}'::jsonb
              WHERE id = $1`,
            [active.id],
          );
        }),
      /immutable/,
      'reproducing a historical decision requires the configuration it was made under',
    );
  });
});
