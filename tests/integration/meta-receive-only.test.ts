import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { UserId } from '../../src/platform/ids.ts';
import {
  computeMetaSignature,
  META_SIGNATURE_HEADER,
} from '../../src/integrations/meta/signature.ts';
import { loadFixture, loadManifest } from '../../src/runtime/cli/fixtures.ts';
import { provisionMetaConnection } from '../../src/runtime/admin/provision.ts';
import { receiveStatusFor } from '../../src/runtime/admin/receive-status.ts';
import { traceRawEvent } from '../../src/runtime/admin/shadow-trace.ts';
import type { Container } from '../../src/runtime/container.ts';
import {
  TEST_APP_SECRET,
  TEST_CREDENTIALS_REF,
  TEST_SECRETS,
  createHarness,
} from '../support/harness.ts';

/**
 * Receive-only transport, attacked (objective 19).
 *
 * Phase 02B is the first phase where the events on the other end of the webhook are real, which
 * changes what the tests are for. Up to here they proved the pipeline works. These prove it fails
 * *safely*: that a delivery which should not be acted on is refused rather than interpreted, and
 * that the refusal leaves evidence.
 *
 * Each block below is one of the eleven hazards named in objective 19. They are grouped rather
 * than merged because they fail differently and would be fixed by different people.
 */

const IDS = loadManifest().identities;

/** A signed POST of a fixture, through the same entry point the HTTP edge calls. */
const post = async (
  container: Container,
  webhookId: string,
  payload: unknown,
  options: { secret?: string } = {},
) => {
  const rawBody = JSON.stringify(payload);
  return await container.ingest.ingest({
    publicWebhookId: webhookId,
    rawBody,
    headers: {
      [META_SIGNATURE_HEADER]: computeMetaSignature(rawBody, options.secret ?? TEST_APP_SECRET),
    },
  });
};

describe('tenant misrouting', () => {
  it('refuses a whatsapp delivery whose phone number belongs to another client on the same WABA', async () => {
    // The hazard this whole identity model exists for. One WhatsApp Business Account can carry
    // many numbers under one partner app, and every delivery names the WABA in `entry.id`. A
    // platform that routed on `entry.id` would put one client's messages in another's inbox.
    const harness = createHarness();
    await harness.seedAccount({
      slug: 'client-a',
      channel: 'WHATSAPP',
      supportedSurfaces: ['DIRECT_MESSAGE'],
      pageId: 'phone-number-ours',
      identities: [
        { kind: 'WHATSAPP_PHONE_NUMBER', externalId: 'phone-number-ours' },
        { kind: 'WHATSAPP_BUSINESS_ACCOUNT', externalId: 'shared-waba' },
      ],
      webhookId: 'hook-a',
    });

    const theirMessage = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'shared-waba',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                // The same business account, a different client's number.
                metadata: { display_phone_number: '15550002222', phone_number_id: 'phone-theirs' },
                messages: [
                  {
                    from: '15559990000',
                    id: 'wamid.OTHER',
                    timestamp: '1748737700',
                    type: 'text',
                    text: { body: 'this belongs to somebody else' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const accepted = await post(harness.container, 'hook-a', theirMessage);
    assert.equal(accepted.status, 'ACCEPTED', 'the delivery is stored; refusal happens later');
    await harness.drain();

    // Nothing became a message, and the refusal is recorded rather than silent.
    assert.equal(harness.container.db.tables.messages.size, 0);
    const event = [...harness.container.db.tables.rawEvents.values()][0]!;
    assert.equal(event.state, 'IGNORED');
    assert.equal(event.normalization?.unroutableItems, 1);
    assert.equal(event.normalization?.byClassification['UNROUTABLE_IDENTITY'], 1);
  });

  it('refuses a facebook delivery for a page this connection does not own', async () => {
    const harness = createHarness();
    await harness.seedAccount({ pageId: 'page-ours', webhookId: 'hook-a' });
    const envelope = {
      object: 'page',
      entry: [
        {
          id: 'page-someone-else',
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: 'page-someone-else' },
              timestamp: 1748736000000,
              message: { mid: 'm_x', text: 'hello' },
            },
          ],
        },
      ],
    };
    await post(harness.container, 'hook-a', envelope);
    await harness.drain();
    assert.equal(harness.container.db.tables.messages.size, 0);
    const event = [...harness.container.db.tables.rawEvents.values()][0]!;
    assert.equal(event.normalization?.unroutableItems, 1);
  });

  it('cannot attach one provider identity to two accounts', async () => {
    // The structural answer, enforced by a primary key rather than by application code: two
    // clients cannot both claim the same page, so a webhook can never be ambiguous.
    const harness = createHarness();
    await harness.seedAccount({ slug: 'client-a', pageId: 'contested-page', webhookId: 'hook-a' });
    await assert.rejects(
      () =>
        harness.seedAccount({ slug: 'client-b', pageId: 'contested-page', webhookId: 'hook-b' }),
      (error: Error & { code?: string }) => error.code === 'CONNECTION_IDENTITY_CONFLICT',
    );
  });

  it('one account cannot read another account through the webhook id', async () => {
    const harness = createHarness();
    const a = await harness.seedAccount({
      slug: 'client-a',
      pageId: 'page-a',
      webhookId: 'hook-a',
    });
    const b = await harness.seedAccount({
      slug: 'client-b',
      pageId: 'page-b',
      webhookId: 'hook-b',
    });

    await post(harness.container, 'hook-a', {
      object: 'page',
      entry: [
        {
          id: 'page-a',
          messaging: [
            {
              sender: { id: 'psid-a' },
              recipient: { id: 'page-a' },
              timestamp: 1748736000000,
              message: { mid: 'm_a', text: 'for a' },
            },
          ],
        },
      ],
    });
    await harness.drain();

    const eventsForB = await harness.container.rawEvents.listByConnection(b.scope, b.connection.id);
    assert.deepEqual(eventsForB, [], "b's connection sees nothing of a's traffic");
    const eventsForA = await harness.container.rawEvents.listByConnection(a.scope, a.connection.id);
    assert.equal(eventsForA.length, 1);
  });
});

