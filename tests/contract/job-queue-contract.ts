import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { TestClock } from '../../src/platform/clock.ts';
import { asId } from '../../src/platform/ids.ts';
import type { AccountId, TraceId } from '../../src/platform/ids.ts';
import type { JobQueue } from '../../src/operations/jobs/queue.ts';

/**
 * The `JobQueue` behavioural contract.
 *
 * This suite is deliberately adapter-agnostic. It is the acceptance criterion for the Phase 1
 * Postgres adapter: when that lands, it must be pointed at this exact suite and pass unchanged.
 * Writing the concurrency guarantees down as tests rather than prose is the only way to know that
 * two implementations really agree — and these guarantees (partition exclusivity, lease expiry,
 * coalescing) are precisely the ones that are easy to implement *almost* correctly.
 */

export interface QueueContractHarness {
  readonly queue: JobQueue;
  readonly clock: TestClock;
  reset(): void;
}

/**
 * The factory may be async.
 *
 * The in-memory adapter can build a fresh world synchronously; a real database cannot — it has to
 * connect, truncate and re-seed. Allowing a Promise here is the smallest change that lets *one*
 * suite describe both, which is the entire point of a contract test.
 */
export type QueueContractFactory = () => QueueContractHarness | Promise<QueueContractHarness>;

export const CONTRACT_ACCOUNT_ID = 'acc_contract';

const ACCOUNT = asId<AccountId>(CONTRACT_ACCOUNT_ID);
const TRACE = asId<TraceId>('trc_contract');

