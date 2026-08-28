import { scopeForAccount } from '../../core/account/index.ts';
import type { Channel, Surface } from '../../core/channel.ts';
import { TerminalError } from '../../platform/errors.ts';
import { asId } from '../../platform/ids.ts';
import type { ChannelConnectionId } from '../../platform/ids.ts';
import type { ProviderIdentity } from '../../moderation/domain/provider.ts';
import { PROVIDER_IDENTITY_KINDS } from '../../moderation/domain/provider.ts';
import { provisionMetaConnection } from '../admin/provision.ts';
import { receiveStatusFor } from '../admin/receive-status.ts';
import type { CliContext } from './context.ts';
import { emit, fail, openCliContext, parseArgs } from './context.ts';

/**
 * `meta-connection` — provision and inspect Meta connections (objectives 11 and 12).
 *
 * The documented seed path for this phase. Not an operator UI, and deliberately so: a UI implies a
 * workflow, and the workflow for attaching a real client is not designed yet. What is needed now
 * is a way to create exactly one receive-only connection, read back what it will and will not do,
 * and see whether anything has arrived on it.
 *
 * Three properties this command guarantees, all of them enforced elsewhere and merely *reported*
 * here — a CLI that was the only thing standing between an operator and a live send would be the
 * wrong place for the guarantee:
 *
 *   1. Every connection it creates is RECEIVE_ONLY with receive capabilities only.
 *   2. The credentials reference must already resolve, so a misconfigured secret is refused now
 *      rather than discovered as a signature failure against real traffic.
 *   3. It prints the webhook *path*, never the app secret or the verify token.
 *
 * Usage
 *   node src/runtime/cli/meta-connection.ts provision \
 *     --account acc_... --channel WHATSAPP --external-id <phone_number_id> \
 *     --credentials-ref secret://client/app [--identity WHATSAPP_BUSINESS_ACCOUNT:<waba>] \
 *     [--surfaces DIRECT_MESSAGE,PUBLIC_COMMENT] [--webhook-id <existing>]
 *
 *   node src/runtime/cli/meta-connection.ts status --account acc_... --connection chc_...
 *   node src/runtime/cli/meta-connection.ts show   --account acc_... --connection chc_...
 */

const USAGE = `usage:
  meta-connection provision --account <id> --channel FACEBOOK|INSTAGRAM|WHATSAPP
                            --external-id <provider id> --credentials-ref <secret://...>
                            [--identity KIND:ID ...] [--surfaces A,B] [--webhook-id <id>]
  meta-connection show      --account <id> --connection <id>
  meta-connection status    --account <id> --connection <id>`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  // Every argument is validated before a connection pool is opened. An unknown command that first
  // failed on a missing PG_RUNTIME_URL would send an operator to fix their database configuration
  // when the actual problem is a typo.
  if (command !== 'provision' && command !== 'show' && command !== 'status') {
    throw new TerminalError('ARGS_INVALID', `unknown command '${command}'\n${USAGE}`);
  }
  const accountId = args['account'];
  if (!accountId) throw new TerminalError('ARGS_INVALID', `--account is required\n${USAGE}`);

  const ctx = openCliContext();
  try {
    const account = await ctx.container.accounts.findById(asId(accountId));
    if (!account) throw new TerminalError('ACCOUNT_NOT_FOUND', 'no such account', { accountId });
    const scope = scopeForAccount(account);

    switch (command) {
      case 'provision':
        emit(await provision(ctx, scope, args));
        return;
      case 'show':
        emit(await show(ctx, scope, args));
        return;
      case 'status':
        emit(await status(ctx, scope, args));
        return;
    }
  } finally {
    await ctx.close();
  }
}

