import type { AccountScope } from '../../core/account/index.ts';
import type { Clock } from '../../platform/clock.ts';
import type { ChannelConnectionId } from '../../platform/ids.ts';
import type { ChannelConnection } from '../../moderation/domain/channel.ts';
import { connectionIdentities, isReceiveOnly } from '../../moderation/domain/channel.ts';
import type { RawEventState } from '../../moderation/domain/raw-event.ts';
import type {
  ChannelConnectionRepository,
  RawInboundEventRepository,
} from '../../moderation/ports.ts';

/**
 * Per-connection receive status (objective 12).
 *
 * This is deliberately *not* on `/health/status`. "When did this client's page last send us
 * anything?" names a tenant, and the health endpoint is the least-authenticated surface in the
 * system — so aggregate counters go there and this goes behind a database credential, where RLS
 * answers the question for exactly one account.
 *
 * It reads the ledger rather than the metrics registry, which matters for the question actually
 * being asked. Counters reset when the process does; the ledger does not, so "we have received
 * nothing from this connection since it was attached" and "this process restarted" stay
 * distinguishable — and only the first is a reason to wake somebody.
 */

export interface ConnectionReceiveStatus {
  readonly connectionId: ChannelConnectionId;
  readonly channel: ChannelConnection['channel'];
  readonly status: ChannelConnection['status'];
  readonly transportMode: ChannelConnection['transportMode'];
  readonly subscriptionState: ChannelConnection['subscriptionState'];
  readonly receiveOnly: boolean;
  readonly enabledSurfaces: readonly string[];
  /** Identity kinds only. The ids themselves are provider identifiers for a named client. */
  readonly identityKinds: readonly string[];
  readonly totalEvents: number;
  readonly byState: Readonly<Record<RawEventState, number>>;
  readonly lastReceivedAt: Date | null;
  readonly lastReceivedAgeMs: number | null;
  /** The most recent delivery that produced at least one message. */
  readonly lastProducedMessagesAt: Date | null;
  readonly signatureRejections: number;
  /** Summed across every normalised delivery on this connection. The misrouting alarm, per tenant. */
  readonly unroutableItems: number;
  readonly surfaceDisabledItems: number;
  readonly duplicateItems: number;
  readonly byClassification: Readonly<Record<string, number>>;
  /** Deliveries persisted but not yet normalised. Non-zero for long is the customer-visible lag. */
  readonly pendingNormalization: number;
}

export interface ReceiveStatusDeps {
  readonly connections: ChannelConnectionRepository;
  readonly rawEvents: RawInboundEventRepository;
  readonly clock: Clock;
}

const EMPTY_STATES: Readonly<Record<RawEventState, number>> = {
  RECEIVED: 0,
  NORMALIZING: 0,
  NORMALIZED: 0,
  IGNORED: 0,
  REJECTED: 0,
  DEAD_LETTERED: 0,
};

export async function receiveStatusFor(
  deps: ReceiveStatusDeps,
  scope: AccountScope,
  connectionId: ChannelConnectionId,
): Promise<ConnectionReceiveStatus | null> {
  const connection = await deps.connections.findById(scope, connectionId);
  if (!connection) return null;

  const events = await deps.rawEvents.listByConnection(scope, connectionId);
  const byState: Record<RawEventState, number> = { ...EMPTY_STATES };
  const byClassification: Record<string, number> = {};

  let lastReceivedAt: Date | null = null;
  let lastProducedMessagesAt: Date | null = null;
  let signatureRejections = 0;
  let unroutableItems = 0;
  let surfaceDisabledItems = 0;
  let duplicateItems = 0;

  for (const event of events) {
    byState[event.state] += 1;
    if (lastReceivedAt === null || event.receivedAt > lastReceivedAt) {
      lastReceivedAt = event.receivedAt;
    }
    if (event.producedMessageIds.length > 0) {
      const at = event.normalizedAt ?? event.receivedAt;
      if (lastProducedMessagesAt === null || at > lastProducedMessagesAt) {
        lastProducedMessagesAt = at;
      }
    }
    if (!event.signatureValid) signatureRejections += 1;

    const summary = event.normalization;
    if (!summary) continue;
    unroutableItems += summary.unroutableItems;
    surfaceDisabledItems += summary.surfaceDisabledItems;
    duplicateItems += summary.duplicateItems;
    for (const [name, count] of Object.entries(summary.byClassification)) {
      byClassification[name] = (byClassification[name] ?? 0) + count;
    }
  }

  const now = deps.clock.nowMs();
  return {
    connectionId: connection.id,
    channel: connection.channel,
    status: connection.status,
    transportMode: connection.transportMode,
    subscriptionState: connection.subscriptionState,
    receiveOnly: isReceiveOnly(connection),
    enabledSurfaces: connection.enabledSurfaces,
    identityKinds: connectionIdentities(connection).map((identity) => identity.kind),
    totalEvents: events.length,
    byState,
    lastReceivedAt,
    lastReceivedAgeMs: lastReceivedAt === null ? null : Math.max(0, now - lastReceivedAt.getTime()),
    lastProducedMessagesAt,
    signatureRejections,
    unroutableItems,
    surfaceDisabledItems,
    duplicateItems,
    byClassification,
    pendingNormalization: byState.RECEIVED + byState.NORMALIZING,
  };
}
