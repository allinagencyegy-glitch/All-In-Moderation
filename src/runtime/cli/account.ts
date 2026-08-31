import { isAccountRole } from '../../core/account/index.ts';
import { TerminalError } from '../../platform/errors.ts';
import {
  provisionOperatorAccount,
  validateOperatorProvisioningInput,
} from '../admin/account-provisioning.ts';
import { emit, fail, openCliContext, parseArgs } from './context.ts';

/**
 * RLS-bound account and reviewer provisioning.
 *
 * The command accepts identity and authority data but reports identifiers and states only. It uses
 * the same app_runtime persistence bundle as the service; no migrator connection is consulted.
 */
const USAGE = `usage:
  node src/runtime/cli/account.ts provision \\
    --slug <account-slug> --name <account-name> --locale <locale> --timezone <IANA timezone> \\
    --user-email <email> --user-name <full-name> --role OWNER|ADMIN|OPERATOR|VIEWER`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command !== 'provision') {
    throw new TerminalError('ARGS_INVALID', `unknown command '${command}'\n${USAGE}`);
  }

  const args = parseArgs(rest);
  const role = required(args, 'role');
  if (!isAccountRole(role)) {
    throw new TerminalError(
      'ARGS_INVALID',
      `--role must be one of OWNER, ADMIN, OPERATOR, VIEWER\n${USAGE}`,
    );
  }

  // Validate every operator-supplied value before opening a database connection. A bad timezone
  // or malformed slug should not be misreported as a missing PG_RUNTIME_URL.
  const input = validateOperatorProvisioningInput({
    slug: required(args, 'slug'),
    name: required(args, 'name'),
    defaultLocale: required(args, 'locale'),
    timezone: required(args, 'timezone'),
    userEmail: required(args, 'user-email'),
    userName: required(args, 'user-name'),
    role,
  });

  const ctx = openCliContext();
  try {
    const result = await provisionOperatorAccount(
      {
        transactions: ctx.persistence.transactions,
        accounts: ctx.persistence.accounts,
        users: ctx.persistence.users,
        memberships: ctx.persistence.memberships,
        ids: ctx.container.ids,
        clock: ctx.container.clock,
      },
      input,
    );

    emit({
      ok: true,
      accountId: result.account.id,
      accountSlug: result.account.slug,
      accountStatus: result.account.status,
      userId: result.user.id,
      userStatus: result.user.status,
      membershipRole: result.membership.role,
      membershipStatus: result.membership.status,
      created: result.created,
    });
  } finally {
    await ctx.close();
  }
}

function required(args: Readonly<Record<string, string>>, name: string): string {
  const value = args[name];
  if (!value) throw new TerminalError('ARGS_INVALID', `--${name} is required\n${USAGE}`);
  return value;
}

await main().catch(fail);