async function provision(
  ctx: CliContext,
  scope: ReturnType<typeof scopeForAccount>,
  args: Readonly<Record<string, string>>,
): Promise<unknown> {
  const channel = args['channel'] as Channel | undefined;
  const externalId = args['external-id'];
  const credentialsRef = args['credentials-ref'];
  if (!channel || !externalId || !credentialsRef) {
    throw new TerminalError(
      'ARGS_INVALID',
      `--channel, --external-id and --credentials-ref are required\n${USAGE}`,
    );
  }

  const result = await provisionMetaConnection(
    {
      connections: ctx.container.connections,
      secrets: ctx.persistence.secrets,
      ids: ctx.container.ids,
    },
    scope,
    {
      channel,
      externalId,
      credentialsRef,
      ...(args['identity'] ? { additionalIdentities: parseIdentities(args['identity']) } : {}),
      ...(args['surfaces'] ? { enabledSurfaces: parseSurfaces(args['surfaces']) } : {}),
      ...(args['webhook-id'] ? { publicWebhookId: args['webhook-id'] } : {}),
    },
  );

  return {
    ok: true,
    replaced: result.replaced,
    connectionId: result.connection.id,
    channel: result.connection.channel,
    transportMode: result.connection.transportMode,
    capabilities: result.connection.capabilities,
    enabledSurfaces: result.connection.enabledSurfaces,
    identities: result.connection.identities,
    // The path, so it can be pasted into the Meta app's callback field. It is a bearer credential
    // to whoever holds it, which is why it is printed here and never written to a log.
    webhookPath: result.webhookPath,
    nextSteps: [
      'Set this path as the Callback URL in the Meta app (see docs/META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md).',
      'Complete the subscription handshake, then subscribe the Page / IG account / WABA to its fields.',
      'This connection is RECEIVE_ONLY: it can never send, react, hide or delete.',
    ],
  };
}

async function show(
  ctx: CliContext,
  scope: ReturnType<typeof scopeForAccount>,
  args: Readonly<Record<string, string>>,
): Promise<unknown> {
  const connection = await ctx.container.connections.findById(scope, connectionArg(args));
  if (!connection) throw new TerminalError('CONNECTION_NOT_FOUND', 'no such connection');
  // `credentialsRef` is a pointer rather than a secret, so it is safe to print — and printing it
  // is how an operator confirms which secret-store entry a connection is actually using.
  return {
    id: connection.id,
    channel: connection.channel,
    provider: connection.provider,
    status: connection.status,
    transportMode: connection.transportMode,
    subscriptionState: connection.subscriptionState,
    supportedSurfaces: connection.supportedSurfaces,
    enabledSurfaces: connection.enabledSurfaces,
    capabilities: connection.capabilities,
    identities: connection.identities,
    credentialsRef: connection.credentialsRef,
    webhookPath: `/webhooks/meta/${connection.publicWebhookId}`,
  };
}

async function status(
  ctx: CliContext,
  scope: ReturnType<typeof scopeForAccount>,
  args: Readonly<Record<string, string>>,
): Promise<unknown> {
  const result = await receiveStatusFor(
    {
      connections: ctx.container.connections,
      rawEvents: ctx.container.rawEvents,
      clock: ctx.container.clock,
    },
    scope,
    connectionArg(args),
  );
  if (!result) throw new TerminalError('CONNECTION_NOT_FOUND', 'no such connection');
  return result;
}

function connectionArg(args: Readonly<Record<string, string>>): ChannelConnectionId {
  const id = args['connection'];
  if (!id) throw new TerminalError('ARGS_INVALID', `--connection is required\n${USAGE}`);
  return asId<ChannelConnectionId>(id);
}

/** `--identity WHATSAPP_BUSINESS_ACCOUNT:1234,FACEBOOK_PAGE:5678` */
function parseIdentities(raw: string): readonly ProviderIdentity[] {
  return raw.split(',').map((entry) => {
    const separator = entry.indexOf(':');
    const kind = entry.slice(0, separator);
    const externalId = entry.slice(separator + 1);
    if (!PROVIDER_IDENTITY_KINDS.includes(kind as ProviderIdentity['kind']) || !externalId) {
      throw new TerminalError(
        'ARGS_INVALID',
        `--identity must be KIND:ID where KIND is one of ${PROVIDER_IDENTITY_KINDS.join(', ')}`,
      );
    }
    return { kind: kind as ProviderIdentity['kind'], externalId };
  });
}

function parseSurfaces(raw: string): readonly Surface[] {
  return raw.split(',').map((entry) => {
    const surface = entry.trim();
    if (surface !== 'DIRECT_MESSAGE' && surface !== 'PUBLIC_COMMENT') {
      throw new TerminalError('ARGS_INVALID', `unknown surface '${surface}'`);
    }
    return surface;
  });
}

await main().catch(fail);
