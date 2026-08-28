import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { asId, createDeterministicIdFactory } from '../../src/platform/ids.ts';
import type { AccountId, TraceId } from '../../src/platform/ids.ts';
import { createPostgresJobQueue } from '../../src/adapters/postgres/job-queue.ts';
import type { JobQueue } from '../../src/operations/jobs/queue.ts';
import type { PostgresTestCluster, PostgresTestDatabases } from '../support/postgres.ts';
import {
  acquirePostgres,
  createTestDatabases,
  postgresAvailable,
  releasePostgres,
  truncateAll,
  withAdminClient,
} from '../support/postgres.ts';

/**
 * Step 19: performance sanity. Not a benchmark — a smoke alarm.
 *
 * The question is not "how fast is it" but "is anything catastrophically wrong": a sequential scan
 * on the claim path, a missing index on the reaper's sweep, lock contention that grows with queue
 * depth. Those are design mistakes, and they are cheap to find now and expensive to find later.
 *
 * Absolute timings are reported rather than asserted. This machine is not production, and a test
 * that fails because a laptop was busy teaches nobody anything. The assertions are on *shape* —
 * plans and scan types — plus one deliberately loose ceiling to catch an order-of-magnitude
 * regression.
 */

const ACCOUNTS = 10;
const PARTITIONS_PER_ACCOUNT = 60;
const JOBS = ACCOUNTS * PARTITIONS_PER_ACCOUNT;
const TRACE = asId<TraceId>('trc_perf');

const available = postgresAvailable();

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

