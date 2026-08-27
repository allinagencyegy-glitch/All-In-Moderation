import type { AccountId, ChannelConnectionId } from '../../platform/ids.ts';
import type { Channel, Surface } from '../../core/channel.ts';

export type ChannelConnectionStatus = 'PENDING' | 'ACTIVE' | 'DEGRADED' | 'DISABLED';

/** One connected surface: a Facebook Page, an Instagram account, a WhatsApp number. */
export interface ChannelConnection {
  readonly id: ChannelConnectionId;
  readonly accountId: AccountId;
  readonly channel: Channel;
  readonly supportedSurfaces: readonly Surface[];
  /** Page id / IG id / phone number id as the provider knows it. */
  readonly externalId: string;
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

export function canReceiveOn(connection: ChannelConnection, surface: Surface): boolean {
  return connection.supportedSurfaces.includes(surface);
}

export function isConnectionUsable(connection: ChannelConnection): boolean {
  return connection.status === 'ACTIVE' || connection.status === 'DEGRADED';
}
