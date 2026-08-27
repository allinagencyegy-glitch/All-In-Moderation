import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

/**
 * Architecture enforcement (ADR-001).
 *
 * A module boundary that is only written down in a document is a suggestion. This test parses
 * every import in `src/` and fails on any edge outside the declared graph, so adding coupling
 * becomes a deliberate act — you have to edit this file, and someone has to review that edit.
 *
 * It also asserts the property that keeps the platform genuinely multi-client: no client-specific
 * identifier appears anywhere in the runtime.
 */

const SRC = resolve(import.meta.dirname, '..', '..', 'src');

/**
 * The dependency graph. Direction matters: `moderation` asks `policy` and `knowledge` questions;
 * neither may ask `moderation` anything, which is what keeps a vendor or policy change from
 * rippling into the conversation model.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  platform: [],
  core: ['platform'],
  policy: ['platform', 'core'],
  knowledge: ['platform', 'core', 'policy'],
  operations: ['platform', 'core'],
  moderation: ['platform', 'core', 'knowledge', 'policy', 'operations'],
  integrations: ['platform', 'core', 'knowledge', 'moderation', 'operations'],
  adapters: ['platform', 'core', 'knowledge', 'policy', 'moderation', 'operations', 'integrations'],
  runtime: [
    'platform',
    'core',
    'knowledge',
    'policy',
    'moderation',
    'operations',
    'integrations',
    'adapters',
  ],
};

/** Names that must never appear in the runtime: business content lives in Account Packs. */
const FORBIDDEN_IDENTIFIERS = ['dental hub', 'dentalhub', 'city smile', 'citysmile'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function moduleOf(file: string): string {
  return relative(SRC, file).split(sep)[0]!;
}

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) specifiers.push(match[1]!);
  return specifiers;
}

const FILES = walk(SRC);

describe('module boundaries', () => {
  it('the declared graph is itself acyclic', () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string, path: string[]): void => {
      if (done.has(node)) return;
      assert.ok(
        !visiting.has(node),
        `cycle in the declared graph: ${[...path, node].join(' -> ')}`,
      );
      visiting.add(node);
      for (const next of ALLOWED[node] ?? []) visit(next, [...path, node]);
      visiting.delete(node);
      done.add(node);
    };
    for (const node of Object.keys(ALLOWED)) visit(node, []);
  });

  it('every source file lives in a declared module', () => {
    const unknown = FILES.map(moduleOf).filter((m) => !(m in ALLOWED));
    assert.deepEqual([...new Set(unknown)], [], 'undeclared top-level directories under src/');
  });

  it('no import crosses a boundary that is not declared', () => {
    const violations: string[] = [];

    for (const file of FILES) {
      const from = moduleOf(file);
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(SRC)) {
          violations.push(`${relative(SRC, file)} imports outside src/: ${specifier}`);
          continue;
        }
        const to = moduleOf(target);
        if (to === from) continue;
        if (!(ALLOWED[from] ?? []).includes(to)) {
          violations.push(`${relative(SRC, file)}: ${from} -> ${to} is not an allowed edge`);
        }
      }
    }

    assert.deepEqual(violations, []);
  });

  it('domain modules never import a database driver or an HTTP client', () => {
    const forbiddenPackages = [
      'pg',
      'postgres',
      'mysql2',
      'mongodb',
      'redis',
      'ioredis',
      'axios',
      'undici',
    ];
    const domainModules = ['platform', 'core', 'knowledge', 'policy', 'moderation', 'operations'];
    const violations: string[] = [];

    for (const file of FILES) {
      if (!domainModules.includes(moduleOf(file))) continue;
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        if (forbiddenPackages.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) {
          violations.push(`${relative(SRC, file)} imports ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, [], 'infrastructure belongs in adapters/, behind a port');
  });

  it('the webhook ingest path cannot reach a language model', () => {
    // Invariant I1: no interpretation before durable persistence. If this file could import the
    // LLM port, someone could one day "just classify it quickly" inside the HTTP handler and turn
    // the provider's webhook timeout into our model's timeout.
    const ingest = join(SRC, 'moderation', 'application', 'ingest-webhook.ts');
    const specifiers = importsOf(ingest);
    assert.ok(
      !specifiers.some((s) => s.includes('/llm/')),
      'ingest-webhook.ts must not import anything from integrations/llm',
    );
    assert.ok(
      !specifiers.some((s) => s.includes('knowledge')),
      'ingest must not consult knowledge before the event is durable',
    );
  });

  it('no client-specific identifier appears in the runtime', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8').toLowerCase();
      for (const name of FORBIDDEN_IDENTIFIERS) {
        if (source.includes(name)) violations.push(`${relative(SRC, file)} mentions "${name}"`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      'client business content belongs in an Account Pack, never in src/ (ADR-010)',
    );
  });

  it('only the composition root constructs concrete adapters', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const from = moduleOf(file);
      if (from === 'runtime' || from === 'adapters') continue;
      for (const specifier of importsOf(file)) {
        if (specifier.includes('adapters/')) {
          violations.push(`${relative(SRC, file)} imports a concrete adapter`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });
});
