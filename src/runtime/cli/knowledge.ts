import { scopeForAccount } from '../../core/account/index.ts';
import { TerminalError } from '../../platform/errors.ts';
import { asId } from '../../platform/ids.ts';
import type { UserId } from '../../platform/ids.ts';
import { loadKnowledgeFile } from '../admin/pack-authoring.ts';
import { emit, fail, openCliContext, parseArgs } from './context.ts';

/**
 * `knowledge` — import knowledge entries from a file.
 *
 * The Knowledge Gate only ever shows the model APPROVED, in-validity entries, so this command is
 * the sole doorway between "a fact someone wrote down" and "a fact the AI may state". It is built
 * to make that doorway narrow:
 *
 *   * Nothing in the file can mark itself approved. `--approve` plus `--approver` is the only way,
 *     and the approver's id lands on the row.
 *   * A PRICE or an OFFER without a `validUntil` is refused rather than approved. The database
 *     refuses it too (`knowledge_commercial_requires_expiry`); the check here exists so an
 *     operator gets a sentence rather than a constraint name.
 *   * Tags are normalised on the way in with the same function retrieval uses on the way out, so
 *     an Arabic tag authored as `كرسي أسنان` is reachable from a customer who typed `الكرسي`.
 *
 * Importing without `--approve` is the normal case, and it is not a no-op: a DRAFT entry is a
 * tracked, reviewable statement of what the client still has to confirm.
 *
 * Usage
 *   node src/runtime/cli/knowledge.ts import --account acc_... \
 *     --file knowledge/<client>/pack/knowledge.draft.json
 *
 *   node src/runtime/cli/knowledge.ts import --account acc_... \
 *     --file knowledge/<client>/pack/knowledge.approved.json --approve --approver usr_...
 */

const USAGE = `usage:
  knowledge import --account <id> --file <path> [--approve --approver <user id>]
  knowledge list   --account <id>`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command !== 'import' && command !== 'list') {
    throw new TerminalError('ARGS_INVALID', `unknown command '${command}'\n${USAGE}`);
  }
  const accountId = args['account'];
  if (!accountId) throw new TerminalError('ARGS_INVALID', `--account is required\n${USAGE}`);

  const approve = args['approve'] === 'true';
  const approver = args['approver'];
  if (approve && !approver) {
    // Approval is attribution. An approved entry with nobody's name on it is the shape of the
    // audit's fifteenth finding, and the schema refuses it as well
    // (`knowledge_approved_requires_approver`).
    throw new TerminalError('ARGS_INVALID', '--approve requires --approver <user id>');
  }

  const ctx = openCliContext();
  try {
    const account = await ctx.container.accounts.findById(asId(accountId));
    if (!account) throw new TerminalError('ACCOUNT_NOT_FOUND', 'no such account', { accountId });
    const scope = scopeForAccount(account);

    if (command === 'list') {
      const entries = await ctx.container.knowledge.findApproved(scope, {
        locale: account.defaultLocale,
        intentCodes: [],
        tags: [],
        limit: 500,
      });
      emit({
        ok: true,
        approved: entries.length,
        entries: entries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
          validUntil: entry.validUntil?.toISOString() ?? null,
          hasPrice: entry.price !== null,
        })),
      });
      return;
    }

    const file = args['file'];
    if (!file) throw new TerminalError('ARGS_INVALID', `--file is required\n${USAGE}`);

    const loaded = loadKnowledgeFile(file, {
      accountId: account.id,
      now: ctx.container.clock.now(),
      ...(approve ? { approve: { approver: asId<UserId>(approver!) } } : {}),
    });

    for (const entry of loaded.entries) {
      await ctx.container.knowledge.save(scope, entry);
      if (entry.status === 'APPROVED') {
        await ctx.container.audit.append(scope, {
          action: 'knowledge.entry_approved',
          subjectType: 'knowledge_entry',
          subjectId: entry.id,
          actorKind: 'HUMAN',
          actorUserId: entry.approvedBy,
          detail: {
            kind: entry.kind,
            title: entry.title,
            valid_until: entry.validUntil?.toISOString() ?? null,
          },
          occurredAt: ctx.container.clock.now(),
        });
      }
    }

    emit({
      ok: true,
      file,
      imported: loaded.entries.length,
      approved: loaded.approved,
      draft: loaded.draft,
      // Printed so the operator sees what the model will actually be able to reach. A large import
      // that produced zero approved entries is the expected outcome for a client whose commercial
      // terms are unconfirmed, not a failure.
      entries: loaded.entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        tags: entry.tags.length,
      })),
    });
  } finally {
    await ctx.close();
  }
}

await main().catch(fail);
