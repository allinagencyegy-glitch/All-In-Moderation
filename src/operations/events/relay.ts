import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import type { DomainEventId } from '../../platform/ids.ts';
import { describeError } from '../../platform/errors.ts';
import type { DomainEventEnvelope } from './contracts.ts';

/**
 * The outbox relay (ADR-009), and the closing of the Phase 01 gap.
 *
 * Phase 01 proved that an event and the state change it describes commit together, and then
 * stopped: nothing ever read the outbox back out. `EventOutbox.markRelayed` took no
 * `AccountScope`, so under RLS it would have matched zero rows and looped forever redelivering —
 * the Postgres adapter threw `NotImplementedError` rather than silently succeed.
 *
 * The fix is the same shape as the queue's: **a role, not a weaker policy**. Reading pending
 * events across tenants is what a relay is for, so it gets its own database role whose grants
 * stop at exactly one table, and a store port scoped to that role. `EventOutbox` keeps its
 * tenant-scoped write side; this port is the cross-tenant read side, and the two are deliberately
 * separate objects so that no repository can accidentally acquire cross-tenant reach.
 *
 * ### Delivery semantics
 *
 * **At least once, never at most once.** Delivery happens before the watermark moves, so a crash
 * between the two redelivers rather than drops. Consumers are told to be idempotent because this
 * is the only ordering that cannot lose an event.
 *
 * **Per-tenant ordering survives a failure.** A failed delivery halts *that account's* stream for
 * the round and leaves the event pending; other accounts continue. Skipping ahead would deliver
 * `conversation.started` after the events that describe what happened in it.
 */

export interface BacklogSample {
  readonly pending: number;
  /** The oldest thing still waiting, or null when nothing is. This is the lag signal. */
  readonly oldestAt: Date | null;
}

export interface OutboxRelayStore {
  /**
   * Pending events across every tenant, oldest first.
   *
   * Unbounded reads are how a relay turns a backlog into an outage, so the limit is required
   * rather than optional.
   */
  listPending(limit: number): Promise<readonly DomainEventEnvelope[]>;
  /**
   * Moves the watermark, conditional on it not having moved already.
   *
   * `false` means another relay got there first. That is a normal outcome under concurrency, not
   * an error — and it is the observable difference between "idempotent" and "hopefully once".
   */
  markRelayed(eventId: DomainEventId, now: Date): Promise<boolean>;
  backlog(): Promise<BacklogSample>;
}

/**
 * Where a relayed event goes.
 *
 * A port, because Phase 02A has no authorised destination: the only implementation is the
 * simulated sink below, which reaches no network. When `event_deliveries` fan-out is built, it
 * implements this and nothing else in this file changes.
 */
export interface RelayTarget {
  readonly id: string;
  deliver(event: DomainEventEnvelope): Promise<void>;
}

export interface RelayOutcome {
  readonly delivered: readonly DomainEventId[];
  /** Already relayed by someone else between our read and our write. */
  readonly alreadyRelayed: readonly DomainEventId[];
  /** Left pending on purpose; retried next round. */
  readonly deferred: readonly DomainEventId[];
}

export interface OutboxRelay {
  relayOnce(): Promise<RelayOutcome>;
}

export const DEFAULT_RELAY_BATCH_SIZE = 100;

/**
 * The Phase 02A destination: a sink that records and reaches nothing.
 *
 * It is the exact analogue of a SIMULATED outbound action, and it exists for the same reason —
 * a stub that pretended to deliver would make the pipeline look healthy while no consumer had
 * ever been contacted. `deliveredCount` is exposed so a test can assert on what a *real* target
 * would have received.
 */
export interface SimulatedRelayTarget extends RelayTarget {
  delivered(): readonly DomainEventEnvelope[];
}

export function createSimulatedRelayTarget(logger: Logger): SimulatedRelayTarget {
  const seen: DomainEventEnvelope[] = [];
  return {
    id: 'simulated',
    deliver(event) {
      seen.push(event);
      // Type and ids only. The envelope's `data` is minimised by contract (ADR-009), but logging
      // it wholesale would still put derived customer facts in a log aggregator.
      logger.info('domain event relayed (SIMULATED)', {
        event_id: event.eventId,
        event_type: event.type,
        account_id: event.accountId,
        trace_id: event.traceId,
      });
      return Promise.resolve();
    },
    delivered: () => seen,
  };
}

export function createOutboxRelay(deps: {
  store: OutboxRelayStore;
  target: RelayTarget;
  clock: Clock;
  logger: Logger;
  batchSize?: number;
}): OutboxRelay {
  const batchSize = deps.batchSize ?? DEFAULT_RELAY_BATCH_SIZE;

  return {
    async relayOnce() {
      const pending = await deps.store.listPending(batchSize);
      const delivered: DomainEventId[] = [];
      const alreadyRelayed: DomainEventId[] = [];
      const deferred: DomainEventId[] = [];
      // Accounts whose stream stalled this round. Everything behind a failure in the same
      // account waits with it, so a consumer never sees an effect before its cause.
      const halted = new Set<string>();

      for (const event of pending) {
        if (halted.has(event.accountId)) {
          deferred.push(event.eventId);
          continue;
        }
        try {
          await deps.target.deliver(event);
        } catch (error) {
          const described = describeError(error);
          halted.add(event.accountId);
          deferred.push(event.eventId);
          deps.logger.warn('relay delivery failed; event stays pending', {
            event_id: event.eventId,
            event_type: event.type,
            account_id: event.accountId,
            target: deps.target.id,
            code: described.code,
            message: described.message,
          });
          continue;
        }
        // Deliberately after delivery. A crash here costs a duplicate, which consumers are
        // required to absorb; the reverse ordering would cost the event entirely.
        const moved = await deps.store.markRelayed(event.eventId, deps.clock.now());
        if (moved) delivered.push(event.eventId);
        else alreadyRelayed.push(event.eventId);
      }

      if (delivered.length > 0 || deferred.length > 0) {
        deps.logger.debug('relay round complete', {
          delivered: delivered.length,
          already_relayed: alreadyRelayed.length,
          deferred: deferred.length,
        });
      }
      return { delivered, alreadyRelayed, deferred };
    },
  };
}
