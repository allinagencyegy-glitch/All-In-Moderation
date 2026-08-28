import { randomBytes } from 'node:crypto';
import type { Clock } from '../platform/clock.ts';
import { systemClock } from '../platform/clock.ts';
import type { IdFactory } from '../platform/ids.ts';
import { createUlidIdFactory } from '../platform/ids.ts';
import type { Logger } from '../platform/logger.ts';
import { createLogger } from '../platform/logger.ts';
import type { AccountRepository } from '../core/account/index.ts';
import { scopeForAccount } from '../core/account/index.ts';
import type {
  ChannelConnectionRepository,
  ChannelIdentityRepository,
  ChannelSecrets,
  ConversationRepository,
  HandoffRepository,
  MessageRepository,
  ModeratorRunRepository,
  OutboundActionRepository,
  RawInboundEventRepository,
  SecretResolver,
} from '../moderation/ports.ts';
import type {
  AccountPackRepository,
  KnowledgeGapRepository,
  KnowledgeRepository,
} from '../knowledge/ports.ts';
import type { AuditLog } from '../operations/audit.ts';
import type { DeadLetterStore } from '../operations/dead-letter.ts';
import type { EventOutbox } from '../operations/events/outbox.ts';
import type { OutboxRelay, OutboxRelayStore, RelayTarget } from '../operations/events/relay.ts';
import { createOutboxRelay, createSimulatedRelayTarget } from '../operations/events/relay.ts';
import type { HealthService, StoreProbe } from '../operations/health.ts';
import { createHealthService } from '../operations/health.ts';
import type { MetricsRegistry } from '../operations/metrics.ts';
import { createMetricsRegistry } from '../operations/metrics.ts';
import type { JobQueue } from '../operations/jobs/queue.ts';
import type { TransactionRunner } from '../operations/transaction.ts';
import { createKnowledgeGate } from '../knowledge/application/knowledge-gate.ts';
import type { LlmProvider, ModelResolver } from '../platform/llm/provider.ts';
import { createStaticModelResolver } from '../platform/llm/provider.ts';
import { createMockLlmProvider } from '../integrations/llm/mock-provider.ts';
import { metaSignatureVerifier } from '../integrations/meta/signature.ts';
import { metaEnvelopeParser } from '../integrations/meta/webhook-parser.ts';
import type { MockLlmProvider } from '../integrations/llm/mock-provider.ts';
import { createWorker } from '../operations/jobs/worker.ts';
import type { Worker } from '../operations/jobs/worker.ts';
import type { DeadLetterHandler, JobHandler } from '../operations/jobs/worker.ts';
import { createDeadLetterSink } from '../operations/jobs/dead-letter-sink.ts';
import { createReaper } from '../operations/jobs/reaper.ts';
import type { Reaper } from '../operations/jobs/reaper.ts';
import type { JobType } from '../operations/jobs/job.ts';
import { TerminalError } from '../platform/errors.ts';
import { asId } from '../platform/ids.ts';
import type { AccountId, ConversationId, RawInboundEventId } from '../platform/ids.ts';
import { createIngestWebhookService } from '../moderation/application/ingest-webhook.ts';
import { createNormalizeEventService } from '../moderation/application/normalize-event.ts';
import { createRunModeratorService } from '../moderation/application/run-moderator.ts';
import { createEscalationService } from '../moderation/application/escalate.ts';
import { createTakeoverService } from '../moderation/application/takeover.ts';
import { createMemoryDatabase } from '../adapters/memory/database.ts';
import type { MemoryDatabase } from '../adapters/memory/database.ts';
import { createMemoryJobQueue } from '../adapters/memory/job-queue.ts';
import {
  createMemoryAccountPackRepository,
  createMemoryAccountRepository,
  createMemoryAuditLog,
  createMemoryChannelConnectionRepository,
  createMemoryChannelIdentityRepository,
  createMemoryConversationRepository,
  createMemoryDeadLetterStore,
  createMemoryEventOutbox,
  createMemoryHandoffRepository,
  createMemoryKnowledgeGapRepository,
  createMemoryKnowledgeRepository,
  createMemoryMessageRepository,
  createMemoryModeratorRunRepository,
  createMemoryOutboundActionRepository,
  createMemoryOutboxRelayStore,
  createMemoryRawInboundEventRepository,
  createMemorySecretResolver,
  createMemoryStoreProbe,
} from '../adapters/memory/repositories.ts';
import type { RuntimeConfig } from './config.ts';
import { loadConfig } from './config.ts';

