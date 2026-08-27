import type { IdFactory } from '../../platform/ids.ts';
import type { Logger } from '../../platform/logger.ts';
import type { SecretResolver } from '../../moderation/ports.ts';
import type { PostgresConfig, PostgresDatabase } from './client.ts';
import { DEFAULT_POSTGRES_CONFIG, createPostgresDatabase } from './client.ts';
import { createPostgresJobQueue } from './job-queue.ts';
import {
  createPostgresAccountPackRepository,
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
  createPostgresRawInboundEventRepository,
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
 */

export interface PostgresPersistenceOptions {
  readonly runtimeConnectionString: string;
  readonly workerConnectionString: string;
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

  return {
    runtimeDb,
    workerDb,
    transactions: runtimeDb.transactions,
    accounts: createPostgresAccountRepository(runtimeDb),
    connections: createPostgresChannelConnectionRepository(runtimeDb),
    rawEvents: createPostgresRawInboundEventRepository(runtimeDb),
    identities: createPostgresChannelIdentityRepository(runtimeDb, options.ids),
    conversations: createPostgresConversationRepository(runtimeDb),
    messages: createPostgresMessageRepository(runtimeDb),
    runs: createPostgresModeratorRunRepository(runtimeDb),
    outboundActions: createPostgresOutboundActionRepository(runtimeDb),
    handoffs: createPostgresHandoffRepository(runtimeDb),
    knowledge: createPostgresKnowledgeRepository(runtimeDb),
    packs: createPostgresAccountPackRepository(runtimeDb),
    knowledgeGaps: createPostgresKnowledgeGapRepository(runtimeDb, options.ids),
    outbox: createPostgresEventOutbox(runtimeDb),
    audit: createPostgresAuditLog(runtimeDb, options.ids),
    deadLetters: createPostgresDeadLetterStore(workerDb, options.ids),
    queue: createPostgresJobQueue({ enqueueDb: runtimeDb, workerDb, ids: options.ids }),
    secrets: options.secrets,
    async close(): Promise<void> {
      await runtimeDb.close();
      await workerDb.close();
    },
  };
}

export type PostgresPersistence = ReturnType<typeof createPostgresPersistence>;

export { createPostgresDatabase, DEFAULT_POSTGRES_CONFIG } from './client.ts';
export type { PostgresConfig, PostgresDatabase } from './client.ts';
export { createMigrator, loadMigrations } from './migrator.ts';
export type { Migrator, MigrationResult } from './migrator.ts';
export { allocateNextSeq } from './repositories.ts';
