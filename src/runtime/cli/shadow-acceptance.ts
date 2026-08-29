import { scopeForAccount } from '../../core/account/index.ts';
import type { Account, AccountScope } from '../../core/account/index.ts';
import type { Channel } from '../../core/channel.ts';
import { createTestClock } from '../../platform/clock.ts';
import { TerminalError } from '../../platform/errors.ts';
import { hashJson } from '../../platform/hash.ts';
import { asId, createDeterministicIdFactory } from '../../platform/ids.ts';
import type {
  AccountId,
  AccountPackVersionId,
  ChannelConnectionId,
  RawInboundEventId,
  UserId,
} from '../../platform/ids.ts';
import { createLogger } from '../../platform/logger.ts';
import { createMockLlmProvider } from '../../integrations/llm/mock-provider.ts';
import { computeMetaSignature, META_SIGNATURE_HEADER } from '../../integrations/meta/signature.ts';
import type { AccountPackVersion } from '../../knowledge/domain/account-pack.ts';
import { PACK_SCHEMA_VERSION, validatePack } from '../../knowledge/domain/account-pack.ts';
import type { ProviderIdentity } from '../../moderation/domain/provider.ts';
import { provisionMetaConnection } from '../admin/provision.ts';
import type { ShadowTrace } from '../admin/shadow-trace.ts';
import { traceRawEvent } from '../admin/shadow-trace.ts';
import { createContainer } from '../container.ts';
import type { CoreContainer } from '../container.ts';
import { loadConfig } from '../config.ts';
import { emit, fail, openCliContext, parseArgs } from './context.ts';
import { loadAllFixtures, loadManifest } from './fixtures.ts';
import { LIVE_OUTBOUND_STATES } from '../../moderation/domain/outbound-action.ts';

/**
 * `shadow-acceptance` — the proof that receive-only is real (objective 14).
 *
 * Two modes, deliberately sharing one verdict function.
 *
 *   `--self-test` runs the whole chain offline: an in-memory deployment, three provisioned
 *     receive-only connections, and every payload in `fixtures/meta/` posted through the real
 *     webhook entry point with a real HMAC over the real bytes. It proves the pipeline end to end
 *     and — the part that matters — that **no outbound action escapes SIMULATED**. It reaches no
 *     network and no database, so CI can gate on it.
 *
 *   Without `--self-test` it attaches to a real deployment and traces the deliveries a real Meta
 *     connection has already produced, applying the same checks to persisted rows.
 *
 * The reason both modes exist, and share code, is that the claim being made is about a *system*,
 * not about a test: "a real Meta event reached us and produced nothing but a simulated decision"
 * has to be checkable against the running deployment, or it is a claim about a fixture.
 */

const USAGE = `usage:
  shadow-acceptance --self-test
  shadow-acceptance --account <id> --connection <id> [--limit N]
  shadow-acceptance --account <id> --raw-event <id>`;

const SELF_TEST_SECRET = 'shadow-acceptance-app-secret';
const SELF_TEST_VERIFY_TOKEN = 'shadow-acceptance-verify-token';
const SELF_TEST_REF = 'secret://shadow-acceptance/app';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args['help'] !== undefined) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (args['self-test'] !== undefined) {
    const report = await selfTest();
    emit(report);
    if (!report.ok) process.exit(1);
    return;
  }

  const accountId = args['account'];
  if (!accountId) throw new TerminalError('ARGS_INVALID', `--account is required\n${USAGE}`);

  const ctx = openCliContext();
  try {
    const account = await ctx.container.accounts.findById(asId(accountId));
    if (!account) throw new TerminalError('ACCOUNT_NOT_FOUND', 'no such account', { accountId });
    const scope = scopeForAccount(account);

    const rawEventIds = args['raw-event']
      ? [asId<RawInboundEventId>(args['raw-event'])]
      : await recentRawEventIds(ctx.container, scope, args);

    const traces: ShadowTrace[] = [];
    for (const rawEventId of rawEventIds) {
      const trace = await traceRawEvent(ctx.container, scope, rawEventId);
      if (trace) traces.push(trace);
    }

    const report = {
      ok: traces.length > 0 && traces.every((trace) => trace.ok),
      traced: traces.length,
      // An empty result is not a pass. "We checked nothing and found nothing wrong" is exactly the
      // shape of a green light nobody should act on.
      note:
        traces.length === 0
          ? 'no deliveries found on this connection; nothing was proven'
          : undefined,
      failures: traces.flatMap((trace) => trace.failures),
      traces,
    };
    emit(report);
    if (!report.ok) process.exit(1);
  } finally {
    await ctx.close();
  }
}

