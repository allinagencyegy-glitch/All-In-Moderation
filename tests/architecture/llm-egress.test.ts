import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { EGRESS_ALLOWLIST } from './no-outbound-meta.test.ts';
import { ANTHROPIC_API_HOST } from '../../src/integrations/llm/anthropic-provider.ts';
import { loadConfig } from '../../src/runtime/config.ts';
import { createContainer } from '../../src/runtime/container.ts';
import { TerminalError } from '../../src/platform/errors.ts';
import { TEST_CONFIG } from '../support/harness.ts';

/**
 * The positive half of the egress proof (ADR-012).
 *
 * `no-outbound-meta.test.ts` says what may not happen anywhere. This file says what may happen,
 * and *only* here: one file, one host, unreachable from any module that makes a decision.
 *
 * The pairing matters. An allowlist with nothing checking the allowlisted file is not a narrower
 * rule than "no egress", it is a hole with a comment next to it. So the file that is exempt from
 * the general ban is held to four constraints the other files are not:
 *
 *   1. It is the only file under `src/` containing `fetch(`.
 *   2. It names exactly one host, and that host is `api.anthropic.com`.
 *   3. It names no Meta host — the global ban applies here too, with no exception.
 *   4. Nothing in `moderation/`, `knowledge/`, `policy/` or `core/` can import it. Only the
 *      composition root may construct it, so a decision path cannot acquire a socket by
 *      accident.
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

/** Comments stripped, exactly as the sibling scan does — the prose here names `fetch` too. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');
}

const PROVIDER = 'src/integrations/llm/anthropic-provider.ts';

describe('llm egress is one file, one host', () => {
  it('the allowlisted file is the language-model adapter and nothing else', () => {
    assert.deepEqual(EGRESS_ALLOWLIST, [PROVIDER]);
  });

  it('no file outside the allowlist contains a network call', () => {
    const offenders = FILES.filter(
      (file) => !EGRESS_ALLOWLIST.includes(named(file)) && /\bfetch\s*\(/.test(code(file)),
    ).map(named);
    assert.deepEqual(offenders, [], 'egress belongs in the one allowlisted adapter');
  });

  it('the adapter does contain the call — the allowlist is not decorative', () => {
    // Without this, deleting the implementation would make every other assertion here pass
    // vacuously, and the suite would report a guarantee about a file that does nothing.
    assert.match(code(join(SRC, 'integrations', 'llm', 'anthropic-provider.ts')), /\bfetch\s*\(/);
  });

  it('the adapter names exactly one host, and it is the model provider', () => {
    assert.equal(ANTHROPIC_API_HOST, 'api.anthropic.com');

    // Every URL in the file has to be built from that one constant. Checked as text because the
    // thing being prevented is a *second* endpoint appearing later — a fallback host, a proxy, a
    // telemetry beacon — which no type would catch.
    const source = code(join(SRC, 'integrations', 'llm', 'anthropic-provider.ts'));
    const urls = [...source.matchAll(/https?:\/\/[^`'"\s]*/g)].map((m) => m[0]);
    assert.ok(urls.length > 0, 'the adapter must actually name its endpoint');
    for (const url of urls) {
      assert.ok(
        url.startsWith('https://${ANTHROPIC_API_HOST}') ||
          url.startsWith(`https://${ANTHROPIC_API_HOST}`),
        `every endpoint must be derived from ANTHROPIC_API_HOST, found ${url}`,
      );
    }

    // And no other host may be named anywhere in the file, in any form.
    const domains = new Set(
      [...source.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|ai|co)\b/gi)].map(
        (m) => m[0].toLowerCase(),
      ),
    );
    assert.deepEqual([...domains].sort(), ['api.anthropic.com'], 'one host, named in one place');
  });

  it('the Meta ban has no exception, allowlisted file included', () => {
    const source = code(join(SRC, 'integrations', 'llm', 'anthropic-provider.ts')).toLowerCase();
    for (const host of [
      'graph.facebook.com',
      'graph.instagram.com',
      'graph.whatsapp.com',
      'api.whatsapp.com',
    ]) {
      assert.ok(!source.includes(host), `the egress adapter must never name ${host}`);
    }
  });

  it('no decision-making module can import the adapter', () => {
    // The capability is granted to the composition root, not to the pipeline. `moderation/`
    // receives an `LlmProvider` through its ports and cannot tell — or reach — which one it got.
    const sealed = ['moderation', 'knowledge', 'policy', 'core', 'operations', 'platform'];
    const violations: string[] = [];
    for (const file of FILES) {
      const module = relative(SRC, file).split(sep)[0]!;
      if (!sealed.includes(module)) continue;
      // Comment-stripped, like every other scan here. `platform/llm/provider.ts` explains in
      // prose that no vendor-shaped object crosses its boundary, and naming the vendor it is
      // excluding is the clearest way to say that. What must not exist is an *import*.
      if (/anthropic/i.test(code(file))) {
        violations.push(`${named(file)} mentions the provider adapter`);
      }
    }
    assert.deepEqual(violations, [], 'only the composition root may know which provider is in use');
  });

  it('the mock provider remains the default, so tests and CI reach no network', () => {
    // Asserted through `loadConfig` rather than against the source text, so the guarantee survives
    // a refactor of how the value is read. An unset `LLM_PROVIDER` is the state of every CI runner
    // and every developer machine; a suite that silently reached a paid API would be both a cost
    // and a leak.
    assert.equal(loadConfig({}).llm.providerId, 'mock');
    assert.equal(loadConfig({ LLM_PROVIDER: 'mock' }).llm.providerId, 'mock');
  });

  it('an unrecognised provider is refused at boot rather than silently defaulted', () => {
    // The dangerous shape is a typo that falls back to something. Falling back to `mock` would be
    // safe but dishonest; falling back to a real provider would be neither.
    assert.throws(
      () => loadConfig({ LLM_PROVIDER: 'anthropik' }),
      /CONFIG_INVALID|Expected one of/,
    );
  });

  it('refuses to boot with a real provider and no credential', () => {
    // The credential is not on `RuntimeConfig` (it would land in a diagnostics dump), so the only
    // place its absence can be caught is here. Failing at boot beats failing on a customer's
    // message — and beats the far worse alternative of silently running the mock in production.
    assert.throws(
      () =>
        createContainer({
          config: { ...TEST_CONFIG, llm: { ...TEST_CONFIG.llm, providerId: 'anthropic' } },
        }),
      (error: unknown) => {
        assert.ok(error instanceof TerminalError);
        assert.equal(error.code, 'LLM_API_KEY_MISSING');
        return true;
      },
    );
  });

  it('builds the real provider only when both the setting and the credential are present', () => {
    // Constructed, never called: `createAnthropicProvider` opens no socket until `complete` runs.
    const container = createContainer({
      config: { ...TEST_CONFIG, llm: { ...TEST_CONFIG.llm, providerId: 'anthropic' } },
      llmApiKey: 'test-key-not-a-real-credential',
    });
    assert.equal(container.provider.id, 'anthropic');
    assert.equal(createContainer({ config: TEST_CONFIG }).provider.id, 'mock');
  });

  it('the provider is constructed in the composition root and nowhere else', () => {
    const constructors = FILES.filter((file) =>
      /createAnthropicProvider\s*\(/.test(code(file)),
    ).map(named);
    assert.deepEqual(constructors.sort(), [PROVIDER, 'src/runtime/container.ts'].sort());
  });
});
