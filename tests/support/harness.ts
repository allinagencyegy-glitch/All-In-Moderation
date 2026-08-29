import type { Account, AccountScope } from '../../src/core/account/index.ts';
import { scopeForAccount } from '../../src/core/account/index.ts';
import type { TestClock } from '../../src/platform/clock.ts';
import { createTestClock } from '../../src/platform/clock.ts';
import { createDeterministicIdFactory } from '../../src/platform/ids.ts';
import { asId } from '../../src/platform/ids.ts';
import type {
  AccountId,
  AccountPackVersionId,
  ChannelConnectionId,
  KnowledgeEntryId,
  UserId,
} from '../../src/platform/ids.ts';
import { createMemoryLogger } from '../../src/platform/logger.ts';
import { hashJson } from '../../src/platform/hash.ts';
import {
  computeMetaSignature,
  META_SIGNATURE_HEADER,
} from '../../src/integrations/meta/signature.ts';
import { createMockLlmProvider } from '../../src/integrations/llm/mock-provider.ts';
import type { MockLlmProvider } from '../../src/integrations/llm/mock-provider.ts';
import type { Channel, Surface } from '../../src/core/channel.ts';
import type { ChannelConnection } from '../../src/moderation/domain/channel.ts';
import type {
  ConnectionCapability,
  ProviderIdentity,
  TransportMode,
} from '../../src/moderation/domain/provider.ts';
import { defaultIdentityKind, receiveCapabilityFor } from '../../src/moderation/domain/provider.ts';
import type { KnowledgeEntry } from '../../src/knowledge/domain/knowledge-entry.ts';
import type { AccountPackVersion } from '../../src/knowledge/domain/account-pack.ts';
import { PACK_SCHEMA_VERSION } from '../../src/knowledge/domain/account-pack.ts';
import type { ChannelSecrets } from '../../src/moderation/ports.ts';
import type { IngestOutcome } from '../../src/moderation/application/ingest-webhook.ts';
import type { Container, CoreContainer } from '../../src/runtime/container.ts';
import { createContainer } from '../../src/runtime/container.ts';
import type { RuntimeConfig } from '../../src/runtime/config.ts';
import type { JobType } from '../../src/operations/jobs/job.ts';

/**
 * Test harness.
 *
 * Everything here is synthetic. There is no client content anywhere in this file, by design: the
 * whole point of Phase 0 is that the runtime carries no business semantics, and a fixture that
 * quietly encoded a real client's intents or prices would undermine exactly the property we are
 * trying to hold (ADR-010).
 */

export const TEST_APP_SECRET = 'test-app-secret';
export const TEST_VERIFY_TOKEN = 'test-verify-token';
export const TEST_CREDENTIALS_REF = 'secret://test/app';

/**
 * The secret bundle every harness resolves.
 *
 * Both halves are present because the webhook lifecycle has two halves: the provider verifies the
 * subscription with `verifyToken` once, then signs every delivery with `appSecret`. A fixture
 * carrying only the second could not exercise the handshake at all.
 */
export const TEST_SECRETS = new Map([
  [TEST_CREDENTIALS_REF, { appSecret: TEST_APP_SECRET, verifyToken: TEST_VERIFY_TOKEN }],
]);

export interface SeedOptions {
  readonly slug?: string;
  readonly accountStatus?: Account['status'];
  readonly webhookId?: string;
  readonly pageId?: string;
  readonly withPack?: boolean;
  readonly debounceMs?: number;
  readonly maxDelayMs?: number;
  readonly insufficientKnowledgeAction?: 'ASK_CLARIFICATION' | 'REQUEST_HUMAN_HANDOFF';
  /** Transport shape. Defaults reproduce a Facebook Page in receive-only mode. */
  readonly channel?: Channel;
  readonly supportedSurfaces?: readonly Surface[];
  /** Defaults to `supportedSurfaces`. Set `[]` to test a connection with nothing turned on. */
  readonly enabledSurfaces?: readonly Surface[];
  readonly identities?: readonly ProviderIdentity[];
  readonly capabilities?: readonly ConnectionCapability[];
  readonly transportMode?: TransportMode;
  readonly connectionStatus?: ChannelConnection['status'];
}

export interface SeededAccount {
  readonly account: Account;
  readonly scope: AccountScope;
  readonly connection: ChannelConnection;
  readonly packId: AccountPackVersionId | null;
}

