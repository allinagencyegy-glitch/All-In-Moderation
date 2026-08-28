import type { Channel, Surface } from '../../core/channel.ts';

/**
 * Provider transport vocabulary.
 *
 * Phase 02A had exactly one notion of "which surface is this connection?": a single `externalId`
 * compared against `entry.id`. That works for Facebook Messenger and for nothing else. A WhatsApp
 * delivery names a WABA in `entry.id` and the routable phone number somewhere else entirely; an
 * Instagram account is a different identifier from the Page it is linked to. Collapsing those into
 * one string is how an event ends up attributed to the wrong tenant.
 *
 * So a connection owns a **set** of typed identities, and an inbound item declares **which one**
 * must own it. Matching is exact on both `kind` and `externalId`: a phone number id that happens
 * to equal some other tenant's page id is not a match, because the kinds differ.
 *
 * Nothing here knows what a webhook looks like. `integrations/meta` maps provider payloads onto
 * this vocabulary, which is what keeps `entry`, `mid` and `wamid` out of the domain (ADR-001).
 */

export const PROVIDERS = ['META', 'INTERNAL'] as const;
export type ProviderType = (typeof PROVIDERS)[number];

/**
 * The identifier kinds Meta actually routes on.
 *
 * `WHATSAPP_BUSINESS_ACCOUNT` and `WHATSAPP_PHONE_NUMBER` are deliberately separate. One WABA
 * carries many numbers, and only the number is a destination; treating them as interchangeable
 * would let a delivery for one client's number be accepted by another client's connection on the
 * same business account.
 */
export const PROVIDER_IDENTITY_KINDS = [
  'FACEBOOK_PAGE',
  'INSTAGRAM_ACCOUNT',
  'WHATSAPP_BUSINESS_ACCOUNT',
  'WHATSAPP_PHONE_NUMBER',
  'INTERNAL',
] as const;
export type ProviderIdentityKind = (typeof PROVIDER_IDENTITY_KINDS)[number];

export interface ProviderIdentity {
  readonly kind: ProviderIdentityKind;
  readonly externalId: string;
}

/**
 * What a connection is *allowed* to do, as data rather than as an `if` somewhere.
 *
 * Receive capabilities and send capabilities are listed together on purpose: the asymmetry is the
 * point. In this phase every Meta connection carries receive capabilities and none carries a send
 * capability, and that fact is visible in a row an operator can read.
 */
export const CONNECTION_CAPABILITIES = [
  'RECEIVE_DIRECT_MESSAGE',
  'RECEIVE_PUBLIC_COMMENT',
  'SEND_DIRECT_MESSAGE',
  'SEND_PUBLIC_COMMENT',
  'REACT',
  'HIDE_COMMENT',
  'DELETE_COMMENT',
] as const;
export type ConnectionCapability = (typeof CONNECTION_CAPABILITIES)[number];

const SEND_CAPABILITIES: ReadonlySet<ConnectionCapability> = new Set<ConnectionCapability>([
  'SEND_DIRECT_MESSAGE',
  'SEND_PUBLIC_COMMENT',
  'REACT',
  'HIDE_COMMENT',
  'DELETE_COMMENT',
]);

export function isSendCapability(capability: ConnectionCapability): boolean {
  return SEND_CAPABILITIES.has(capability);
}

/**
 * Receive-only is a property of the *connection*, not of the process.
 *
 * `OUTBOUND_MODE` is a single global switch, and a global switch is the wrong granularity for a
 * multi-client platform: enabling one client would arm every other one at the same instant. A
 * per-connection mode means the first real Meta connection can be proven in shadow while the flag
 * that would let anything send is still refused at boot.
 */
export const TRANSPORT_MODES = ['RECEIVE_ONLY', 'SEND_AND_RECEIVE'] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/**
 * Where a connection is in the provider's subscription handshake.
 *
 * Recorded rather than inferred because "the webhook is quiet" has two very different causes —
 * nobody messaged us, or the subscription was never completed — and they need different people.
 */
export const SUBSCRIPTION_STATES = [
  'UNCONFIGURED',
  'CHALLENGE_PENDING',
  'CHALLENGE_PASSED',
  'SUBSCRIBED',
  'REVOKED',
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

/** The identity kind a channel routes on when a connection declares nothing more specific. */
export function defaultIdentityKind(channel: Channel): ProviderIdentityKind {
  switch (channel) {
    case 'FACEBOOK':
      return 'FACEBOOK_PAGE';
    case 'INSTAGRAM':
      return 'INSTAGRAM_ACCOUNT';
    case 'WHATSAPP':
      return 'WHATSAPP_PHONE_NUMBER';
    case 'WEB':
    case 'TEST':
      return 'INTERNAL';
  }
}

export function sameIdentity(a: ProviderIdentity, b: ProviderIdentity): boolean {
  return a.kind === b.kind && a.externalId === b.externalId;
}

/** The receive capability a surface needs, so the mapping lives in one place. */
export function receiveCapabilityFor(surface: Surface): ConnectionCapability {
  return surface === 'PUBLIC_COMMENT' ? 'RECEIVE_PUBLIC_COMMENT' : 'RECEIVE_DIRECT_MESSAGE';
}
