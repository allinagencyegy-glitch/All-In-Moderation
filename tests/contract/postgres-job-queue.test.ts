import { after } from 'node:test';
import { createTestClock } from '../../src/platform/clock.ts';
import { createDeterministicIdFactory } from '../../src/platform/ids.ts';
import { createPostgresJobQueue } from '../../src/adapters/postgres/job-queue.ts';
import type { PostgresTestCluster, PostgresTestDatabases } from '../support/postgres.ts';
import {
  acquirePostgres,
  createTestDatabases,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';
import { CONTRACT_ACCOUNT_ID, runJobQueueContract } from './job-queue-contract.ts';

/**
 * The Postgres adapter, run against the *same* contract as the in-memory one.
 *
 * Phase 0 predicted this file would be "about this size and the suite is not touched". The suite
 * needed exactly one change — an async factory — because a real database cannot be rebuilt
 * synchronously. Every behavioural assertion is unchanged, which is what makes a pass here
 * meaningful: partition exclusivity, lease expiry and coalescing mean the same thing in both
 * implementations, or this goes red.
 */

let cluster: PostgresTestCluster | null = null;
let dbs: PostgresTestDatabases | null = null;

const available = postgresAvailable();

if (available) {
  runJobQueueContract('postgres', async () => {
    cluster ??= await acquirePostgres();
    dbs ??= createTestDatabases(cluster, { maxConnections: 6 });
    await truncateAll(cluster.adminUrl);
    // `jobs.account_id` has a real foreign key, so the contract's account must exist. This is a
    // fixture requirement of the adapter, not a change to what the contract asserts.
    await withAdminClient(cluster.adminUrl, async (client) => {
      await client.query(
        `INSERT INTO accounts (id, slug, name, status) VALUES ($1, $1, 'Contract', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [CONTRACT_ACCOUNT_ID],
      );
    });

    const ids = createDeterministicIdFactory();
    return {
      queue: createPostgresJobQueue({ enqueueDb: dbs.worker, workerDb: dbs.worker, ids }),
      clock: createTestClock(),
      reset: () => undefined,
    };
  });

  after(async () => {
    await dbs?.close();
    if (cluster) await releasePostgres();
  });
}