/**
 * The harness, parameterised by container type.
 *
 * The seeding and driving logic is identical whether the store is a Map or PostgreSQL - and that
 * is the point. Sharing it means the Postgres suite exercises the same fixtures and the same call
 * sequence as the Phase 0 suite, so a difference in outcome is a difference in the *adapter*
 * rather than in how the two suites happen to be written.
 */
export interface HarnessOver<C extends CoreContainer> {
  readonly container: C;
  readonly clock: TestClock;
  readonly provider: MockLlmProvider;
  readonly logs: ReturnType<typeof createMemoryLogger>['records'];
  seedAccount(options?: SeedOptions): Promise<SeededAccount>;
  seedKnowledge(scope: AccountScope, entry: Partial<KnowledgeEntry>): Promise<KnowledgeEntry>;
  postWebhook(
    seeded: SeededAccount,
    body: unknown,
    options?: { signature?: string },
  ): Promise<IngestOutcome>;
  drain(workerId?: string): Promise<number>;
  drainTypes(types: readonly JobType[], workerId?: string): Promise<number>;
}

export type Harness = HarnessOver<Container>;

export const TEST_CONFIG: RuntimeConfig = {
  nodeEnv: 'test',
  role: 'all',
  logLevel: 'debug',
  outboundMode: 'SIMULATE',
  worker: {
    leaseMs: 30_000,
    pollIntervalMs: 10,
    maxAttempts: 3,
    concurrency: 1,
    shutdownGraceMs: 2_000,
  },
  scheduler: { reaperIntervalMs: 50, relayIntervalMs: 50, relayBatchSize: 100 },
  http: {
    // Port 0 asks the OS for a free one, so suites can run in parallel and on a busy machine.
    port: 0,
    host: '127.0.0.1',
    headersTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    shutdownGraceMs: 2_000,
  },
  health: { inboundLagMs: 300_000, outboxLagMs: 300_000, deadLetterCeiling: 0 },
  llm: {
    providerId: 'mock',
    reasonModel: 'mock-model-1',
    timeoutMs: 5_000,
    temperature: 0.2,
    maxOutputTokens: 1_024,
    structuredOutput: true,
  },
  ingest: { maxBodyBytes: 1_000_000 },
};

export function createHarness(
  overrides: {
    config?: Partial<RuntimeConfig>;
    /**
     * The secret bundle this deployment can resolve.
     *
     * Overridable so a suite can build the two configurations that must *fail*: a connection whose
     * reference resolves to nothing, and one that resolves without a verify token. Both are
     * indistinguishable from a provider misbehaving unless they are exercised deliberately.
     */
    secrets?: ReadonlyMap<string, string | ChannelSecrets>;
  } = {},
): Harness {
  const clock = createTestClock();
  const ids = createDeterministicIdFactory();
  const { logger, records } = createMemoryLogger('debug');
  const provider = createMockLlmProvider({ clock });

  const container = createContainer({
    config: { ...TEST_CONFIG, ...overrides.config },
    clock,
    ids,
    logger,
    provider,
    secrets: overrides.secrets ?? TEST_SECRETS,
    // Deterministic backoff: tests assert on scheduled times, not on luck.
    random: () => 0.5,
  });

  return createHarnessOver(container, clock, provider, records);
}

