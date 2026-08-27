import type { AccountId, UserId } from '../../platform/ids.ts';
import { TenantViolationError, TerminalError } from '../../platform/errors.ts';
import type { Account, AccountRole } from './account.ts';
import { canOperateConversations } from './account.ts';

declare const scopeBrand: unique symbol;

/**
 * The tenant capability token (ADR-002, layer 1).
 *
 * Every repository method takes one of these as its first argument, so a data-access call that
 * forgets tenancy does not compile. The brand is backed by a module-private symbol, so a scope
 * cannot be forged with an object literal anywhere else in the codebase — it must come from one
 * of the resolvers below, each of which performs an actual authorisation check.
 *
 * Note what is deliberately absent: there is no ambient "current account" lookup. Ambient state
 * fails *open* when a caller forgets to set it; an explicit argument fails *closed* at compile
 * time.
 */
export interface AccountScope {
  readonly accountId: AccountId;
  readonly [scopeBrand]: true;
}

function mint(accountId: AccountId): AccountScope {
  return { accountId } as AccountScope;
}

/**
 * Resolves a scope for a background worker acting on behalf of an account.
 *
 * Callers must pass the `Account` they loaded, not a bare id, so that a scope can never be
 * produced for an account that does not exist or has been archived.
 */
export function scopeForAccount(account: Account): AccountScope {
  if (account.status === 'ARCHIVED') {
    throw new TerminalError('ACCOUNT_ARCHIVED', 'Cannot act on an archived account', {
      accountId: account.id,
    });
  }
  return mint(account.id);
}

/** Resolves a scope for a human operator, gated on an active membership. */
export function scopeForMember(
  account: Account,
  userId: UserId,
  role: AccountRole,
  membershipStatus: 'ACTIVE' | 'REVOKED',
): AccountScope {
  if (membershipStatus !== 'ACTIVE') {
    throw new TerminalError('MEMBERSHIP_INACTIVE', 'User has no active membership for account', {
      accountId: account.id,
      userId,
    });
  }
  if (!canOperateConversations(role)) {
    throw new TerminalError('INSUFFICIENT_ROLE', 'Role may not operate conversations', {
      accountId: account.id,
      userId,
      role,
    });
  }
  return scopeForAccount(account);
}

/**
 * Asserts that a loaded row belongs to the scope that requested it.
 *
 * This is layer 1's last line: adapters call it after hydrating any row, so that even a
 * hand-written query with a missing predicate produces a loud `TenantViolationError` rather
 * than quietly returning another tenant's data.
 */
export function scopeViolation(
  scope: AccountScope,
  row: { readonly accountId: AccountId },
  resource: string,
): TenantViolationError | null {
  return row.accountId === scope.accountId
    ? null
    : new TenantViolationError(scope.accountId, row.accountId, resource);
}

/** Synchronous form, for code paths that are not already returning a Promise. */
export function assertInScope(
  scope: AccountScope,
  row: { readonly accountId: AccountId },
  resource: string,
): void {
  const violation = scopeViolation(scope, row, resource);
  if (violation) throw violation;
}

/**
 * Async scope enforcement for repository reads.
 *
 * Repositories return Promises, so a scope violation must *reject* rather than throw
 * synchronously — a synchronous throw from a Promise-returning function escapes `Promise.all` and
 * `.catch()` handling and surfaces somewhere surprising. Every adapter uses these two helpers so
 * that in-memory and Postgres behave identically under the shared contract tests.
 */
export function readInScope<T extends { readonly accountId: AccountId }>(
  scope: AccountScope,
  row: T | undefined | null,
  resource: string,
): Promise<T | null> {
  if (!row) return Promise.resolve(null);
  const violation = scopeViolation(scope, row, resource);
  return violation ? Promise.reject(violation) : Promise.resolve(row);
}

export function writeInScope<T extends { readonly accountId: AccountId }>(
  scope: AccountScope,
  row: T,
  resource: string,
  write: () => void,
): Promise<void> {
  const violation = scopeViolation(scope, row, resource);
  if (violation) return Promise.reject(violation);
  write();
  return Promise.resolve();
}

/** Cache keys are always tenant-prefixed; there is no API that accepts an unprefixed key. */
export function scopedCacheKey(scope: AccountScope, ...parts: readonly string[]): string {
  return ['acct', scope.accountId, ...parts].join(':');
}

/** Job partition keys are tenant-prefixed so partitions cannot collide across accounts. */
export function scopedPartitionKey(scope: AccountScope, kind: string, id: string): string {
  return `acct:${scope.accountId}:${kind}:${id}`;
}