export function runJobQueueContract(name: string, create: QueueContractFactory): void {
  describe(`JobQueue contract: ${name}`, () => {
    let h: QueueContractHarness;

    beforeEach(async () => {
      h = await create();
    });

    const enqueue = (
      partitionKey: string,
      overrides: Partial<Parameters<JobQueue['enqueue']>[0]> = {},
    ) =>
      h.queue.enqueue({
        accountId: ACCOUNT,
        type: 'moderator.run',
        partitionKey,
        payload: {},
        runAt: h.clock.now(),
        traceId: TRACE,
        ...overrides,
      });

    it('1. at most one RUNNING job per partition key', async () => {
      await enqueue('p1');
      await enqueue('p1');

      const first = await h.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: h.clock.now() });
      const second = await h.queue.claim({ workerId: 'w2', leaseMs: 1_000, now: h.clock.now() });

      assert.ok(first);
      assert.equal(second, null);

      await h.queue.complete(first.id, h.clock.now());
      const third = await h.queue.claim({ workerId: 'w2', leaseMs: 1_000, now: h.clock.now() });
      assert.ok(third, 'the partition frees up once the first job finishes');
    });

    it('2. different partitions run concurrently', async () => {
      await enqueue('p1');
      await enqueue('p2');

      const first = await h.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: h.clock.now() });
      const second = await h.queue.claim({ workerId: 'w2', leaseMs: 1_000, now: h.clock.now() });

      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.partitionKey, second.partitionKey);
    });

    it('3. a job is invisible until run_at has elapsed', async () => {
      await enqueue('p1', { runAt: new Date(h.clock.nowMs() + 5_000) });
      assert.equal(
        await h.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: h.clock.now() }),
        null,
      );

      h.clock.advanceMs(5_000);
      assert.ok(await h.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: h.clock.now() }));
    });

    it('4. claim order is (run_at, seq)', async () => {
      await enqueue('p1', { runAt: new Date(h.clock.nowMs() + 1_000) });
      await enqueue('p2', { runAt: new Date(h.clock.nowMs()) });
      await enqueue('p3', { runAt: new Date(h.clock.nowMs()) });

      h.clock.advanceMs(2_000);
      const order: string[] = [];
      for (let i = 0; i < 3; i++) {
        const job = await h.queue.claim({ workerId: `w${i}`, leaseMs: 60_000, now: h.clock.now() });
        if (job) order.push(job.partitionKey);
      }
      assert.deepEqual(order, ['p2', 'p3', 'p1']);
    });

    it('5. enqueueCoalesced never creates a second READY job for one (partition, dedupe)', async () => {
      const first = await h.queue.enqueueCoalesced(
        {
          accountId: ACCOUNT,
          type: 'moderator.run',
          partitionKey: 'p1',
          dedupeKey: 'k1',
          payload: {},
          runAt: h.clock.now(),
          traceId: TRACE,
        },
        { debounceMs: 1_000, maxDelayMs: 5_000 },
      );
      assert.equal(first.coalesced, false);

      h.clock.advanceMs(500);
      const second = await h.queue.enqueueCoalesced(
        {
          accountId: ACCOUNT,
          type: 'moderator.run',
          partitionKey: 'p1',
          dedupeKey: 'k1',
          payload: {},
          runAt: h.clock.now(),
          traceId: TRACE,
        },
        { debounceMs: 1_000, maxDelayMs: 5_000 },
      );
      assert.equal(second.coalesced, true);
      assert.equal(second.job.id, first.job.id);
      assert.equal(second.job.runAt.getTime(), h.clock.nowMs() + 1_000, 'run_at moved forward');
    });

    it('6. coalescing never pushes run_at past first_enqueued_at + maxDelayMs', async () => {
      const start = h.clock.nowMs();
      let last = await h.queue.enqueueCoalesced(
        {
          accountId: ACCOUNT,
          type: 'moderator.run',
          partitionKey: 'p1',
          dedupeKey: 'k1',
          payload: {},
          runAt: h.clock.now(),
          traceId: TRACE,
        },
        { debounceMs: 2_000, maxDelayMs: 3_000 },
      );

      for (let i = 0; i < 5; i++) {
        h.clock.advanceMs(1_000);
        last = await h.queue.enqueueCoalesced(
          {
            accountId: ACCOUNT,
            type: 'moderator.run',
            partitionKey: 'p1',
            dedupeKey: 'k1',
            payload: {},
            runAt: h.clock.now(),
            traceId: TRACE,
          },
          { debounceMs: 2_000, maxDelayMs: 3_000 },
        );
      }

      assert.ok(last.job.runAt.getTime() <= start + 3_000, 'the anti-starvation ceiling holds');
      assert.ok(last.ceilingApplied);
    });

    it('7. a RUNNING job does not block a new READY job being coalesced behind it', async () => {
      await h.queue.enqueueCoalesced(
        {
          accountId: ACCOUNT,
          type: 'moderator.run',
          partitionKey: 'p1',
          dedupeKey: 'k1',
          payload: {},
          runAt: h.clock.now(),
          traceId: TRACE,
        },
        { debounceMs: 0, maxDelayMs: 0 },
      );
      const running = await h.queue.claim({ workerId: 'w1', leaseMs: 60_000, now: h.clock.now() });
      assert.ok(running);

      // A message arriving mid-run must be able to schedule the *next* run. If the coalescing
      // index covered RUNNING as well as READY, this follow-up would be silently dropped.
      const queued = await h.queue.enqueueCoalesced(
        {
          accountId: ACCOUNT,
          type: 'moderator.run',
          partitionKey: 'p1',
          dedupeKey: 'k1',
          payload: {},
          runAt: h.clock.now(),
          traceId: TRACE,
        },
        { debounceMs: 0, maxDelayMs: 0 },
      );
      assert.equal(queued.coalesced, false);
      assert.notEqual(queued.job.id, running.id);
      assert.equal(queued.job.state, 'READY');
    });

    it('8. an expired lease returns the job to READY, preserving the attempt count', async () => {
      await enqueue('p1');
      const claimed = await h.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: h.clock.now() });
      assert.ok(claimed);
      assert.equal(claimed.attempt, 1);

      h.clock.advanceMs(1_500);
      const reclaimed = await h.queue.reapExpiredLeases(h.clock.now());
      assert.deepEqual(reclaimed, [claimed.id]);

      const after = await h.queue.findById(claimed.id);
      assert.equal(after!.state, 'READY');
      assert.equal(after!.attempt, 1);
      assert.equal(after!.leaseOwner, null);
    });

    it('9. an expired lease does not block its partition', async () => {
      await enqueue('p1');
      await enqueue('p1');
      const claimed = await h.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: h.clock.now() });
      assert.ok(claimed);

      h.clock.advanceMs(1_500);
      const other = await h.queue.claim({ workerId: 'w2', leaseMs: 1_000, now: h.clock.now() });
      assert.ok(other, 'a dead worker must not freeze a conversation forever');
    });

    it('10. a job with no attempts left dead-letters instead of looping', async () => {
      await enqueue('p1', { maxAttempts: 1 });
      const claimed = await h.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: h.clock.now() });
      assert.ok(claimed);

      h.clock.advanceMs(1_500);
      await h.queue.reapExpiredLeases(h.clock.now());

      const after = await h.queue.findById(claimed.id);
      assert.equal(after!.state, 'DEAD_LETTERED');
    });

    it('11. fail(retryAt) reschedules; fail(null) dead-letters, and neither returns to READY twice', async () => {
      await enqueue('p1');
      const claimed = await h.queue.claim({ workerId: 'w1', leaseMs: 60_000, now: h.clock.now() });
      assert.ok(claimed);

      const retryAt = new Date(h.clock.nowMs() + 10_000);
      await h.queue.fail(claimed.id, { code: 'X', message: 'boom' }, retryAt, h.clock.now());
      let after = await h.queue.findById(claimed.id);
      assert.equal(after!.state, 'READY');
      assert.equal(after!.runAt.getTime(), retryAt.getTime());
      assert.equal(after!.lastError?.code, 'X');

      h.clock.advanceMs(10_000);
      const again = await h.queue.claim({ workerId: 'w1', leaseMs: 60_000, now: h.clock.now() });
      assert.ok(again);
      await h.queue.fail(again.id, { code: 'X', message: 'boom' }, null, h.clock.now());
      after = await h.queue.findById(again.id);
      assert.equal(after!.state, 'DEAD_LETTERED');

      assert.equal(
        await h.queue.claim({ workerId: 'w1', leaseMs: 60_000, now: h.clock.now() }),
        null,
        'a dead-lettered job is never handed out again',
      );
    });

    it('12. type filtering only hands out the requested job types', async () => {
      await enqueue('p1', { type: 'raw_event.normalize' });
      await enqueue('p2', { type: 'moderator.run' });

      const claimed = await h.queue.claim({
        workerId: 'w1',
        leaseMs: 1_000,
        now: h.clock.now(),
        types: ['moderator.run'],
      });
      assert.equal(claimed?.type, 'moderator.run');
    });

    it('13. state counts are queryable for operator visibility', async () => {
      await enqueue('p1');
      await enqueue('p2');
      const claimed = await h.queue.claim({ workerId: 'w1', leaseMs: 1_000, now: h.clock.now() });
      assert.ok(claimed);

      const counts = await h.queue.countByState();
      assert.equal(counts['READY'], 1);
      assert.equal(counts['RUNNING'], 1);
    });
  });
}