describe('postgres performance sanity', { skip: available ? false : 'no PostgreSQL' }, () => {
  let cluster: PostgresTestCluster;
  let dbs: PostgresTestDatabases;
  let queue: JobQueue;
  const findings: string[] = [];

  before(async () => {
    cluster = await acquirePostgres();
    await truncateAll(cluster.adminUrl);
    dbs = createTestDatabases(cluster, { maxConnections: 8, statementTimeoutMs: 60_000 });
    queue = createPostgresJobQueue({
      enqueueDb: dbs.worker,
      workerDb: dbs.worker,
      ids: createDeterministicIdFactory(),
    });

    await withAdminClient(cluster.adminUrl, async (client) => {
      for (let a = 0; a < ACCOUNTS; a++) {
        await client.query(
          `INSERT INTO accounts (id, slug, name, status) VALUES ($1,$1,'Perf','ACTIVE')`,
          [`acc_perf_${String(a)}`],
        );
      }
    });

    const started = Date.now();
    for (let a = 0; a < ACCOUNTS; a++) {
      for (let p = 0; p < PARTITIONS_PER_ACCOUNT; p++) {
        await queue.enqueue({
          accountId: asId<AccountId>(`acc_perf_${String(a)}`),
          type: 'moderator.run',
          partitionKey: `acct:acc_perf_${String(a)}:conv:cnv_${String(p)}`,
          payload: { conversationId: `cnv_${String(p)}` },
          runAt: new Date(),
          traceId: TRACE,
        });
      }
    }
    findings.push(
      `enqueued ${String(JOBS)} jobs across ${String(ACCOUNTS)} accounts in ${String(Date.now() - started)}ms`,
    );

    // The planner needs statistics before its choices mean anything.
    await withAdminClient(cluster.adminUrl, async (client) => {
      await client.query('ANALYZE jobs, conversations, messages, knowledge_entries');
    });
  });

  after(async () => {
    // Reported rather than asserted: these are the numbers the handoff document quotes.
    console.log(
      `\n  performance sanity findings:\n${findings.map((f) => `    - ${f}`).join('\n')}`,
    );
    await dbs.close();
    await releasePostgres();
  });

  const explain = async (sql: string, params: unknown[]): Promise<PlanNode[]> =>
    await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
        `EXPLAIN (FORMAT JSON) ${sql}`,
        params,
      );
      return flattenPlan(result.rows[0]!['QUERY PLAN'][0].Plan);
    });

  it('the claim path uses an index, not a sequential scan over the queue', async () => {
    // The single most important plan in the system. A sequential scan here means claim latency
    // grows with the size of the *whole* queue, so one busy account slows every other one down.
    // Deliberately the candidate scan the adapter actually issues, including the
    // already-probed-partition filter. Explaining a simplified stand-in would prove that a query
    // nobody runs is fast.
    const nodes = await explain(
      `SELECT j.id, j.partition_key FROM jobs j
        WHERE j.state = 'READY' AND j.run_at <= now()
          AND j.partition_key <> ALL($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM jobs r
             WHERE r.partition_key = j.partition_key
               AND r.state = 'RUNNING' AND r.lease_expires_at > now())
        ORDER BY j.run_at, j.seq
        LIMIT 1`,
      [[]],
    );
    const scans = nodes.filter((n) => n['Relation Name'] === 'jobs').map((n) => n['Node Type']);
    findings.push(`claim plan node types over jobs: ${scans.join(', ')}`);
    assert.ok(scans.length > 0, 'the plan touches the jobs table');
    assert.ok(
      !scans.includes('Seq Scan'),
      `the claim path fell back to a sequential scan: ${scans.join(', ')}`,
    );
    assert.ok(
      nodes.some((n) => n['Index Name'] === 'jobs_ready_idx'),
      'the partial index on READY jobs is the one that should be chosen',
    );
  });

  it('the reaper sweep uses its lease-expiry index', async () => {
    const nodes = await explain(
      `SELECT id FROM jobs WHERE state = 'RUNNING' AND lease_expires_at <= now()`,
      [],
    );
    const indexes = nodes.map((n) => n['Index Name']).filter(Boolean);
    findings.push(`reaper plan indexes: ${indexes.join(', ') || 'none'}`);
    assert.ok(
      !nodes.some((n) => n['Relation Name'] === 'jobs' && n['Node Type'] === 'Seq Scan'),
      'the reaper runs on a timer against the whole queue; it must not scan it',
    );
  });

  it('the conversation lookup on every inbound message uses its index', async () => {
    const nodes = await explain(
      `SELECT id FROM conversations
        WHERE account_id = $1 AND channel_connection_id = $2 AND channel_identity_id = $3
          AND surface = $4 AND thread_ref IS NOT DISTINCT FROM $5`,
      ['acc_perf_0', 'chc_x', 'chi_x', 'DIRECT_MESSAGE', null],
    );
    findings.push(`conversation lookup nodes: ${nodes.map((n) => n['Node Type']).join(', ')}`);
    // An empty table legitimately plans a sequential scan, so this asserts the index *exists* and
    // is usable rather than that the planner picked it on no rows.
    const indexes = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'conversations'",
      );
      return result.rows.map((r) => r.indexname);
    });
    assert.ok(indexes.includes('conversations_lookup_idx'));
  });

  it('claim latency does not grow catastrophically with queue depth', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = process.hrtime.bigint();
      const job = await queue.claim({ workerId: 'perf', leaseMs: 60_000, now: new Date() });
      samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
      assert.ok(job, 'there is still work to claim');
      await queue.complete(job.id, new Date());
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    findings.push(
      `claim latency over ${String(JOBS)} queued jobs: p50 ${p50.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms`,
    );
    // Deliberately loose. This catches "we forgot an index" (hundreds of ms), not jitter.
    assert.ok(p95 < 250, `claim p95 was ${p95.toFixed(1)}ms, which suggests a missing index`);
  });

  it('every index the hot paths depend on actually exists', async () => {
    const expected = [
      ['jobs', 'jobs_ready_idx'],
      ['jobs', 'jobs_running_partition_idx'],
      ['jobs', 'jobs_lease_expiry_idx'],
      ['jobs', 'jobs_coalesce_idx'],
      ['jobs', 'jobs_account_state_idx'],
      ['conversations', 'conversations_lookup_idx'],
      ['messages', 'messages_conversation_seq_idx'],
      ['raw_inbound_events', 'raw_inbound_events_pending_idx'],
      ['outbound_actions', 'outbound_actions_dispatch_idx'],
      ['knowledge_entries', 'knowledge_retrieval_idx'],
      ['domain_event_outbox', 'domain_event_outbox_relay_idx'],
      ['dead_letters', 'dead_letters_open_idx'],
    ] as const;

    const present = await withAdminClient(cluster.adminUrl, async (client) => {
      const result = await client.query<{ tablename: string; indexname: string }>(
        'SELECT tablename, indexname FROM pg_indexes WHERE schemaname = $1',
        ['public'],
      );
      return new Set(result.rows.map((r) => `${r.tablename}.${r.indexname}`));
    });

    const missing = expected
      .map(([table, index]) => `${table}.${index}`)
      .filter((key) => !present.has(key));
    assert.deepEqual(missing, [], 'an index named in the DDL is not in the database');
  });

  it('many accounts sharing one queue do not serialise against each other', async () => {
    // Partition keys are tenant-prefixed, so a busy account's partitions can never collide with
    // another's. The check is that claims across accounts genuinely proceed in parallel.
    const workers = [0, 1, 2, 3].map(() =>
      createPostgresJobQueue({
        enqueueDb: dbs.worker,
        workerDb: dbs.worker,
        ids: createDeterministicIdFactory(),
      }),
    );
    const started = Date.now();
    const claims = await Promise.all(
      workers.map((w, i) =>
        w.claim({ workerId: `perf-${String(i)}`, leaseMs: 30_000, now: new Date() }),
      ),
    );
    const elapsed = Date.now() - started;
    const won = claims.filter((c) => c !== null);
    findings.push(
      `4 concurrent claims across accounts: ${String(won.length)} won in ${String(elapsed)}ms`,
    );
    assert.equal(won.length, 4, 'four different partitions, four claims');
    assert.equal(new Set(won.map((j) => j.partitionKey)).size, 4);
    for (const job of won) await queue.complete(job.id, new Date());
  });

  it('the queue reports its own depth cheaply, so "what is stuck?" is a query', async () => {
    const started = Date.now();
    const counts = await queue.countByState();
    const elapsed = Date.now() - started;
    findings.push(
      `countByState over ${String(JOBS)} rows: ${String(elapsed)}ms, ${JSON.stringify(counts)}`,
    );
    assert.ok((counts['READY'] ?? 0) > 0);
    assert.ok(elapsed < 1_000, 'operator visibility must not itself be an expensive query');
  });
});
