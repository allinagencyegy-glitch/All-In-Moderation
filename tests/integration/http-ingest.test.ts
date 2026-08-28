import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  META_SIGNATURE_HEADER,
  computeMetaSignature,
} from '../../src/integrations/meta/signature.ts';
import type { AppHarness } from '../support/app-harness.ts';
import { createAppHarness } from '../support/app-harness.ts';
import {
  TEST_APP_SECRET,
  TEST_VERIFY_TOKEN,
  metaMessageEnvelope,
  type SeededAccount,
} from '../support/harness.ts';
import { httpRequest, jsonBody } from '../support/http-client.ts';

/**
 * The webhook contract, over a real socket.
 *
 * Phase 01 closed with the webhook path "fully built and fully unproven over HTTP". Every
 * property below had a unit test that called `ingest()` directly with a string it had just
 * constructed — which cannot detect the failures that only exist between a socket and that
 * string: a body parser that consumed the bytes first, a size cap applied after buffering, a
 * lossy decode, an acknowledgement that waited for the work.
 *
 * The role is `web` on purpose. With workers running, "the job is still READY when the
 * acknowledgement arrives" would be a race rather than an assertion.
 */

const CAP_BYTES = 4_096;

describe('http webhook ingest', () => {
  let h: AppHarness;
  let seeded: SeededAccount;

  before(async () => {
    h = await createAppHarness({
      config: {
        role: 'web',
        ingest: { maxBodyBytes: CAP_BYTES },
      },
    });
    seeded = await h.seedAccount({ webhookId: 'hook-http-1', pageId: 'page-http-1' });
  });

  after(async () => {
    await h.stop();
  });

  const url = (id = seeded.connection.publicWebhookId): string => `/webhooks/meta/${id}`;

  const post = async (
    body: Buffer | string,
    options: { signature?: string | null; path?: string } = {},
  ) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    const signature =
      options.signature === null
        ? undefined
        : (options.signature ?? computeMetaSignature(bytes.toString('utf8'), TEST_APP_SECRET));
    return await httpRequest(h.base, options.path ?? url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { [META_SIGNATURE_HEADER]: signature } : {}),
      },
      body: bytes,
    });
  };

  const envelope = (mid: string, text = 'hello'): string =>
    JSON.stringify(
      metaMessageEnvelope(seeded.connection.externalId, [{ senderId: 'psid-1', mid, text }]),
    );

  it('accepts a correctly signed delivery and persists it before answering', async () => {
    const before = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    const response = await post(envelope('m_http_1'));

    assert.equal(response.status, 200);
    assert.equal(jsonBody(response)['status'], 'ACCEPTED');

    const after = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    assert.equal(after.length, before.length + 1);
    const stored = after[after.length - 1]!;
    assert.equal(stored.signatureValid, true);
    assert.equal(stored.state, 'RECEIVED');
  });

  it('verifies the signature over the exact bytes that arrived, not a re-serialisation', async () => {
    // Multi-byte UTF-8 and a lone `/`. `JSON.stringify` on the *server* would escape neither the
    // same way nor necessarily at all, so a body parser in the request path would produce a
    // different byte sequence and this HMAC would stop matching. That is the whole test.
    const raw = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: seeded.connection.externalId,
          time: 1_767_225_600_000,
          messaging: [
            {
              sender: { id: 'psid-utf8' },
              recipient: { id: seeded.connection.externalId },
              timestamp: 1_767_225_600_000,
              message: { mid: 'm_http_utf8', text: 'héllo 🌍 ünïcode — a/b' },
            },
          ],
        },
      ],
    });
    assert.ok(Buffer.byteLength(raw, 'utf8') > raw.length, 'the fixture must be multi-byte');

    const response = await post(raw);
    assert.equal(response.status, 200);
    assert.equal(jsonBody(response)['status'], 'ACCEPTED');

    const events = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    const stored = events.find((e) => JSON.stringify(e.payload).includes('m_http_utf8'));
    assert.ok(stored, 'the multi-byte delivery was stored');
    assert.equal(stored.signatureValid, true);
  });

  it('rejects a body that is not valid utf-8 rather than silently repairing it', async () => {
    // 0xff never appears in valid UTF-8. `toString('utf8')` would turn it into U+FFFD, and the
    // signature would then be checked against bytes nobody sent.
    const bytes = Buffer.concat([
      Buffer.from('{"object":"page","x":"', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('"}', 'utf8'),
    ]);
    const response = await httpRequest(h.base, url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [META_SIGNATURE_HEADER]: computeMetaSignature('anything', TEST_APP_SECRET),
      },
      body: bytes,
    });
    assert.equal(response.status, 400);
    assert.equal(jsonBody(response)['status'], 'MALFORMED_BODY');
  });

  it('stores an invalid signature for forensics and still answers 200', async () => {
    const response = await post(envelope('m_http_bad'), {
      signature: `sha256=${'0'.repeat(64)}`,
    });

    // 200, deliberately (ADR-006): the provider must not redeliver a body we will never accept,
    // and a 4xx would tell a prober which secret it guessed wrong.
    assert.equal(response.status, 200);
    assert.equal(jsonBody(response)['status'], 'REJECTED_SIGNATURE');

    const events = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    const stored = events.find((e) => JSON.stringify(e.payload).includes('m_http_bad'));
    assert.ok(stored);
    assert.equal(stored.signatureValid, false);
    assert.equal(stored.state, 'REJECTED');
    assert.equal(stored.error?.code, 'SIGNATURE_INVALID');

    // The decisive half: a rejected event must never produce work.
    const jobs = [...h.db.tables.jobs.values()].filter(
      (job) => job.payload['rawEventId'] === stored.id,
    );
    assert.deepEqual(jobs, [], 'a rejected delivery is never normalised');
  });

  it('rejects a missing and a malformed signature header', async () => {
    const missing = await post(envelope('m_http_nosig'), { signature: null });
    assert.equal(jsonBody(missing)['status'], 'REJECTED_SIGNATURE');

    const malformed = await post(envelope('m_http_malformed'), { signature: 'sha1=deadbeef' });
    assert.equal(jsonBody(malformed)['status'], 'REJECTED_SIGNATURE');
  });

  it('refuses an oversized body on the declared length, before reading it', async () => {
    const big = `{"pad":"${'x'.repeat(CAP_BYTES * 2)}"}`;
    const response = await post(big);
    assert.equal(response.status, 413);
    assert.equal(jsonBody(response)['status'], 'PAYLOAD_TOO_LARGE');

    // Nothing was stored. A cap that persists first and rejects afterwards is not a cap.
    const events = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    assert.ok(
      !events.some((e) => JSON.stringify(e.payload).includes('xxxxxxxxxx')),
      'an oversized body never reaches the ledger',
    );
  });

  it('refuses an oversized body that declares no length at all', async () => {
    // Chunked, so `Content-Length` never arrives and the streaming byte counter is the only
    // thing standing between the cap and an unbounded buffer.
    const response = await httpRequest(h.base, url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"pad":"${'y'.repeat(CAP_BYTES * 2)}"}`,
      omitContentLength: true,
    });
    assert.equal(response.status, 413);
    assert.equal(jsonBody(response)['status'], 'PAYLOAD_TOO_LARGE');

    const events = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    assert.ok(!events.some((e) => JSON.stringify(e.payload).includes('yyyyyyyyyy')));
  });

  it('accepts a body that sits exactly on the cap', async () => {
    // Off-by-one on a size cap is the classic version of this bug, in both directions.
    const padding = CAP_BYTES - Buffer.byteLength('{"object":"page","pad":""}', 'utf8');
    const exact = `{"object":"page","pad":"${'z'.repeat(padding)}"}`;
    assert.equal(Buffer.byteLength(exact, 'utf8'), CAP_BYTES);

    const response = await post(exact);
    // Accepted by the cap, then stored: a `page` envelope with no entries is a real, if empty,
    // delivery.
    assert.equal(response.status, 200);
    assert.equal(jsonBody(response)['status'], 'ACCEPTED');
  });

  it('is idempotent across duplicate deliveries of the same bytes', async () => {
    const body = envelope('m_http_dupe');
    const first = await post(body);
    const second = await post(body);
    const third = await post(body);

    assert.equal(jsonBody(first)['status'], 'ACCEPTED');
    // A duplicate is a normal, non-alerting outcome that must be *reported* rather than swallowed
    // (F-01) — and it must still answer 200, or the provider redelivers forever.
    assert.equal(second.status, 200);
    assert.equal(jsonBody(second)['status'], 'DUPLICATE');
    assert.equal(jsonBody(third)['status'], 'DUPLICATE');

    const events = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    const matching = events.filter((e) => JSON.stringify(e.payload).includes('m_http_dupe'));
    assert.equal(matching.length, 1, 'one ledger row for three deliveries');

    const jobs = [...h.db.tables.jobs.values()].filter(
      (job) => job.payload['rawEventId'] === matching[0]!.id,
    );
    assert.equal(jobs.length, 1, 'one job for three deliveries');
  });

  it('acknowledges before the work is done, not after', async () => {
    const response = await post(envelope('m_http_fast'));
    assert.equal(response.status, 200);

    const events = await h.container.rawEvents.listByConnection(seeded.scope, seeded.connection.id);
    const stored = events.find((e) => JSON.stringify(e.payload).includes('m_http_fast'))!;

    // The load-bearing assertion. At the moment the client had its 200: the event is durable,
    // and the job that will interpret it has not started. Persist first, process second.
    assert.equal(stored.state, 'RECEIVED');
    assert.equal(stored.normalizedAt, null);
    const job = [...h.db.tables.jobs.values()].find((j) => j.payload['rawEventId'] === stored.id);
    assert.equal(job?.state, 'READY');
    assert.equal(job?.attempt, 0);

    // No conversation, no message, no model call — nothing interpretive ran on the request path.
    assert.equal(h.db.tables.conversations.size, 0);
    assert.equal(h.db.tables.messages.size, 0);
    assert.equal(h.provider.callCount(), 0);

    // A budget, not a benchmark. Generous enough not to flake on a loaded CI runner, tight
    // enough that anything awaiting a model would blow through it.
    assert.ok(response.durationMs < 1_000, `acknowledgement took ${String(response.durationMs)}ms`);
  });

  it('answers 404 for an unknown webhook id, without saying why', async () => {
    const response = await post(envelope('m_http_unknown'), { path: '/webhooks/meta/not-a-hook' });
    assert.equal(response.status, 404);
    assert.equal(jsonBody(response)['status'], 'UNKNOWN_CONNECTION');
  });

  it('answers 405 for methods the webhook route does not implement', async () => {
    const response = await httpRequest(h.base, url(), { method: 'DELETE' });
    assert.equal(response.status, 405);
  });

  describe('the subscription handshake', () => {
    const verify = (query: string) => httpRequest(h.base, `${url()}?${query}`);

    it('echoes the challenge verbatim when the token matches', async () => {
      const response = await verify(
        `hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=1158201444`,
      );
      assert.equal(response.status, 200);
      // Verbatim, as text. A JSON wrapper fails the provider's byte comparison.
      assert.equal(response.body, '1158201444');
      assert.match(String(response.headers['content-type']), /text\/plain/);
    });

    it('refuses a wrong token, a wrong mode, and a missing challenge', async () => {
      const wrongToken = await verify(
        'hub.mode=subscribe&hub.verify_token=not-the-token&hub.challenge=abc',
      );
      assert.equal(wrongToken.status, 403);

      const wrongMode = await verify(
        `hub.mode=unsubscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=abc`,
      );
      assert.equal(wrongMode.status, 403);

      const noChallenge = await verify(`hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}`);
      assert.equal(noChallenge.status, 403);
    });

    it('refuses a connection with no configured token rather than accepting any', async () => {
      // A connection whose credentials reference resolves to nothing at all.
      const other = await h.seedAccount({ webhookId: 'hook-http-no-token' });
      await h.container.connections.save({
        ...other.connection,
        credentialsRef: 'secret://test/absent',
      });
      const response = await httpRequest(
        h.base,
        `/webhooks/meta/hook-http-no-token?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=abc`,
      );
      assert.equal(response.status, 403);
    });

    it('answers 404 for an unknown webhook id', async () => {
      const response = await httpRequest(
        h.base,
        '/webhooks/meta/nope?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y',
      );
      assert.equal(response.status, 404);
    });
  });

  it('never logs the signature, the secret, or the message body', async () => {
    await post(envelope('m_http_logs', 'a very private sentence'));
    const serialised = JSON.stringify(h.logs);
    assert.ok(!serialised.includes(TEST_APP_SECRET), 'the app secret never reaches a log');
    assert.ok(!serialised.includes('a very private sentence'), 'customer text never reaches a log');
    assert.ok(!serialised.includes(TEST_VERIFY_TOKEN), 'the verify token never reaches a log');
  });
});
