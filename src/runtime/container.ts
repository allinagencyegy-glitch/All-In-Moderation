import { randomBytes } from 'node:crypto';
import type { Clock } from '../platform/clock.ts';
import { systemClock } from '../platform/clock.ts';
import type { IdFactory } from '../platform/ids.ts';
import { createUlidIdFactory } from '../platform/ids.ts';
import type { Logger } from '../platform/logger.ts';
import { createLogger } from '../platform/logger.ts';
import type { AccountRepository } from '../core/account/index.ts';
import { scopeForAccount } from '../core/account/index.ts';
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
  createMemoryRawInboundEventRepository,
  createMemorySecretResolver,
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

export interface Container {
  readonly config: RuntimeConfig;
  readonly db: MemoryDatabase;
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
  readonly queue: ReturnType<typeof createMemoryJobQueue>;
  readonly deadLetters: ReturnType<typeof createMemoryDeadLetterStore>;
  readonly outbox: ReturnType<typeof createMemoryEventOutbox>;
  readonly audit: ReturnType<typeof createMemoryAuditLog>;
  readonly knowledge: ReturnType<typeof createMemoryKnowledgeRepository>;
  readonly packs: ReturnType<typeof createMemoryAccountPackRepository>;
  readonly conversations: ReturnType<typeof createMemoryConversationRepository>;
  readonly messages: ReturnType<typeof createMemoryMessageRepository>;
  readonly runs: ReturnType<typeof createMemoryModeratorRunRepository>;
  readonly outboundActions: ReturnType<typeof createMemoryOutboundActionRepository>;
  readonly handoffs: ReturnType<typeof createMemoryHandoffRepository>;
  readonly knowledgeGaps: ReturnType<typeof createMemoryKnowledgeGapRepository>;
  readonly connections: ReturnType<typeof createMemoryChannelConnectionRepository>;
  readonly rawEvents: ReturnType<typeof createMemoryRawInboundEventRepository>;
  /**
   * Crash recovery. Returns expired leases to READY and gives lease-expiry dead letters the same
   * operator visibility and human escalation a worker failure gets (ADR-004).
   */
  readonly reaper: Reaper;
  createWorker(
    workerId: string,
    options?: { leaseMs?: number; types?: readonly JobType[] },
  ): Worker;
}

export interface ContainerOptions {
  readonly config?: RuntimeConfig;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly logger?: Logger;
  readonly provider?: LlmProvider | MockLlmProvider;
  readonly secrets?: ReadonlyMap<string, string>;
  readonly random?: () => number;
}

export function createContainer(options: ContainerOptions = {}): Container {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? systemClock;
  const ids =
    options.ids ??
    createUlidIdFactory(
      (n) => randomBytes(n),
      () => clock.nowMs(),
    );
  const logger = options.logger ?? createLogger({ level: config.logLevel, now: () => clock.now() });

  const db = createMemoryDatabase();
  const accounts = createMemoryAccountRepository(db);
  const connections = createMemoryChannelConnectionRepository(db);
  const rawEvents = createMemoryRawInboundEventRepository(db);
  const identities = createMemoryChannelIdentityRepository(db, ids);
  const conversations = createMemoryConversationRepository(db);
  const messages = createMemoryMessageRepository(db);
  const runs = createMemoryModeratorRunRepository(db);
  const outboundActions = createMemoryOutboundActionRepository(db);
  const handoffs = createMemoryHandoffRepository(db);
  const knowledge = createMemoryKnowledgeRepository(db);
  const packs = createMemoryAccountPackRepository(db);
  const knowledgeGaps = createMemoryKnowledgeGapRepository(db);
  const outbox = createMemoryEventOutbox(db);
  const audit = createMemoryAuditLog(db, ids);
  const deadLetters = createMemoryDeadLetterStore(db);
  const queue = createMemoryJobQueue(db);
  const secrets = createMemorySecretResolver(options.secrets ?? new Map());

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
    transactions: db.transactions,
    clock,
    ids,
    logger,
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
    transactions: db.transactions,
    clock,
    ids,
    logger,
    config: { moderatorMaxAttempts: config.worker.maxAttempts },
  });

  const moderator = createRunModeratorService({
    accounts,
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
    transactions: db.transactions,
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
    transactions: db.transactions,
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
    transactions: db.transactions,
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

  return {
    config,
    db,
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