/**
 * The composition root.
 *
 * This is the only place in the codebase that knows which concrete adapters are in use. Every
 * module above it depends on ports, which is what makes the Phase 1 swap to Postgres a change to
 * this file plus a new adapter directory — and nothing else.
 */

/**
 * The set of ports the composition root needs, as one swappable unit.
 *
 * Phase 0 predicted the Postgres swap would be "a change to this file plus a new adapter
 * directory - and nothing else". This interface is where that promise is cashed: the memory
 * bundle and the Postgres bundle satisfy it identically, and every service below is built from it
 * without knowing which one it got.
 */
export interface Persistence {
  readonly transactions: TransactionRunner;
  readonly accounts: AccountRepository;
  readonly connections: ChannelConnectionRepository;
  readonly rawEvents: RawInboundEventRepository;
  readonly identities: ChannelIdentityRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly runs: ModeratorRunRepository;
  readonly outboundActions: OutboundActionRepository;
  readonly handoffs: HandoffRepository;
  readonly knowledge: KnowledgeRepository;
  readonly packs: AccountPackRepository;
  readonly knowledgeGaps: KnowledgeGapRepository;
  readonly outbox: EventOutbox;
  /** The cross-tenant read side of the outbox. Its own role on Postgres (0007). */
  readonly relay: OutboxRelayStore;
  /** The two cross-tenant aggregates the health snapshot needs, and a real round trip. */
  readonly probe: StoreProbe;
  readonly audit: AuditLog;
  readonly deadLetters: DeadLetterStore;
  readonly queue: JobQueue;
  readonly secrets: SecretResolver;
}

export interface CoreContainer {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly accounts: AccountRepository;
  readonly provider: LlmProvider;
  readonly models: ModelResolver;
  readonly ingest: ReturnType<typeof createIngestWebhookService>;
  readonly normalize: ReturnType<typeof createNormalizeEventService>;
  readonly moderator: ReturnType<typeof createRunModeratorService>;
  readonly takeover: ReturnType<typeof createTakeoverService>;
  readonly escalation: ReturnType<typeof createEscalationService>;
  readonly queue: JobQueue;
  readonly deadLetters: DeadLetterStore;
  readonly outbox: EventOutbox;
  readonly audit: AuditLog;
  readonly knowledge: KnowledgeRepository;
  readonly packs: AccountPackRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly runs: ModeratorRunRepository;
  readonly outboundActions: OutboundActionRepository;
  readonly handoffs: HandoffRepository;
  readonly knowledgeGaps: KnowledgeGapRepository;
  readonly connections: ChannelConnectionRepository;
  readonly rawEvents: RawInboundEventRepository;
  /**
   * Crash recovery. Returns expired leases to READY and gives lease-expiry dead letters the same
   * operator visibility and human escalation a worker failure gets (ADR-004).
   */
  readonly reaper: Reaper;
  /**
   * The outbox relay. Runs on a timer rather than as a queued job: it is cross-tenant by nature,
   * and a per-account job row would need an account to belong to before it could ask which
   * accounts have pending events.
   */
  readonly relay: OutboxRelay;
  readonly relayTarget: RelayTarget;
  readonly health: HealthService;
  /** Inbound transport counters, shared by ingest, normalisation and the health snapshot. */
  readonly metrics: MetricsRegistry;
  createWorker(
    workerId: string,
    options?: { leaseMs?: number; types?: readonly JobType[] },
  ): Worker;
}

