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

export type AccountRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export interface AccountMembership {
  readonly accountId: AccountId;
  readonly userId: UserId;
  readonly role: AccountRole;
  readonly status: 'ACTIVE' | 'REVOKED';
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
