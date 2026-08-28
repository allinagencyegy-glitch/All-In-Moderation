import type { JobId } from '../../platform/ids.ts';
import { asId } from '../../platform/ids.ts';
import { TerminalError } from '../../platform/errors.ts';
import type { Job } from '../../operations/jobs/job.ts';
import { assertJobTransition, isLeaseLive } from '../../operations/jobs/job.ts';
import type {
  ClaimOptions,
  CoalesceOptions,
  CoalesceResult,
  EnqueueRequest,
  JobQueue,
} from '../../operations/jobs/queue.ts';
import type { MemoryDatabase } from './database.ts';
import { values } from './database.ts';

/**
 * In-memory implementation of the durable queue contract (ADR-004).
 *
 * It mirrors the Postgres claim query exactly, including the parts that are easy to get subtly
 * wrong:
 *
 *   - **Partition exclusivity** — a job is only claimable if no *live-leased* job shares its
 *     partition key. This is the `NOT EXISTS (... state='RUNNING' AND lease_expires_at > now())`
 *     clause, and it is what serialises a conversation without holding a lock across a model call.
 *   - **Expired leases do not block.** A dead worker must not freeze a conversation forever; the
 *     partition frees itself the moment the lease lapses, and idempotent handlers make the
 *     resulting redelivery safe.
 *   - **Coalescing applies to READY jobs only.** A RUNNING job has already captured its input
 *     watermark, so a message arriving mid-run must be able to schedule a *new* job behind it —
 *     otherwise the follow-up would be silently dropped.
 *   - **Ordering is `(runAt, seq)`**, so claim order is deterministic and testable.
 */
