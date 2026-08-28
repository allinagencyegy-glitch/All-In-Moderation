import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  computeMetaSignature,
  META_SIGNATURE_HEADER,
} from '../../src/integrations/meta/signature.ts';
import { loadFixture, loadManifest } from '../../src/runtime/cli/fixtures.ts';
import { provisionMetaConnection } from '../../src/runtime/admin/provision.ts';
import { receiveStatusFor } from '../../src/runtime/admin/receive-status.ts';
import { traceRawEvent } from '../../src/runtime/admin/shadow-trace.ts';
import { TEST_APP_SECRET, TEST_CREDENTIALS_REF, TEST_SECRETS } from '../support/harness.ts';
import type { PostgresHarness } from '../support/postgres-harness.ts';
import { createPostgresHarness } from '../support/postgres-harness.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import { acquirePostgres, postgresAvailable, releasePostgres } from '../support/postgres.ts';

/**
 * The Meta transport layer, on the real database.
 *
 * The in-memory suite is the regression test for behaviour; this suite is the regression test for
 * the *claims the schema makes*. Three of them cannot be tested anywhere else:
 *
 *   1. Identity uniqueness is a **primary key**, not an application check. "Two clients cannot
 *      claim the same page" is worth very little if it is enforced by code that a future writer
 *      could bypass — so the assertion has to reach the constraint.
 *   2. The receive-only rule is a **CHECK constraint**. A row that claims RECEIVE_ONLY while
 *      holding a send capability must be impossible to write, not merely never written.
 *   3. `normalization` and `provider_context` are jsonb columns granted narrowly. If either one
 *      failed to round-trip, the memory adapter would still pass and the ledger would silently
 *      lose the verdict that objective 7 exists to preserve.
 */

const available = postgresAvailable();
const IDS = loadManifest().identities;

