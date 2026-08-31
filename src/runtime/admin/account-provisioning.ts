import type {
  Account,
  AccountMembership,
  AccountMembershipRepository,
  AccountRepository,
  AccountRole,
  User,
  UserRepository,
} from '../../core/account/index.ts';
import { isAccountRole, scopeForAccount } from '../../core/account/index.ts';
import type { Clock } from '../../platform/clock.ts';
import { TerminalError } from '../../platform/errors.ts';
import type { AccountId, IdFactory, UserId } from '../../platform/ids.ts';
import { ID_PREFIX } from '../../platform/ids.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';

/** The complete and deliberately small input to first-tenant provisioning. */
export interface OperatorProvisioningInput {
  readonly slug: string;
  readonly name: string;
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly userEmail: string;
  readonly userName: string;
  readonly role: AccountRole;
}

export interface OperatorProvisioningDeps {
  readonly transactions: TransactionRunner;
  readonly accounts: AccountRepository;
  readonly users: UserRepository;
  readonly memberships: AccountMembershipRepository;
  readonly ids: IdFactory;
  readonly clock: Clock;
}

export interface OperatorProvisioningResult {
  readonly account: Account;
  readonly user: User;
  readonly membership: AccountMembership;
  readonly created: {
    readonly account: boolean;
    readonly user: boolean;
    readonly membership: boolean;
  };
}

/**
 * Creates or resolves an account, platform user, and membership as one transaction.
 *
 * Existing rows are never updated here. A rerun either proves that all identity and authority
 * fields still mean the same thing, or refuses with a specific conflict. This keeps an innocuous
 * typo from becoming an account rename, a disabled user reactivation, or a role change.
 */
export async function provisionOperatorAccount(
  deps: OperatorProvisioningDeps,
  raw: OperatorProvisioningInput,
): Promise<OperatorProvisioningResult> {
  const input = validateOperatorProvisioningInput(raw);

  return await deps.transactions.run(async () => {
    const existingAccount = await deps.accounts.findBySlug(input.slug);
    let account: Account;
    let accountCreated = false;

    if (existingAccount) {
      assertCompatibleAccount(existingAccount, input);
      account = existingAccount;
    } else {
      account = {
        id: deps.ids.next<AccountId>(ID_PREFIX.account),
        slug: input.slug,
        name: input.name,
        status: 'ACTIVE',
        defaultLocale: input.defaultLocale,
        timezone: input.timezone,
        createdAt: deps.clock.now(),
      };
      const inserted = await deps.accounts.insertIfNew(account);
      account = inserted.record;
      accountCreated = inserted.inserted;
      assertCompatibleAccount(account, input);
    }

    const existingUser = await deps.users.findByNormalizedEmail(input.userEmail);
    let user: User;
    let userCreated = false;

    if (existingUser) {
      user = existingUser;
    } else {
      const candidate: User = {
        id: deps.ids.next<UserId>(ID_PREFIX.user),
        email: input.userEmail,
        fullName: input.userName,
        status: 'ACTIVE',
        createdAt: deps.clock.now(),
      };
      const inserted = await deps.users.insertIfNew(candidate);
      user = inserted.record;
      userCreated = inserted.inserted;
    }
    assertCompatibleUser(user, input);

    const scope = scopeForAccount(account);
    const candidateMembership: AccountMembership = {
      accountId: account.id,
      userId: user.id,
      role: input.role,
      status: 'ACTIVE',
    };
    const insertedMembership = await deps.memberships.insertIfNew(scope, candidateMembership);
    assertCompatibleMembership(insertedMembership.record, candidateMembership);

    return {
      account,
      user,
      membership: insertedMembership.record,
      created: {
        account: accountCreated,
        user: userCreated,
        membership: insertedMembership.inserted,
      },
    };
  });
}

export function normalizeOperatorEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateOperatorProvisioningInput(
  input: OperatorProvisioningInput,
): OperatorProvisioningInput {
  const slug = input.slug.trim();
  const name = input.name.trim();
  const defaultLocale = input.defaultLocale.trim();
  const timezone = input.timezone.trim();
  const userEmail = normalizeOperatorEmail(input.userEmail);
  const userName = input.userName.trim();

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    throw new TerminalError(
      'PROVISION_INPUT_INVALID',
      'slug must be a lower-case kebab-case identifier of at most 64 characters',
    );
  }
  requiredBounded('name', name, 200);
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(defaultLocale)) {
    throw new TerminalError('PROVISION_INPUT_INVALID', 'default locale is not a valid locale tag');
  }
  requiredBounded('timezone', timezone, 100);
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new TerminalError('PROVISION_INPUT_INVALID', 'timezone is not a valid IANA timezone');
  }
  if (
    userEmail.length > 320 ||
    !/^[^\s@]+@[^\s@]+$/.test(userEmail) ||
    userEmail.startsWith('@') ||
    userEmail.endsWith('@')
  ) {
    throw new TerminalError('PROVISION_INPUT_INVALID', 'user email is not valid');
  }
  requiredBounded('user name', userName, 200);
  if (!isAccountRole(input.role)) {
    throw new TerminalError(
      'PROVISION_INPUT_INVALID',
      'role must be one of OWNER, ADMIN, OPERATOR, VIEWER',
    );
  }

  return { slug, name, defaultLocale, timezone, userEmail, userName, role: input.role };
}

function requiredBounded(field: string, value: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength) {
    throw new TerminalError(
      'PROVISION_INPUT_INVALID',
      `${field} must be between 1 and ${String(maxLength)} characters`,
    );
  }
}

function assertCompatibleAccount(account: Account, input: OperatorProvisioningInput): void {
  const conflicts: string[] = [];
  if (account.slug !== input.slug) conflicts.push('slug');
  if (account.name !== input.name) conflicts.push('name');
  if (account.defaultLocale !== input.defaultLocale) conflicts.push('defaultLocale');
  if (account.timezone !== input.timezone) conflicts.push('timezone');
  if (account.status !== 'ACTIVE') conflicts.push('status');
  if (conflicts.length > 0) {
    throw new TerminalError(
      'ACCOUNT_PROVISION_CONFLICT',
      `Account slug is already mapped to conflicting fields: ${conflicts.join(', ')}`,
      { accountId: account.id, fields: conflicts.join(',') },
    );
  }
}

function assertCompatibleUser(user: User, input: OperatorProvisioningInput): void {
  const conflicts: string[] = [];
  if (normalizeOperatorEmail(user.email) !== input.userEmail) conflicts.push('email');
  if (user.fullName !== input.userName) conflicts.push('fullName');
  if (user.status !== 'ACTIVE') conflicts.push('status');
  if (conflicts.length > 0) {
    throw new TerminalError(
      'USER_PROVISION_CONFLICT',
      `Existing user has conflicting fields: ${conflicts.join(', ')}`,
      { userId: user.id, fields: conflicts.join(',') },
    );
  }
}

function assertCompatibleMembership(
  membership: AccountMembership,
  expected: AccountMembership,
): void {
  const conflicts: string[] = [];
  if (membership.accountId !== expected.accountId) conflicts.push('accountId');
  if (membership.userId !== expected.userId) conflicts.push('userId');
  if (membership.role !== expected.role) conflicts.push('role');
  if (membership.status !== 'ACTIVE') conflicts.push('status');
  if (conflicts.length > 0) {
    throw new TerminalError(
      'MEMBERSHIP_PROVISION_CONFLICT',
      `Existing membership has conflicting authority fields: ${conflicts.join(', ')}`,
      { accountId: expected.accountId, userId: expected.userId, fields: conflicts.join(',') },
    );
  }
}
