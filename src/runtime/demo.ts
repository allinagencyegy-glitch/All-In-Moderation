/**
 * A runnable walkthrough of the Phase 0 vertical slice: `npm run demo`.
 *
 * It exercises the real services with the in-memory adapters and a scripted mock model, and
 * narrates what happened at each stage. Nothing here touches a network, and every outbound action
 * is recorded as SIMULATED.
 *
 * The point of the demo is not the happy path — the tests cover that. It is to make the *shape* of
 * the pipeline visible to a reader in one screen: persist, normalise, coalesce, decide, gate,
 * record.
 */
import { createTestClock } from '../platform/clock.ts';
import { createDeterministicIdFactory } from '../platform/ids.ts';
import { asId } from '../platform/ids.ts';
import type {
  AccountId,
  AccountPackVersionId,
  ChannelConnectionId,
  KnowledgeEntryId,
  UserId,
} from '../platform/ids.ts';
import { createLogger } from '../platform/logger.ts';
import { hashJson } from '../platform/hash.ts';
import { scopeForAccount } from '../core/account/index.ts';
import type { Account } from '../core/account/index.ts';
import { createMockLlmProvider } from '../integrations/llm/mock-provider.ts';
import { computeMetaSignature, META_SIGNATURE_HEADER } from '../integrations/meta/signature.ts';
import type { AccountPackVersion } from '../knowledge/domain/account-pack.ts';
import { PACK_SCHEMA_VERSION, validatePack } from '../knowledge/domain/account-pack.ts';
import type { KnowledgeEntry } from '../knowledge/domain/knowledge-entry.ts';
import { createContainer } from './container.ts';
import type { RuntimeConfig } from './config.ts';

const CONFIG: RuntimeConfig = {
  nodeEnv: 'development',
  role: 'all',
  logLevel: 'warn',
  outboundMode: 'SIMULATE',
  worker: { leaseMs: 30_000, pollIntervalMs: 100, maxAttempts: 3 },
  llm: {
    providerId: 'mock',
    reasonModel: 'mock-model-1',
    timeoutMs: 5_000,
    temperature: 0.2,
    maxOutputTokens: 1_024,
  },
  ingest: { maxBodyBytes: 1_000_000 },
};

const APP_SECRET = 'demo-app-secret';
const CREDENTIALS_REF = 'secret://demo/app';
const PAGE_ID = 'demo-page-1';

const say = (line: string): void => console.log(line);

