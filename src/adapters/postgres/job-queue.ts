import type { JobId, IdFactory } from '../../platform/ids.ts';
import { ID_PREFIX, asId } from '../../platform/ids.ts';
import { TerminalError } from '../../platform/errors.ts';
import type { Job, JobState, JobType } from '../../operations/jobs/job.ts';
import type {
  ClaimOptions,
  CoalesceOptions,
  CoalesceResult,
  EnqueueRequest,
  JobQueue,
} from '../../operations/jobs/queue.ts';
import type { PgClient, PostgresDatabase } from './client.ts';

/**
 * Advisory-lock namespace for partition exclusivity.
 *
 * The two-argument form partitions the advisory space, so a partition lock can never collide with
 * the migrator's lock. Both arguments are `int4`, which is why this is not the same shape of
 * number as the migrator's single-argument `bigint` key.
 *
 * `hashtext` collisions between two different partition keys are possible and harmless: the
 * effect is that two unrelated conversations occasionally serialise, which costs a little
 * throughput and breaks nothing.
 */
export const PARTITION_LOCK_NAMESPACE = 4_017_320;

/**
 * How many partitions one claim will lock-and-reject before giving up for this round.
 *
 * Each probe is a partition that looked idle in the candidate scan and turned out to be busy once
 * the lock was held — that only happens in a genuine race, so in the steady state a claim makes
 * exactly one probe. The bound exists so a pathological burst cannot turn one claim into an
 * unbounded scan of the queue; the worker simply tries again.
 */
const MAX_CLAIM_PROBES = 4;

/**
 * The durable queue on PostgreSQL (ADR-004, ADR-005).
 *
 * Two things about this file are load-bearing.
 *
 * **Time is a parameter, never `now()`.** Every predicate compares against a caller-supplied
 * timestamp. That is what lets the shared contract suite drive lease expiry and debounce ceilings
 * with a `TestClock` instead of with `setTimeout`, and it means the queue has no opinion about
 * whose clock is authoritative — the worker's is.
 *
 * **Partition exclusivity needs a lock, not just a predicate.** The claim query in 0003 checks
 * `NOT EXISTS (... state='RUNNING' ...)`. Under READ COMMITTED that check runs against a snapshot
 * taken before any concurrent claimer commits, so two workers can each pick a *different* READY
 * job in the *same* partition and both conclude the partition is free. `FOR UPDATE SKIP LOCKED`
 * does not help: it locks the rows being claimed, and those are different rows.
 *
 * This is textbook write skew, and it is invisible to a single-threaded in-memory adapter — the
 * exact class of bug Phase 1 exists to find. The fix is a transaction-scoped advisory lock keyed
 * on the partition, taken as part of the candidate predicate: a claimer that cannot take the
 * partition lock skips that candidate rather than blocking on it, which preserves the lock-free
 * scaling property the design wanted from SKIP LOCKED.
 *
 * The lock alone is still not sufficient, which is why `claim` is three statements rather than
 * one. A snapshot is fixed when its statement begins, so a rival that commits *after* our snapshot
 * and *before* our lock call is invisible to the predicate that just took the lock. The decisive
 * check has to happen in a later statement, under the lock, with a newer snapshot. See `claim`.
 */

interface JobRow {
  id: string;
  seq: string;
  account_id: string;
  type: string;
  partition_key: string;
  dedupe_key: string | null;
  payload: Record<string, string>;
  state: string;
  run_at: Date;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  first_enqueued_at: Date;
  last_error: { code: string; message: string } | null;
  trace_id: string;
}

const COLUMNS = `id, seq, account_id, type, partition_key, dedupe_key, payload, state, run_at,
  attempt, max_attempts, lease_owner, lease_expires_at, first_enqueued_at, last_error, trace_id`;

function hydrate(row: JobRow): Job {
  return {
    id: asId<JobId>(row.id),
    // bigint arrives as a string (see the int8 type parser); seq is a small monotonic counter in
    // practice, and Number is exact well past any queue depth this system will see.
    seq: Number(row.seq),
    accountId: asId(row.account_id),
    type: row.type as JobType,
    partitionKey: row.partition_key,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    state: row.state as JobState,
    runAt: row.run_at,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    firstEnqueuedAt: row.first_enqueued_at,
    lastError: row.last_error,
    traceId: asId(row.trace_id),
  };
}

const LEASE_EXPIRED_REQUEUED = {
  code: 'LEASE_EXPIRED',
  message: 'worker lease expired; job reclaimed',
};
const LEASE_EXPIRED_EXHAUSTED = {
  code: 'LEASE_EXPIRED',
  message: 'worker lease expired with no attempts left',
};
const LEASE_RELEASED = {
  code: 'LEASE_RELEASED',
  message: 'worker shut down before completing',
};

