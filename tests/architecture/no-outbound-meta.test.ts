import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * The negative proof: nothing in this repository can call Meta (objectives 8, 14 and 19).
 *
 * Phase 02B connects a real client's Facebook Page, Instagram account or WhatsApp number to this
 * system. The promise made in return is that the connection is one-way. That promise cannot rest
 * on a configuration flag, on a code review, or on the fact that nobody has written the call yet —
 * all three are things that change quietly on a Friday afternoon.
 *
 * So it rests on this: **there is no outbound HTTP capability in `src/` at all.** Not disabled,
 * not feature-flagged, not behind a mode check. Absent. A future phase that adds live sending has
 * to delete an assertion from this file, and deleting an assertion is a reviewable act with a
 * name on it.
 *
 * The scan is textual, which is the point. A type-level check would be defeated by the first
 * `any`; a lint rule would be defeated by a disable comment. Reading the source for the strings
 * that make a network call is crude and very hard to do by accident.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = walk(SRC);
const named = (file: string): string => relative(ROOT, file).split(sep).join('/');

/**
 * Comments must be stripped before scanning.
 *
 * Half of this codebase's value is in prose explaining *why* a call is not made, and that prose
 * necessarily names `graph.facebook.com` and `fetch`. A scan that could not tell a warning from a
 * violation would force the explanations out of the source, which is the opposite of the goal.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no outbound meta capability exists', () => {
  it('no source file names a Meta API host', () => {
    // If a base URL is not in the repository, no amount of misconfiguration produces a request to
    // one. This is the single highest-value assertion in the file.
    const hosts = [
      'graph.facebook.com',
      'graph.instagram.com',
      'graph.whatsapp.com',
      'api.whatsapp.com',
      'facebook.com/v',
    ];
    const violations: string[] = [];
    for (const file of FILES) {
      const source = code(file).toLowerCase();
      for (const host of hosts) {
        if (source.includes(host)) violations.push(`${named(file)} references ${host}`);
      }
    }
    assert.deepEqual(violations, [], 'no Meta API endpoint may appear in src/');
  });

  it('no source file can make an outbound HTTP request', () => {
    // `node:http` and `node:https` are permitted for *serving* — the runtime has an HTTP edge —
    // but nothing may construct a client request. `fetch`, `undici` and friends have no
    // server-side use here at all.
    const forbidden: readonly (readonly [RegExp, string])[] = [
      [/\bfetch\s*\(/, 'fetch()'],
      [/\bnew\s+Request\s*\(/, 'new Request()'],
      [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
      [/\bfrom\s+['"]undici['"]/, "import from 'undici'"],
      [/\bfrom\s+['"]axios['"]/, "import from 'axios'"],
      [/\bfrom\s+['"]node-fetch['"]/, "import from 'node-fetch'"],
      [/\bfrom\s+['"]got['"]/, "import from 'got'"],
      [/\bhttps?\.request\s*\(/, 'http(s).request()'],
      [/\bhttps?\.get\s*\(/, 'http(s).get()'],
    ];
    const violations: string[] = [];
    for (const file of FILES) {
      const source = code(file);
      for (const [pattern, label] of forbidden) {
        if (pattern.test(source)) violations.push(`${named(file)} uses ${label}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      'src/ must contain no outbound HTTP client; receive-only is structural, not configured',
    );
  });

  it('the meta integration is parsing and verification only', () => {
    // Everything under integrations/meta reads bytes that arrived. Nothing there produces bytes
    // that leave. If a send client is ever written, this is where it would land — so this is
    // where the tripwire goes.
    const metaFiles = FILES.filter((file) => named(file).startsWith('src/integrations/meta/'));
    assert.ok(metaFiles.length > 0, 'the meta integration exists');

    const senderish = [
      /\bsendMessage\b/,
      /\bpostComment\b/,
      /\bhideComment\b/,
      /\bdeleteComment\b/,
      /\breactTo\b/,
      /\baccessToken\b/,
      /\bpageAccessToken\b/,
    ];
    const violations: string[] = [];
    for (const file of metaFiles) {
      const source = code(file);
      for (const pattern of senderish) {
        if (pattern.test(source)) violations.push(`${named(file)} matches ${pattern.source}`);
      }
    }
    assert.deepEqual(violations, [], 'integrations/meta may not acquire a send path or a token');
  });

  it('the moderation decision path holds no dispatch handler', () => {
    // `outbound.dispatch` is deliberately absent from the worker's handler map. Registering a stub
    // that "succeeded" would make the pipeline look healthy while nothing reached a customer; a
    // real one would make it reach a customer. Neither is authorised.
    const container = readFileSync(join(SRC, 'runtime', 'container.ts'), 'utf8');
    const handlerBlock = container.slice(
      container.indexOf('const handlers:'),
      container.indexOf('const deadLetterHandlers:'),
    );
    assert.ok(handlerBlock.length > 0, 'the handler map is where it was');
    assert.ok(
      !/['"]outbound\.dispatch['"]\s*:/.test(handlerBlock),
      'no dispatch handler may be registered in this phase',
    );
  });

  it('the only relay target reachable from the composition root is the simulated one', () => {
    const container = readFileSync(join(SRC, 'runtime', 'container.ts'), 'utf8');
    assert.ok(container.includes('createSimulatedRelayTarget'));
    const relay = readFileSync(join(SRC, 'operations', 'events', 'relay.ts'), 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(relay), 'the relay reaches no network');
  });

  it('the fixture corpus contains no real credential or token', () => {
    // Fixtures are committed and replayed anywhere. A real page access token in one would be a
    // credential leak with a very long tail.
    const dir = join(ROOT, 'fixtures', 'meta');
    const suspicious = [/EAA[A-Za-z0-9]{20,}/, /\baccess_token\b/, /\bapp_secret\b/];
    const violations: string[] = [];
    for (const entry of readdirSync(dir)) {
      const source = readFileSync(join(dir, entry), 'utf8');
      for (const pattern of suspicious) {
        if (pattern.test(source))
          violations.push(`fixtures/meta/${entry} matches ${pattern.source}`);
      }
    }
    assert.deepEqual(violations, []);
  });
});
