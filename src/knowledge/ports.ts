import type { AccountScope } from '../core/account/index.ts';
import type { AccountPackVersionId, KnowledgeEntryId } from '../platform/ids.ts';
import type { AccountPackVersion } from './domain/account-pack.ts';
import type { KnowledgeEntry } from './domain/knowledge-entry.ts';

export interface KnowledgeQuery {
  readonly locale: string;
  readonly intentCodes: readonly string[];
  readonly tags: readonly string[];
  readonly limit: number;
}

export interface KnowledgeRepository {
  /** MUST return only APPROVED entries for the given scope. Validity is filtered by the gate. */
  findApproved(scope: AccountScope, query: KnowledgeQuery): Promise<readonly KnowledgeEntry[]>;
  findByIds(
    scope: AccountScope,
    ids: readonly KnowledgeEntryId[],
  ): Promise<readonly KnowledgeEntry[]>;
  save(scope: AccountScope, entry: KnowledgeEntry): Promise<void>;
}

export interface AccountPackRepository {
  findActive(scope: AccountScope): Promise<AccountPackVersion | null>;
  findById(scope: AccountScope, id: AccountPackVersionId): Promise<AccountPackVersion | null>;
  save(scope: AccountScope, pack: AccountPackVersion): Promise<void>;
}

export interface KnowledgeGapRecord {
  readonly accountId: string;
  readonly conversationId: string;
  readonly moderatorRunId: string;
  /** Normalised, minimised — never the customer's raw sentence (ADR-009 data minimisation). */
  readonly questionShape: string;
  readonly intentCode: string;
  readonly locale: string;
  readonly observedAt: Date;
}

export interface KnowledgeGapRepository {
  record(scope: AccountScope, gap: KnowledgeGapRecord): Promise<void>;
  list(scope: AccountScope): Promise<readonly KnowledgeGapRecord[]>;
}