describe('signature bypass', () => {
  it('rejects a body altered after signing, and stores the attempt', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: 'page-1', webhookId: 'hook-1' });
    const body = JSON.stringify(loadFixture('facebook-messenger-text').payload);
    const outcome = await harness.container.ingest.ingest({
      publicWebhookId: 'hook-1',
      rawBody: `${body} `, // one byte, appended after signing
      headers: { [META_SIGNATURE_HEADER]: computeMetaSignature(body, TEST_APP_SECRET) },
    });
    assert.equal(outcome.status, 'REJECTED_SIGNATURE');
    // Meta retries a non-2xx and eventually disables the subscription, so a rejected signature
    // still answers 200 — the delivery is refused, not the connection.
    assert.equal(outcome.httpStatus, 200);

    await harness.drain();
    assert.equal(harness.container.db.tables.messages.size, 0);
    const stored = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(stored[0]!.state, 'REJECTED', 'kept as evidence, never normalised');
  });

  it('refuses to normalise a rejected delivery even if a job is forced', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: 'page-1', webhookId: 'hook-1' });
    await post(harness.container, 'hook-1', loadFixture('facebook-messenger-text').payload, {
      secret: 'not-the-secret',
    });
    const [event] = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    await assert.rejects(
      () => harness.container.normalize.normalize(event!.id, seeded.scope),
      (error: Error & { code?: string }) => error.code === 'RAW_EVENT_REJECTED',
    );
  });

  it('a connection whose secret does not resolve rejects rather than accepts', async () => {
    // The dangerous failure would be treating "no secret configured" as "no verification needed".
    const harness = createHarness({ secrets: new Map() });
    await harness.seedAccount({ pageId: 'page-1', webhookId: 'hook-1' });
    const outcome = await post(harness.container, 'hook-1', { object: 'page', entry: [] });
    assert.equal(outcome.status, 'REJECTED_SIGNATURE');
  });

  it('refuses the subscription handshake for an unconfigured verify token', async () => {
    const harness = createHarness({
      secrets: new Map([[TEST_CREDENTIALS_REF, { appSecret: TEST_APP_SECRET }]]),
    });
    await harness.seedAccount({ webhookId: 'hook-1' });
    const outcome = await harness.container.ingest.verifySubscription({
      publicWebhookId: 'hook-1',
      mode: 'subscribe',
      verifyToken: 'anything',
      challenge: 'c',
    });
    assert.deepEqual(outcome, { status: 'REJECTED', reason: 'NOT_CONFIGURED', httpStatus: 403 });
  });
});

