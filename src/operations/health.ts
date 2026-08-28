import type { Clock } from '../platform/clock.ts';
import { describeError } from '../platform/errors.ts';
import type { BacklogSample } from './events/relay.ts';
import type { DeadLetterStore } from './dead-letter.ts';
import type { JobQueue } from './jobs/queue.ts';

/**
 * Operational health.
 *
 * Every number here was already a query somebody could have run by hand; Phase 01 said so
 * explicitly, and that was the problem. A metric that only exists as a query someone remembers to
 * type is a metric nobody looks at during an incident. This module is where those queries acquire
 * somewhere to go.
 *
 * Two rules shape what a snapshot may contain:
 *
 *   - **Aggregates only, never rows.** A health endpoint is the least-authenticated surface in the
 *     system. It reports counts and ages; it never reports which account, which conversation, or
 *     what anybody said. That is also why the backlog probes are aggregate at the *SQL* level
 *     rather than filtered afterwards — the query cannot leak what it never selected.
 *   - **Liveness and readiness are different questions.** "Is this process alive?" must be
 *     answerable without touching the database, or a database blip evicts a healthy process and
 *     turns a degradation into an outage. "Should this process receive traffic?" must touch it.
 */

export type HealthStatus = 'OK' | 'DEGRADED' | 'DOWN';

/**
 * The store-shaped half of a health check.
 *
 * `operations` may not import an adapter, so the two cross-tenant aggregates the snapshot needs
 * arrive through this port. Both are deliberately narrow: a count and an age, nothing else.
 */
export interface StoreProbe {
  /** A real round trip. Rejects when the store cannot be reached. */
  ping(): Promise<void>;
  /** Inbound events persisted but not yet normalised. The customer-visible lag. */
  inboundBacklog(): Promise<BacklogSample>;
  /** Domain events persisted but not yet relayed. The downstream lag. */
  outboxBacklog(): Promise<BacklogSample>;
}

export interface HealthThresholds {
  /** Beyond this, unprocessed inbound is a degradation rather than normal queue latency. */
  readonly inboundLagMs: number;
  readonly outboxLagMs: number;
  /**
   * Any dead letter at all is an alert — this is the one queue that should be empty — so the
   * default is zero and raising it is a deliberate act.
   */
  readonly deadLetterCeiling: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  inboundLagMs: 300_000,
  outboxLagMs: 300_000,
  deadLetterCeiling: 0,
};

export interface ProcessIdentity {
  readonly role: string;
  readonly outboundMode: string;
  readonly nodeEnv: string;
}

export interface HealthSnapshot {
  readonly status: HealthStatus;
  readonly checkedAt: Date;
  readonly uptimeMs: number;
  readonly process: {
    readonly pid: number;
    readonly role: string;
    readonly outboundMode: string;
    readonly nodeEnv: string;
    readonly shuttingDown: boolean;
  };
  readonly database: {
    readonly reachable: boolean;
    readonly latencyMs: number | null;
    /** The error *code*, never the statement or its parameters (which carry customer content). */
    readonly errorCode: string | null;
  };
  readonly queue: {
    readonly depth: Readonly<Record<string, number>>;
    readonly ready: number;
    readonly running: number;
    readonly deadLettered: number;
  };
  readonly deadLetters: { readonly count: number };
  readonly inbound: BacklogSample & { readonly ageMs: number | null };
  readonly outbox: BacklogSample & { readonly ageMs: number | null };
  /** Why the status is not OK. Empty on a healthy snapshot. */
  readonly reasons: readonly string[];
}

export interface HealthService {
  /** Cheap and store-free: "is this process running?" */
  liveness(): { readonly alive: true; readonly uptimeMs: number; readonly shuttingDown: boolean };
  /** The full picture, including everything that requires the database. */
  snapshot(): Promise<HealthSnapshot>;
}

export function createHealthService(deps: {
  probe: StoreProbe;
  queue: JobQueue;
  deadLetters: DeadLetterStore;
  clock: Clock;
  startedAt: Date;
  identity: ProcessIdentity;
  /** Read live, so a snapshot taken during shutdown says so rather than lying. */
  isShuttingDown: () => boolean;
  thresholds?: HealthThresholds;
}): HealthService {
  const thresholds = deps.thresholds ?? DEFAULT_HEALTH_THRESHOLDS;
  const uptime = (): number => deps.clock.nowMs() - deps.startedAt.getTime();

  const age = (sample: BacklogSample, now: Date): number | null =>
    sample.oldestAt === null ? null : Math.max(0, now.getTime() - sample.oldestAt.getTime());

  return {
    liveness: () => ({ alive: true, uptimeMs: uptime(), shuttingDown: deps.isShuttingDown() }),

    async snapshot() {
      const checkedAt = deps.clock.now();
      const reasons: string[] = [];

      const startedPing = Date.now();
      let reachable = true;
      let errorCode: string | null = null;
      try {
        await deps.probe.ping();
      } catch (error) {
        reachable = false;
        errorCode = describeError(error).code;
      }
      const latencyMs = reachable ? Date.now() - startedPing : null;

      const empty: BacklogSample = { pending: 0, oldestAt: null };
      // When the store is unreachable the remaining probes would only produce the same failure
      // with a longer timeout. Reporting zeros next to `reachable: false` is honest; reporting
      // *nothing* would make an unreachable database indistinguishable from an idle one.
      const [depth, deadLetterCount, inbound, outbox] = reachable
        ? await Promise.all([
            deps.queue.countByState(),
            deps.deadLetters.count(),
            deps.probe.inboundBacklog(),
            deps.probe.outboxBacklog(),
          ])
        : [{} as Record<string, number>, 0, empty, empty];

      if (!reachable) reasons.push(`database unreachable (${errorCode ?? 'UNKNOWN'})`);
      if (deadLetterCount > thresholds.deadLetterCeiling) {
        reasons.push(`${String(deadLetterCount)} dead letters`);
      }

      const inboundAge = age(inbound, checkedAt);
      if (inboundAge !== null && inboundAge > thresholds.inboundLagMs) {
        reasons.push(`oldest unprocessed inbound event is ${String(inboundAge)}ms old`);
      }
      const outboxAge = age(outbox, checkedAt);
      if (outboxAge !== null && outboxAge > thresholds.outboxLagMs) {
        reasons.push(`oldest unrelayed domain event is ${String(outboxAge)}ms old`);
      }

      const status: HealthStatus = !reachable ? 'DOWN' : reasons.length > 0 ? 'DEGRADED' : 'OK';

      return {
        status,
        checkedAt,
        uptimeMs: uptime(),
        process: {
          pid: process.pid,
          role: deps.identity.role,
          outboundMode: deps.identity.outboundMode,
          nodeEnv: deps.identity.nodeEnv,
          shuttingDown: deps.isShuttingDown(),
        },
        database: { reachable, latencyMs, errorCode },
        queue: {
          depth,
          ready: depth['READY'] ?? 0,
          running: depth['RUNNING'] ?? 0,
          deadLettered: depth['DEAD_LETTERED'] ?? 0,
        },
        deadLetters: { count: deadLetterCount },
        inbound: { ...inbound, ageMs: inboundAge },
        outbox: { ...outbox, ageMs: outboxAge },
        reasons,
      };
    },
  };
}
