import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMetaSignature,
  metaSignatureVerifier,
  META_SIGNATURE_HEADER,
  verifyMetaSignature,
} from '../../src/integrations/meta/signature.ts';
import {
  metaEnvelopeParser,
  parseMetaEnvelope,
} from '../../src/integrations/meta/webhook-parser.ts';
import { metaCommentEnvelope, metaEchoEnvelope, metaMessageEnvelope } from '../support/harness.ts';

const SECRET = 'app-secret';
const NOW = new Date('2026-06-01T00:00:00.000Z');

describe('meta signature verification', () => {
  it('accepts a signature computed over the exact raw body', () => {
    const body = '{"object":"page"}';
    const result = verifyMetaSignature(body, computeMetaSignature(body, SECRET), SECRET);
    assert.deepEqual(result, { valid: true });
  });

  it('rejects a signature over re-serialised JSON', () => {
    // The classic bug: a body parser runs before verification and the signature is computed over
    // `JSON.stringify(parsed)`, which differs by whitespace or key order.
    const original = '{"object":"page", "entry":[]}';
    const reserialised = JSON.stringify(JSON.parse(original));
    const result = verifyMetaSignature(
      original,
      computeMetaSignature(reserialised, SECRET),
      SECRET,
    );
    assert.deepEqual(result, { valid: false, reason: 'MISMATCH' });
  });

  it('distinguishes missing, malformed and mismatched signatures', () => {
    const body = '{}';
    assert.deepEqual(verifyMetaSignature(body, undefined, SECRET), {
      valid: false,
      reason: 'MISSING',
    });
    assert.deepEqual(verifyMetaSignature(body, 'sha1=abc', SECRET), {
      valid: false,
      reason: 'MALFORMED',
    });
    assert.deepEqual(verifyMetaSignature(body, `sha256=${'0'.repeat(64)}`, SECRET), {
      valid: false,
      reason: 'MISMATCH',
    });
  });

  it('rejects an empty secret rather than treating it as a match', () => {
    const body = '{}';
    const result = verifyMetaSignature(body, computeMetaSignature(body, SECRET), '');
    assert.equal(result.valid, false);
  });

  it('the port implementation reads the header itself', () => {
    const body = '{"a":1}';
    const headers = { [META_SIGNATURE_HEADER]: computeMetaSignature(body, SECRET) };
    assert.deepEqual(metaSignatureVerifier.verify({ rawBody: body, headers, appSecret: SECRET }), {
      valid: true,
    });
  });
});

