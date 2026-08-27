/**
 * Time is a dependency, not an ambient fact.
 *
 * Every durable timer, SLA, debounce ceiling, lease expiry and knowledge validity window in this
 * platform is a time comparison. If time is read from `Date.now()` inside domain code, none of
 * those can be tested deterministically, and "it works on my machine at 14:03" becomes a real
 * category of bug.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/**
 * A clock tests fully control. Advancing it is explicit, which makes the time-dependent parts of
 * the system (debounce ceilings, lease expiry, price validity) assertable rather than flaky.
 */
export interface TestClock extends Clock {
  advanceMs(ms: number): void;
  setTo(date: Date): void;
}

export function createTestClock(start: Date = new Date('2026-01-01T00:00:00.000Z')): TestClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    nowMs: () => current,
    advanceMs: (ms: number) => {
      if (ms < 0) throw new Error('TestClock cannot move backwards');
      current += ms;
    },
    setTo: (date: Date) => {
      current = date.getTime();
    },
  };
}
