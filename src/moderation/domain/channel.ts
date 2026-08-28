import { TerminalError } from '../../platform/errors.ts';
import type { AccountId, ChannelConnectionId } from '../../platform/ids.ts';
import type { Channel, Surface } from '../../core/channel.ts';
import type {
  ConnectionCapability,
  ProviderIdentity,
  ProviderType,
  SubscriptionState,
  TransportMode,
} from './provider.ts';
import {
  defaultIdentityKind,
  isSendCapability,
  receiveCapabilityFor,
  sameIdentity,
} from './provider.ts';

export type ChannelConnectionStatus = 'PENDING' | 'ACTIVE' | 'DEGRADED' | 'DISABLED';

/** One connected surface: a Facebook Page, an Instagram account, a WhatsApp number. */
export interface ChannelConnection {
  readonly id: ChannelConnectionId;
  readonly accountId: AccountId;
  readonly channel: Channel;
  /** Which transport implements this connection. Adapters are chosen from this, never guessed. */
  readonly provider: ProviderType;
  readonly supportedSurfaces: readonly Surface[];
  /**
   * The surfaces actually turned on, a subset of `supportedSurfaces`.
   *
   * Separate because "this channel can carry public comments" and "this client wants us reading
   * their public comments" are different statements, and conflating them means enabling a channel
   * silently enables every surface it is capable of.
   */
  readonly enabledSurfaces: readonly Surface[];
  /** Page id / IG id / phone number id as the provider knows it. The primary routing identity. */
  readonly externalId: string;
  /**
   * Every provider identity this connection owns, typed.
   *
   * Empty means "the primary identity only" — see `connectionIdentities`. Populating it is what
   * lets a WhatsApp connection be addressed by phone number while its deliveries name a WABA.
   */
  readonly identities: readonly ProviderIdentity[];
  readonly capabilities: readonly ConnectionCapability[];
  /**
   * Receive-only until somebody deliberately says otherwise, per connection.
   *
   * This is the flag that makes a real Meta connection safe to attach: even if the process-wide
   * outbound mode were ever flipped, a RECEIVE_ONLY connection still records simulated outcomes.
   */
  readonly transportMode: TransportMode;
  readonly subscriptionState: SubscriptionState;
  /**
   * Opaque id embedded in the webhook URL. This is what establishes tenancy *before* the request
   * body is parsed, so trust never depends on payload contents (ADR-006).
   */
  readonly publicWebhookId: string;
  /** Pointer into the secret store. Never the secret itself. */
  readonly credentialsRef: string;
  readonly status: ChannelConnectionStatus;
  readonly settings: Readonly<Record<string, unknown>>;
}

/**
 * The identities this connection owns.
 *
 * Falls back to the primary `externalId` under the channel's default kind, so a connection that
 * declares no identity set is still matched — and still matched *exactly*, rather than being
 * treated as a wildcard. There is no shape of this data that matches everything.
 */
export function connectionIdentities(connection: ChannelConnection): readonly ProviderIdentity[] {
  const primary: ProviderIdentity = {
    kind: defaultIdentityKind(connection.channel),
    externalId: connection.externalId,
  };
  if (connection.identities.length === 0) return [primary];
  return connection.identities.some((identity) => sameIdentity(identity, primary))
    ? connection.identities
    : [primary, ...connection.identities];
}

/**
 * Does this connection own the identity an inbound item claims to be addressed to?
 *
 * Fail-closed and exact on both halves. An item whose routing identity is not in this set is not
 * ours, and the correct response is to record it and stop — never to fall back to "well, it
 * arrived on this webhook id, so it must belong here". The URL proves the tenant; the identity
 * proves the surface, and both have to agree.
 */
export function connectionOwnsIdentity(
  connection: ChannelConnection,
  identity: ProviderIdentity,
): boolean {
  return connectionIdentities(connection).some((owned) => sameIdentity(owned, identity));
}

/** True when the sender of an item is this connection's own surface — the echo loop-breaker. */
export function isSelfIdentity(connection: ChannelConnection, externalId: string): boolean {
  return (
    connectionIdentities(connection).some((owned) => owned.externalId === externalId) ||
    connection.externalId === externalId
  );
}

export function canReceiveOn(connection: ChannelConnection, surface: Surface): boolean {
  return connection.supportedSurfaces.includes(surface);
}

/**
 * Whether an inbound item on this surface should become a conversation.
 *
 * Three independent conditions, all required: the channel supports the surface, the client has
 * enabled it, and the connection carries the receive capability. A surface that fails any of them
 * is recorded and dropped rather than processed.
 */
export function isSurfaceEnabled(connection: ChannelConnection, surface: Surface): boolean {
  return (
    canReceiveOn(connection, surface) &&
    connection.enabledSurfaces.includes(surface) &&
    connection.capabilities.includes(receiveCapabilityFor(surface))
  );
}

export function isConnectionUsable(connection: ChannelConnection): boolean {
  return connection.status === 'ACTIVE' || connection.status === 'DEGRADED';
}

/** Receive-only connections may never produce a real effect, whatever the process is configured for. */
export function isReceiveOnly(connection: ChannelConnection): boolean {
  return connection.transportMode === 'RECEIVE_ONLY';
}

/**
 * A connection is internally consistent.
 *
 * Returns the reasons it is not, so a provisioning path can refuse with an explanation rather
 * than writing a row that is quietly incapable of doing its job. The receive-only rule is the
 * load-bearing one: a connection that claims RECEIVE_ONLY while holding a send capability is a
 * contradiction, and contradictions in safety configuration resolve the wrong way under pressure.
 */
export function validateConnection(connection: ChannelConnection): readonly string[] {
  const problems: string[] = [];

  for (const surface of connection.enabledSurfaces) {
    if (!connection.supportedSurfaces.includes(surface)) {
      problems.push(`enabled surface ${surface} is not in supportedSurfaces`);
    }
    if (!connection.capabilities.includes(receiveCapabilityFor(surface))) {
      problems.push(`enabled surface ${surface} has no matching receive capability`);
    }
  }

  if (isReceiveOnly(connection)) {
    for (const capability of connection.capabilities) {
      if (isSendCapability(capability)) {
        problems.push(`RECEIVE_ONLY connection must not hold send capability ${capability}`);
      }
    }
  }

  const seen = new Set<string>();
  for (const identity of connectionIdentities(connection)) {
    if (identity.externalId.length === 0) problems.push(`identity ${identity.kind} has no id`);
    const key = `${identity.kind}:${identity.externalId}`;
    if (seen.has(key)) problems.push(`duplicate identity ${key}`);
    seen.add(key);
  }

  if (connection.credentialsRef.length === 0) problems.push('credentialsRef is empty');
  if (connection.publicWebhookId.length === 0) problems.push('publicWebhookId is empty');

  return problems;
}

/**
 * One provider identity, one connection, platform-wide.
 *
 * Raised by both adapters with the same code so that "two clients claimed the same page" is a
 * single, recognisable failure rather than a SQLSTATE in one environment and something else in
 * the other. The identity *kind* is named; the id is not, because it belongs to whoever already
 * holds it and telling the loser which account that is would be a disclosure.
 */
export function identityConflict(identity: ProviderIdentity): TerminalError {
  return new TerminalError(
    'CONNECTION_IDENTITY_CONFLICT',
    `A ${identity.kind} identity is already claimed by another channel connection`,
    { kind: identity.kind },
  );
}