describe('meta envelope parsing', () => {
  it('parses a direct message into a channel-neutral item', () => {
    const result = parseMetaEnvelope(
      metaMessageEnvelope('page-1', [{ senderId: 'psid-1', mid: 'm_1', text: 'hello' }]),
      NOW,
    );
    assert.equal(result.items.length, 1);
    const item = result.items[0]!;
    assert.equal(item.kind, 'MESSAGE');
    assert.equal(item.surface, 'DIRECT_MESSAGE');
    assert.equal(item.channel, 'FACEBOOK');
    assert.equal(item.senderExternalId, 'psid-1');
    assert.equal(item.dedupeKey, 'm_1');
    assert.equal(item.dedupeSource, 'PROVIDER_ID');
    assert.equal(item.text, 'hello');
  });

  it('parses a public comment onto the PUBLIC_COMMENT surface with a thread reference', () => {
    const result = parseMetaEnvelope(
      metaCommentEnvelope('page-1', {
        commentId: 'c_1',
        postId: 'p_1',
        fromId: 'u_1',
        text: 'how much?',
      }),
      NOW,
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.surface, 'PUBLIC_COMMENT');
    assert.equal(result.items[0]!.threadRef, 'p_1');
    assert.equal(result.items[0]!.dedupeKey, 'c_1');
  });

  it('classifies echoes and receipts explicitly rather than dropping them silently', () => {
    // Phase 02A returned an `ignored` count, which collapsed "this is our own message coming
    // back", "this is a read receipt" and "we have never seen this shape" into one number. Those
    // need three different responses, so each item is now returned carrying its own verdict and
    // the decision to act is taken downstream (objective 7).
    const echo = parseMetaEnvelope(metaEchoEnvelope('page-1', 'psid-1', 'm_1'), NOW);
    assert.equal(echo.items.length, 1);
    assert.equal(echo.items[0]!.classification, 'ECHO_SELF_MESSAGE');
    assert.equal(echo.items[0]!.kind, 'ECHO');
    assert.equal(echo.issues.length, 0);

    const receipt = parseMetaEnvelope(
      {
        object: 'page',
        entry: [
          {
            id: 'page-1',
            messaging: [
              {
                sender: { id: 'psid-1' },
                recipient: { id: 'page-1' },
                timestamp: 1,
                delivery: { mids: [] },
              },
            ],
          },
        ],
      },
      NOW,
    );
    assert.equal(receipt.items.length, 1);
    assert.equal(receipt.items[0]!.classification, 'RECEIPT_DELIVERY');
    assert.equal(receipt.items[0]!.kind, 'RECEIPT');
  });

  it('derives a stable key when the provider supplies no id, and records that it is derived', () => {
    const envelope = {
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: 'page-1' },
              timestamp: 1000,
              message: { text: 'hi' },
            },
          ],
        },
      ],
    };
    const first = parseMetaEnvelope(envelope, NOW).items[0]!;
    const second = parseMetaEnvelope(envelope, NOW).items[0]!;
    assert.equal(first.dedupeSource, 'DERIVED');
    assert.equal(first.dedupeKey, second.dedupeKey, 'the derived key is stable across parses');
    assert.equal(first.providerMessageId, null);
  });

  it('surfaces an attachment-only message with the right content type', () => {
    const result = parseMetaEnvelope(
      {
        object: 'page',
        entry: [
          {
            id: 'page-1',
            messaging: [
              {
                sender: { id: 'psid-1' },
                recipient: { id: 'page-1' },
                timestamp: 1000,
                message: {
                  mid: 'm_img',
                  attachments: [{ type: 'image', payload: { url: 'https://example.test/i.jpg' } }],
                },
              },
            ],
          },
        ],
      },
      NOW,
    );
    assert.equal(result.items[0]!.contentType, 'IMAGE');
    assert.equal(result.items[0]!.attachments.length, 1);
  });

  it('records an uninterpretable messaging item as UNSUPPORTED rather than discarding it', () => {
    const result = parseMetaEnvelope(
      {
        object: 'page',
        entry: [
          {
            id: 'page-1',
            messaging: [
              {
                sender: { id: 'psid-1' },
                recipient: { id: 'page-1' },
                timestamp: 1,
                postback: { payload: 'X' },
              },
            ],
          },
        ],
      },
      NOW,
    );
    assert.equal(result.items[0]!.kind, 'UNSUPPORTED');
  });

  it('maps the object field to the right channel', () => {
    const ig = parseMetaEnvelope(
      { object: 'instagram', entry: [{ id: 'ig-1', messaging: [] }] },
      NOW,
    );
    assert.deepEqual(ig.items, []);

    const wa = parseMetaEnvelope(
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'wa-1',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550001111', phone_number_id: 'pn-1' },
                  messages: [
                    {
                      from: '15559998888',
                      id: 'wamid.X',
                      timestamp: '1000',
                      type: 'text',
                      text: { body: 'x' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      NOW,
    );
    assert.equal(wa.items[0]!.channel, 'WHATSAPP');
    // The routable identity is the phone number id from `metadata`, not `entry.id` — which names
    // the business account, and which many numbers can share.
    assert.deepEqual(wa.items[0]!.routing, { kind: 'WHATSAPP_PHONE_NUMBER', externalId: 'pn-1' });
    assert.equal(wa.items[0]!.entryExternalId, 'wa-1');
  });

  it('refuses to read a whatsapp envelope with another channel’s transport', () => {
    // WhatsApp has no `messaging` array. Something claiming to be one is a shape we do not
    // understand, not a message to be interpreted with Messenger's rules — and interpreting it
    // that way would route it on `entry.id`, which for WhatsApp is the wrong identifier entirely.
    const result = parseMetaEnvelope(
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'wa-1',
            messaging: [
              {
                sender: { id: 'p1' },
                recipient: { id: 'wa-1' },
                timestamp: 1,
                message: { mid: 'm', text: 'x' },
              },
            ],
          },
        ],
      },
      NOW,
    );
    assert.deepEqual(result.items, []);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0]!, /messaging\[0\] on a whatsapp envelope/);
  });

  it('is total: no input shape throws', () => {
    for (const payload of [
      null,
      undefined,
      42,
      'text',
      [],
      {},
      { entry: 'nope' },
      { entry: [null] },
    ]) {
      assert.doesNotThrow(() => parseMetaEnvelope(payload, NOW));
    }
    assert.deepEqual(parseMetaEnvelope(null, NOW).items, []);
    assert.ok(parseMetaEnvelope(null, NOW).issues.length > 0, 'unparseable input is reported');
  });

  it('the port implementation delegates to the same function', () => {
    const envelope = metaMessageEnvelope('page-1', [{ senderId: 'p', mid: 'm', text: 't' }]);
    assert.deepEqual(metaEnvelopeParser.parse(envelope, NOW), parseMetaEnvelope(envelope, NOW));
  });
});