async function recentRawEventIds(
  container: CoreContainer,
  scope: AccountScope,
  args: Readonly<Record<string, string>>,
): Promise<readonly RawInboundEventId[]> {
  const connectionId = args['connection'];
  if (!connectionId) {
    throw new TerminalError('ARGS_INVALID', `--connection or --raw-event is required\n${USAGE}`);
  }
  const limit = Number(args['limit'] ?? '10');
  const events = await container.rawEvents.listByConnection(
    scope,
    asId<ChannelConnectionId>(connectionId),
  );
  return [...events]
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 10)
    .map((event) => event.id);
}

// ------------------------------------------------------------------------------------------------
// Self-test
// ------------------------------------------------------------------------------------------------

export interface SelfTestReport {
  readonly ok: boolean;
  readonly mode: 'self-test';
  readonly fixtures: number;
  readonly deliveriesAccepted: number;
  readonly messagesCreated: number;
  readonly conversationsTouched: number;
  readonly outboundActions: number;
  readonly liveOutboundActions: number;
  /** Drafts waiting for a human. Not live, and reported so the number is visible rather than implied. */
  readonly suggestedOutboundActions: number;
  readonly byClassification: Readonly<Record<string, number>>;
  readonly transport: unknown;
  readonly failures: readonly string[];
}

/**
 * The offline end-to-end proof.
 *
 * Everything the real path does, minus the network: `ingest()` is the same function the HTTP edge
 * calls, the signature is computed over the same bytes the HTTP edge would have hashed, and the
 * worker is the same worker. What is *not* simulated is the safety property being tested.
 */
