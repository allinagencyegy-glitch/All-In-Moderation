import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The shadow-acceptance tool, run as a tool (objective 14).
 *
 * `selfTest()` is exercised here through the CLI rather than by importing it, and that is the
 * point: the operator's proof and CI's proof have to be the *same command*, or "we ran the
 * acceptance check" means one thing in the pipeline and another on a laptop. The subprocess also
 * proves the exit code, which is what a deployment gate actually reads.
 *
 * It reaches no network and no database. The run is entirely in-memory, so this is a normal test
 * with a normal runtime, not an integration that needs infrastructure.
 */

const CLI = resolve(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'runtime',
  'cli',
  'shadow-acceptance.ts',
);

interface SelfTestReport {
  ok: boolean;
  fixtures: number;
  deliveriesAccepted: number;
  messagesCreated: number;
  conversationsTouched: number;
  outboundActions: number;
  liveOutboundActions: number;
  byClassification: Record<string, number>;
  failures: string[];
}

function runSelfTest(): SelfTestReport {
  const stdout = execFileSync(process.execPath, [CLI, '--self-test'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'error' },
  });
  return JSON.parse(stdout) as SelfTestReport;
}

describe('shadow acceptance self-test', () => {
  const report = runSelfTest();

  it('passes, and exits zero', () => {
    // execFileSync throws on a non-zero exit, so reaching this line is half the assertion.
    assert.deepEqual(report.failures, []);
    assert.equal(report.ok, true);
  });

  it('drove every fixture through the real ingest path', () => {
    assert.ok(report.fixtures >= 30, 'the corpus is the one under fixtures/meta');
    assert.equal(report.deliveriesAccepted, report.fixtures, 'every payload was accepted');
  });

  it('produced real conversation state, so the proof is not vacuous', () => {
    assert.ok(report.messagesCreated > 0);
    assert.ok(report.conversationsTouched > 0);
  });

  it('produced outbound actions, and every one of them is simulated', () => {
    // The load-bearing pair. Without the first assertion the second is true for the trivial
    // reason that there was nothing to check.
    assert.ok(report.outboundActions > 0, 'the moderator reached decisions');
    assert.equal(report.liveOutboundActions, 0);
  });

  it('exercised the loop-breaker and the unsupported-variant path', () => {
    const echoes =
      (report.byClassification['ECHO_SELF_MESSAGE'] ?? 0) +
      (report.byClassification['ECHO_SELF_COMMENT'] ?? 0);
    assert.ok(echoes > 0, 'echoes were classified rather than actioned');
    assert.ok(
      (report.byClassification['UNKNOWN_FIELD'] ?? 0) > 0,
      'unrecognised shapes were recorded under their own name',
    );
    assert.ok((report.byClassification['MALFORMED'] ?? 0) > 0);
  });

  it('covered all three channels', () => {
    // WhatsApp is the one Phase 02A could not parse at all, and Instagram comments are the one it
    // would have silently dropped. Both must appear or the corpus was not really exercised.
    assert.ok((report.byClassification['MESSAGE_INTERACTIVE'] ?? 0) > 0, 'whatsapp');
    assert.ok((report.byClassification['COMMENT'] ?? 0) >= 3, 'facebook and instagram comments');
    assert.ok((report.byClassification['STATUS_UPDATE'] ?? 0) > 0, 'whatsapp statuses');
  });
});