/** The in-memory container, which additionally exposes the store itself for assertions. */
export interface Container extends CoreContainer {
  readonly db: MemoryDatabase;
}

export interface ContainerOptions {
  readonly config?: RuntimeConfig;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly logger?: Logger;
  readonly provider?: LlmProvider | MockLlmProvider;
  readonly secrets?: ReadonlyMap<string, string | ChannelSecrets>;
  readonly random?: () => number;
  /**
   * Where relayed domain events go. Absent means the simulated sink, which reaches no network —
   * the only destination authorised in this phase.
   */
  readonly relayTarget?: RelayTarget;
  /** When this process started, for uptime. Injected so a health snapshot is assertable. */
  readonly startedAt?: Date;
  readonly isShuttingDown?: () => boolean;
  /** Injected so a test can assert on transport counters without reaching into the container. */
  readonly metrics?: MetricsRegistry;
}

/** Assembles the in-memory persistence bundle. The Phase 0 default. */
export function createMemoryPersistence(
  db: MemoryDatabase,
  ids: IdFactory,
  secrets: ReadonlyMap<string, string | ChannelSecrets>,
): Persistence {
  return {
    transactions: db.transactions,
    accounts: createMemoryAccountRepository(db),
    connections: createMemoryChannelConnectionRepository(db),
    rawEvents: createMemoryRawInboundEventRepository(db),
    identities: createMemoryChannelIdentityRepository(db, ids),
    conversations: createMemoryConversationRepository(db),
    messages: createMemoryMessageRepository(db),
    runs: createMemoryModeratorRunRepository(db),
    outboundActions: createMemoryOutboundActionRepository(db),
    handoffs: createMemoryHandoffRepository(db),
    knowledge: createMemoryKnowledgeRepository(db),
    packs: createMemoryAccountPackRepository(db),
    knowledgeGaps: createMemoryKnowledgeGapRepository(db),
    outbox: createMemoryEventOutbox(db),
    relay: createMemoryOutboxRelayStore(db),
    probe: createMemoryStoreProbe(db),
    audit: createMemoryAuditLog(db, ids),
    deadLetters: createMemoryDeadLetterStore(db),
    queue: createMemoryJobQueue(db),
    secrets: createMemorySecretResolver(secrets),
  };
}

/**
 * Builds every service from a persistence bundle.
 *
 * Nothing below this line mentions a concrete adapter. Pointing the platform at PostgreSQL is a
 * different argument to this function, not a different code path through it - which is the only
 * way the Postgres proof can claim to exercise the *same* system the memory tests do.
 */
