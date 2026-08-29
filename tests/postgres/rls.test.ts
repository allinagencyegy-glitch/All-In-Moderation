import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, ConversationId } from '../../src/platform/ids.ts';
import type { PostgresTestCluster } from '../support/postgres.ts';
import {
  acquirePostgres,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * Step 5: tenant isolation, proven against real PostgreSQL as a non-superuser.
 *
 * This is the suite that has to be right. Everything else in the platform is a correctness
 * problem; this one is a *disclosure* problem, and the failure mode is a client reading another
 * client's customer conversations.
 *
 * Two decisions make it meaningful rather than decorative:
 *
 *   1. **It connects as `app_runtime_login`, never as `postgres`.** A superuser bypasses RLS
 *      silently. An isolation suite run as superuser passes whether the policies exist or not,
 *      which is worse than having no suite — it manufactures confidence.
 *
 *   2. **It attacks the tables directly, in SQL.** The repositories add their own `account_id`
 *      predicates, so testing through them proves the repositories are careful, not that the
 *      database is. These queries deliberately omit the predicate, which is exactly what a bug
 *      would do.
 *
 * The last test removes a policy and asserts the leak appears, so the suite cannot pass
 * vacuously.
 */

const ACCOUNT_A = asId<AccountId>('acc_tenant_a');
const ACCOUNT_B = asId<AccountId>('acc_tenant_b');
const CONVERSATION_A = asId<ConversationId>('cnv_a');
const CONVERSATION_B = asId<ConversationId>('cnv_b');

const available = postgresAvailable();

describe('postgres row-level security', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let runtime: pg.Client;

  before(async () => {
    cluster = await acquirePostgres();
  });

  after(async () => {
    await runtime.end();
    await releasePostgres();
  });

  beforeEach(async () => {
    await truncateAll(cluster.adminUrl);
    runtime ??= await (async () => {
      const client = new pg.Client({ connectionString: cluster.runtimeUrl });
      await client.connect();
      return client;
    })();
    await seedTwoTenants(cluster);
  });

  /** Runs `fn` with `app.account_id` set, exactly as the adapter's tenant transaction does. */
  const asTenant = async <T>(
    accountId: string,
    fn: (client: pg.Client) => Promise<T>,
  ): Promise<T> => {
    await runtime.query('BEGIN');
    try {
      await runtime.query('SELECT set_config($1,$2,true)', ['app.account_id', accountId]);
      return await fn(runtime);
    } finally {
      await runtime.query('ROLLBACK');
    }
  };

  it('the test role is genuinely not a superuser and does not bypass RLS', async () => {
    const row = await asTenant(ACCOUNT_A, async (client) => {
      const result = await client.query<{
        current_user: string;
        superuser: boolean;
        bypassrls: boolean;
      }>(
        `SELECT current_user,
                rolsuper AS superuser,
                rolbypassrls AS bypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );
      return result.rows[0]!;
    });
    assert.equal(row.current_user, 'app_runtime_login');
    assert.equal(row.superuser, false, 'a superuser would silently bypass every policy below');
    assert.equal(row.bypassrls, false);
  });

  it('A reads its own conversations', async () => {
    const rows = await asTenant(ACCOUNT_A, async (client) => {
      const result = await client.query<{ id: string }>('SELECT id FROM conversations');
      return result.rows;
    });
    assert.deepEqual(rows, [{ id: CONVERSATION_A }]);
  });

  it("A cannot read B's rows, on any tenant table, with no predicate at all", async () => {
    const leaks: string[] = [];
    for (const table of [
      'conversations',
      'messages',
      'raw_inbound_events',
      'moderator_runs',
      'outbound_actions',
      'outbound_action_reviews',
      'handoffs',
      'channel_connections',
      'channel_identities',
      'knowledge_entries',
      'account_pack_versions',
      'audit_events',
      'domain_event_outbox',
      'conversation_ownership_transitions',
    ]) {
      const foreign = await asTenant(ACCOUNT_A, async (client) => {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE account_id <> $1`,
          [ACCOUNT_A],
        );
        return Number(result.rows[0]!.count);
      });
      if (foreign !== 0) leaks.push(`${table}: ${String(foreign)} foreign rows visible`);
    }
    assert.deepEqual(leaks, []);
  });

  it('B cannot see A either — isolation is symmetric, not a fixture artefact', async () => {
    const visible = await asTenant(ACCOUNT_B, async (client) => {
      const result = await client.query<{ id: string }>('SELECT id FROM conversations');
      return result.rows.map((r) => r.id);
    });
    assert.deepEqual(visible, [CONVERSATION_B]);
  });

  it("A cannot UPDATE B's conversation, even naming its primary key", async () => {
    const updated = await asTenant(ACCOUNT_A, async (client) => {
      const result = await client.query(
        "UPDATE conversations SET engagement = 'IDLE' WHERE id = $1",
        [CONVERSATION_B],
      );
      return result.rowCount ?? 0;
    });
    assert.equal(updated, 0, 'the row is invisible, so the update matches nothing');

    // And the row really is untouched — a silent no-op that still mutated would be worse.
    const after = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ engagement: string }>(
        'SELECT engagement FROM conversations WHERE id = $1',
        [CONVERSATION_B],
      );
      return result.rows[0]!.engagement;
    });
    assert.equal(after, 'AWAITING_MODERATOR');
  });

  it("A cannot DELETE B's rows", async () => {
    // The runtime role has no DELETE grant at all; the policy is the second line, not the first.
    await assert.rejects(
      () => asTenant(ACCOUNT_A, (client) => client.query('DELETE FROM conversations')),
      (error: unknown) => (error as { code?: string }).code === '42501',
    );
  });

  it('A cannot smuggle a row into B by writing a foreign account_id', async () => {
    await assert.rejects(
      () =>
        asTenant(ACCOUNT_A, (client) =>
          client.query(
            `INSERT INTO audit_events (id, account_id, action, subject_type, subject_id, actor_kind)
             VALUES ('aud_evil', $1, 'replay.executed', 'conversation', $2, 'SYSTEM')`,
            [ACCOUNT_B, CONVERSATION_B],
          ),
        ),
      (error: unknown) => (error as { code?: string }).code === '42501',
      'the WITH CHECK half of the policy must reject a cross-tenant insert',
    );
  });

  it('A cannot reference a B row through a composite foreign key', async () => {
    /*
     * Layer 2 of ADR-002, and the reason every table carries `UNIQUE (account_id, id)`.
     *
     * Even if a policy were removed tomorrow, `FOREIGN KEY (account_id, conversation_id)` means a
     * row claiming to belong to account A cannot point at a conversation belonging to B: the pair
     * does not exist. Structure, not vigilance.
     *
     * The check is made twice because migration 0006 deferred exactly one of these constraints,
     * and a guarantee that only holds on the immediate ones is a different guarantee.
     */

    // Immediate: the statement itself fails.
    await assert.rejects(
      () =>
        asTenant(ACCOUNT_A, (client) =>
          client.query(
            `INSERT INTO moderator_runs (id, account_id, conversation_id, state, trigger,
                input_watermark, observed_ownership_version, pack_version_id,
                prompt_template_version, trace_id)
             VALUES ('mrn_evil', $1, $2, 'PENDING', 'INBOUND_MESSAGE', 0, 0, 'apv_x', 'v1',
                     'trc_evil')`,
            [ACCOUNT_A, CONVERSATION_B],
          ),
        ),
      (error: unknown) => (error as { code?: string }).code === '23503',
      'foreign key violation, not a policy violation — the constraint catches it first',
    );

    /*
     * Deferred: `messages_account_id_conversation_id_fkey` is DEFERRABLE INITIALLY DEFERRED, so
     * the offending INSERT is accepted and the transaction is refused at COMMIT instead. Nothing
     * is written either way — what moves is only where the error surfaces. Asserting it here is
     * what stops "deferred" from quietly becoming "unenforced".
     */
    await runtime.query('BEGIN');
    let committed = false;
    try {
      await runtime.query('SELECT set_config($1,$2,true)', ['app.account_id', ACCOUNT_A]);
      await runtime.query(
        `INSERT INTO messages (id, account_id, conversation_id, seq, direction, author_kind,
            channel, dedupe_key, dedupe_source, content_type, provider_ts)
         VALUES ('msg_evil', $1, $2, 99, 'INBOUND', 'CUSTOMER', 'TEST', 'evil', 'DERIVED',
                 'TEXT', now())`,
        [ACCOUNT_A, CONVERSATION_B],
      );
      await assert.rejects(
        () => runtime.query('COMMIT'),
        (error: unknown) => (error as { code?: string }).code === '23503',
        'a deferred constraint still refuses the commit; it does not forgive it',
      );
      committed = true;
    } finally {
      // A failed COMMIT already ends the transaction; rolling back again would be an error.
      if (!committed) await runtime.query('ROLLBACK');
    }

    const orphan = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM messages WHERE id = 'msg_evil'",
      );
      return Number(result.rows[0]!.count);
    });
    assert.equal(orphan, 0, 'the deferred check must leave nothing behind');
  });

  it('a connection with no tenant context set sees nothing at all', async () => {
    // Fail closed. `app_current_account_id()` returns NULL when unset, and `account_id = NULL` is
    // NULL, so every policy evaluates false. A forgotten SET LOCAL loses data, never leaks it.
    await runtime.query('BEGIN');
    try {
      const result = await runtime.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM conversations',
      );
      assert.equal(Number(result.rows[0]!.count), 0);
    } finally {
      await runtime.query('ROLLBACK');
    }
  });

  it('the suite is not vacuous: dropping the policy makes the leak appear', async () => {
    // If this test ever fails, every assertion above is meaningless — they would pass with the
    // policies deleted. Guarding against that is the whole reason it exists.
    await withAdminClient(cluster.adminUrl, async (client) => {
      await client.query('DROP POLICY conversations_tenant_isolation ON conversations');
      await client.query('ALTER TABLE conversations DISABLE ROW LEVEL SECURITY');
    });
    try {
      const visible = await asTenant(ACCOUNT_A, async (client) => {
        const result = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM conversations',
        );
        return Number(result.rows[0]!.count);
      });
      assert.equal(visible, 2, "without RLS, account A sees B's conversation");
    } finally {
      await withAdminClient(cluster.adminUrl, async (client) => {
        await client.query('ALTER TABLE conversations ENABLE ROW LEVEL SECURITY');
        await client.query('ALTER TABLE conversations FORCE ROW LEVEL SECURITY');
        await client.query(
          `CREATE POLICY conversations_tenant_isolation ON conversations
             USING (account_id = app_current_account_id())`,
        );
      });
    }
  });

  it('every tenant table has RLS enabled and forced', async () => {
    const weak = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname = 'account_id' AND a.attnum > 0)`,
      );
      return result.rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity);
    });
    assert.deepEqual(
      weak.map((r) => r.relname),
      [],
      'a table with account_id but without FORCE RLS is a table the owner can read straight past',
    );
  });
});

/** Two complete tenants, seeded as superuser so the fixture itself is not what is under test. */
async function seedTwoTenants(cluster: PostgresTestCluster): Promise<void> {
  await withAdminClient(cluster.adminUrl, async (client) => {
    for (const [accountId, conversationId, suffix] of [
      [ACCOUNT_A, CONVERSATION_A, 'a'],
      [ACCOUNT_B, CONVERSATION_B, 'b'],
    ] as const) {
      await client.query(
        `INSERT INTO accounts (id, slug, name, status) VALUES ($1,$1,$1,'ACTIVE')`,
        [accountId],
      );
      await client.query(
        `INSERT INTO channel_connections (id, account_id, channel, supported_surfaces, external_id,
            public_webhook_id, credentials_ref, status)
         VALUES ($1,$2,'TEST',ARRAY['DIRECT_MESSAGE'],$3,$4,'secret://x','ACTIVE')`,
        [`chc_${suffix}`, accountId, `page_${suffix}`, `hook_${suffix}`],
      );
      await client.query(
        `INSERT INTO channel_identities (id, account_id, channel, external_id)
         VALUES ($1,$2,'TEST',$3)`,
        [`chi_${suffix}`, accountId, `psid_${suffix}`],
      );
      await client.query(
        `INSERT INTO conversations (id, account_id, channel_connection_id, channel_identity_id,
            surface, lifecycle, ownership, engagement)
         VALUES ($1,$2,$3,$4,'DIRECT_MESSAGE','OPEN','AI_OWNED','AWAITING_MODERATOR')`,
        [conversationId, accountId, `chc_${suffix}`, `chi_${suffix}`],
      );
      await client.query(
        `INSERT INTO messages (id, account_id, conversation_id, seq, direction, author_kind,
            channel, dedupe_key, dedupe_source, content_type, text, provider_ts)
         VALUES ($1,$2,$3,1,'INBOUND','CUSTOMER','TEST',$4,'DERIVED','TEXT',$5,now())`,
        [`msg_${suffix}`, accountId, conversationId, `dk_${suffix}`, `secret of ${suffix}`],
      );
      await client.query(
        `INSERT INTO audit_events (id, account_id, action, subject_type, subject_id, actor_kind)
         VALUES ($1,$2,'replay.executed','conversation',$3,'SYSTEM')`,
        [`aud_${suffix}`, accountId, conversationId],
      );
      await client.query(
        `INSERT INTO knowledge_entries (id, account_id, kind, title, body, locale, status)
         VALUES ($1,$2,'FAQ','t','b','en','DRAFT')`,
        [`kne_${suffix}`, accountId],
      );
    }
  });
}
