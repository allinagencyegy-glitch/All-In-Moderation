import { createTestClock } from '../../src/platform/clock.ts';
import { createMemoryDatabase } from '../../src/adapters/memory/database.ts';
import { createMemoryJobQueue } from '../../src/adapters/memory/job-queue.ts';
import { runJobQueueContract } from './job-queue-contract.ts';

/**
 * The in-memory adapter, run against the shared contract.
 *
 * When the Postgres adapter lands in Phase 1, it gets a sibling file of about this size and the
 * suite is not touched. If the two adapters ever disagree about partition exclusivity, lease
 * expiry, or coalescing, this is where it surfaces.
 */
runJobQueueContract('memory', () => {
  const clock = createTestClock();
  const db = createMemoryDatabase();
  return { queue: createMemoryJobQueue(db), clock, reset: () => db.reset() };
});