describe('replay and duplicate delivery', () => {
  it('an identical redelivery writes no second ledger row', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: 'page-1', webhookId: 'hook-1' });
    const payload = loadFixture('facebook-messenger-text').payload;

    const first = await post(harness.container, 'hook-1', payload);
    const second = await post(harness.container, 'hook-1', payload);
    assert.equal(first.status, 'ACCEPTED');
    assert.equal(second.status, 'DUPLICATE');

    const events = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(events.length, 1);
  });

  it('a re-batched redelivery produces a second ledger row but no second message', async () => {
    // Delivery-level dedupe hashes the body, so a provider that re-batches the same message into
    // a different envelope defeats it. Only the item key catches this (F-02).
    const harness = createHarness();
    await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    const original = loadFixture('facebook-messenger-text').payload as Record<string, unknown>;
    const rebatched = { ...original, extra_batch_marker: 1 };

    await post(harness.container, 'hook-1', original);
    await harness.drain();
    await post(harness.container, 'hook-1', rebatched);
    await harness.drain();

    assert.equal(harness.container.db.tables.rawEvents.size, 2);
    assert.equal(harness.container.db.tables.messages.size, 1, 'one message, two deliveries');
  });

  it('two copies of one message inside a single envelope produce one message', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    await post(harness.container, 'hook-1', loadFixture('duplicate-item-in-one-envelope').payload);
    await harness.drain();

    assert.equal(harness.container.db.tables.messages.size, 1);
    const events = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(events[0]!.normalization?.duplicateItems, 1);
    assert.equal(events[0]!.normalization?.createdMessages, 1);
  });
});

describe('event ordering', () => {
  it('preserves arrival order as message sequence within a conversation', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: 'page-1', webhookId: 'hook-1' });
    const envelope = (mid: string, text: string) => ({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: 'page-1' },
              timestamp: 1748736000000,
              message: { mid, text },
            },
          ],
        },
      ],
    });

    for (const [index, text] of ['first', 'second', 'third'].entries()) {
      await post(harness.container, 'hook-1', envelope(`m_${String(index)}`, text));
      await harness.drainTypes(['raw_event.normalize']);
    }

    const conversation = [...harness.container.db.tables.conversations.values()][0]!;
    const messages = await harness.container.messages.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.deepEqual(
      messages.map((message) => message.text),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(
      messages.map((message) => message.seq),
      [1, 2, 3],
    );
  });

  it('reads a whatsapp string-seconds timestamp rather than stamping the receipt time', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({
      channel: 'WHATSAPP',
      supportedSurfaces: ['DIRECT_MESSAGE'],
      pageId: IDS.whatsappPhoneNumberId,
      webhookId: 'hook-wa',
    });
    await post(harness.container, 'hook-wa', loadFixture('whatsapp-text').payload);
    await harness.drainTypes(['raw_event.normalize']);

    const conversation = [...harness.container.db.tables.conversations.values()][0]!;
    const [message] = await harness.container.messages.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.equal(message!.providerTs.toISOString(), new Date(1748737700 * 1000).toISOString());
    assert.notEqual(message!.providerTs.getTime(), message!.receivedAt.getTime());
  });
});