/** Wraps any already-composed container in the harness API. */
export function createHarnessOver<C extends CoreContainer>(
  container: C,
  clock: TestClock,
  provider: MockLlmProvider,
  records: ReturnType<typeof createMemoryLogger>['records'],
): HarnessOver<C> {
  let seedCounter = 0;

  return {
    container,
    clock,
    provider,
    logs: records,

    async seedAccount(options = {}) {
      seedCounter += 1;
      const suffix = String(seedCounter);
      // Seeded ACTIVE so a scope can be minted, then flipped to the requested status. In
      // production an archived account's scope cannot be minted at all — which is the point.
      const active: Account = {
        id: asId<AccountId>(`acc_test_${suffix}`),
        slug: options.slug ?? `demo-${suffix}`,
        name: `Demo Account ${suffix}`,
        status: 'ACTIVE',
        defaultLocale: 'en',
        timezone: 'UTC',
        createdAt: clock.now(),
      };
      await container.accounts.save(active);
      const scope = scopeForAccount(active);
      const account: Account = { ...active, status: options.accountStatus ?? 'ACTIVE' };

      const channel = options.channel ?? 'FACEBOOK';
      const supportedSurfaces = options.supportedSurfaces ?? ['DIRECT_MESSAGE', 'PUBLIC_COMMENT'];
      const enabledSurfaces = options.enabledSurfaces ?? supportedSurfaces;
      const externalId = options.pageId ?? `page-${suffix}`;
      const connection: ChannelConnection = {
        id: asId<ChannelConnectionId>(`chc_test_${suffix}`),
        accountId: account.id,
        channel,
        provider: 'META',
        supportedSurfaces,
        enabledSurfaces,
        externalId,
        identities: options.identities ?? [{ kind: defaultIdentityKind(channel), externalId }],
        // Derived from what is enabled, so the default seed is always internally consistent. A
        // test that wants an inconsistent connection has to ask for one explicitly.
        capabilities: options.capabilities ?? enabledSurfaces.map(receiveCapabilityFor),
        transportMode: options.transportMode ?? 'RECEIVE_ONLY',
        subscriptionState: 'SUBSCRIBED',
        publicWebhookId: options.webhookId ?? `hook-${suffix}`,
        credentialsRef: TEST_CREDENTIALS_REF,
        status: options.connectionStatus ?? 'ACTIVE',
        settings: {},
      };
      await container.connections.save(connection);

      let packId: AccountPackVersionId | null = null;
      if (options.withPack !== false) {
        const pack = buildPack(account.id, {
          debounceMs: options.debounceMs ?? 2_500,
          maxDelayMs: options.maxDelayMs ?? 8_000,
          insufficientKnowledgeAction:
            options.insufficientKnowledgeAction ?? 'REQUEST_HUMAN_HANDOFF',
        });
        await container.packs.save(scope, pack);
        packId = pack.id;
      }

      if (account.status !== 'ACTIVE') await container.accounts.save(account);
      return { account, scope, connection, packId };
    },

    async seedKnowledge(scope, entry) {
      const id = entry.id ?? asId<KnowledgeEntryId>(`kne_${String(++seedCounter)}`);
      const full: KnowledgeEntry = {
        id,
        accountId: scope.accountId,
        kind: entry.kind ?? 'FAQ',
        title: entry.title ?? 'Opening hours',
        body: entry.body ?? 'We are open Monday to Friday.',
        locale: entry.locale ?? 'en',
        status: entry.status ?? 'APPROVED',
        validFrom: entry.validFrom ?? null,
        validUntil: entry.validUntil ?? null,
        sourceRef: entry.sourceRef ?? null,
        evidence: entry.evidence ?? null,
        approvedBy: entry.approvedBy ?? asId<UserId>('usr_test'),
        approvedAt: entry.approvedAt ?? clock.now(),
        productRef: entry.productRef ?? null,
        paymentType: entry.paymentType ?? null,
        price: entry.price ?? null,
        tags: entry.tags ?? ['hours'],
        intentCodes: entry.intentCodes ?? ['GENERAL_QUESTION'],
        supersedesId: entry.supersedesId ?? null,
        updatedAt: entry.updatedAt ?? clock.now(),
      };
      await container.knowledge.save(scope, full);
      return full;
    },

    postWebhook(seeded, body, options = {}) {
      const raw = JSON.stringify(body);
      const signature = options.signature ?? computeMetaSignature(raw, TEST_APP_SECRET);
      return container.ingest.ingest({
        publicWebhookId: seeded.connection.publicWebhookId,
        rawBody: raw,
        headers: { [META_SIGNATURE_HEADER]: signature },
      });
    },

    drain(workerId = 'worker-1') {
      return container.createWorker(workerId).drain();
    },

    drainTypes(types, workerId = 'worker-1') {
      return container.createWorker(workerId, { types }).drain();
    },
  };
}

// --- envelope builders ------------------------------------------------------------------------

export interface MessageSpec {
  readonly senderId: string;
  readonly mid: string;
  readonly text: string;
  readonly timestampMs?: number;
}

export function metaMessageEnvelope(
  pageId: string,
  messages: readonly MessageSpec[],
  baseTimestampMs = 1_767_225_600_000,
): unknown {
  return {
    object: 'page',
    entry: [
      {
        id: pageId,
        time: baseTimestampMs,
        messaging: messages.map((m, index) => ({
          sender: { id: m.senderId },
          recipient: { id: pageId },
          timestamp: m.timestampMs ?? baseTimestampMs + index * 1000,
          message: { mid: m.mid, text: m.text },
        })),
      },
    ],
  };
}

