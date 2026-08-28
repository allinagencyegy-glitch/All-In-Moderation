import type { IncomingMessage } from 'node:http';

/**
 * Reading a webhook body without destroying it, and without letting it destroy us.
 *
 * This module is small and it is the most security-relevant file added in Phase 02, so both
 * halves are spelled out.
 *
 * ### Why bytes, and why never a parser
 *
 * Meta signs the **raw request body** with the app secret. Any body parser that runs before
 * verification and hands the handler an object has already destroyed the evidence: re-serialising
 * it changes key order, whitespace and number formatting, and the HMAC no longer matches. That is
 * why nothing in the HTTP layer parses. The bytes go to the domain exactly as they arrived, and
 * the JSON parse happens afterwards, in the ledger write, where it cannot affect verification.
 *
 * The one place fidelity could still be lost is the `Buffer -> string` conversion the ingest port
 * takes. `toString('utf8')` replaces invalid sequences with U+FFFD, so bytes that are not valid
 * UTF-8 would silently become *different* bytes and the signature check would fail for a reason
 * nobody could diagnose. Rather than assume the input is well-formed, `decodeExactUtf8` re-encodes
 * and compares: either the string is byte-identical to what arrived, or the request is refused as
 * malformed. Never "close enough".
 *
 * ### Why two limits
 *
 * A cooperative sender that is merely over the cap should get a clean `413` it can log and act
 * on, which means reading to the end of its request rather than resetting the connection under it.
 * A sender that is *not* cooperative must not be able to make us read forever. So the body is
 * discarded rather than buffered once it passes the cap — memory stays flat — and a hard ceiling
 * some multiple above it cuts the socket for anything that keeps going. The server's
 * `requestTimeout` is the third and final bound, on time rather than bytes.
 */

export type RawBodyResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'TOO_LARGE'; readonly hardStopped: boolean }
  | { readonly ok: false; readonly reason: 'ABORTED' };

/** Past this multiple of the cap we stop being polite and cut the connection. */
export const HARD_CEILING_FACTOR = 4;

export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<RawBodyResult> {
  return new Promise<RawBodyResult>((resolve) => {
    // The cheapest rejection available: a declared length over the cap is refused before a single
    // byte of payload is read. A lying or absent header is caught by the counter below.
    const declared = Number(req.headers['content-length'] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({ ok: false, reason: 'TOO_LARGE', hardStopped: false });
      return;
    }

    const hardCeiling = maxBytes * HARD_CEILING_FACTOR;
    const chunks: Buffer[] = [];
    let received = 0;
    let overflowed = false;
    let settled = false;

    const settle = (result: RawBodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        if (!overflowed) {
          overflowed = true;
          // Stop accumulating immediately. From here the stream is drained and discarded, so a
          // 100 MB body costs time bounded by `requestTimeout`, not memory.
          chunks.length = 0;
        }
        if (received > hardCeiling) {
          req.destroy();
          settle({ ok: false, reason: 'TOO_LARGE', hardStopped: true });
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflowed) {
        settle({ ok: false, reason: 'TOO_LARGE', hardStopped: false });
        return;
      }
      settle({ ok: true, bytes: Buffer.concat(chunks) });
    });

    req.on('error', () => {
      // A destroy() we issued ourselves lands here after the settle above, which is why `settle`
      // is idempotent: the first outcome is the true one.
      settle({ ok: false, reason: 'ABORTED' });
    });

    // The backstop, and the reason there is no `aborted` listener: that event is deprecated, and
    // a client that vanishes mid-body may produce `close` and nothing else. Without this the
    // promise would never settle and the request would leak a handler for the life of the
    // process. `close` always fires, and by then `end` has either happened or never will.
    req.on('close', () => {
      settle({ ok: false, reason: 'ABORTED' });
    });
  });
}

/**
 * Decodes to a string only when the decode is lossless.
 *
 * Returns null when the bytes are not valid UTF-8, because a lossy decode would hand the
 * signature verifier bytes the sender never sent.
 */
export function decodeExactUtf8(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}
