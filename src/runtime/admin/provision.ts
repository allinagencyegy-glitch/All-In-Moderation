import { randomBytes } from 'node:crypto';
import type { AccountScope } from '../../core/account/index.ts';
import type { Channel, Surface } from '../../core/channel.ts';
import { TerminalError } from '../../platform/errors.ts';
import type { ChannelConnectionId, IdFactory } from '../../platform/ids.ts';
import { ID_PREFIX } from '../../platform/ids.ts';
import type { ChannelConnection } from '../../moderation/domain/channel.ts';
import { validateConnection } from '../../moderation/domain/channel.ts';
import type { ProviderIdentity, SubscriptionState } from '../../moderation/domain/provider.ts';
import { defaultIdentityKind, receiveCapabilityFor } from '../../moderation/domain/provider.ts';
import type { ChannelConnectionRepository, SecretResolver } from '../../moderation/ports.ts';

/**
 * Provisioning a Meta connection, safely (objective 11).
 *
 * Not a UI. This phase needs exactly one thing from provisioning: a way to attach a real Meta
 * surface to an account such that the resulting row cannot possibly send anything. So this module
 * is deliberately narrow and deliberately opinionated:
 *
 *   * **Receive-only is not a parameter.** There is no argument that produces a send capability.
 *     Promoting a connection is a separate, later, deliberate act — not a flag somebody can pass
 *     by accident while wiring up a client at 6pm on a Friday.
 *   * **The secret must already resolve.** A connection whose `credentialsRef` points at nothing
 *     will fail every signature check and answer every subscription handshake with 403, which
 *     looks exactly like Meta misbehaving. Checking at provisioning time turns a confusing
 *     production symptom into a clear refusal here.
 *   * **The webhook id is generated, never chosen.** It is a bearer credential: whoever knows it
 *     can address this tenant's endpoint. A human-chosen one would be guessable.
 *   * **Identity conflicts surface as refusals.** Two accounts claiming the same page is refused
 *     by a primary key in the database (0008); this is where that refusal becomes a sentence an
 *     operator can act on.
 */