describe('echo loops', () => {
  it('does not create a customer turn from our own messenger echo', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    await post(harness.container, 'hook-1', loadFixture('facebook-messenger-echo').payload);
    await harness.drain();

    assert.equal(harness.container.db.tables.messages.size, 0);
    assert.equal(harness.container.db.tables.conversations.size, 0);
    const events = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(events[0]!.normalization?.byClassification['ECHO_SELF_MESSAGE'], 1);
  });

  it('does not answer its own public comment', async () => {
    // Instagram sends no is_echo for comments. Without the identity check the moderator would see
    // its own reply as a new customer comment and answer it, in public, forever.
    const harness = createHarness();
    const seeded = await harness.seedAccount({
      channel: 'INSTAGRAM',
      pageId: IDS.instagramAccountId,
      webhookId: 'hook-ig',
    });
    await post(
      harness.container,
      'hook-ig',
      loadFixture('instagram-comment-reply-self-echo').payload,
    );
    await harness.drain();

    assert.equal(harness.container.db.tables.messages.size, 0);
    const events = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(events[0]!.normalization?.byClassification['ECHO_SELF_COMMENT'], 1);
  });

  it('catches a self-comment even when the parser did not, because the connection knows more', async () => {
    // The parser only knows the ids inside the envelope. The connection knows every identity it
    // owns, so a page posting under a second identity is still caught here.
    const harness = createHarness();
    const seeded = await harness.seedAccount({
      pageId: 'page-primary',
      identities: [
        { kind: 'FACEBOOK_PAGE', externalId: 'page-primary' },
        { kind: 'FACEBOOK_PAGE', externalId: 'page-alias' },
      ],
      webhookId: 'hook-1',
    });
    await post(harness.container, 'hook-1', {
      object: 'page',
      entry: [
        {
          id: 'page-primary',
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                created_time: 1748736600,
                comment_id: 'c_1',
                post_id: 'p_1',
                parent_id: 'p_1',
                from: { id: 'page-alias', name: 'Our other identity' },
                message: 'our own words coming back',
              },
            },
          ],
        },
      ],
    });
    await harness.drain();

    assert.equal(harness.container.db.tables.messages.size, 0);
    const events = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(events[0]!.normalization?.byClassification['ECHO_SELF_COMMENT'], 1);
  });
});

describe('unsupported payload loss', () => {
  it('records every unsupported variant with a named classification', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });

    for (const name of [
      'facebook-messenger-postback',
      'facebook-feed-non-comment',
      'malformed-messaging-item',
    ]) {
      await post(harness.container, 'hook-1', loadFixture(name).payload);
    }
    await harness.drain();

    const events = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    const classifications = events.flatMap((event) =>
      Object.keys(event.normalization?.byClassification ?? {}),
    );
    assert.deepEqual([...classifications].sort(), ['MALFORMED', 'POSTBACK', 'UNKNOWN_FIELD']);
    for (const event of events) {
      assert.equal(event.state, 'IGNORED', 'recorded and closed, never left in limbo');
      assert.ok(event.normalization !== null, 'every event carries a verdict');
    }
  });

  it('records an envelope object nobody has taught the parser, without inventing a channel', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    await post(harness.container, 'hook-1', loadFixture('unknown-envelope-object').payload);
    await harness.drain();

    const [event] = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(event!.state, 'IGNORED');
    assert.equal(event!.normalization?.parsedItems, 0);
    assert.equal(event!.normalization?.issues.length, 1);
    // The verbatim payload is still on the row, which is the only way to diagnose it later.
    assert.ok(event!.payload !== null);
  });

  it('refuses an item on a surface the client has not enabled, and says so', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({
      pageId: IDS.facebookPageId,
      supportedSurfaces: ['DIRECT_MESSAGE', 'PUBLIC_COMMENT'],
      enabledSurfaces: ['DIRECT_MESSAGE'],
      webhookId: 'hook-1',
    });
    await post(harness.container, 'hook-1', loadFixture('facebook-comment-add').payload);
    await harness.drain();

    assert.equal(harness.container.db.tables.messages.size, 0);
    const [event] = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(event!.normalization?.surfaceDisabledItems, 1);
    assert.equal(event!.normalization?.byClassification['SURFACE_DISABLED'], 1);
  });
});

