import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { asId } from '../../src/platform/ids.ts';
import type { OperatorProvisioningInput } from '../../src/runtime/admin/account-provisioning.ts';
import { provisionOperatorAccount } from '../../src/runtime/admin/account-provisioning.ts';
import type { PostgresHarness } from '../support/postgres-harness.ts';
import { createPostgresHarness } from '../support/postgres-harness.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import { acquirePostgres, postgresAvailable, releasePostgres } from '../support/postgres.ts';

const available = postgresAvailable();
const BASE: OperatorProvisioningInput = {
  slug: 'dental-hub',
  name: 'Dental Hub',
  defaultLocale: 'ar',
  timezone: 'Africa/Cairo',
  userEmail: 'owner@example.com',
  userName: 'Dental Hub Owner',
  role: 'OWNER',
};

describe('postgres operator provisioning', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let h: PostgresHarness;

  before(async () => {
    cluster = await acquirePostgres();
  });

  beforeEach(async () => {
    await h?.close();
    h = await createPostgresHarness(cluster);
  });

  after(async () => {
    await h?.close();
    await releasePostgres();
  });

  const provision = (input: OperatorProvisioningInput = BASE) =>
    provisionOperatorAccount(
      {
        transactions: h.persistence.transactions,
        accounts: h.persistence.accounts,
        users: h.persistence.users,
        memberships: h.persistence.memberships,
        ids: h.container.ids,
        clock: h.container.clock,
      },
      input,
    );

  it('creates and idempotently resolves all three rows through app_runtime', async () => {
    const first = await provision();
    const second = await provision();

    assert.equal(second.account.id, first.account.id);
    assert.equal(second.user.id, first.user.id);
    assert.deepEqual(second.membership, first.membership);
    assert.deepEqual(first.created, { account: true, user: true, membership: true });
    assert.deepEqual(second.created, { account: false, user: false, membership: false });
  });

  it('enforces normalized email uniqueness in PostgreSQL and reuses the user id', async () => {
    const first = await provision({ ...BASE, userEmail: ' Owner@Example.COM ' });
    const second = await provision({
      ...BASE,
      slug: 'second-account',
      name: 'Second Account',
      userEmail: 'owner@example.com',
    });

    assert.equal(second.user.id, first.user.id);
    assert.equal(second.created.user, false);
  });

  it('keeps runtime reads blind without a tenant and membership rows isolated by FORCE RLS', async () => {
    const result = await provision();

    const role = await h.persistence.runtimeDb.unscoped(async (client) => {
      const attributes = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      const accounts = await client.query<{ id: string }>('SELECT id FROM accounts');
      const memberships = await client.query<{ account_id: string }>(
        'SELECT account_id FROM account_memberships',
      );
      return {
        attributes: attributes.rows[0]!,
        accounts: accounts.rows,
        memberships: memberships.rows,
      };
    }, 'operator-provisioning:rls-proof');

    assert.equal(role.attributes.rolsuper, false);
    assert.equal(role.attributes.rolbypassrls, false);
    assert.deepEqual(role.accounts, []);
    assert.deepEqual(role.memberships, []);

    const wrongTenantRows = await h.persistence.runtimeDb.scoped(
      asId('acc_not_the_tenant'),
      async (client) => {
        const rows = await client.query<{ user_id: string }>(
          'SELECT user_id FROM account_memberships',
        );
        return rows.rows;
      },
      'operator-provisioning:wrong-tenant',
    );
    assert.deepEqual(wrongTenantRows, []);

    const resolved = await h.persistence.accounts.findBySlug('dental-hub');
    assert.equal(
      resolved?.id,
      result.account.id,
      'the id-only resolver establishes the real scope',
    );
  });
});