export async function selfTest(): Promise<SelfTestReport> {
  const failures: string[] = [];
  const clock = createTestClock(new Date('2026-08-27T09:00:00.000Z'));
  const provider = createMockLlmProvider({ clock });
  // `warn` unless the operator asked for more. The report on stdout is the output of this
  // command; log lines interleaved with it are noise a reader has to learn to ignore.
  const config = { ...loadConfig(), outboundMode: 'SIMULATE' as const };
  const level = process.env['LOG_LEVEL'] ? config.logLevel : 'warn';
  const container = createContainer({
    config: { ...config, logLevel: level },
    clock,
    ids: createDeterministicIdFactory(),
    logger: createLogger({ level, now: () => clock.now() }),
    provider,
    secrets: new Map([
      [SELF_TEST_REF, { appSecret: SELF_TEST_SECRET, verifyToken: SELF_TEST_VERIFY_TOKEN }],
    ]),
  });

  /*
   * The model is scripted to *want* to reply, on every run.
   *
   * This is the whole point of the self-test. A moderator that never reaches a decision produces
   * no outbound action, and "no outbound action was live" would then be true for the trivial
   * reason that there were none — a green light proving nothing. So the model proposes a reply
   * every time, the policy gate authorises it, an outbound action is written for every
   * conversation, and only then does the SIMULATED assertion carry weight.
   */
  provider.script({
    kind: 'RESPOND',
    text: JSON.stringify({
      intent: { code: 'GENERAL_QUESTION', confidence: 0.9 },
      entities: {},
      proposed_action: 'ASK_CLARIFICATION',
      reply_text: 'Could you tell me a little more about what you need?',
      knowledge_refs: [],
      needs_human: false,
      confidence: 0.9,
    }),
  });

  const account: Account = {
    id: asId<AccountId>('acc_shadow'),
    slug: 'shadow-acceptance',
    name: 'Shadow Acceptance',
    status: 'ACTIVE',
    defaultLocale: 'en',
    timezone: 'UTC',
    createdAt: clock.now(),
  };
  await container.accounts.save(account);
  const scope = scopeForAccount(account);
  await container.packs.save(scope, buildPack(account.id, clock.now()));

  const identities = loadManifest().identities;

  // One connection per channel, provisioned through the same code path an operator uses. The
  // WhatsApp connection owns both identities so a delivery naming the WABA is still attributable
  // while the routable identity remains the phone number.
  const webhookIds = new Map<Channel, string>();
  for (const [channel, externalId, extra] of [
    ['FACEBOOK', identities.facebookPageId, []],
    ['INSTAGRAM', identities.instagramAccountId, []],
    [
      'WHATSAPP',
      identities.whatsappPhoneNumberId,
      [
        {
          kind: 'WHATSAPP_BUSINESS_ACCOUNT',
          externalId: identities.whatsappBusinessAccountId,
        } satisfies ProviderIdentity,
      ],
    ],
  ] as const) {
    const result = await provisionMetaConnection(
      {
        connections: container.connections,
        secrets: { resolve: (ref) => resolveSelfTestSecret(ref) },
        ids: container.ids,
      },
      scope,
      {
        channel,
        externalId,
        additionalIdentities: extra,
        credentialsRef: SELF_TEST_REF,
        subscriptionState: 'SUBSCRIBED',
      },
    );
    if (result.connection.transportMode !== 'RECEIVE_ONLY') {
      failures.push(`${channel} connection was not provisioned RECEIVE_ONLY`);
    }
    for (const capability of result.connection.capabilities) {
      if (capability.startsWith('SEND') || capability === 'REACT') {
        failures.push(`${channel} connection holds a send capability: ${capability}`);
      }
    }
    webhookIds.set(channel, result.connection.publicWebhookId);
  }

  // --- verify the subscription handshake on every connection ------------------------------------
  for (const [channel, webhookId] of webhookIds) {
    const verified = await container.ingest.verifySubscription({
      publicWebhookId: webhookId,
      mode: 'subscribe',
      verifyToken: SELF_TEST_VERIFY_TOKEN,
      challenge: 'shadow-challenge',
    });
    if (verified.status !== 'VERIFIED' || verified.challenge !== 'shadow-challenge') {
      failures.push(`${channel} subscription handshake did not echo the challenge`);
    }
    const wrongToken = await container.ingest.verifySubscription({
      publicWebhookId: webhookId,
      mode: 'subscribe',
      verifyToken: 'not-the-token',
      challenge: 'shadow-challenge',
    });
    if (wrongToken.status !== 'REJECTED') {
      failures.push(`${channel} accepted a subscription handshake with the wrong token`);
    }
  }

  // --- post every fixture through the real ingest entry point -----------------------------------
  const fixtures = loadAllFixtures();
  let accepted = 0;
  for (const fixture of fixtures) {
    const webhookId = webhookIds.get(fixture.channel);
    if (!webhookId) {
      failures.push(`no connection provisioned for ${fixture.channel}`);
      continue;
    }
    const rawBody = JSON.stringify(fixture.payload);
    const outcome = await container.ingest.ingest({
      publicWebhookId: webhookId,
      rawBody,
      headers: { [META_SIGNATURE_HEADER]: computeMetaSignature(rawBody, SELF_TEST_SECRET) },
    });
    if (outcome.status === 'ACCEPTED') accepted += 1;
    else if (outcome.status !== 'DUPLICATE') {
      failures.push(`${fixture.name} was ${outcome.status} rather than accepted`);
    }

    // A forged signature over the same bytes must be refused, on every channel.
    const forged = await container.ingest.ingest({
      publicWebhookId: webhookId,
      rawBody: `${rawBody} `,
      headers: { [META_SIGNATURE_HEADER]: computeMetaSignature(rawBody, 'wrong-secret') },
    });
    if (forged.status !== 'REJECTED_SIGNATURE') {
      failures.push(`${fixture.name}: a forged signature was ${forged.status}`);
    }
  }

  // --- drain: normalise, then let the debounce elapse and run the moderator ----------------------
  await container.createWorker('shadow', { types: ['raw_event.normalize'] }).drain();
  clock.advanceMs(30_000);
  await container.createWorker('shadow').drain();

  // --- trace every delivery, applying the same checks as the live mode ---------------------------
  const byClassification: Record<string, number> = {};
  let messagesCreated = 0;
  const conversations = new Set<string>();

  for (const event of container.db.tables.rawEvents.values()) {
    if (!event.signatureValid) continue; // The forged deliveries; refused, stored, never traced.
    const trace = await traceRawEvent(container, scope, event.id);
    if (!trace) {
      failures.push('a persisted delivery could not be traced');
      continue;
    }
    if (!trace.ok) failures.push(...trace.failures);
    messagesCreated += trace.messages.length;
    for (const conversation of trace.conversations) conversations.add(conversation.conversationId);
    for (const [name, count] of Object.entries(trace.normalization?.byClassification ?? {})) {
      byClassification[name] = (byClassification[name] ?? 0) + count;
    }
  }

  // --- the load-bearing assertion ----------------------------------------------------------------
  let outboundActions = 0;
  let liveOutboundActions = 0;
  let suggestedOutboundActions = 0;
  for (const action of container.db.tables.outbound.values()) {
    outboundActions += 1;
    // Two independent conditions, and either one alone makes an action "live".
    //
    // The mode check is the original one, narrowed from "not SIMULATED" to "AUTONOMOUS": Phase
    // 02C introduced SUGGESTED, which means the *opposite* of a send — a draft deliberately kept
    // out of the dispatch queue until a named person accepts it and sends it themselves.
    //
    // The state check is new, and it is the stronger of the two. It asserts against the state
    // machine rather than against a label, so an action that somehow acquired a dispatch state
    // while still calling itself SUGGESTED is caught here even though its mode looks safe.
    const liveMode = action.deliveryMode === 'AUTONOMOUS';
    const liveState = LIVE_OUTBOUND_STATES.has(action.state);
    if (action.deliveryMode === 'SUGGESTED') suggestedOutboundActions += 1;
    if (liveMode || liveState) {
      liveOutboundActions += 1;
      failures.push(
        `outbound action ${action.id} is live: mode ${action.deliveryMode}, state ${action.state}`,
      );
    }
  }

  if (messagesCreated === 0) {
    failures.push('no messages were created, so nothing about the pipeline was proven');
  }
  if (outboundActions === 0) {
    // Without this the SIMULATED assertion is vacuous: zero live actions out of zero actions.
    failures.push('no outbound action was produced, so the receive-only guarantee was not tested');
  }
  if (container.db.tables.deadLetters.length > 0) {
    failures.push(`${String(container.db.tables.deadLetters.length)} jobs dead-lettered`);
  }
  if (accepted === 0) failures.push('no deliveries were accepted');
  // Every echo in the corpus must have been classified as one. If this is zero the loop-breaker
  // was not exercised, whatever else passed.
  const echoes =
    (byClassification['ECHO_SELF_MESSAGE'] ?? 0) + (byClassification['ECHO_SELF_COMMENT'] ?? 0);
  if (echoes === 0) failures.push('no echo was classified, so the loop-breaker was not exercised');

  return {
    ok: failures.length === 0,
    mode: 'self-test',
    fixtures: fixtures.length,
    deliveriesAccepted: accepted,
    messagesCreated,
    conversationsTouched: conversations.size,
    outboundActions,
    liveOutboundActions,
    suggestedOutboundActions,
    byClassification,
    transport: container.metrics.snapshot(),
    failures,
  };
}