export function createMemoryJobQueue(db: MemoryDatabase): JobQueue {
  const { tables } = db;

  const nextSeq = (): number => {
    tables.jobSeq += 1;
    return tables.jobSeq;
  };

  const findReadyDuplicate = (partitionKey: string, dedupeKey: string): Job | undefined =>
    values(tables.jobs).find(
      (job) =>
        job.state === 'READY' && job.partitionKey === partitionKey && job.dedupeKey === dedupeKey,
    );

  const insert = (request: EnqueueRequest, seq: number): Job => {
    const job: Job = {
      id: asId<JobId>(`job_${String(seq).padStart(6, '0')}`),
      accountId: request.accountId,
      type: request.type,
      partitionKey: request.partitionKey,
      dedupeKey: request.dedupeKey ?? null,
      payload: request.payload,
      state: 'READY',
      runAt: request.runAt,
      attempt: 0,
      maxAttempts: request.maxAttempts ?? 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      firstEnqueuedAt: request.runAt,
      lastError: null,
      traceId: request.traceId,
      seq,
    };
    tables.jobs.set(job.id, job);
    return job;
  };

  return {
    enqueue(request) {
      if (request.dedupeKey) {
        const existing = findReadyDuplicate(request.partitionKey, request.dedupeKey);
        // Mirrors the partial unique index: a plain enqueue must not create a second READY job
        // for the same (partition, dedupe) pair.
        if (existing) return Promise.resolve(existing);
      }
      return Promise.resolve(insert(request, nextSeq()));
    },

    enqueueCoalesced(request: EnqueueRequest, options: CoalesceOptions): Promise<CoalesceResult> {
      const dedupeKey = request.dedupeKey;
      if (!dedupeKey) {
        throw new TerminalError('COALESCE_WITHOUT_KEY', 'enqueueCoalesced requires a dedupeKey');
      }
      const existing = findReadyDuplicate(request.partitionKey, dedupeKey);
      const now = request.runAt.getTime();

      if (!existing) {
        const job = insert({ ...request, runAt: new Date(now + options.debounceMs) }, nextSeq());
        // `firstEnqueuedAt` anchors the anti-starvation ceiling to the moment the burst started,
        // not to the moment of the latest message.
        const anchored: Job = { ...job, firstEnqueuedAt: request.runAt };
        tables.jobs.set(anchored.id, anchored);
        return Promise.resolve({ job: anchored, coalesced: false, ceilingApplied: false });
      }

      const ceiling = existing.firstEnqueuedAt.getTime() + options.maxDelayMs;
      const desired = now + options.debounceMs;
      const target = Math.min(desired, ceiling);
      const ceilingApplied = desired > ceiling;
      // Only ever move forward, and never past the ceiling: a continuously typing customer must
      // still get an answer (F-21).
      const runAt = new Date(Math.max(existing.runAt.getTime(), Math.min(target, ceiling)));
      const updated: Job = { ...existing, runAt };
      tables.jobs.set(updated.id, updated);
      return Promise.resolve({ job: updated, coalesced: true, ceilingApplied });
    },

    claim(options: ClaimOptions) {
      const { now, workerId, leaseMs, types } = options;
      const busyPartitions = new Set(
        values(tables.jobs)
          .filter((job) => isLeaseLive(job, now))
          .map((job) => job.partitionKey),
      );

      const candidate = values(tables.jobs)
        .filter((job) => job.state === 'READY')
        .filter((job) => job.runAt.getTime() <= now.getTime())
        .filter((job) => (types ? types.includes(job.type) : true))
        .filter((job) => !busyPartitions.has(job.partitionKey))
        .sort((a, b) => {
          const byRunAt = a.runAt.getTime() - b.runAt.getTime();
          return byRunAt !== 0 ? byRunAt : a.seq - b.seq;
        })[0];

      if (!candidate) return Promise.resolve(null);

      assertJobTransition(candidate.state, 'RUNNING');
      const claimed: Job = {
        ...candidate,
        state: 'RUNNING',
        attempt: candidate.attempt + 1,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      };
      tables.jobs.set(claimed.id, claimed);
      return Promise.resolve(claimed);
    },

    complete(jobId) {
      const job = tables.jobs.get(jobId);
      if (!job) return Promise.resolve();
      assertJobTransition(job.state, 'SUCCEEDED');
      tables.jobs.set(jobId, {
        ...job,
        state: 'SUCCEEDED',
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return Promise.resolve();
    },

    fail(jobId, error, retryAt) {
      const job = tables.jobs.get(jobId);
      if (!job) return Promise.resolve();
      if (retryAt === null) {
        assertJobTransition(job.state, 'DEAD_LETTERED');
        tables.jobs.set(jobId, {
          ...job,
          state: 'DEAD_LETTERED',
          lastError: error,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        return Promise.resolve();
      }
      assertJobTransition(job.state, 'READY');
      tables.jobs.set(jobId, {
        ...job,
        state: 'READY',
        runAt: retryAt,
        lastError: error,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      return Promise.resolve();
    },

    releaseLease(jobId, now) {
      const job = tables.jobs.get(jobId);
      // Not RUNNING means the lease already lapsed and the reaper (or another worker) owns the
      // outcome. Writing READY here would resurrect a job someone else is holding.
      if (!job || job.state !== 'RUNNING') return Promise.resolve(false);
      assertJobTransition(job.state, 'READY');
      tables.jobs.set(jobId, {
        ...job,
        state: 'READY',
        runAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: { code: 'LEASE_RELEASED', message: 'worker shut down before completing' },
      });
      return Promise.resolve(true);
    },

    reapExpiredLeases(now) {
      const reclaimed: JobId[] = [];
      for (const job of values(tables.jobs)) {
        if (job.state !== 'RUNNING') continue;
        if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > now.getTime()) continue;
        // The attempt count is preserved, so a crash loop still exhausts its retries and
        // dead-letters rather than spinning forever (F-20).
        if (job.attempt >= job.maxAttempts) {
          tables.jobs.set(job.id, {
            ...job,
            state: 'DEAD_LETTERED',
            lastError: {
              code: 'LEASE_EXPIRED',
              message: 'worker lease expired with no attempts left',
            },
            leaseOwner: null,
            leaseExpiresAt: null,
          });
        } else {
          tables.jobs.set(job.id, {
            ...job,
            state: 'READY',
            runAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: { code: 'LEASE_EXPIRED', message: 'worker lease expired; job reclaimed' },
          });
        }
        reclaimed.push(job.id);
      }
      return Promise.resolve(reclaimed);
    },

    findById(jobId) {
      return Promise.resolve(tables.jobs.get(jobId) ?? null);
    },

    countByState() {
      const counts: Record<string, number> = {};
      for (const job of values(tables.jobs)) {
        counts[job.state] = (counts[job.state] ?? 0) + 1;
      }
      return Promise.resolve(counts);
    },
  };
}
