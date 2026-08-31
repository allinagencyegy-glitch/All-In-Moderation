import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '../../src/core/account/index.ts';
import { scopeForAccount } from '../../src/core/account/index.ts';
import { createMemoryDatabase } from '../../src/adapters/memory/database.ts';
import { createMemoryPersistence } from '../../src/runtime/container.ts';
import { createTestClock } from '../../src/platform/clock.ts';
import { createDeterministicIdFactory } from '../../src/platform/ids.ts';
import type { OperatorProvisioningInput } from '../../src/runtime/admin/account-provisioning.ts';
import { provisionOperatorAccount } from '../../src/runtime/admin/account-provisioning.ts';

const BASE: OperatorProvisioningInput = {
  slug: 'dental-hub',
  name: 'Dental Hub',
  defaultLocale: 'ar',
  timezone: 'Africa/Cairo',
  userEmail: 'owner@example.com',
  userName: 'Dental Hub Owner',
  role: 'OWNER',
};

function fixture() {
  const db = createMemoryDatabase();
  const ids = createDeterministicIdFactory();
  const clock = createTestClock();
  const persistence = createMemoryPersistence(db, ids, new Map());
  const provision = (input: OperatorProvisioningInput = BASE) =>
    provisionOperatorAccount(
      {
        transactions: persistence.transactions,
        accounts: persistence.accounts,
        users: persistence.users,
        memberships: persistence.memberships,
        ids,
        clock,
      },
      input,
    );
  return { db, persistence, provision };
}

describe('operator account provisioning', () => {
  it('creates an ACTIVE account, user, and membership with canonical prefixed ids', async () => {
    const { db, provision } = fixture();
    const result = await provision();

    assert.equal(result.account.id, 'acc_0001');
    assert.equal(result.account.status, 'ACTIVE');
    assert.equal(result.user.id, 'usr_0001');
    assert.equal(result.user.status, 'ACTIVE');
    assert.equal(result.membership.role, 'OWNER');
    assert.equal(result.membership.status, 'ACTIVE');
    assert.deepEqual(result.created, { account: true, user: true, membership: true });
    assert.equal(db.tables.accounts.size, 1);
    assert.equal(db.tables.users.size, 1);
    assert.equal(db.tables.memberships.size, 1);
  });

  it('is idempotent and preserves every identifier on an exact rerun', async () => {
    const { db, provision } = fixture();
    const first = await provision();
    const second = await provision();

    assert.equal(second.account.id, first.account.id);
    assert.equal(second.user.id, first.user.id);
    assert.deepEqual(second.membership, first.membership);
    assert.deepEqual(second.created, { account: false, user: false, membership: false });
    assert.equal(db.tables.accounts.size, 1);
    assert.equal(db.tables.users.size, 1);
    assert.equal(db.tables.memberships.size, 1);
  });

  it('normalizes duplicate email and reuses the existing platform user across accounts', async () => {
    const { db, provision } = fixture();
    const first = await provision({ ...BASE, userEmail: ' Owner@Example.COM ' });
    const second = await provision({
      ...BASE,
      slug: 'second-account',
      name: 'Second Account',
      userEmail: 'owner@example.com',
    });

    assert.equal(first.user.email, 'owner@example.com');
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.created.user, false);
    assert.equal(second.created.account, true);
    assert.equal(second.created.membership, true);
    assert.equal(db.tables.users.size, 1);
    assert.equal(db.tables.memberships.size, 2);
  });

  it('refuses a slug mapped to materially conflicting account identity data', async () => {
    const { db, provision } = fixture();
    const first = await provision();

    await assert.rejects(
      () => provision({ ...BASE, name: 'Different Company' }),
      (error: unknown) => (error as { code?: string }).code === 'ACCOUNT_PROVISION_CONFLICT',
    );
    assert.equal(db.tables.accounts.size, 1);
    assert.equal(db.tables.accounts.get(first.account.id)?.name, 'Dental Hub');
  });

  it('refuses to change an existing membership role or authority state', async () => {
    const { db, provision } = fixture();
    const first = await provision();

    await assert.rejects(
      () => provision({ ...BASE, role: 'ADMIN' }),
      (error: unknown) => (error as { code?: string }).code === 'MEMBERSHIP_PROVISION_CONFLICT',
    );
    assert.equal(db.tables.memberships.get(`${first.account.id}:${first.user.id}`)?.role, 'OWNER');
  });

  it('rejects invalid roles before performing any write', async () => {
    const { db, provision } = fixture();

    await assert.rejects(
      () => provision({ ...BASE, role: 'SUPERADMIN' as AccountRole }),
      (error: unknown) => (error as { code?: string }).code === 'PROVISION_INPUT_INVALID',
    );
    assert.equal(db.tables.accounts.size, 0);
    assert.equal(db.tables.users.size, 0);
    assert.equal(db.tables.memberships.size, 0);
  });

  it('keeps membership writes tenant-scoped in the memory adapter', async () => {
    const { persistence, provision } = fixture();
    const first = await provision();
    const second = await provision({ ...BASE, slug: 'second', name: 'Second' });

    await assert.rejects(
      () => persistence.memberships.insertIfNew(scopeForAccount(second.account), first.membership),
      (error: unknown) => (error as { code?: string }).code === 'TENANT_VIOLATION',
    );
  });
});