describe('postgres meta transport', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let h: PostgresHarness;
  let admin: pg.Client;

  before(async () => {
    cluster = await acquirePostgres();
    admin = new pg.Client({ connectionString: cluster.adminUrl });
    await admin.connect();
  });

  beforeEach(async () => {
    await h?.close();
    h = await createPostgresHarness(cluster);
  });

  after(async () => {
    await h?.close();
    await admin.end();
    await releasePostgres();
  });

  const post = async (webhookId: string, payload: unknown, secret = TEST_APP_SECRET) => {
    const rawBody = JSON.stringify(payload);
    return await h.container.ingest.ingest({
      publicWebhookId: webhookId,
      rawBody,
      headers: { [META_SIGNATURE_HEADER]: computeMetaSignature(rawBody, secret) },
    });
  };

  it('round-trips the whole transport shape of a connection', async () => {
    const seeded = await h.seedAccount({
      channel: 'WHATSAPP',
      supportedSurfaces: ['DIRECT_MESSAGE'],
      pageId: IDS.whatsappPhoneNumberId,
      identities: [
        { kind: 'WHATSAPP_PHONE_NUMBER', externalId: IDS.whatsappPhoneNumberId },
        { kind: 'WHATSAPP_BUSINESS_ACCOUNT', externalId: IDS.whatsappBusinessAccountId },
      ],
      webhookId: 'hook-wa',
    });

    const read = await h.container.connections.findById(seeded.scope, seeded.connection.id);
    assert.ok(read);
    assert.equal(read.provider, 'META');
    assert.equal(read.transportMode, 'RECEIVE_ONLY');
    assert.equal(read.subscriptionState, 'SUBSCRIBED');
    assert.deepEqual(read.enabledSurfaces, ['DIRECT_MESSAGE']);
    assert.deepEqual(read.capabilities, ['RECEIVE_DIRECT_MESSAGE']);
    assert.deepEqual(
      [...read.identities].sort((a, b) => a.kind.localeCompare(b.kind)),
      [
        { kind: 'WHATSAPP_BUSINESS_ACCOUNT', externalId: IDS.whatsappBusinessAccountId },
        { kind: 'WHATSAPP_PHONE_NUMBER', externalId: IDS.whatsappPhoneNumberId },
      ],
    );
  });

  it('replacing a connection replaces its identity set rather than accumulating it', async () => {
    const seeded = await h.seedAccount({ pageId: 'page-a', webhookId: 'hook-a' });
    await h.container.connections.save({
      ...seeded.connection,
      identities: [{ kind: 'FACEBOOK_PAGE', externalId: 'page-a' }],
    });
    const read = await h.container.connections.findById(seeded.scope, seeded.connection.id);
    assert.equal(read!.identities.length, 1);

    const { rows } = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM channel_connection_identities WHERE channel_connection_id = $1',
      [seeded.connection.id],
    );
    assert.equal(rows[0]!.count, '1', 'stale identities are deleted, not left behind');
  });

  it('the database itself refuses one provider identity claimed by two accounts', async () => {
    await h.seedAccount({ slug: 'client-a', pageId: 'contested', webhookId: 'hook-a' });
    await assert.rejects(
      () => h.seedAccount({ slug: 'client-b', pageId: 'contested', webhookId: 'hook-b' }),
      (error: Error & { code?: string }) => error.code === 'CONNECTION_IDENTITY_CONFLICT',
    );

    // And the constraint really is the primary key, not a query the adapter runs first.
    const { rows } = await admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'channel_connection_identities'::regclass AND contype = 'p'`,
    );
    assert.equal(rows.length, 1);
  });

  it('the database refuses a receive-only row that holds a send capability', async () => {
    const seeded = await h.seedAccount({ pageId: 'page-a', webhookId: 'hook-a' });
    // Written as the migrator, bypassing every application check, so what is being tested is the
    // CHECK constraint and nothing else.
    await assert.rejects(
      () =>
        admin.query(
          `UPDATE channel_connections
              SET capabilities = capabilities || ARRAY['SEND_DIRECT_MESSAGE']
            WHERE id = $1`,
          [seeded.connection.id],
        ),
      (error: Error & { constraint?: string }) =>
        error.constraint === 'channel_connections_receive_only_has_no_send_capability',
    );
  });

  it('persists the normalisation verdict on the ledger row', async () => {
    const seeded = await h.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    await post('hook-1', loadFixture('facebook-messenger-receipts').payload);
    await h.drainTypes(['raw_event.normalize']);

    const [event] = await h.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(event!.state, 'IGNORED');
    assert.deepEqual(event!.normalization?.byClassification, {
      RECEIPT_DELIVERY: 1,
      RECEIPT_READ: 1,
    });
    assert.equal(event!.normalization?.createdMessages, 0);

    // Read straight from the column too: the adapter could be reconstructing this from elsewhere.
    const { rows } = await admin.query<{ normalization: unknown }>(
      'SELECT normalization FROM raw_inbound_events WHERE id = $1',
      [event!.id],
    );
    assert.ok(rows[0]!.normalization !== null);
  });

  it('persists provider provenance on the message', async () => {
    const seeded = await h.seedAccount({
      channel: 'WHATSAPP',
      supportedSurfaces: ['DIRECT_MESSAGE'],
      pageId: IDS.whatsappPhoneNumberId,
      identities: [
        { kind: 'WHATSAPP_PHONE_NUMBER', externalId: IDS.whatsappPhoneNumberId },
        { kind: 'WHATSAPP_BUSINESS_ACCOUNT', externalId: IDS.whatsappBusinessAccountId },
      ],
      webhookId: 'hook-wa',
    });
    await post('hook-wa', loadFixture('whatsapp-reply-and-ctwa-referral').payload);
    await h.drainTypes(['raw_event.normalize']);

    const [event] = await h.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    const messageId = event!.producedMessageIds[0]!;
    const message = await h.container.messages.findById(seeded.scope, messageId);
    assert.ok(message);
    const context = message.providerContext as Record<string, unknown>;
    assert.equal(context['routingKind'], 'WHATSAPP_PHONE_NUMBER');
    assert.equal(context['entryExternalId'], IDS.whatsappBusinessAccountId);
    assert.ok(context['referral'] !== undefined);
    assert.equal(message.rawInboundEventId, event!.id);
    // The Cloud API never sends a media URL, but a text reply has no attachment either way.
    assert.equal(message.attachments.length, 0);
  });

  it('keeps a whatsapp media id through the attachment column', async () => {
    const seeded = await h.seedAccount({
      channel: 'WHATSAPP',
      supportedSurfaces: ['DIRECT_MESSAGE'],
      pageId: IDS.whatsappPhoneNumberId,
      webhookId: 'hook-wa',
    });
    await post('hook-wa', loadFixture('whatsapp-media-image').payload);
    await h.drainTypes(['raw_event.normalize']);

    const [event] = await h.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    const message = await h.container.messages.findById(
      seeded.scope,
      event!.producedMessageIds[0]!,
    );
    const attachment = message!.attachments[0]!;
    assert.equal(attachment.providerUrl, null);
    assert.equal(attachment.storageRef, '1085850938533805');
    assert.equal(attachment.mimeType, 'image/jpeg');
  });

  it('refuses an unroutable identity and records why, on the real store', async () => {
    const seeded = await h.seedAccount({
      channel: 'WHATSAPP',
      supportedSurfaces: ['DIRECT_MESSAGE'],
      pageId: 'phone-ours',
      identities: [
        { kind: 'WHATSAPP_PHONE_NUMBER', externalId: 'phone-ours' },
        { kind: 'WHATSAPP_BUSINESS_ACCOUNT', externalId: 'shared-waba' },
      ],
      webhookId: 'hook-wa',
    });
    await post('hook-wa', {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'shared-waba',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550002222', phone_number_id: 'phone-theirs' },
                messages: [
                  {
                    from: '15559990000',
                    id: 'wamid.OTHER',
                    timestamp: '1748737700',
                    type: 'text',
                    text: { body: 'not ours' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await h.drainTypes(['raw_event.normalize']);

    const [event] = await h.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(event!.normalization?.unroutableItems, 1);
    const { rows } = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages',
    );
    assert.equal(rows[0]!.count, '0');
  });

  it('a disabled connection answers 200 rather than 404, because the resolver no longer hides it', async () => {
    // 0005 filtered `status <> DISABLED` inside the SECURITY DEFINER resolver, which made a
    // disabled connection indistinguishable from a webhook id that never existed — so the
    // application's CONNECTION_DISABLED branch was unreachable on Postgres and the two adapters
    // disagreed about a case the tests exercise. 0008 removed the filter.
    await h.seedAccount({ connectionStatus: 'DISABLED', webhookId: 'hook-disabled' });
    const outcome = await post('hook-disabled', { object: 'page', entry: [] });
    assert.equal(outcome.status, 'CONNECTION_DISABLED');
    assert.equal(outcome.httpStatus, 200);
  });

  it('provisions a connection through the admin path and receives on it', async () => {
    const seeded = await h.seedAccount({
      slug: 'client-a',
      pageId: 'page-seed',
      webhookId: 'hook-seed',
    });
    const result = await provisionMetaConnection(
      {
        connections: h.container.connections,
        secrets: { resolve: (ref) => Promise.resolve(TEST_SECRETS.get(ref) ?? null) },
        ids: h.container.ids,
      },
      seeded.scope,
      {
        channel: 'INSTAGRAM',
        externalId: IDS.instagramAccountId,
        credentialsRef: TEST_CREDENTIALS_REF,
        subscriptionState: 'SUBSCRIBED',
      },
    );
    assert.equal(result.connection.transportMode, 'RECEIVE_ONLY');

    const accepted = await post(
      result.connection.publicWebhookId,
      loadFixture('instagram-comment').payload,
    );
    assert.equal(accepted.status, 'ACCEPTED');
    await h.drainTypes(['raw_event.normalize']);

    const status = await receiveStatusFor(
      { connections: h.container.connections, rawEvents: h.container.rawEvents, clock: h.clock },
      seeded.scope,
      result.connection.id,
    );
    assert.equal(status!.totalEvents, 1);
    assert.equal(status!.byClassification['COMMENT'], 1);
    assert.equal(status!.pendingNormalization, 0);
    assert.ok(status!.lastProducedMessagesAt !== null);
  });

  it('traces a delivery end to end on the real store, and every outcome is simulated', async () => {
    const seeded = await h.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    h.provider.script({
      kind: 'RESPOND',
      text: JSON.stringify({
        intent: { code: 'GENERAL_QUESTION', confidence: 0.9 },
        entities: {},
        proposed_action: 'ASK_CLARIFICATION',
        reply_text: 'Could you tell me more?',
        knowledge_refs: [],
        needs_human: false,
        confidence: 0.9,
      }),
    });

    await post('hook-1', loadFixture('facebook-messenger-text').payload);
    await h.drainTypes(['raw_event.normalize']);
    h.clock.advanceMs(30_000);
    await h.drain();

    const [event] = await h.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    const trace = await traceRawEvent(h.container, seeded.scope, event!.id);
    assert.ok(trace);
    assert.equal(trace.ok, true, trace.failures.join('; '));
    assert.equal(trace.messages.length, 1);
    const actions = trace.conversations.flatMap((conversation) => conversation.outboundActions);
    assert.ok(actions.length > 0, 'the moderator reached a decision, so this is not vacuous');
    assert.ok(actions.every((action) => action.simulated));
  });

  it('isolates identities between tenants under RLS', async () => {
    const a = await h.seedAccount({ slug: 'client-a', pageId: 'page-a', webhookId: 'hook-a' });
    await h.seedAccount({ slug: 'client-b', pageId: 'page-b', webhookId: 'hook-b' });

    // Scoped to A, the adapter can only see A's identities — even though the identity table's
    // primary key is deliberately platform-wide.
    const read = await h.container.connections.findByExternalId(a.scope, 'FACEBOOK', 'page-b');
    assert.equal(read, null);

    const { rows } = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM channel_connection_identities',
    );
    assert.equal(rows[0]!.count, '2', 'both rows exist; only the visibility differs');
  });
});