describe('token leakage and raw PII in logs', () => {
  it('never logs the webhook id, the app secret or the verify token', async () => {
    const harness = createHarness();
    const container = harness.container;
    await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'super-secret-hook-id' });

    // Exercise every logging branch: unknown connection, bad handshake, bad signature, success.
    await container.ingest.verifySubscription({
      publicWebhookId: 'no-such-hook',
      mode: 'subscribe',
      verifyToken: 'guess',
      challenge: 'c',
    });
    await container.ingest.ingest({
      publicWebhookId: 'no-such-hook',
      rawBody: '{}',
      headers: {},
    });
    await post(container, 'super-secret-hook-id', loadFixture('facebook-messenger-text').payload, {
      secret: 'wrong',
    });
    await post(container, 'super-secret-hook-id', loadFixture('facebook-messenger-text').payload);
    await harness.drain();

    const logged = harness.logs.map((line) => JSON.stringify(line)).join('\n');
    assert.ok(logged.length > 0, 'the run produced log lines to inspect');
    assert.ok(!logged.includes('super-secret-hook-id'), 'the webhook id is a bearer credential');
    assert.ok(!logged.includes(TEST_APP_SECRET), 'the app secret never reaches a log');
    assert.ok(!logged.includes('test-verify-token'), 'the verify token never reaches a log');
  });

  it('never logs a customer message body or a commenter name', async () => {
    const harness = createHarness();
    const container = harness.container;
    await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });

    await post(container, 'hook-1', loadFixture('facebook-messenger-text').payload);
    await post(container, 'hook-1', loadFixture('facebook-comment-add').payload);
    await harness.drain();

    const logged = harness.logs.map((line) => JSON.stringify(line)).join('\n');
    assert.ok(!logged.includes('Do you have any appointments this week?'));
    assert.ok(!logged.includes('How much is a check-up?'));
    assert.ok(!logged.includes('A Customer'));
  });

  it('keeps no credential on the connection row and no signature header on the ledger row', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    // The connection points at a secret; it never contains one.
    assert.equal(seeded.connection.credentialsRef, TEST_CREDENTIALS_REF);
    assert.ok(!JSON.stringify(seeded.connection).includes(TEST_APP_SECRET));

    await harness.container.ingest.ingest({
      publicWebhookId: 'hook-1',
      rawBody: '{"object":"page","entry":[]}',
      headers: {
        [META_SIGNATURE_HEADER]: computeMetaSignature(
          '{"object":"page","entry":[]}',
          TEST_APP_SECRET,
        ),
        authorization: 'Bearer a-page-access-token',
        cookie: 'session=abc',
      },
    });
    const [event] = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(event!.headers['authorization'], undefined);
    assert.equal(event!.headers['cookie'], undefined);
  });
});

describe('accidental outbound', () => {
  it('forces SIMULATED on a receive-only connection even when the process is armed to send', async () => {
    // The process-wide flag and the per-connection flag are independent brakes, and this asserts
    // the second one alone is sufficient. `loadConfig` refuses OUTBOUND_MODE=LIVE at boot, so the
    // only way to reach an armed process is to construct the config directly — which is exactly
    // what a future phase will do once one client is promoted.
    const harness = createHarness({ config: { outboundMode: 'LIVE' } });
    const container = harness.container;
    const seeded = await harness.seedAccount({
      pageId: IDS.facebookPageId,
      webhookId: 'hook-1',
      transportMode: 'RECEIVE_ONLY',
    });
    harness.provider.script({
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

    await post(container, 'hook-1', loadFixture('facebook-messenger-text').payload);
    await harness.drainTypes(['raw_event.normalize']);
    harness.clock.advanceMs(30_000);
    await harness.drain();

    const conversation = [...container.db.tables.conversations.values()][0]!;
    const actions = await container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    assert.ok(actions.length > 0, 'the moderator did reach a decision, so this is not vacuous');
    for (const action of actions) {
      assert.equal(action.deliveryMode, 'SIMULATED');
      assert.equal(action.state, 'SIMULATED');
    }
  });

  it('simulates when the connection has vanished, rather than defaulting to send', async () => {
    const harness = createHarness({ config: { outboundMode: 'LIVE' } });
    const container = harness.container;
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    harness.provider.script({
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

    await post(container, 'hook-1', loadFixture('facebook-messenger-text').payload);
    await harness.drainTypes(['raw_event.normalize']);
    // Delete the connection between normalisation and the moderator run.
    container.db.tables.connections.delete(seeded.connection.id);
    harness.clock.advanceMs(30_000);
    await harness.drain();

    const conversation = [...container.db.tables.conversations.values()][0]!;
    const actions = await container.outboundActions.listByConversation(
      seeded.scope,
      conversation.id,
    );
    for (const action of actions) assert.equal(action.deliveryMode, 'SIMULATED');
  });

  it('provisioning cannot produce a connection that is capable of sending', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ slug: 'client-a', webhookId: 'hook-a' });
    const result = await provisionMetaConnection(
      {
        connections: harness.container.connections,
        secrets: { resolve: (ref) => Promise.resolve(TEST_SECRETS.get(ref) ?? null) },
        ids: harness.container.ids,
      },
      seeded.scope,
      {
        channel: 'INSTAGRAM',
        externalId: 'ig-new',
        credentialsRef: TEST_CREDENTIALS_REF,
      },
    );
    assert.equal(result.connection.transportMode, 'RECEIVE_ONLY');
    assert.deepEqual([...result.connection.capabilities].sort(), [
      'RECEIVE_DIRECT_MESSAGE',
      'RECEIVE_PUBLIC_COMMENT',
    ]);
    assert.match(result.webhookPath, /^\/webhooks\/meta\/[a-f0-9]{32}$/);
  });

  it('provisioning refuses a credentials reference that does not resolve', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ webhookId: 'hook-a' });
    await assert.rejects(
      () =>
        provisionMetaConnection(
          {
            connections: harness.container.connections,
            secrets: { resolve: () => Promise.resolve(null) },
            ids: harness.container.ids,
          },
          seeded.scope,
          { channel: 'FACEBOOK', externalId: 'page-new', credentialsRef: 'secret://missing' },
        ),
      (error: Error & { code?: string }) => error.code === 'PROVISION_SECRET_UNRESOLVED',
    );
  });
});