async function main(): Promise<void> {
  const clock = createTestClock(new Date('2026-08-27T09:00:00.000Z'));
  const provider = createMockLlmProvider({ clock });
  const container = createContainer({
    config: CONFIG,
    clock,
    ids: createDeterministicIdFactory(),
    logger: createLogger({ level: 'warn', now: () => clock.now() }),
    provider,
    secrets: new Map([[CREDENTIALS_REF, APP_SECRET]]),
  });

  // --- seed a synthetic account ---------------------------------------------------------------
  const account: Account = {
    id: asId<AccountId>('acc_demo'),
    slug: 'acme-demo',
    name: 'Acme Demo Account',
    status: 'ACTIVE',
    defaultLocale: 'en',
    timezone: 'UTC',
    createdAt: clock.now(),
  };
  await container.accounts.save(account);
  const scope = scopeForAccount(account);

  await container.connections.save({
    id: asId<ChannelConnectionId>('chc_demo'),
    accountId: account.id,
    channel: 'FACEBOOK',
    supportedSurfaces: ['DIRECT_MESSAGE', 'PUBLIC_COMMENT'],
    externalId: PAGE_ID,
    publicWebhookId: 'demo-hook',
    credentialsRef: CREDENTIALS_REF,
    status: 'ACTIVE',
    settings: {},
  });

  const sections = {
    profile: { display_name: 'Acme Demo' },
    brand_voice: { tone: 'Warm, brief, factual.' },
    intent_taxonomy: {
      intents: [
        {
          code: 'PRICE_INQUIRY',
          description: 'Asking about price or payment',
          requires_knowledge: true,
        },
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
      ],
    },
    escalation: {
      handoff_sla_ms: 900_000,
      handoff_fallback_to_ai: false,
      insufficient_knowledge_action: 'REQUEST_HUMAN_HANDOFF',
    },
  };
  const pack: AccountPackVersion = {
    id: asId<AccountPackVersionId>('apv_demo'),
    accountId: account.id,
    version: 1,
    status: 'ACTIVE',
    contentHash: hashJson(sections),
    sections,
    publishedBy: asId<UserId>('usr_demo'),
    publishedAt: clock.now(),
    schemaVersion: PACK_SCHEMA_VERSION,
    notes: 'synthetic demo pack',
  };
  const packIssues = validatePack(pack);
  if (packIssues.length > 0) throw new Error(`demo pack invalid: ${JSON.stringify(packIssues)}`);
  await container.packs.save(scope, pack);

  const offer: KnowledgeEntry = {
    id: asId<KnowledgeEntryId>('kne_demo_price'),
    accountId: account.id,
    kind: 'PRICE',
    title: 'Widget model A price',
    body: 'Model A is 1,250 EUR including delivery.',
    locale: 'en',
    status: 'APPROVED',
    validFrom: null,
    validUntil: new Date('2026-12-31T00:00:00.000Z'),
    sourceRef: 'demo/price-list',
    evidence: 'synthetic demo data',
    approvedBy: asId<UserId>('usr_demo'),
    approvedAt: clock.now(),
    productRef: 'model-a',
    paymentType: 'CASH',
    price: { amount: '1250.00', currency: 'EUR' },
    tags: ['price', 'model', 'installment'],
    intentCodes: ['PRICE_INQUIRY'],
    supersedesId: null,
    updatedAt: clock.now(),
  };
  await container.knowledge.save(scope, offer);

  const expired: KnowledgeEntry = {
    ...offer,
    id: asId<KnowledgeEntryId>('kne_demo_expired'),
    title: 'Last spring promotion',
    body: 'Model A at 990 EUR.',
    validUntil: new Date('2026-05-01T00:00:00.000Z'),
    price: { amount: '990.00', currency: 'EUR' },
  };
  await container.knowledge.save(scope, expired);

  say('All In Moderation — Phase 0 vertical slice');
  say('='.repeat(72));
  say(`account   : ${account.slug} (${account.id})`);
  say(`pack      : v${pack.version} ${pack.id}`);
  say(`knowledge : 1 current price, 1 expired promotion (the expired one must never be used)`);
  say('');

  provider.script({
    kind: 'RESPOND',
    text: JSON.stringify({
      intent: { code: 'PRICE_INQUIRY', confidence: 0.94 },
      entities: { product: 'model A' },
      proposed_action: 'ANSWER_FROM_KNOWLEDGE',
      reply_text: 'Model A is 1,250 EUR including delivery.',
      knowledge_refs: [offer.id],
      needs_human: false,
      confidence: 0.9,
    }),
  });

  // --- a burst of three messages ---------------------------------------------------------------
  const envelopeFor = (mid: string, text: string): string =>
    JSON.stringify({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          time: clock.nowMs(),
          messaging: [
            {
              sender: { id: 'psid-demo-1' },
              recipient: { id: PAGE_ID },
              timestamp: clock.nowMs(),
              message: { mid, text },
            },
          ],
        },
      ],
    });

  const post = async (body: string) =>
    container.ingest.ingest({
      publicWebhookId: 'demo-hook',
      rawBody: body,
      headers: { [META_SIGNATURE_HEADER]: computeMetaSignature(body, APP_SECRET) },
    });

  const burst = ['price?', 'model A', 'installment please'];
  say('1. Inbound: three webhooks arriving within a few seconds');
  let lastBody = '';
  for (const [index, text] of burst.entries()) {
    lastBody = envelopeFor(`m_${index + 1}`, text);
    const outcome = await post(lastBody);
    say(`   "${text}" -> ${outcome.status} (HTTP ${outcome.httpStatus})`);
    await container.createWorker('demo-worker', { types: ['raw_event.normalize'] }).drain();
    clock.advanceMs(900);
  }

  // The identical delivery again, which providers do routinely. Delivery-level deduplication
  // catches it before anything downstream is touched.
  const duplicate = await post(lastBody);
  await container.createWorker('demo-worker', { types: ['raw_event.normalize'] }).drain();
  say(`   identical redelivery -> ${duplicate.status} (HTTP ${duplicate.httpStatus})`);

  // A *re-batched* redelivery: a different body, so only item-level deduplication can catch it.
  const rebatched = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: clock.nowMs() + 1,
        messaging: [
          {
            sender: { id: 'psid-demo-1' },
            recipient: { id: PAGE_ID },
            timestamp: clock.nowMs(),
            message: { mid: 'm_3', text: 'installment please' },
          },
        ],
      },
    ],
  });
  const rebatchedOutcome = await post(rebatched);
  await container.createWorker('demo-worker', { types: ['raw_event.normalize'] }).drain();
  say(
    `   re-batched redelivery -> ${rebatchedOutcome.status}, messages stored: ${container.db.tables.messages.size} (still 3)`,
  );
  say('');

  const conversation = [...container.db.tables.conversations.values()][0]!;
  const moderatorJobs = [...container.db.tables.jobs.values()].filter(
    (j) => j.type === 'moderator.run',
  );
  say('2. Normalised');
  say(
    `   conversation    : ${conversation.id} (${conversation.surface}, ${conversation.ownership})`,
  );
  say(
    `   messages        : ${container.db.tables.messages.size} (seq 1..${conversation.lastInboundSeq})`,
  );
  say(`   watermark       : ${conversation.lastProcessedInboundSeq} (nothing processed yet)`);
  say(`   moderator jobs  : ${moderatorJobs.length} — the burst coalesced onto one run`);
  say('');

  // --- the moderator run ------------------------------------------------------------------------
  say('3. Debounce elapses; the moderator runs once for the whole burst');
  clock.advanceMs(3_000);
  const processed = await container.createWorker('demo-worker').drain();
  say(`   jobs processed  : ${processed}`);

  const run = (await container.runs.listByConversation(scope, conversation.id))[0]!;
  say(`   run             : ${run.state}`);
  say(`   pack pinned     : ${run.packVersionId} / prompt ${run.promptTemplateVersion}`);
  say(
    `   intent          : ${run.decision?.proposal.intent.code} (${run.decision?.proposal.intent.confidence})`,
  );
  say(`   proposed        : ${run.decision?.proposal.proposed_action}`);
  say(`   policy verdict  : ${run.decision?.policyOutcome} — ${run.decision?.policyReason}`);
  say(`   final action    : ${run.decision?.finalAction}`);
  say('');

  const knowledgeShown = provider.calls[0]!.request.turns[0]!.content;
  say('4. What the model was allowed to see');
  say(
    `   current price offered to the model : ${knowledgeShown.includes(offer.id) ? 'yes' : 'no'}`,
  );
  say(
    `   EXPIRED promotion offered          : ${knowledgeShown.includes(expired.id) ? 'yes' : 'no'}  <- must be "no"`,
  );
  say('');

  const actions = await container.outboundActions.listByConversation(scope, conversation.id);
  const after = await container.conversations.findById(scope, conversation.id);
  say('5. Result');
  for (const action of actions) {
    say(`   outbound        : ${action.actionType} [${action.state}/${action.deliveryMode}]`);
    say(`   text            : ${action.payload.text ?? '(none)'}`);
    say(`   idempotency key : ${action.idempotencyKey}`);
  }
  say(
    `   watermark       : ${after!.lastProcessedInboundSeq} (advanced with the decision, in one commit)`,
  );
  say(`   engagement      : ${after!.engagement}`);
  say('');

  const events = await container.outbox.listAll(scope);
  say('6. Domain events queued for downstream systems (outbox, not pushed synchronously)');
  for (const event of events) say(`   ${event.type} -> ${JSON.stringify(event.data)}`);
  say('');

  // --- human takeover ---------------------------------------------------------------------------
  say('7. A human takes the conversation over, then the customer writes again');
  await container.takeover.takeOver(
    scope,
    conversation.id,
    asId<UserId>('usr_operator'),
    'demo takeover',
  );
  await post(envelopeFor('m_4', 'can you call me?'));
  await container.createWorker('demo-worker', { types: ['raw_event.normalize'] }).drain();
  clock.advanceMs(5_000);
  await container.createWorker('demo-worker').drain();

  const runs = await container.runs.listByConversation(scope, conversation.id);
  const lastRun = runs[runs.length - 1]!;
  const finalActions = await container.outboundActions.listByConversation(scope, conversation.id);
  const owned = await container.conversations.findById(scope, conversation.id);
  say(`   ownership       : ${owned!.ownership} (version ${owned!.ownershipVersion})`);
  say(`   last run        : ${lastRun.state} — ${lastRun.skipReason ?? 'no skip reason'}`);
  say(
    `   outbound total  : ${finalActions.length} — unchanged; the AI did not talk over the human`,
  );
  say(
    `   watermark       : ${owned!.lastProcessedInboundSeq} of ${owned!.lastInboundSeq} (the human sees the unanswered message)`,
  );
  say(`   model calls     : ${provider.callCount()}`);
  say('');

  say('='.repeat(72));
  say('Nothing in this run contacted a network. All outbound actions are SIMULATED.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