function resolveSelfTestSecret(
  ref: string,
): Promise<{ appSecret: string; verifyToken?: string } | null> {
  return Promise.resolve(
    ref === SELF_TEST_REF
      ? { appSecret: SELF_TEST_SECRET, verifyToken: SELF_TEST_VERIFY_TOKEN }
      : null,
  );
}

/** A minimal synthetic pack. No client business content lives in this repository (ADR-010). */
function buildPack(accountId: AccountId, now: Date): AccountPackVersion {
  const sections = {
    profile: { display_name: 'Shadow Acceptance' },
    brand_voice: { tone: 'Neutral and concise.' },
    intent_taxonomy: {
      intents: [
        { code: 'GENERAL_QUESTION', description: 'A general question', requires_knowledge: true },
        { code: 'SMALL_TALK', description: 'Greeting or thanks' },
      ],
    },
    routing: { debounce_ms: 2_500, max_delay_ms: 8_000 },
    authority_matrix: {
      rules: [
        { surface: '*', action: 'NO_ACTION', effect: 'ALLOW' },
        { surface: '*', action: 'REQUEST_HUMAN_HANDOFF', effect: 'ALLOW' },
        { surface: 'DIRECT_MESSAGE', action: 'ANSWER_FROM_KNOWLEDGE', effect: 'ALLOW' },
        { surface: 'DIRECT_MESSAGE', action: 'ASK_CLARIFICATION', effect: 'ALLOW' },
        { surface: 'PUBLIC_COMMENT', action: 'MOVE_TO_DIRECT_MESSAGE', effect: 'ALLOW' },
      ],
    },
    escalation: {
      handoff_sla_ms: 900_000,
      handoff_fallback_to_ai: false,
      insufficient_knowledge_action: 'REQUEST_HUMAN_HANDOFF',
    },
  };
  const pack: AccountPackVersion = {
    id: asId<AccountPackVersionId>('apv_shadow'),
    accountId,
    version: 1,
    status: 'ACTIVE',
    contentHash: hashJson(sections),
    sections,
    publishedBy: asId<UserId>('usr_shadow'),
    publishedAt: now,
    schemaVersion: PACK_SCHEMA_VERSION,
    notes: 'synthetic shadow-acceptance pack',
  };
  const issues = validatePack(pack);
  if (issues.length > 0) {
    const described = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new TerminalError('PACK_INVALID', `self-test pack invalid: ${described}`);
  }
  return pack;
}

await main().catch(fail);