export function createContainerWith(
  persistence: Persistence,
  options: ContainerOptions = {},
): CoreContainer {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? systemClock;
  const ids =
    options.ids ??
    createUlidIdFactory(
      (n) => randomBytes(n),
      () => clock.nowMs(),
    );
  const logger = options.logger ?? createLogger({ level: config.logLevel, now: () => clock.now() });
  // One registry for the whole process. Injectable so a test can assert on it, and so a suite
  // that builds two containers does not see one's counts in the other's snapshot.
  const metrics = options.metrics ?? createMetricsRegistry();

  const {
    accounts,
    connections,
    rawEvents,
    identities,
    conversations,
    messages,
    runs,
    outboundActions,
    handoffs,
    knowledge,
    packs,
    knowledgeGaps,
    outbox,
    audit,
    deadLetters,
    queue,
    secrets,
  } = persistence;
  const transactions = persistence.transactions;

  const provider = options.provider ?? createMockLlmProvider({ clock });
  const models = createStaticModelResolver({
    REASON: {
      providerId: provider.id,
      model: config.llm.reasonModel,
      temperature: config.llm.temperature,
      maxOutputTokens: config.llm.maxOutputTokens,
      timeoutMs: config.llm.timeoutMs,
    },
    CLASSIFY: {
      providerId: provider.id,
      model: config.llm.reasonModel,
      temperature: 0,
      maxOutputTokens: 256,
      timeoutMs: config.llm.timeoutMs,
    },
    VISION: {
      providerId: provider.id,
      model: config.llm.reasonModel,
      temperature: 0,
      maxOutputTokens: 512,
      timeoutMs: config.llm.timeoutMs,
    },
    TRANSCRIBE: {
      providerId: provider.id,
      model: config.llm.reasonModel,
      temperature: 0,
      maxOutputTokens: 512,
      timeoutMs: config.llm.timeoutMs,
    },
  });

  const knowledgeGate = createKnowledgeGate(knowledge);

  const ingest = createIngestWebhookService({
    connections,
    accounts,
    rawEvents,
    secrets,
    // Channel adapters are injected here and nowhere else. Adding WhatsApp or TikTok means a new
    // parser/verifier pair plus one line in this file — the domain does not change.
    signatures: metaSignatureVerifier,
    queue,
    transactions,
    clock,
    ids,
    logger,
    metrics,
    config: {
      maxBodyBytes: config.ingest.maxBodyBytes,
      normalizeMaxAttempts: config.worker.maxAttempts,
    },
  });

  const normalize = createNormalizeEventService({
    rawEvents,
    connections,
    accounts,
    identities,
    conversations,
    messages,
    packs,
    parser: metaEnvelopeParser,
    queue,
    outbox,
    transactions,
    clock,
    ids,
    logger,
    metrics,
    config: { moderatorMaxAttempts: config.worker.maxAttempts },
  });

  const moderator = createRunModeratorService({
    accounts,
    connections,
    conversations,
    messages,
    runs,
    outbound: outboundActions,
    handoffs,
    packs,
    knowledgeGate,
    knowledgeGaps,
    provider,
    models,
    queue,
    outbox,
    audit,
    transactions,
    clock,
    ids,
    logger,
    config: {
      simulateOutbound: config.outboundMode === 'SIMULATE',
      shadowModeEnabled: false,
      maxAttempts: config.worker.maxAttempts,
    },
  });

  const escalation = createEscalationService({
    conversations,
    handoffs,
    packs,
    outbox,
    audit,
    transactions,
    clock,
    ids,
    logger,
  });

  const takeover = createTakeoverService({
    conversations,
    messages,
    outbound: outboundActions,
    handoffs,
    audit,
    transactions,
    clock,
    ids,
    logger,
  });

  /**
   * Tenancy is re-resolved from the job row, never taken from the payload (ADR-002).
   * A handler that trusted its payload for `account_id` would turn a queue-poisoning bug into a
   * cross-tenant one.
   */
  const scopeForJobAccount = async (accountId: AccountId) => {
    const account = await accounts.findById(accountId);
    if (!account) {
      throw new TerminalError(
        'ACCOUNT_NOT_FOUND',
        'Job references an account that no longer exists',
        {
          accountId,
        },
      );
    }
    return scopeForAccount(account);
  };

  const handlers: Partial<Record<JobType, JobHandler>> = {
    'raw_event.normalize': async (job) => {
      const scope = await scopeForJobAccount(job.accountId);
      const rawEventId = job.payload['rawEventId'];
      if (!rawEventId) throw new TerminalError('JOB_PAYLOAD_INVALID', 'rawEventId missing');
      await normalize.normalize(asId<RawInboundEventId>(rawEventId), scope);
    },
    'moderator.run': async (job, signal) => {
      const scope = await scopeForJobAccount(job.accountId);
      const conversationId = job.payload['conversationId'];
      if (!conversationId) throw new TerminalError('JOB_PAYLOAD_INVALID', 'conversationId missing');
      await moderator.run(asId<ConversationId>(conversationId), scope, signal);
    },
    // `outbound.dispatch` is intentionally absent: Phase 0 records SIMULATED actions and never
    // dispatches. Registering a stub that "succeeds" would make the pipeline look healthy while
    // nothing reached a customer.
    //
    // `outbox.relay` is absent for a different reason. A job row carries an `account_id`, and the
    // relay's first question is "which accounts have pending events?" — which a per-tenant job
    // cannot ask. It runs on a timer instead (see `runtime/application.ts`), and nothing enqueues
    // the job type. Should one ever appear, the worker dead-letters it rather than dropping it.
  };

  /**
   * When moderator work exhausts its retries, a human is asked to take the conversation.
   * Without this the customer would sit behind a queue that quietly ended (F-05, F-20).
   */
  const deadLetterHandlers: Partial<Record<JobType, DeadLetterHandler>> = {
    'moderator.run': async (job, error) => {
      const conversationId = job.payload['conversationId'];
      if (!conversationId) return;
      const scope = await scopeForJobAccount(job.accountId);
      await escalation.escalateUnrecoverable(scope, asId<ConversationId>(conversationId), error);
    },
  };

  // One sink, two callers. The worker reaches it by exhausting attempts; the reaper reaches it by
  // finding an expired lease with none left. Both must record and escalate identically.
  const deadLetterSink = createDeadLetterSink({
    deadLetters,
    handlers: deadLetterHandlers,
    clock,
    logger,
  });

  const reaper = createReaper({
    queue,
    deadLetterSink,
    clock,
    logger: logger.child({ component: 'reaper' }),
  });

  const relayTarget =
    options.relayTarget ?? createSimulatedRelayTarget(logger.child({ component: 'relay-target' }));
  const relay = createOutboxRelay({
    store: persistence.relay,
    target: relayTarget,
    clock,
    logger: logger.child({ component: 'relay' }),
    batchSize: config.scheduler.relayBatchSize,
  });

  const health = createHealthService({
    probe: persistence.probe,
    queue,
    deadLetters,
    clock,
    startedAt: options.startedAt ?? clock.now(),
    identity: {
      role: config.role,
      outboundMode: config.outboundMode,
      nodeEnv: config.nodeEnv,
    },
    isShuttingDown: options.isShuttingDown ?? (() => false),
    metrics,
    thresholds: {
      inboundLagMs: config.health.inboundLagMs,
      outboxLagMs: config.health.outboxLagMs,
      deadLetterCeiling: config.health.deadLetterCeiling,
    },
  });

  return {
    config,
    clock,
    ids,
    logger,
    accounts,
    provider,
    models,
    ingest,
    normalize,
    moderator,
    takeover,
    escalation,
    queue,
    deadLetters,
    outbox,
    audit,
    knowledge,
    packs,
    conversations,
    messages,
    runs,
    outboundActions,
    handoffs,
    knowledgeGaps,
    connections,
    rawEvents,
    reaper,
    relay,
    relayTarget,
    health,
    metrics,
    createWorker(workerId, workerOptions) {
      return createWorker({
        queue,
        handlers,
        deadLetterSink,
        deadLetters,
        clock,
        logger: logger.child({ worker_id: workerId }),
        options: {
          workerId,
          leaseMs: workerOptions?.leaseMs ?? config.worker.leaseMs,
          ...(workerOptions?.types ? { types: workerOptions.types } : {}),
          ...(options.random ? { random: options.random } : {}),
        },
      });
    },
  };
}

/**
 * The default composition root: everything in memory, no network, no database.
 *
 * Unchanged in signature and behaviour from Phase 0 - the Phase 0 suite is the regression test for
 * that, and it must keep passing while the same services run on PostgreSQL next door.
 */
export function createContainer(options: ContainerOptions = {}): Container {
  const db = createMemoryDatabase();
  const clock = options.clock ?? systemClock;
  const ids =
    options.ids ??
    createUlidIdFactory(
      (n) => randomBytes(n),
      () => clock.nowMs(),
    );
  const persistence = createMemoryPersistence(db, ids, options.secrets ?? new Map());
  const core = createContainerWith(persistence, { ...options, ids, clock });
  return { ...core, db };
}