export function createPostgresJobQueue(deps: {
  /**
   * The tenant-scoped database used for `enqueue`.
   *
   * This is not a stylistic split. ADR-004's entire argument is that the job row commits in the
   * *same* transaction as the domain write, and that transaction lives on the runtime pool. An
   * enqueue issued on the worker pool would open its own connection and its own transaction, and
   * a crash between the two would lose exactly the event the design promises never to lose.
   */
  enqueueDb: PostgresDatabase;
  /** The worker-role database: `claim`, `fail` and `reap` are cross-tenant by contract. */
  workerDb: PostgresDatabase;
  ids: IdFactory;
}): JobQueue {
  const { enqueueDb, workerDb, ids } = deps;
  const db = workerDb;

  const insert = async (
    client: PgClient,
    request: EnqueueRequest,
    runAt: Date,
    firstEnqueuedAt: Date,
  ): Promise<Job | null> => {
    const id = ids.next<JobId>(ID_PREFIX.job);
    const result = await client.query<JobRow>(
      `INSERT INTO jobs (id, account_id, type, partition_key, dedupe_key, payload, state,
                         run_at, attempt, max_attempts, first_enqueued_at, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,'READY',$7,0,$8,$9,$10)
       ON CONFLICT (partition_key, dedupe_key) WHERE state = 'READY' AND dedupe_key IS NOT NULL
       DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        id,
        request.accountId,
        request.type,
        request.partitionKey,
        request.dedupeKey ?? null,
        JSON.stringify(request.payload),
        runAt,
        request.maxAttempts ?? 5,
        firstEnqueuedAt,
        request.traceId,
      ],
    );
    // `DO NOTHING` returns no row when the partial unique index rejected the insert. The database
    // is the arbiter of the coalescing rule, not a prior SELECT — two concurrent enqueues for one
    // burst race, and exactly one of them may win.
    const row = result.rows[0];
    return row ? hydrate(row) : null;
  };

  const findReadyDuplicate = async (
    client: PgClient,
    partitionKey: string,
    dedupeKey: string,
  ): Promise<Job | null> => {
    const result = await client.query<JobRow>(
      `SELECT ${COLUMNS} FROM jobs
        WHERE partition_key = $1 AND dedupe_key = $2 AND state = 'READY'
        FOR UPDATE`,
      [partitionKey, dedupeKey],
    );
    const row = result.rows[0];
    return row ? hydrate(row) : null;
  };

  /** After losing an insert race there must be a winner; not finding one is a real bug. */
  const requireWinner = async (
    client: PgClient,
    partitionKey: string,
    dedupeKey: string,
  ): Promise<Job> => {
    const winner = await findReadyDuplicate(client, partitionKey, dedupeKey);
    if (!winner) {
      throw new TerminalError('JOB_ENQUEUE_LOST', 'Coalesced insert lost and no winner found', {
        partitionKey,
      });
    }
    return winner;
  };

  return {
    async enqueue(request) {
      return await enqueueDb.scoped(
        request.accountId,
        async (client) => {
          const dedupeKey = request.dedupeKey;
          if (dedupeKey === undefined) {
            // No dedupe key means the partial unique index cannot fire, so the insert always wins.
            const inserted = await insert(client, request, request.runAt, request.runAt);
            if (!inserted) {
              throw new TerminalError(
                'JOB_ENQUEUE_LOST',
                'Un-deduplicated insert returned no row; the coalescing index fired unexpectedly',
                { partitionKey: request.partitionKey },
              );
            }
            return inserted;
          }
          const existing = await findReadyDuplicate(client, request.partitionKey, dedupeKey);
          if (existing) return existing;
          const inserted = await insert(client, request, request.runAt, request.runAt);
          if (inserted) return inserted;
          // Lost the insert race with a concurrent enqueue; the winner is the job this caller wanted.
          return await requireWinner(client, request.partitionKey, dedupeKey);
        },
        'jobs:enqueue',
      );
    },

    async enqueueCoalesced(
      request: EnqueueRequest,
      options: CoalesceOptions,
    ): Promise<CoalesceResult> {
      const dedupeKey = request.dedupeKey;
      if (!dedupeKey) {
        throw new TerminalError('COALESCE_WITHOUT_KEY', 'enqueueCoalesced requires a dedupeKey');
      }
      return await enqueueDb.scoped(
        request.accountId,
        async (client) => {
          // `FOR UPDATE` on the existing READY row serialises concurrent messages in one burst:
          // without it, two arrivals could both read the old run_at and both write, and the later
          // write could move the schedule *backwards*.
          const existing = await findReadyDuplicate(client, request.partitionKey, dedupeKey);
          const now = request.runAt.getTime();

          if (!existing) {
            const runAt = new Date(now + options.debounceMs);
            // `firstEnqueuedAt` anchors the anti-starvation ceiling to the start of the burst.
            const inserted = await insert(client, request, runAt, request.runAt);
            if (inserted) return { job: inserted, coalesced: false, ceilingApplied: false };
            // A concurrent message in the same burst inserted first. That is a coalesce, not a
            // failure — which is the whole point of doing this in the database.
            const winner = await requireWinner(client, request.partitionKey, dedupeKey);
            return { job: winner, coalesced: true, ceilingApplied: false };
          }

          const ceiling = existing.firstEnqueuedAt.getTime() + options.maxDelayMs;
          const desired = now + options.debounceMs;
          const ceilingApplied = desired > ceiling;
          // Only ever forward, never past the ceiling: a customer who keeps typing must still get
          // an answer (F-21).
          const runAt = new Date(Math.max(existing.runAt.getTime(), Math.min(desired, ceiling)));
          const updated = await client.query<JobRow>(
            `UPDATE jobs SET run_at = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
            [existing.id, runAt],
          );
          return {
            job: hydrate(updated.rows[0]!),
            coalesced: true,
            ceilingApplied,
          };
        },
        'jobs:enqueueCoalesced',
      );
    },

    async claim(options: ClaimOptions) {
      const { workerId, leaseMs, now, types } = options;
      const typeFilter = types && types.length > 0 ? types : null;
      return await db.unscoped(async (client) => {
        // Partitions this transaction locked and then found busy. Excluding them is what stops a
        // lost race from being reported to the worker as "the queue is empty".
        const skipped: string[] = [];

        for (let probe = 0; probe < MAX_CLAIM_PROBES; probe++) {
          // Step 1: pick a candidate and take its partition lock. `NOT EXISTS` runs against this
          // statement's snapshot, so it is a cheap filter here, not the guarantee.
          const candidate = await client.query<{ id: string; partition_key: string }>(
            `SELECT j.id, j.partition_key FROM jobs j
              WHERE j.state = 'READY'
                AND j.run_at <= $1::timestamptz
                AND ($2::text[] IS NULL OR j.type = ANY($2::text[]))
                AND j.partition_key <> ALL($3::text[])
                AND NOT EXISTS (
                  SELECT 1 FROM jobs r
                   WHERE r.partition_key = j.partition_key
                     AND r.state = 'RUNNING'
                     AND r.lease_expires_at > $1::timestamptz)
                -- try_ (not blocking) so a contended partition is skipped, not queued behind.
                AND pg_try_advisory_xact_lock($4, hashtext(j.partition_key))
              ORDER BY j.run_at, j.seq
              FOR UPDATE SKIP LOCKED
              LIMIT 1`,
            [now, typeFilter, skipped, PARTITION_LOCK_NAMESPACE],
          );
          const picked = candidate.rows[0];
          if (!picked) return null;

          /*
           * Step 2: re-check the partition under the lock, in a *new* statement.
           *
           * This is the step the single-statement version could not perform, and the reason the
           * claim is split at all. Under READ COMMITTED a statement's snapshot is fixed when the
           * statement begins, so a rival claimer that committed after our snapshot was taken but
           * before our `pg_try_advisory_xact_lock` call is invisible to step 1: the lock is free
           * by then (it is released at commit) and the rival's RUNNING row is not yet in view.
           * Both claimers would take different READY jobs in the same partition and both conclude
           * it was idle — the same write skew the advisory lock was added to close, merely
           * narrowed to microseconds.
           *
           * Holding the lock makes a second statement decisive. Any rival that claimed in this
           * partition must have held this same lock, so by the time we hold it that transaction
           * has ended; if it committed, a fresh snapshot sees its row.
           */
          const busy = await client.query(
            `SELECT 1 FROM jobs
              WHERE partition_key = $1 AND state = 'RUNNING' AND lease_expires_at > $2::timestamptz
              LIMIT 1`,
            [picked.partition_key, now],
          );
          if (busy.rows.length > 0) {
            skipped.push(picked.partition_key);
            continue;
          }

          // Step 3: take it. The row is already locked by step 1's FOR UPDATE, so no rival can
          // move it out from under this update.
          const result = await client.query<JobRow>(
            `UPDATE jobs SET
               state = 'RUNNING',
               lease_owner = $2,
               lease_expires_at = $3::timestamptz + ($4 || ' milliseconds')::interval,
               attempt = attempt + 1
             WHERE id = $1 AND state = 'READY'
             RETURNING ${COLUMNS}`,
            [picked.id, workerId, now, String(leaseMs)],
          );
          const row = result.rows[0];
          if (row) return hydrate(row);
          skipped.push(picked.partition_key);
        }
        return null;
      }, 'jobs:claim');
    },

    async complete(jobId) {
      await db.unscoped(async (client) => {
        // The state predicate is the guard: a job whose lease expired and was reclaimed must not
        // be marked SUCCEEDED by the worker that lost it. Silently doing nothing is correct here —
        // the reclaiming worker owns the outcome now.
        await client.query(
          `UPDATE jobs SET state = 'SUCCEEDED', lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $1 AND state = 'RUNNING'`,
          [jobId],
        );
      }, 'jobs:complete');
    },

    async fail(jobId, error, retryAt) {
      await db.unscoped(async (client) => {
        if (retryAt === null) {
          await client.query(
            `UPDATE jobs SET state = 'DEAD_LETTERED', last_error = $2,
                             lease_owner = NULL, lease_expires_at = NULL
              WHERE id = $1 AND state IN ('RUNNING','FAILED')`,
            [jobId, JSON.stringify(error)],
          );
          return;
        }
        await client.query(
          `UPDATE jobs SET state = 'READY', run_at = $3, last_error = $2,
                           lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $1 AND state IN ('RUNNING','FAILED')`,
          [jobId, JSON.stringify(error), retryAt],
        );
      }, 'jobs:fail');
    },

    async releaseLease(jobId, now) {
      return await db.unscoped(async (client) => {
        // `state = 'RUNNING'` is the whole guard. A worker whose lease already lapsed no longer
        // owns the job — the reaper may have requeued it and a second worker may be running it —
        // so releasing it would hand READY to a partition that is genuinely busy.
        const result = await client.query(
          `UPDATE jobs SET state = 'READY', run_at = $2::timestamptz, last_error = $3::jsonb,
                           lease_owner = NULL, lease_expires_at = NULL
            WHERE id = $1 AND state = 'RUNNING'`,
          [jobId, now, JSON.stringify(LEASE_RELEASED)],
        );
        return (result.rowCount ?? 0) > 0;
      }, 'jobs:releaseLease');
    },

    async reapExpiredLeases(now) {
      return await db.unscoped(async (client) => {
        // One statement, two outcomes, chosen per row. Doing this as two statements would leave a
        // window in which a job counted as neither requeued nor dead-lettered — and a concurrent
        // reaper could act on it in between.
        //
        // `FOR UPDATE SKIP LOCKED` in the CTE is what makes concurrent reapers safe: the second
        // reaper skips rows the first has already taken instead of double-recovering them.
        const result = await client.query<{ id: string; state: string }>(
          `WITH expired AS (
             SELECT id, attempt, max_attempts FROM jobs
              WHERE state = 'RUNNING' AND lease_expires_at <= $1::timestamptz
              FOR UPDATE SKIP LOCKED)
           UPDATE jobs j SET
             state = CASE WHEN e.attempt >= e.max_attempts THEN 'DEAD_LETTERED' ELSE 'READY' END,
             run_at = CASE WHEN e.attempt >= e.max_attempts THEN j.run_at ELSE $1::timestamptz END,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = CASE WHEN e.attempt >= e.max_attempts THEN $2::jsonb ELSE $3::jsonb END
           FROM expired e
           WHERE j.id = e.id
           RETURNING j.id, j.state`,
          [now, JSON.stringify(LEASE_EXPIRED_EXHAUSTED), JSON.stringify(LEASE_EXPIRED_REQUEUED)],
        );
        return result.rows.map((row) => asId<JobId>(row.id));
      }, 'jobs:reapExpiredLeases');
    },

    async findById(jobId) {
      return await db.unscoped(async (client) => {
        const result = await client.query<JobRow>(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [
          jobId,
        ]);
        const row = result.rows[0];
        return row ? hydrate(row) : null;
      }, 'jobs:findById');
    },

    async countByState() {
      return await db.unscoped(async (client) => {
        const result = await client.query<{ state: string; count: string }>(
          'SELECT state, count(*)::text AS count FROM jobs GROUP BY state',
        );
        const counts: Record<string, number> = {};
        for (const row of result.rows) counts[row.state] = Number(row.count);
        return counts;
      }, 'jobs:countByState');
    },
  };
}
