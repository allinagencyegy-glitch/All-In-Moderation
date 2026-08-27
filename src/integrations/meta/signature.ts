import { createHmac } from 'node:crypto';
import { safeEqual } from '../../platform/hash.ts';
import type {
  SignatureVerification,
  WebhookSignatureVerifier,
} from '../../moderation/domain/inbound.ts';

/**
 * Meta webhook signature verification.
 *
 * Meta signs the raw request body with the app secret and sends `sha256=<hex>` in
 * `X-Hub-Signature-256`. Two details matter and are easy to get wrong:
 *
 *   - The signature covers the **raw bytes**, not a re-serialised object. Any body parser that
 *     runs before verification and hands us an object has already destroyed the evidence.
 *   - The comparison must be constant time. A plain `===` on an HMAC leaks timing information;
 *     it is a small hole, but a free one to close.
 */

export const META_SIGNATURE_HEADER = 'x-hub-signature-256';

export function computeMetaSignature(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
}

export function verifyMetaSignature(
  rawBody: string,
  headerValue: string | undefined,
  appSecret: string,
): SignatureVerification {
  if (!headerValue) return { valid: false, reason: 'MISSING' };
  if (!headerValue.startsWith('sha256=') || headerValue.length !== 71) {
    return { valid: false, reason: 'MALFORMED' };
  }
  const expected = computeMetaSignature(rawBody, appSecret);
  return safeEqual(expected, headerValue) ? { valid: true } : { valid: false, reason: 'MISMATCH' };
}

/** The Meta implementation of the domain's signature-verifier port. */
export const metaSignatureVerifier: WebhookSignatureVerifier = {
  verify: ({ rawBody, headers, appSecret }) =>
    verifyMetaSignature(rawBody, headers[META_SIGNATURE_HEADER], appSecret),
};
