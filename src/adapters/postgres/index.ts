import type { IdFactory } from '../../platform/ids.ts';
import type { Logger } from '../../platform/logger.ts';
import type { SecretResolver } from '../../moderation/ports.ts';
import type { PostgresConfig, PostgresDatabase } from './client.ts';
import { DEFAULT_POSTGRES_CONFIG, createPostgresDatabase } from './client.ts';
import { createPostgresJobQueue } from './job-queue.ts';
import {
  createPostgresAccountPackRepository,
  createPostgresAccountMembershipRepository,
  createPostgresAccountRepository,
  createPostgresAuditLog,
  createPostgresChannelConnectionRepository,
  createPostgresChannelIdentityRepository,
  createPostgresConversationRepository,
  createPostgresDeadLetterStore,
  createPostgresEventOutbox,
  createPostgresHandoffRepository,
  createPostgresKnowledgeGapRepository,
  createPostgresKnowledgeRepository,
  createPostgresMessageRepository,
  createPostgresModeratorRunRepository,
  createPostgresOutboundActionRepository,
  createPostgresOutboundActionReviewRepository,
  createPostgresOutboxRelayStore,
  createPostgresRawInboundEventRepository,
  createPostgresStoreProbe,
  createPostgresUserRepository,
} from './repositories.ts';

/**
 * The PostgreSQL persistence bundle: every port the composition root needs, in one object.
 *
 * The two-pool split is the important part and it is not an optimisation. `app_runtime` is bound
 * by RLS and may only ever act inside a tenant context; `app_worker` sees the queue across
 * tenants and is granted nothing except `jobs` and `dead_letters`. A single role could not
 * satisfy both without giving the runtime cross-tenant reach — which is precisely the property the
 * tenancy model exists to deny.
 *
 * `enqueue` runs on the *runtime* pool so that it joins the caller's transaction. That is what
 * keeps ADR-004's central claim true: the job row and the domain write commit together, or
 * neither does.
 *
 * Phase 02 adds a **third** pool for the same reason there was a second. The outbox relay reads
 * pending events across tenants and moves a watermark; on the runtime pool RLS matches nothing,
 * and on the worker pool it would mean granting the queue role a table it has no business
 * touching. `app_relay` is granted one table and one writable column (0007), so the relay's blast
 * radius is the outbox and stops there.
 */

export interface PostgresPersistenceOptions {
  readonly runtimeConnectionString: string;
  readonly workerConnectionString: string;
  /**
   * Required, not optional. Defaulting it to the worker or runtime string would silently widen a
   * privilege boundary — the single most expensive kind of convenience.
   */
  readonly relayConnectionString: string;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly secrets: SecretResolver;
  readonly pool?: Partial<Omit<PostgresConfig, 'connectionString'>>;
}

export function createPostgresPersistence(options: PostgresPersistenceOptions) {
  const base = { ...DEFAULT_POSTGRES_CONFIG, ...options.pool };

  const runtimeDb: PostgresDatabase = createPostgresDatabase({
    config: { ...base, connectionString: options.runtimeConnectionString },
    logger: options.logger.child({ pool: 'runtime' }),
  });
  const workerDb: PostgresDatabase = createPostgresDatabase({
    config: { ...base, connectionString: options.workerConnectionString },
    logger: options.logger.child({ pool: 'worker' }),
    bypassTenantContext: true,
  });
  const relayDb: PostgresDatabase = createPostgresDatabase({
    // A relay is a background trickle, not a request path; two connections is generous.
    config: { ...base, maxConnections: 2, connectionString: options.relayConnectionString },
    logger: options.logger.child({ pool: 'relay' }),
    bypassTenantContext: true,
  });

  return {
    runtimeDb,
    workerDb,
    relayDb,
    transactions: runtimeDb.transactions,
    accounts: createPostgresAccountRepository(runtimeDb),
    users: createPostgresUserRepository(runtimeDb),
    memberships: createPostgresAccountMembershipRepository(runtimeDb),
    connections: createPostgresChannelConnectionRepository(runtimeDb),
    rawEvents: createPostgresRawInboundEventRepository(runtimeDb),
    identities: createPostgresChannelIdentityRepository(runtimeDb, options.ids),
    conversations: createPostgresConversationRepository(runtimeDb),
    messages: createPostgresMessageRepository(runtimeDb),
    runs: createPostgresModeratorRunRepository(runtimeDb),
    outboundActions: createPostgresOutboundActionRepository(runtimeDb),
    outboundReviews: createPostgresOutboundActionReviewRepository(runtimeDb),
    handoffs: createPostgresHandoffRepository(runtimeDb),
    knowledge: createPostgresKnowledgeRepository(runtimeDb),
    packs: createPostgresAccountPackRepository(runtimeDb),
    knowledgeGaps: createPostgresKnowledgeGapRepository(runtimeDb, options.ids),
    outbox: createPostgresEventOutbox(runtimeDb, relayDb),
    relay: createPostgresOutboxRelayStore(relayDb),
    probe: createPostgresStoreProbe({ workerDb, relayDb }),
    audit: createPostgresAuditLog(runtimeDb, options.ids),
    deadLetters: createPostgresDeadLetterStore(workerDb, options.ids),
    queue: createPostgresJobQueue({ enqueueDb: runtimeDb, workerDb, ids: options.ids }),
    secrets: options.secrets,
    async close(): Promise<void> {
      // Every pool, even if one throws. A pool left open holds sockets and keeps the event loop
      // alive, which is precisely the "finished but never exits" failure Phase 01 spent a finding
      // on.
      const results = await Promise.allSettled([
        runtimeDb.close(),
        workerDb.close(),
        relayDb.close(),
      ]);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason as Error;
    },
  };
}

export type PostgresPersistence = ReturnType<typeof createPostgresPersistence>;

export { createPostgresDatabase, DEFAULT_POSTGRES_CONFIG } from './client.ts';
export type { PostgresConfig, PostgresDatabase } from './client.ts';
export { createMigrator, loadMigrations } from './migrator.ts';
export type { Migrator, MigrationResult } from './migrator.ts';
export {
  MIGRATION_ROLE,
  MIN_PASSWORD_LENGTH,
  REQUIRED_EXTENSIONS,
  ROLE_MODEL,
  bootstrapDatabase,
  quoteIdentifier,
} from './bootstrap.ts';
export type {
  BootstrapCapabilities,
  BootstrapOptions,
  BootstrapReport,
  RoleKey,
  RoleModelEntry,
} from './bootstrap.ts';
export { allocateNextSeq } from './repositories.ts';
