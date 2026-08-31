import type { AccountId, UserId } from '../../platform/ids.ts';

export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';

export interface Account {
  readonly id: AccountId;
  readonly slug: string;
  readonly name: string;
  readonly status: AccountStatus;
  readonly defaultLocale: string;
  readonly timezone: string;
  readonly createdAt: Date;
}

export const ACCOUNT_ROLES = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export type UserStatus = 'ACTIVE' | 'DISABLED';

/** Platform identity. Account authority is carried only by a membership, never by this row. */
export interface User {
  readonly id: UserId;
  /** Canonical lower-case, surrounding whitespace removed. */
  readonly email: string;
  readonly fullName: string | null;
  readonly status: UserStatus;
  readonly createdAt: Date;
}

export interface AccountMembership {
  readonly accountId: AccountId;
  readonly userId: UserId;
  readonly role: AccountRole;
  readonly status: 'ACTIVE' | 'REVOKED';
}

export function isAccountRole(value: string): value is AccountRole {
  return ACCOUNT_ROLES.includes(value as AccountRole);
}

/**
 * A suspended account still ingests and persists everything; it only stops *acting*.
 *
 * This distinction is load-bearing: dropping a suspended client's inbound messages would be
 * silent data loss dressed up as a billing feature, and it is unrecoverable once the provider
 * stops retrying.
 */
export function canActAutonomously(account: Account): boolean {
  return account.status === 'ACTIVE';
}

export function canIngest(account: Account): boolean {
  return account.status === 'ACTIVE' || account.status === 'SUSPENDED';
}

const OPERATOR_ROLES: ReadonlySet<AccountRole> = new Set<AccountRole>([
  'OWNER',
  'ADMIN',
  'OPERATOR',
]);

/** Roles permitted to take over a conversation and send messages as a human agent. */
export function canOperateConversations(role: AccountRole): boolean {
  return OPERATOR_ROLES.has(role);
}
