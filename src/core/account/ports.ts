import type { AccountId, UserId } from '../../platform/ids.ts';
import type { Account, AccountMembership, User } from './account.ts';
import type { AccountScope } from './scope.ts';

/**
 * Account lookup is the one repository that legitimately takes an id rather than a scope: it is
 * the operation that *produces* scopes. Everything downstream of it is scope-gated.
 */
export interface AccountRepository {
  findById(id: AccountId): Promise<Account | null>;
  findBySlug(slug: string): Promise<Account | null>;
  insertIfNew(account: Account): Promise<{ readonly inserted: boolean; readonly record: Account }>;
  save(account: Account): Promise<void>;
}

/** Users are platform-scoped; this port never grants account authority. */
export interface UserRepository {
  findByNormalizedEmail(email: string): Promise<User | null>;
  insertIfNew(user: User): Promise<{ readonly inserted: boolean; readonly record: User }>;
}

/** Membership access is tenant-scoped in both adapters and by PostgreSQL FORCE RLS. */
export interface AccountMembershipRepository {
  findByUserId(scope: AccountScope, userId: UserId): Promise<AccountMembership | null>;
  insertIfNew(
    scope: AccountScope,
    membership: AccountMembership,
  ): Promise<{
    readonly inserted: boolean;
    readonly record: AccountMembership;
  }>;
}
