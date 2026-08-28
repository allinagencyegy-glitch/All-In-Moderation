import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Channel } from '../../core/channel.ts';

/**
 * Loader for `fixtures/meta/` — the canonical Meta payload corpus.
 *
 * The corpus lives at the repository root rather than under `tests/` because two very different
 * things read it: the parser contract suite, and the shadow-acceptance tool that an operator runs
 * against a real deployment. `src/` may not import from `tests/`, so a corpus under `tests/` would
 * have had to be duplicated — and two copies of "what Meta sends" drift, with the offline proof
 * and the live proof quietly checking different things.
 *
 * Every payload is synthetic. No client identifier, access token or real customer message appears
 * in the corpus, which is what makes it safe to commit and to replay anywhere (ADR-010).
 */

export interface FixtureExpectation {
  readonly items: number;
  /** How many items may become a customer turn — kind MESSAGE or COMMENT. */
  readonly actionable: number;
  readonly issues: number;
  readonly classifications: Readonly<Record<string, number>>;
}

export interface MetaFixture {
  readonly name: string;
  readonly channel: Channel;
  readonly description: string;
  /** Which official document the shape comes from, or "Synthetic" and why. */
  readonly source: string;
  readonly expect: FixtureExpectation;
  readonly payload: unknown;
}

export interface FixtureManifest {
  readonly description: string;
  /** The synthetic ids the corpus is written against, for provisioning a matching connection. */
  readonly identities: {
    readonly facebookPageId: string;
    readonly instagramAccountId: string;
    readonly whatsappBusinessAccountId: string;
    readonly whatsappPhoneNumberId: string;
    readonly whatsappDisplayPhoneNumber: string;
  };
  readonly fixtures: readonly string[];
}

/** Resolved from this file rather than from `process.cwd()`, so it works from any directory. */
export const FIXTURE_DIR = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'meta');

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as unknown;

export function loadManifest(): FixtureManifest {
  return read('manifest') as FixtureManifest;
}

export function loadFixture(name: string): MetaFixture {
  return read(name) as MetaFixture;
}

/**
 * Every fixture the manifest names, in manifest order.
 *
 * Driven by the manifest rather than by a directory listing on purpose: a fixture file deleted or
 * renamed becomes a loud failure here, where a `readdir` would simply have found one less file and
 * the suite would have gone quietly green with less coverage than it claims.
 */
export function loadAllFixtures(): readonly MetaFixture[] {
  return loadManifest().fixtures.map(loadFixture);
}
