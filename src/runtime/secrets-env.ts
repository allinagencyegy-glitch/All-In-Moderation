import { TerminalError } from '../platform/errors.ts';
import type { ChannelSecrets } from '../moderation/ports.ts';

/**
 * `WEBHOOK_SECRETS`, parsed.
 *
 * Secrets stay resolved by reference (ADR-002); this is the stop-gap resolver's *source*, not a
 * change to that rule. No secret manager is integrated yet, so the environment carries the bundle
 * and the `SecretResolver` port carries the indirection — swapping in a real manager changes the
 * composition root and nothing else.
 *
 * Shape: `{ "secret://<ref>": { "appSecret": "...", "verifyToken": "..." } }`
 *
 * Extracted from `main.ts` because the admin CLIs need exactly the same parsing, and a CLI that
 * re-implemented it would eventually disagree about what a valid bundle is — with the disagreement
 * showing up as a signature failure against a real Meta delivery.
 *
 * Nothing here logs. A parse failure names the *reference* whose entry was wrong and never the
 * value, because the value is the secret.
 */
export function parseWebhookSecrets(raw: string | undefined): Map<string, ChannelSecrets> {
  if (!raw) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Deliberately not including the parse error: a truncated JSON error message quotes the
    // input, and the input is a bag of app secrets.
    throw new TerminalError('CONFIG_INVALID', 'WEBHOOK_SECRETS is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TerminalError('CONFIG_INVALID', 'WEBHOOK_SECRETS must be a JSON object');
  }

  const out = new Map<string, ChannelSecrets>();
  for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TerminalError('CONFIG_INVALID', `WEBHOOK_SECRETS['${ref}'] must be an object`);
    }
    const entry = value as Record<string, unknown>;
    const appSecret = entry['appSecret'];
    if (typeof appSecret !== 'string' || appSecret.length === 0) {
      throw new TerminalError('CONFIG_INVALID', `WEBHOOK_SECRETS['${ref}'].appSecret is required`);
    }
    const verifyToken = entry['verifyToken'];
    out.set(ref, {
      appSecret,
      ...(typeof verifyToken === 'string' && verifyToken.length > 0 ? { verifyToken } : {}),
    });
  }
  return out;
}