describe('archived and suspended accounts', () => {
  it('a suspended account still ingests, because dropping its messages would be data loss', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({
      accountStatus: 'SUSPENDED',
      pageId: IDS.facebookPageId,
      webhookId: 'hook-1',
    });
    const outcome = await post(
      harness.container,
      'hook-1',
      loadFixture('facebook-messenger-text').payload,
    );
    assert.equal(outcome.status, 'ACCEPTED');
    const events = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(events.length, 1);
  });

  it('an archived account declines to store, and answers 200 rather than 404', async () => {
    const harness = createHarness();
    await harness.seedAccount({ accountStatus: 'ARCHIVED', webhookId: 'hook-1' });
    const outcome = await post(harness.container, 'hook-1', { object: 'page', entry: [] });
    assert.equal(outcome.status, 'CONNECTION_DISABLED');
    // 404 would make Meta retry and then disable the subscription. 200 says "received, doing
    // nothing", which is the truth.
    assert.equal(outcome.httpStatus, 200);
    assert.equal(harness.container.db.tables.rawEvents.size, 0);
  });

  it('a disabled connection answers 200 and stores nothing', async () => {
    const harness = createHarness();
    await harness.seedAccount({ connectionStatus: 'DISABLED', webhookId: 'hook-1' });
    const outcome = await post(harness.container, 'hook-1', { object: 'page', entry: [] });
    assert.equal(outcome.status, 'CONNECTION_DISABLED');
    assert.equal(outcome.httpStatus, 200);
  });

  it('an unknown webhook id is a 404 and writes nothing', async () => {
    const harness = createHarness();
    await harness.seedAccount({ webhookId: 'hook-1' });
    const outcome = await post(harness.container, 'hook-unknown', { object: 'page', entry: [] });
    assert.deepEqual(outcome, { status: 'UNKNOWN_CONNECTION', httpStatus: 404 });
    assert.equal(harness.container.db.tables.rawEvents.size, 0);
  });
});

