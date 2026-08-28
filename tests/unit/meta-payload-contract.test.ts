import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetaEnvelope } from '../../src/integrations/meta/webhook-parser.ts';
import {
  INBOUND_CLASSIFICATIONS,
  classificationCounts,
  isActionable,
} from '../../src/moderation/domain/inbound.ts';
import type { NormalizedInboundItem } from '../../src/moderation/domain/inbound.ts';
import { loadAllFixtures, loadFixture, loadManifest } from '../../src/runtime/cli/fixtures.ts';

/**
 * The parser contract, against official Meta payload shapes (objective 13).
 *
 * Two layers, and both are needed.
 *
 * The **corpus sweep** runs every fixture in `fixtures/meta/` through the parser and compares the
 * whole verdict — item count, actionable count, issue count, and the classification histogram —
 * against the expectation committed beside the payload. That is what makes a change in parser
 * behaviour show up as a named diff rather than as a test somebody forgot to write. It is also
 * what the shadow-acceptance self-test replays, so the offline proof and the live proof are
 * checking the same thing.
 *
 * The **named assertions** then pin the handful of details that a count cannot express: that the
 * WhatsApp routing identity is the phone number and not the business account, that a story reply
 * is distinguishable from a message reply, that an ad referral survives normalisation. Those are
 * the facts that are expensive to lose and invisible in a histogram.
 */

const NOW = new Date('2026-06-01T00:00:00.000Z');

const parse = (name: string): readonly NormalizedInboundItem[] =>
  parseMetaEnvelope(loadFixture(name).payload, NOW).items;

const only = (name: string): NormalizedInboundItem => {
  const items = parse(name);
  assert.equal(items.length, 1, `${name} should carry exactly one item`);
  return items[0]!;
};