export function metaCommentEnvelope(
  pageId: string,
  comment: {
    commentId: string;
    postId: string;
    fromId: string;
    text: string;
    createdSeconds?: number;
  },
): unknown {
  return {
    object: 'page',
    entry: [
      {
        id: pageId,
        time: 1_767_225_600_000,
        changes: [
          {
            field: 'feed',
            value: {
              item: 'comment',
              verb: 'add',
              comment_id: comment.commentId,
              post_id: comment.postId,
              from: { id: comment.fromId },
              message: comment.text,
              created_time: comment.createdSeconds ?? 1_767_225_600,
            },
          },
        ],
      },
    ],
  };
}

export function metaEchoEnvelope(pageId: string, senderId: string, mid: string): unknown {
  return {
    object: 'page',
    entry: [
      {
        id: pageId,
        time: 1_767_225_600_000,
        messaging: [
          {
            sender: { id: pageId },
            recipient: { id: senderId },
            timestamp: 1_767_225_600_000,
            message: { mid, text: 'previous outbound', is_echo: true },
          },
        ],
      },
    ],
  };
}

// --- model output builders --------------------------------------------------------------------

export interface DecisionOverrides {
  readonly intentCode?: string;
  readonly confidence?: number;
  readonly action?: string;
  readonly replyText?: string;
  readonly knowledgeRefs?: readonly string[];
  readonly needsHuman?: boolean;
  readonly handoffReason?: string;
  readonly tags?: readonly string[];
}

/** A schema-valid decision. Tests that want invalid output should hand-write the JSON. */
export function decisionJson(overrides: DecisionOverrides = {}): string {
  const decision: Record<string, unknown> = {
    intent: {
      code: overrides.intentCode ?? 'GENERAL_QUESTION',
      confidence: overrides.confidence ?? 0.9,
    },
    proposed_action: overrides.action ?? 'ANSWER_FROM_KNOWLEDGE',
    knowledge_refs: overrides.knowledgeRefs ?? [],
    needs_human: overrides.needsHuman ?? false,
    confidence: overrides.confidence ?? 0.9,
  };
  if (overrides.replyText !== undefined) decision['reply_text'] = overrides.replyText;
  if (overrides.handoffReason !== undefined) decision['handoff_reason'] = overrides.handoffReason;
  if (overrides.tags !== undefined) decision['tags'] = overrides.tags;
  return JSON.stringify(decision);
}

// --- pack builder ------------------------------------------------------------------------------

export function buildPack(
  accountId: AccountId,
  options: {
    debounceMs: number;
    maxDelayMs: number;
    insufficientKnowledgeAction: 'ASK_CLARIFICATION' | 'REQUEST_HUMAN_HANDOFF';
  },
): AccountPackVersion {
  const sections = {
    profile: { display_name: 'Demo Account' },
    brand_voice: { tone: 'Neutral and concise.' },
    intent_taxonomy: {
      intents: [
        { code: 'GENERAL_QUESTION', description: 'A general question', requires_knowledge: true },
        { code: 'PRICE_INQUIRY', description: 'Asking about price', requires_knowledge: true },
        { code: 'COMPLAINT', description: 'A complaint', escalate: true },
        { code: 'SMALL_TALK', description: 'Greeting or thanks' },
      ],
    },
    routing: { debounce_ms: options.debounceMs, max_delay_ms: options.maxDelayMs },
    authority_matrix: {
      rules: [
        { surface: '*', action: 'NO_ACTION', effect: 'ALLOW' },
        { surface: '*', action: 'ADD_TAG', effect: 'ALLOW' },
        { surface: '*', action: 'REQUEST_HUMAN_HANDOFF', effect: 'ALLOW' },
        { surface: 'DIRECT_MESSAGE', action: 'ANSWER_FROM_KNOWLEDGE', effect: 'ALLOW' },
        { surface: 'DIRECT_MESSAGE', action: 'ASK_CLARIFICATION', effect: 'ALLOW' },
        { surface: 'PUBLIC_COMMENT', action: 'MOVE_TO_DIRECT_MESSAGE', effect: 'ALLOW' },
        { surface: 'PUBLIC_COMMENT', action: 'PUBLIC_REPLY', effect: 'REQUIRE_APPROVAL' },
      ],
    },
    escalation: {
      handoff_sla_ms: 900_000,
      handoff_fallback_to_ai: false,
      insufficient_knowledge_action: options.insufficientKnowledgeAction,
    },
  };
  return {
    id: asId<AccountPackVersionId>(`apv_${accountId}`),
    accountId,
    version: 1,
    status: 'ACTIVE',
    contentHash: hashJson(sections),
    sections,
    publishedBy: asId<UserId>('usr_test'),
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    schemaVersion: PACK_SCHEMA_VERSION,
    notes: null,
  };
}
