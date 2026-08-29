import { scopeForAccount } from '../../core/account/index.ts';
import { TerminalError } from '../../platform/errors.ts';
import { asId } from '../../platform/ids.ts';
import type { AccountPackVersionId, UserId } from '../../platform/ids.ts';
import { validatePack } from '../../knowledge/domain/account-pack.ts';
import { loadPackFile } from '../admin/pack-authoring.ts';
import { emit, fail, openCliContext, parseArgs } from './context.ts';

/**
 * `pack` — validate and publish an Account Pack from a file.
 *
 * Onboarding a client is authoring a pack, not writing code (ADR-010). Until this command existed
 * the only packs in the system were built inline by the demo and the shadow-acceptance self-test,
 * which is to say there was no way to onboard a client at all.
 *
 * `validate` opens no database and needs no credentials, so it belongs in a pre-commit hook and in
 * review. `publish` writes exactly one ACTIVE version; the partial unique index in migration 0004
 * is what guarantees there is never a second one, and the memory adapter mirrors it.
 *
 * Usage
 *   node src/runtime/cli/pack.ts validate --file knowledge/<client>/pack/pack.json
 *   node src/runtime/cli/pack.ts publish  --account acc_... --file <path> \
 *                                         --publisher usr_... [--version 1] [--pack-id apv_...]
 */

const USAGE = `usage:
  pack validate --file <path>
  pack publish  --account <id> --file <path> --publisher <user id> [--version <n>] [--pack-id <id>]`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command !== 'validate' && command !== 'publish') {
    throw new TerminalError('ARGS_INVALID', `unknown command '${command}'\n${USAGE}`);
  }
  const file = args['file'];
  if (!file) throw new TerminalError('ARGS_INVALID', `--file is required\n${USAGE}`);

  // Validation is deliberately offline. Requiring a database to check a JSON file would keep the
  // check out of CI, which is the one place it is most useful.
  if (command === 'validate') {
    const pack = loadPackFile(file, {
      accountId: asId('acc_validate'),
      version: 1,
      publishedBy: asId<UserId>('usr_validate'),
      now: new Date(),
    });
    emit({
      ok: true,
      file,
      sections: Object.keys(pack.sections).sort(),
      contentHash: pack.contentHash,
      schemaVersion: pack.schemaVersion,
      issues: validatePack(pack),
    });
    return;
  }

  const accountId = args['account'];
  const publisher = args['publisher'];
  if (!accountId) throw new TerminalError('ARGS_INVALID', `--account is required\n${USAGE}`);
  if (!publisher) {
    // A published pack has to name who published it, and the schema agrees:
    // `pack_published_requires_publisher` (migration 0004).
    throw new TerminalError('ARGS_INVALID', `--publisher is required\n${USAGE}`);
  }

  const ctx = openCliContext();
  try {
    const account = await ctx.container.accounts.findById(asId(accountId));
    if (!account) throw new TerminalError('ACCOUNT_NOT_FOUND', 'no such account', { accountId });
    const scope = scopeForAccount(account);

    const current = await ctx.container.packs.findActive(scope);
    const version = args['version']
      ? Number.parseInt(args['version'], 10)
      : (current?.version ?? 0) + 1;
    if (!Number.isInteger(version) || version < 1) {
      throw new TerminalError('ARGS_INVALID', '--version must be a positive integer');
    }

    const pack = loadPackFile(file, {
      accountId: account.id,
      version,
      publishedBy: asId<UserId>(publisher),
      now: ctx.container.clock.now(),
      ...(args['pack-id'] ? { packId: asId<AccountPackVersionId>(args['pack-id']) } : {}),
    });

    // Saving an ACTIVE version supersedes the previous one — in the repository and, on Postgres,
    // under the partial unique index that makes "exactly one ACTIVE" a database fact.
    await ctx.container.packs.save(scope, pack);
    await ctx.container.audit.append(scope, {
      action: 'pack.published',
      subjectType: 'account_pack_version',
      subjectId: pack.id,
      actorKind: 'HUMAN',
      actorUserId: asId<UserId>(publisher),
      detail: {
        version: pack.version,
        content_hash: pack.contentHash,
        supersedes: current?.id ?? null,
      },
      occurredAt: ctx.container.clock.now(),
    });

    emit({
      ok: true,
      packVersionId: pack.id,
      version: pack.version,
      status: pack.status,
      contentHash: pack.contentHash,
      supersedes: current?.id ?? null,
      sections: Object.keys(pack.sections).length,
    });
  } finally {
    await ctx.close();
  }
}

await main().catch(fail);