export interface ProvisionMetaConnectionInput {
  readonly channel: Channel;
  /** The primary provider identity: page id, IG account id, or WhatsApp phone number id. */
  readonly externalId: string;
  /**
   * Additional identities this connection owns.
   *
   * For WhatsApp this is where the business account id goes, so that a delivery naming the WABA
   * is still attributable — while the *routable* identity stays the phone number.
   */
  readonly additionalIdentities?: readonly ProviderIdentity[];
  /** Which surfaces the client has asked us to read. Defaults to the channel's full set. */
  readonly enabledSurfaces?: readonly Surface[];
  readonly credentialsRef: string;
  /** Supplied only when re-provisioning a known connection; generated otherwise. */
  readonly publicWebhookId?: string;
  readonly subscriptionState?: SubscriptionState;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface ProvisionDeps {
  readonly connections: ChannelConnectionRepository;
  readonly secrets: SecretResolver;
  readonly ids: IdFactory;
  /** Injected so a test is deterministic; production passes `randomBytes`. */
  readonly randomBytes?: (size: number) => Buffer;
}

export interface ProvisionResult {
  readonly connection: ChannelConnection;
  /** True when an existing connection for the same channel and external id was updated. */
  readonly replaced: boolean;
  /** The path Meta must be pointed at. Not a secret to us, but a bearer credential to a caller. */
  readonly webhookPath: string;
}

/** The surfaces each channel can carry. Narrower than the domain's vocabulary, on purpose. */
const SURFACES: Readonly<Record<Channel, readonly Surface[]>> = {
  FACEBOOK: ['DIRECT_MESSAGE', 'PUBLIC_COMMENT'],
  INSTAGRAM: ['DIRECT_MESSAGE', 'PUBLIC_COMMENT'],
  // WhatsApp has no public surface. Enabling one would be meaningless rather than merely unused.
  WHATSAPP: ['DIRECT_MESSAGE'],
  // Neither is a Meta transport; both are refused above, and are listed only so that adding a
  // channel to the vocabulary is a compile error here rather than an undefined lookup at runtime.
  WEB: ['DIRECT_MESSAGE'],
  TEST: ['DIRECT_MESSAGE', 'PUBLIC_COMMENT'],
};

/** 32 hex characters: unguessable, URL-safe, and inside the route pattern's length bound. */
export function generatePublicWebhookId(random: (size: number) => Buffer = randomBytes): string {
  return random(16).toString('hex');
}

export async function provisionMetaConnection(
  deps: ProvisionDeps,
  scope: AccountScope,
  input: ProvisionMetaConnectionInput,
): Promise<ProvisionResult> {
  if (input.channel === 'TEST' || input.channel === 'WEB') {
    throw new TerminalError(
      'PROVISION_INVALID',
      `${input.channel} is not a Meta channel and cannot be provisioned as one`,
      { channel: input.channel },
    );
  }
  if (input.externalId.trim().length === 0) {
    throw new TerminalError('PROVISION_INVALID', 'externalId is required');
  }

  // Fail here rather than at the first delivery. A connection whose secret does not resolve
  // rejects every signature and every handshake, which is indistinguishable from Meta being wrong.
  const secret = await deps.secrets.resolve(input.credentialsRef);
  if (!secret || secret.appSecret.length === 0) {
    throw new TerminalError(
      'PROVISION_SECRET_UNRESOLVED',
      'credentialsRef does not resolve to an app secret; configure the secret store first',
      { credentialsRef: input.credentialsRef },
    );
  }
  if (!secret.verifyToken) {
    throw new TerminalError(
      'PROVISION_SECRET_UNRESOLVED',
      'credentialsRef resolves without a verifyToken, so the subscription handshake would be refused',
      { credentialsRef: input.credentialsRef },
    );
  }

  const supported = SURFACES[input.channel];
  const enabled = input.enabledSurfaces ?? supported;
  for (const surface of enabled) {
    if (!supported.includes(surface)) {
      throw new TerminalError(
        'PROVISION_INVALID',
        `${input.channel} does not carry the ${surface} surface`,
        { channel: input.channel, surface },
      );
    }
  }

  const primary: ProviderIdentity = {
    kind: defaultIdentityKind(input.channel),
    externalId: input.externalId,
  };
  const identities = dedupeIdentities([primary, ...(input.additionalIdentities ?? [])]);

  const existing = await deps.connections.findByExternalId(scope, input.channel, input.externalId);

  const connection: ChannelConnection = {
    id: existing?.id ?? deps.ids.next<ChannelConnectionId>(ID_PREFIX.channelConnection),
    accountId: scope.accountId,
    channel: input.channel,
    provider: 'META',
    supportedSurfaces: supported,
    enabledSurfaces: enabled,
    externalId: input.externalId,
    identities,
    // Receive capabilities only, derived from what is enabled. There is no input to this function
    // that produces a send capability, and the database refuses one on a RECEIVE_ONLY row anyway.
    capabilities: enabled.map(receiveCapabilityFor),
    transportMode: 'RECEIVE_ONLY',
    subscriptionState: input.subscriptionState ?? existing?.subscriptionState ?? 'UNCONFIGURED',
    publicWebhookId:
      input.publicWebhookId ??
      existing?.publicWebhookId ??
      generatePublicWebhookId(deps.randomBytes),
    credentialsRef: input.credentialsRef,
    status: 'ACTIVE',
    settings: input.settings ?? existing?.settings ?? {},
  };

  const problems = validateConnection(connection);
  if (problems.length > 0) {
    throw new TerminalError(
      'PROVISION_INVALID',
      `connection is not internally consistent: ${problems.join('; ')}`,
      { problemCount: problems.length },
    );
  }

  // A conflicting identity raises CONNECTION_IDENTITY_CONFLICT from whichever adapter is in use.
  // It is allowed to propagate: "another account already owns this page" is exactly the answer.
  await deps.connections.save(connection);

  return {
    connection,
    replaced: existing !== null,
    webhookPath: `/webhooks/meta/${connection.publicWebhookId}`,
  };
}

function dedupeIdentities(identities: readonly ProviderIdentity[]): readonly ProviderIdentity[] {
  const seen = new Set<string>();
  const out: ProviderIdentity[] = [];
  for (const identity of identities) {
    const key = `${identity.kind}:${identity.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(identity);
  }
  return out;
}
