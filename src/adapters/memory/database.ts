import type { Account } from '../../core/account/index.ts';
import type { AccountPackVersion } from '../../knowledge/domain/account-pack.ts';
import type { KnowledgeEntry } from '../../knowledge/domain/knowledge-entry.ts';
import type { KnowledgeGapRecord } from '../../knowledge/ports.ts';
import type { DomainEventEnvelope } from '../../operations/events/contracts.ts';
import type { AuditEvent } from '../../operations/audit.ts';
import type { DeadLetter } from '../../operations/dead-letter.ts';
import type { Job } from '../../operations/jobs/job.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';
import type { ChannelConnection } from '../../moderation/domain/channel.ts';
import type {
  Conversation,
  OwnershipTransitionRecord,
} from '../../moderation/domain/conversation.ts';
import type { Handoff } from '../../moderation/domain/handoff.ts';
import type { ChannelIdentity } from '../../moderation/domain/identity.ts';
import type { Message } from '../../moderation/domain/message.ts';
import type { ModeratorRun } from '../../moderation/domain/moderator-run.ts';
import type { OutboundAction } from '../../moderation/domain/outbound-action.ts';
import type { OutboundActionReview } from '../../moderation/domain/review.ts';
import type { RawInboundEvent } from '../../moderation/domain/raw-event.ts';

/**
 * An in-memory store that honours the *semantics* the Postgres adapters must provide.
 *
 * It is not a stand-in for Postgres, and the handoff document says so plainly. What it does give
 * us is a way to prove the contracts — atomic commit, unique-key deduplication, partition
 * exclusivity, lease expiry — without a database in the loop, using the same contract test suite
 * that will later be run against the real adapters (ADR-003).
 *
 * The transaction implementation is a genuine snapshot-and-restore, not a no-op. That matters:
 * it lets us assert that a failure between "persist the event" and "enqueue the work" rolls both
 * back, which is the property the entire ingest design rests on (ADR-004).
 */

export interface MemoryTables {
  accounts: Map<string, Account>;
  connections: Map<string, ChannelConnection>;
  rawEvents: Map<string, RawInboundEvent>;
  identities: Map<string, ChannelIdentity>;
  conversations: Map<string, Conversation>;
  messages: Map<string, Message>;
  runs: Map<string, ModeratorRun>;
  outbound: Map<string, OutboundAction>;
  /** Append-only, like the table: a review is inserted and never updated. */
  outboundReviews: OutboundActionReview[];
  handoffs: Map<string, Handoff>;
  knowledge: Map<string, KnowledgeEntry>;
  packs: Map<string, AccountPackVersion>;
  jobs: Map<string, Job>;
  knowledgeGaps: KnowledgeGapRecord[];
  outbox: DomainEventEnvelope[];
  relayedEventIds: Set<string>;
  audit: AuditEvent[];
  deadLetters: DeadLetter[];
  ownershipTransitions: OwnershipTransitionRecord[];
  jobSeq: number;
}

export interface MemoryDatabase {
  readonly tables: MemoryTables;
  readonly transactions: TransactionRunner;
  reset(): void;
}

function emptyTables(): MemoryTables {
  return {
    accounts: new Map(),
    connections: new Map(),
    rawEvents: new Map(),
    identities: new Map(),
    conversations: new Map(),
    messages: new Map(),
    runs: new Map(),
    outbound: new Map(),
    outboundReviews: [],
    handoffs: new Map(),
    knowledge: new Map(),
    packs: new Map(),
    jobs: new Map(),
    knowledgeGaps: [],
    outbox: [],
    relayedEventIds: new Set(),
    audit: [],
    deadLetters: [],
    ownershipTransitions: [],
    jobSeq: 0,
  };
}

export function createMemoryDatabase(): MemoryDatabase {
  const tables = emptyTables();
  let depth = 0;

  const snapshot = (): MemoryTables => ({
    accounts: new Map(tables.accounts),
    connections: new Map(tables.connections),
    rawEvents: new Map(tables.rawEvents),
    identities: new Map(tables.identities),
    conversations: new Map(tables.conversations),
    messages: new Map(tables.messages),
    runs: new Map(tables.runs),
    outbound: new Map(tables.outbound),
    outboundReviews: [...tables.outboundReviews],
    handoffs: new Map(tables.handoffs),
    knowledge: new Map(tables.knowledge),
    packs: new Map(tables.packs),
    jobs: new Map(tables.jobs),
    knowledgeGaps: [...tables.knowledgeGaps],
    outbox: [...tables.outbox],
    relayedEventIds: new Set(tables.relayedEventIds),
    audit: [...tables.audit],
    deadLetters: [...tables.deadLetters],
    ownershipTransitions: [...tables.ownershipTransitions],
    jobSeq: tables.jobSeq,
  });

  const restore = (saved: MemoryTables): void => {
    Object.assign(tables, saved);
  };

  const transactions: TransactionRunner = {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      // Nested calls join the outer transaction rather than creating a savepoint. Postgres would
      // need SAVEPOINT for true nesting; we do not use nested rollback anywhere, and pretending
      // to support it would hide that difference.
      if (depth > 0) return await fn();
      const saved = snapshot();
      depth += 1;
      try {
        return await fn();
      } catch (error) {
        restore(saved);
        throw error;
      } finally {
        depth -= 1;
      }
    },
  };

  return {
    tables,
    transactions,
    reset() {
      restore(emptyTables());
    },
  };
}

/** Records are stored immutably, so a shallow copy on read is enough to prevent aliasing. */
export function values<T>(map: Map<string, T>): T[] {
  return [...map.values()];
}