describe('observability and the shadow trace', () => {
  it('counts deliveries, signatures, duplicates and classifications', async () => {
    const harness = createHarness();
    await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    const payload = loadFixture('facebook-messenger-text').payload;

    await post(harness.container, 'hook-1', payload);
    await post(harness.container, 'hook-1', payload); // byte-identical redelivery
    // A *different* body for the forged one. Delivery-level dedupe hashes the body and runs
    // before the signature branch, so re-posting the same bytes would be counted as a duplicate
    // and the signature counter would never move.
    await post(
      harness.container,
      'hook-1',
      { ...(payload as object), forged: true },
      {
        secret: 'wrong',
      },
    );
    await post(harness.container, 'hook-unknown', payload);
    await harness.drain();

    const snapshot = harness.container.metrics.snapshot();
    assert.equal(snapshot['transport.webhook_delivery{channel=FACEBOOK,outcome=ACCEPTED}'], 1);
    assert.equal(snapshot['transport.webhook_delivery{channel=FACEBOOK,outcome=DUPLICATE}'], 1);
    assert.equal(
      snapshot['transport.webhook_delivery{channel=FACEBOOK,outcome=REJECTED_SIGNATURE}'],
      1,
    );
    assert.equal(snapshot['transport.webhook_unknown_connection'], 1);
    assert.equal(
      snapshot['transport.inbound_item{channel=FACEBOOK,classification=MESSAGE_TEXT}'],
      1,
    );
  });

  it('publishes only aggregates on the health snapshot, never an identifier', async () => {
    const harness = createHarness();
    await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    await post(harness.container, 'hook-1', loadFixture('facebook-messenger-text').payload);
    await harness.drain();

    const snapshot = await harness.container.health.snapshot();
    assert.equal(snapshot.transport.deliveries['ACCEPTED'], 1);
    assert.equal(snapshot.transport.deliveriesByChannel['FACEBOOK'], 1);

    const serialised = JSON.stringify(snapshot);
    assert.ok(!serialised.includes('hook-1'));
    assert.ok(!serialised.includes(IDS.facebookPageId));
    assert.ok(!serialised.includes('acc_test'));
  });

  it('reports per-connection receive status behind a tenant scope', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    await post(harness.container, 'hook-1', loadFixture('facebook-messenger-text').payload);
    await post(harness.container, 'hook-1', loadFixture('facebook-messenger-echo').payload);
    await harness.drain();

    const status = await receiveStatusFor(
      {
        connections: harness.container.connections,
        rawEvents: harness.container.rawEvents,
        clock: harness.container.clock,
      },
      seeded.scope,
      seeded.connection.id,
    );
    assert.ok(status);
    assert.equal(status.totalEvents, 2);
    assert.equal(status.receiveOnly, true);
    assert.equal(status.pendingNormalization, 0);
    assert.equal(status.byClassification['ECHO_SELF_MESSAGE'], 1);
    assert.ok(status.lastReceivedAt !== null);
    // Identity *kinds* only: the ids belong to a named client.
    assert.deepEqual(status.identityKinds, ['FACEBOOK_PAGE']);
  });

  it('refuses receive status for a connection in another account', async () => {
    const harness = createHarness();
    const a = await harness.seedAccount({
      slug: 'client-a',
      pageId: 'page-a',
      webhookId: 'hook-a',
    });
    const b = await harness.seedAccount({
      slug: 'client-b',
      pageId: 'page-b',
      webhookId: 'hook-b',
    });
    const deps = {
      connections: harness.container.connections,
      rawEvents: harness.container.rawEvents,
      clock: harness.container.clock,
    };
    await assert.rejects(
      () => receiveStatusFor(deps, a.scope, b.connection.id),
      (error: Error & { code?: string }) => error.code === 'TENANT_VIOLATION',
    );
  });

  it('traces a delivery end to end and refuses to call a non-simulated outcome a pass', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    harness.provider.script({
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

    await post(harness.container, 'hook-1', loadFixture('facebook-messenger-text').payload);
    await harness.drainTypes(['raw_event.normalize']);
    harness.clock.advanceMs(30_000);
    await harness.drain();

    const [event] = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    const trace = await traceRawEvent(harness.container, seeded.scope, event!.id);
    assert.ok(trace);
    assert.equal(trace.ok, true, trace.failures.join('; '));
    assert.equal(trace.receiveOnly, true);
    assert.equal(trace.signatureValid, true);
    assert.equal(trace.state, 'NORMALIZED');
    assert.equal(trace.messages.length, 1);
    assert.equal(trace.conversations.length, 1);
    assert.ok(trace.conversations[0]!.outboundActions.every((action) => action.simulated));
    // The trace never carries the customer's words, only their length.
    assert.ok(!JSON.stringify(trace).includes('Do you have any appointments this week?'));

    // And the verdict is not a rubber stamp: promote the connection and the same trace fails.
    await harness.container.connections.save({
      ...seeded.connection,
      transportMode: 'SEND_AND_RECEIVE',
    });
    const promoted = await traceRawEvent(harness.container, seeded.scope, event!.id);
    assert.equal(promoted!.ok, false);
    assert.match(promoted!.failures.join(' '), /not RECEIVE_ONLY/);
  });

  it('records provider provenance on the message', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({
      channel: 'WHATSAPP',
      supportedSurfaces: ['DIRECT_MESSAGE'],
      pageId: IDS.whatsappPhoneNumberId,
      identities: [
        { kind: 'WHATSAPP_PHONE_NUMBER', externalId: IDS.whatsappPhoneNumberId },
        { kind: 'WHATSAPP_BUSINESS_ACCOUNT', externalId: IDS.whatsappBusinessAccountId },
      ],
      webhookId: 'hook-wa',
    });
    await post(
      harness.container,
      'hook-wa',
      loadFixture('whatsapp-reply-and-ctwa-referral').payload,
    );
    await harness.drainTypes(['raw_event.normalize']);

    const conversation = [...harness.container.db.tables.conversations.values()][0]!;
    const [message] = await harness.container.messages.listByConversation(
      seeded.scope,
      conversation.id,
    );
    const context = message!.providerContext as Record<string, unknown>;
    assert.equal(context['classification'], 'MESSAGE_TEXT');
    assert.equal(context['routingKind'], 'WHATSAPP_PHONE_NUMBER');
    assert.equal(context['entryExternalId'], IDS.whatsappBusinessAccountId);
    // Meta sends the ad referral once, with the first message, and never again.
    assert.ok(context['referral'] !== undefined);
    assert.ok(context['replyTo'] !== undefined);
    assert.equal(message!.rawInboundEventId !== null, true);
  });
});

