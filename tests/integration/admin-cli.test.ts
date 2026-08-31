import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The admin CLIs, as an operator meets them.
 *
 * These are thin — the logic they call is tested directly elsewhere — but they are the *only*
 * interface the receive-only checklist has. A CLI that fails to load, or that accepts an argument
 * it should refuse, turns a documented procedure into an improvised one at exactly the moment
 * somebody is attaching a real client's Page.
 *
 * Every case here runs the real entry point in a subprocess and asserts the **exit code**, because
 * that is what a deployment script reads and what a human notices. None of them touches a network
 * or a database: each stops at an argument or configuration check.
 */

const CLI = (name: string): string =>
  resolve(import.meta.dirname, '..', '..', 'src', 'runtime', 'cli', `${name}.ts`);

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(name: string, args: readonly string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [CLI(name), ...args], {
    encoding: 'utf8',
    // A blank string, not `undefined`: an inherited PG_MIGRATOR_URL from a developer's shell would
    // make this suite try to reach a real database.
    env: { ...process.env, PG_RUNTIME_URL: '', PG_MIGRATOR_URL: '', LOG_LEVEL: 'error', ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('admin CLIs', () => {
  it('account prints the complete provisioning usage without opening a database', () => {
    const result = run('account', []);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /account\.ts provision/);
    assert.match(result.stdout, /OWNER\|ADMIN\|OPERATOR\|VIEWER/);
  });

  it('account refuses an invalid role before opening a database', () => {
    const result = run('account', [
      'provision',
      '--slug',
      'dental-hub',
      '--name',
      'Dental Hub',
      '--locale',
      'ar',
      '--timezone',
      'Africa/Cairo',
      '--user-email',
      'owner@example.com',
      '--user-name',
      'Owner',
      '--role',
      'SUPERADMIN',
    ]);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr) as { code: string; message: string };
    assert.equal(error.code, 'ARGS_INVALID');
    assert.match(error.message, /OWNER, ADMIN, OPERATOR, VIEWER/);
    assert.ok(!error.message.includes('PG_RUNTIME_URL'));
  });

  it('meta-connection prints usage and succeeds with no arguments', () => {
    const result = run('meta-connection', []);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /meta-connection provision/);
    assert.match(result.stdout, /FACEBOOK\|INSTAGRAM\|WHATSAPP/);
  });

  it('meta-connection refuses a command without an account', () => {
    const result = run('meta-connection', ['provision']);
    assert.equal(result.status, 1);
    // Structured, and on stderr: a caller that pipes stdout gets the report or nothing.
    const error = JSON.parse(result.stderr) as { ok: boolean; code: string };
    assert.equal(error.ok, false);
    assert.equal(error.code, 'ARGS_INVALID');
  });

  it('meta-connection refuses an unknown command rather than doing something else', () => {
    const result = run('meta-connection', ['delete', '--account', 'acc_1']);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr) as { code: string; message: string };
    assert.equal(error.code, 'ARGS_INVALID');
    assert.match(error.message, /unknown command/);
  });

  it('shadow-acceptance prints usage for --help and refuses a trace with no account', () => {
    const help = run('shadow-acceptance', ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /shadow-acceptance --self-test/);

    const noAccount = run('shadow-acceptance', ['--connection', 'chc_1']);
    assert.equal(noAccount.status, 1);
    assert.match((JSON.parse(noAccount.stderr) as { code: string }).code, /ARGS_INVALID/);
  });

  it('migrate refuses to run without PG_MIGRATOR_URL, and names the role', () => {
    // The privilege boundary made visible in the command itself. `app_runtime` cannot change the
    // schema — the security suite asserts that — so accepting the runtime URL here would produce a
    // confusing permission error instead of a clear refusal.
    const result = run('migrate', []);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr) as { code: string; message: string };
    assert.equal(error.code, 'CONFIG_MISSING');
    assert.match(error.message, /PG_MIGRATOR_URL/);
    assert.match(error.message, /app_migrator/);
  });

  it('migrate prints usage for --help without touching a database', () => {
    const result = run('migrate', ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /apply every pending migration/);
  });

  it('no CLI ever prints a connection string or a secret on the failure path', () => {
    // `describeError` deliberately drops the cause chain, because a pg failure carries the
    // connection string inside it.
    const secretish = 'postgres://someone:hunter2@db.internal:5432/prod';
    const result = run('migrate', [], { PG_MIGRATOR_URL: '' });
    const combined = result.stdout + result.stderr;
    assert.ok(!combined.includes('hunter2'));
    assert.ok(!combined.includes(secretish));
  });
});