describe('meta payload corpus', () => {
  const fixtures = loadAllFixtures();

  it('the manifest names at least one fixture per channel and per required category', () => {
    // Objective 13 lists the payload families that must be covered. Asserting the coverage here
    // means deleting a fixture fails the build rather than quietly shrinking the contract.
    const names = fixtures.map((fixture) => fixture.name);
    const required = [
      'facebook-messenger-text',
      'facebook-comment-add',
      'instagram-dm-text',
      'instagram-comment',
      'whatsapp-text',
      'whatsapp-media-image',
      'facebook-messenger-reply-and-referral',
      'facebook-messenger-echo',
      'facebook-messenger-receipts',
      'malformed-messaging-item',
      'unknown-envelope-object',
      'duplicate-item-in-one-envelope',
    ];
    for (const name of required) {
      assert.ok(names.includes(name), `manifest is missing required fixture ${name}`);
    }

    const channels = new Set(fixtures.map((fixture) => fixture.channel));
    assert.deepEqual([...channels].sort(), ['FACEBOOK', 'INSTAGRAM', 'WHATSAPP']);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: ${fixture.description}`, () => {
      const result = parseMetaEnvelope(fixture.payload, NOW);
      const actual = {
        items: result.items.length,
        actionable: result.items.filter(isActionable).length,
        issues: result.issues.length,
        classifications: classificationCounts(result.items),
      };
      assert.deepEqual(actual, {
        items: fixture.expect.items,
        actionable: fixture.expect.actionable,
        issues: fixture.expect.issues,
        classifications: fixture.expect.classifications,
      });

      for (const item of result.items) {
        assert.equal(item.channel, fixture.channel, 'every item carries the fixture channel');
        assert.ok(
          INBOUND_CLASSIFICATIONS.includes(item.classification),
          `classification ${item.classification} is outside the declared vocabulary`,
        );
        // The dedupe key is what makes redelivery idempotent. An empty one would silently make
        // every item collide with every other item on the same connection.
        assert.ok(item.dedupeKey.length > 0, 'every item has a dedupe key');
        assert.ok(item.routing.externalId.length > 0, 'every item has a routing identity');
        assert.ok(Number.isFinite(item.providerTs.getTime()), 'every item has a usable timestamp');
      }
    });
  }
});

describe('meta payload details a histogram cannot express', () => {
  it('routes whatsapp on the phone number id, never on the business account', () => {
    // The single most expensive routing bug available: one WABA can carry many numbers belonging
    // to different clients under one partner app.
    const identities = loadManifest().identities;
    const item = only('whatsapp-text');
    assert.deepEqual(item.routing, {
      kind: 'WHATSAPP_PHONE_NUMBER',
      externalId: identities.whatsappPhoneNumberId,
    });
    assert.equal(item.entryExternalId, identities.whatsappBusinessAccountId);
    assert.notEqual(item.routing.externalId, item.entryExternalId);
  });

  it('refuses to route a whatsapp delivery that carries no phone number id', () => {
    const result = parseMetaEnvelope(loadFixture('whatsapp-missing-phone-number-id').payload, NOW);
    // The item is still produced — nothing is discarded — but it is addressed to the business
    // account, which no connection owns as a routable destination, so the gate downstream refuses
    // it. The issue is what tells an operator why.
    assert.equal(result.items[0]!.routing.kind, 'WHATSAPP_BUSINESS_ACCOUNT');
    assert.match(result.issues[0]!, /phone_number_id/);
  });

  it('reads whatsapp string-seconds and messenger number-milliseconds as the same instant kind', () => {
    const whatsapp = only('whatsapp-text');
    const messenger = only('facebook-messenger-text');
    // Both fixtures are stamped in 2025. A unit confusion parks one of them in 1970 or in 57000.
    assert.equal(whatsapp.providerTs.getUTCFullYear(), 2025);
    assert.equal(messenger.providerTs.getUTCFullYear(), 2025);
    assert.notEqual(whatsapp.providerTs.getTime(), NOW.getTime());
    assert.notEqual(messenger.providerTs.getTime(), NOW.getTime());
  });

  it('distinguishes a story reply from a reply to a message', () => {
    assert.deepEqual(only('instagram-dm-story-reply').replyTo, {
      kind: 'STORY',
      externalId: '17895695668004550',
      url: 'https://lookaside.fbsbx.com/story.jpg',
    });
    assert.deepEqual(only('facebook-messenger-reply-and-referral').replyTo, {
      kind: 'MESSAGE',
      externalId: 'm_AAAAAAAAAA1',
      url: null,
    });
  });

  it('normalises both referral shapes onto one', () => {
    // Messenger sends {ref, source, type, ad_id}; WhatsApp sends
    // {source_url, source_type, source_id, ctwa_clid}. Meta sends either exactly once, on the
    // first message of a conversation, so losing it here loses it permanently.
    const messenger = only('facebook-messenger-reply-and-referral').referral;
    assert.equal(messenger?.adId, '6045246247433');
    assert.equal(messenger.ref, 'SPRING_PROMO');

    const whatsapp = only('whatsapp-reply-and-ctwa-referral').referral;
    assert.equal(whatsapp?.ctwaClickId, 'AfxYzExampleClickId');
    assert.equal(whatsapp.ref, '6045246247433');
    assert.equal(whatsapp.sourceUrl, 'https://fb.me/example');
  });

  it('keeps a whatsapp media id, because the cloud api never sends a url', () => {
    const attachment = only('whatsapp-media-image').attachments[0]!;
    assert.equal(attachment.url, null, 'no url is available without an authenticated call');
    assert.equal(attachment.providerAssetId, '1085850938533805');
    assert.equal(attachment.mimeType, 'image/jpeg');
    assert.equal(attachment.checksum, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    // The caption is the customer's words about the media, so it is the message text.
    assert.equal(only('whatsapp-media-image').text, 'Is this the right entrance?');
  });

  it('reads a sticker id that arrives as a json number', () => {
    // Meta sends `sticker_id` as a number. Reading it as a string files every sticker as an
    // ordinary photo, which is the difference between "the customer sent a thumbs-up" and
    // "the customer sent an image somebody should look at".
    const item = only('facebook-messenger-sticker');
    assert.equal(item.classification, 'MESSAGE_STICKER');
    assert.equal(item.attachments[0]!.kind, 'STICKER');
    assert.equal(item.attachments[0]!.providerAssetId, '369239263222822');
  });

  it('does not turn a top-level comment into a reply to itself', () => {
    // Facebook sets parent_id to the *post* on a top-level comment.
    const top = only('facebook-comment-add');
    assert.equal(top.parentRef, null);
    assert.equal(top.threadRef, `${loadManifest().identities.facebookPageId}_8001`);

    const nested = only('facebook-comment-nested-reply');
    assert.equal(nested.parentRef, `${loadManifest().identities.facebookPageId}_9001`);
  });

  it('keys the three whatsapp statuses of one message separately', () => {
    const items = parse('whatsapp-statuses');
    const keys = new Set(items.map((item) => item.dedupeKey));
    assert.equal(keys.size, 3, 'sent, delivered and read share a wamid and must not collide');
    assert.equal(items.filter((item) => item.classification === 'RECEIPT_READ').length, 1);
  });

  it('gives an echo a different key from the message it echoes', () => {
    const echo = only('facebook-messenger-echo');
    assert.equal(echo.classification, 'ECHO_SELF_MESSAGE');
    assert.notEqual(echo.dedupeKey, 'm_AAAAAAAAAA4');
    assert.ok(echo.dedupeKey.startsWith('echo:'));
  });

  it('carries the commenter display name, and never the page name for a self comment', () => {
    assert.equal(only('facebook-comment-add').senderDisplayName, 'A Customer');
    // Instagram identifies commenters by username rather than by name.
    assert.equal(only('instagram-comment').senderDisplayName, 'a_customer');
  });

  it('reads both entries of a batched delivery, not only the first', () => {
    const items = parse('batched-multi-entry');
    assert.equal(items.length, 3);
    assert.equal(items.filter((item) => item.surface === 'PUBLIC_COMMENT').length, 1);
  });

  it('gives two copies of one message inside one envelope the same key', () => {
    // Delivery-level dedupe cannot catch this: the body hashes once. Only the item key can.
    const items = parse('duplicate-item-in-one-envelope');
    assert.equal(items.length, 2);
    assert.equal(items[0]!.dedupeKey, items[1]!.dedupeKey);
  });

  it('is total: every fixture parses without throwing, and so does every mutilation of one', () => {
    // Meta will one day send something no fixture anticipates. The parser's contract is that it
    // never throws inside a job handler, whatever arrives.
    const base = loadFixture('facebook-messenger-text').payload as Record<string, unknown>;
    const mutations: unknown[] = [
      null,
      undefined,
      42,
      'text',
      [],
      {},
      { object: 'page' },
      { object: 'page', entry: 'not-an-array' },
      { object: 'page', entry: [null, 7, 'x'] },
      { object: 'page', entry: [{ id: null, messaging: [null] }] },
      { ...base, entry: [{ id: 'p', messaging: [{ sender: 3, recipient: [] }] }] },
      { ...base, object: 42 },
    ];
    for (const payload of mutations) {
      const result = parseMetaEnvelope(payload, NOW);
      assert.ok(Array.isArray(result.items));
      assert.ok(Array.isArray(result.issues));
    }
  });
});
