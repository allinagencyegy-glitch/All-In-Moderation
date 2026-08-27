import type { AccountId } from '../../platform/ids.ts';
import type { Account } from './account.ts';

/**
 * Account lookup is the one repository that legitimately takes an id rather than a scope: it is
 * the operation that *produces* scopes. Everything downstream of it is scope-gated.
 */
export interface AccountRepository {
  findById(id: AccountId): Promise<Account | null>;
  findBySlug(slug: string): Promise<Account | null>;
  save(account: Account): Promise<void>;
}
