import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively, so that two semantically identical payloads
 * hash identically. Deduplication (ADR-006) and Account Pack content addressing (ADR-010) both
 * depend on this, and a key-order-sensitive hash would silently create duplicate rows.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    out[key] = canonicalise(entry);
  }
  return out;
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Constant-time comparison for signatures and secrets. A plain `===` on an HMAC leaks timing
 * information; it is a small hole but a free one to close.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