describe('the connection is the authority, not the payload', () => {
  it('an item is refused when the URL says one tenant and the payload says another surface', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: 'page-ours', webhookId: 'hook-1' });
    // Correct webhook id — so tenancy resolves — but a page we do not own.
    await post(harness.container, 'hook-1', {
      object: 'page',
      entry: [
        {
          id: 'page-not-ours',
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: 'page-not-ours' },
              timestamp: 1748736000000,
              message: { mid: 'm_1', text: 'hello' },
            },
          ],
        },
      ],
    });
    await harness.drain();
    const [event] = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(event!.normalization?.unroutableItems, 1);
    assert.equal(event!.normalization?.createdMessages, 0);
  });

  it('a connection with no identity set still matches exactly, never as a wildcard', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({
      pageId: 'page-ours',
      identities: [],
      webhookId: 'hook-1',
    });
    await post(harness.container, 'hook-1', loadFixture('facebook-messenger-text').payload);
    await harness.drain();
    const [event] = await harness.container.rawEvents.listByConnection(
      seeded.scope,
      seeded.connection.id,
    );
    assert.equal(event!.normalization?.unroutableItems, 1, 'the fixture names a different page');

    await post(harness.container, 'hook-1', {
      object: 'page',
      entry: [
        {
          id: 'page-ours',
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: 'page-ours' },
              timestamp: 1748736000000,
              message: { mid: 'm_ours', text: 'ours' },
            },
          ],
        },
      ],
    });
    await harness.drain();
    assert.equal(harness.container.db.tables.messages.size, 1);
  });
});

describe('operator identifiers', () => {
  it('a takeover message carries no invented provider provenance', async () => {
    const harness = createHarness();
    const seeded = await harness.seedAccount({ pageId: IDS.facebookPageId, webhookId: 'hook-1' });
    await post(harness.container, 'hook-1', loadFixture('facebook-messenger-text').payload);
    await harness.drainTypes(['raw_event.normalize']);

    const conversation = [...harness.container.db.tables.conversations.values()][0]!;
    await harness.container.takeover.sendAsHuman(
      seeded.scope,
      conversation.id,
      asId<UserId>('usr_operator'),
      'Hello, this is a person.',
    );
    const messages = await harness.container.messages.listByConversation(
      seeded.scope,
      conversation.id,
    );
    const outbound = messages.find((message) => message.direction === 'OUTBOUND')!;
    assert.deepEqual(outbound.providerContext, {});
    assert.equal(outbound.rawInboundEventId, null);
  });
});
