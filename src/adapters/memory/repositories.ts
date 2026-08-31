import type {
  Account,
  AccountMembershipRepository,
  AccountRepository,
  AccountScope,
  UserRepository,
} from '../../core/account/index.ts';
import { readInScope, scopeViolation, writeInScope } from '../../core/account/index.ts';
import type { AuditEvent, AuditLog } from '../../operations/audit.ts';
import type { DeadLetter, DeadLetterStore } from '../../operations/dead-letter.ts';
import type {
  AuditEventId,
  ChannelIdentityId,
  DomainEventId,
  IdFactory,
} from '../../platform/ids.ts';
import { ID_PREFIX } from '../../platform/ids.ts';
import { TerminalError } from '../../platform/errors.ts';
import type {
  AccountPackRepository,
  KnowledgeGapRepository,
  KnowledgeRepository,
} from '../../knowledge/ports.ts';
import { isUsable } from '../../knowledge/domain/knowledge-entry.ts';
import type { DomainEventEnvelope } from '../../operations/events/contracts.ts';
import type { EventOutbox } from '../../operations/events/outbox.ts';
import { assertPublishable } from '../../operations/events/outbox.ts';
import type { OutboxRelayStore } from '../../operations/events/relay.ts';
import type { StoreProbe } from '../../operations/health.ts';
import { connectionIdentities, identityConflict } from '../../moderation/domain/channel.ts';
import { sameIdentity } from '../../moderation/domain/provider.ts';
import type { ChannelIdentity } from '../../moderation/domain/identity.ts';
import type {
  ChannelConnectionRepository,
  ChannelIdentityRepository,
  ChannelSecrets,
  ConversationRepository,
  HandoffRepository,
  MessageRepository,
  ModeratorRunRepository,
  OutboundActionRepository,
  OutboundActionReviewRepository,
  RawInboundEventRepository,
  SecretResolver,
} from '../../moderation/ports.ts';
import type { MemoryDatabase } from './database.ts';
import { values } from './database.ts';

/**
 * In-memory repositories.
 *
 * Two behaviours are implemented faithfully rather than approximated, because the tests that
 * matter depend on them:
 *
 *   1. **Scope enforcement.** Every read asserts that the row belongs to the requesting scope.
 *      This mirrors what Postgres RLS does at runtime (ADR-002 layer 2) and means a cross-tenant
 *      bug fails loudly here rather than returning another account's data quietly.
 *   2. **Unique-key deduplication.** `insertIfNew` returns the existing row instead of throwing,
 *      exactly as `ON CONFLICT DO NOTHING ... RETURNING` behaves, so duplicate webhooks stay a
 *      non-event (F-01).
 */

export function createMemoryAccountRepository(db: MemoryDatabase): AccountRepository {
  return {
    findById(id) {
      return Promise.resolve(db.tables.accounts.get(id) ?? null);
    },
    findBySlug(slug) {
      return Promise.resolve(values(db.tables.accounts).find((a) => a.slug === slug) ?? null);
    },
    insertIfNew(account) {
      const existing =
        db.tables.accounts.get(account.id) ??
        values(db.tables.accounts).find((other) => other.slug === account.slug);
      if (existing) return Promise.resolve({ inserted: false, record: existing });
      db.tables.accounts.set(account.id, account);
      return Promise.resolve({ inserted: true, record: account });
    },
    save(account: Account) {
      const slugOwner = values(db.tables.accounts).find(
        (other) => other.id !== account.id && other.slug === account.slug,
      );
      if (slugOwner) {
        return Promise.reject(
          new TerminalError('ACCOUNT_SLUG_CONFLICT', 'Account slug is already in use'),
        );
      }
      db.tables.accounts.set(account.id, account);
      return Promise.resolve();
    },
  };
}

export function createMemoryUserRepository(db: MemoryDatabase): UserRepository {
  const find = (email: string) =>
    values(db.tables.users).find((user) => user.email.trim().toLowerCase() === email) ?? null;

  return {
    findByNormalizedEmail(email) {
      return Promise.resolve(find(email));
    },
    insertIfNew(user) {
      const existing = find(user.email);
      if (existing) return Promise.resolve({ inserted: false, record: existing });
      db.tables.users.set(user.id, user);
      return Promise.resolve({ inserted: true, record: user });
    },
  };
}

export function createMemoryAccountMembershipRepository(
  db: MemoryDatabase,
): AccountMembershipRepository {
  const key = (accountId: string, userId: string): string => `${accountId}:${userId}`;

  return {
    findByUserId(scope, userId) {
      return readInScope(
        scope,
        db.tables.memberships.get(key(scope.accountId, userId)),
        'account_membership',
      );
    },
    insertIfNew(scope, membership) {
      const violation = scopeViolation(scope, membership, 'account_membership');
      if (violation) return Promise.reject(violation);
      const membershipKey = key(membership.accountId, membership.userId);
      const existing = db.tables.memberships.get(membershipKey);
      if (existing) return Promise.resolve({ inserted: false, record: existing });
      db.tables.memberships.set(membershipKey, membership);
      return Promise.resolve({ inserted: true, record: membership });
    },
  };
}

export function createMemoryChannelConnectionRepository(
  db: MemoryDatabase,
): ChannelConnectionRepository {
  return {
    findByPublicWebhookId(publicWebhookId) {
      return Promise.resolve(
        values(db.tables.connections).find((c) => c.publicWebhookId === publicWebhookId) ?? null,
      );
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.connections.get(id), 'channel_connection');
    },
    findByExternalId(scope, channel, externalId) {
      const found = values(db.tables.connections).find(
        (c) =>
          c.accountId === scope.accountId && c.channel === channel && c.externalId === externalId,
      );
      return Promise.resolve(found ?? null);
    },
    save(connection) {
      /*
       * The in-memory twin of migration 0008's platform-wide primary key on
       * `channel_connection_identities`.
       *
       * Enforced here rather than left to PostgreSQL because this is the constraint that makes
       * cross-tenant misrouting structurally impossible, and a safety property that only holds in
       * one of two adapters is a safety property the memory suite cannot regression-test. The
       * error code matches the one the Postgres adapter translates a unique violation into.
       */
      for (const identity of connectionIdentities(connection)) {
        const claimedBy = values(db.tables.connections).find(
          (other) =>
            other.id !== connection.id &&
            other.provider === connection.provider &&
            connectionIdentities(other).some((owned) => sameIdentity(owned, identity)),
        );
        if (claimedBy) return Promise.reject(identityConflict(identity));
      }
      db.tables.connections.set(connection.id, connection);
      return Promise.resolve();
    },
  };
}

export function createMemoryRawInboundEventRepository(
  db: MemoryDatabase,
): RawInboundEventRepository {
  return {
    insertIfNew(scope, event) {
      const violation = scopeViolation(scope, event, 'raw_inbound_event');
      if (violation) return Promise.reject(violation);
      const existing = values(db.tables.rawEvents).find(
        (e) =>
          e.channelConnectionId === event.channelConnectionId &&
          e.deliveryKey === event.deliveryKey,
      );
      if (existing) return Promise.resolve({ inserted: false, record: existing });
      db.tables.rawEvents.set(event.id, event);
      return Promise.resolve({ inserted: true, record: event });
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.rawEvents.get(id), 'raw_inbound_event');
    },
    save(scope, event) {
      return writeInScope(scope, event, 'raw_inbound_event', () => {
        db.tables.rawEvents.set(event.id, event);
      });
    },
    listByConnection(scope, id) {
      return Promise.resolve(
        values(db.tables.rawEvents).filter(
          (e) => e.accountId === scope.accountId && e.channelConnectionId === id,
        ),
      );
    },
  };
}

export function createMemoryChannelIdentityRepository(
  db: MemoryDatabase,
  ids: IdFactory,
): ChannelIdentityRepository {
  return {
    findOrCreate(scope, input) {
      const existing = values(db.tables.identities).find(
        (i) =>
          i.accountId === scope.accountId &&
          i.channel === input.channel &&
          i.externalId === input.externalId,
      );
      if (existing) {
        const touched: ChannelIdentity = { ...existing, lastSeenAt: input.now };
        db.tables.identities.set(touched.id, touched);
        return Promise.resolve(touched);
      }
      const created: ChannelIdentity = {
        id: ids.next<ChannelIdentityId>(ID_PREFIX.channelIdentity),
        accountId: scope.accountId,
        channel: input.channel,
        externalId: input.externalId,
        contactIdentityId: null,
        displayName: input.displayName,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
      };
      db.tables.identities.set(created.id, created);
      return Promise.resolve(created);
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.identities.get(id), 'channel_identity');
    },
  };
}

export function createMemoryConversationRepository(db: MemoryDatabase): ConversationRepository {
  return {
    findActiveFor(scope, lookup) {
      const found = values(db.tables.conversations)
        .filter(
          (c) =>
            c.accountId === scope.accountId &&
            c.channelConnectionId === lookup.channelConnectionId &&
            c.channelIdentityId === lookup.channelIdentityId &&
            c.surface === lookup.surface &&
            c.threadRef === lookup.threadRef,
        )
        // A CLOSED conversation is still the right one to return: the customer sees one thread,
        // so a reply reopens rather than forking (ADR-008, axis 1).
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return Promise.resolve(found ?? null);
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.conversations.get(id), 'conversation');
    },
    save(scope, conversation) {
      return writeInScope(scope, conversation, 'conversation', () => {
        db.tables.conversations.set(conversation.id, conversation);
      });
    },
    async saveIfUnchanged(scope, conversation, expectedOwnershipVersion) {
      // Mirrors `UPDATE conversations SET ... WHERE id = $1 AND ownership_version = $2`:
      // the comparison and the write are one indivisible step, and a mismatch writes nothing.
      let applied = false;
      await writeInScope(scope, conversation, 'conversation', () => {
        const current = db.tables.conversations.get(conversation.id);
        if (!current || current.ownershipVersion !== expectedOwnershipVersion) return;
        db.tables.conversations.set(conversation.id, conversation);
        applied = true;
      });
      return applied;
    },
    appendOwnershipTransition(scope, record) {
      return writeInScope(scope, record, 'conversation_ownership', () => {
        db.tables.ownershipTransitions.push(record);
      });
    },
    listOwnershipTransitions(scope, id) {
      return Promise.resolve(
        db.tables.ownershipTransitions.filter(
          (r) => r.accountId === scope.accountId && r.conversationId === id,
        ),
      );
    },
  };
}

export function createMemoryMessageRepository(db: MemoryDatabase): MessageRepository {
  return {
    insertIfNew(scope, message) {
      const violation = scopeViolation(scope, message, 'message');
      if (violation) return Promise.reject(violation);
      const existing = values(db.tables.messages).find(
        (m) =>
          m.accountId === message.accountId &&
          m.channel === message.channel &&
          m.dedupeKey === message.dedupeKey,
      );
      if (existing) return Promise.resolve({ inserted: false, record: existing });
      db.tables.messages.set(message.id, message);
      return Promise.resolve({ inserted: true, record: message });
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.messages.get(id), 'message');
    },
    listByConversation(scope, id) {
      return Promise.resolve(
        values(db.tables.messages)
          .filter((m) => m.accountId === scope.accountId && m.conversationId === id)
          .sort((a, b) => a.seq - b.seq),
      );
    },
    listAboveSeq(scope, id, seq) {
      return Promise.resolve(
        values(db.tables.messages)
          .filter((m) => m.accountId === scope.accountId && m.conversationId === id && m.seq > seq)
          .sort((a, b) => a.seq - b.seq),
      );
    },
  };
}

export function createMemoryModeratorRunRepository(db: MemoryDatabase): ModeratorRunRepository {
  return {
    save(scope, run) {
      return writeInScope(scope, run, 'moderator_run', () => {
        db.tables.runs.set(run.id, run);
      });
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.runs.get(id), 'moderator_run');
    },
    listByConversation(scope, id) {
      return Promise.resolve(
        values(db.tables.runs)
          .filter((r) => r.accountId === scope.accountId && r.conversationId === id)
          .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
      );
    },
  };
}

export function createMemoryOutboundActionRepository(db: MemoryDatabase): OutboundActionRepository {
  return {
    save(scope, action) {
      return writeInScope(scope, action, 'outbound_action', () => {
        db.tables.outbound.set(action.id, action);
      });
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.outbound.get(id), 'outbound_action');
    },
    // Mirrors the partial index `outbound_actions_review_idx`: suggested drafts still suppressed,
    // oldest first.
    listAwaitingReview(scope, limit) {
      return Promise.resolve(
        values(db.tables.outbound)
          .filter(
            (a) =>
              a.accountId === scope.accountId &&
              a.deliveryMode === 'SUGGESTED' &&
              a.state === 'SUPPRESSED',
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit),
      );
    },
    findByIdempotencyKey(scope, key) {
      const found = values(db.tables.outbound).find(
        (a) => a.accountId === scope.accountId && a.idempotencyKey === key,
      );
      return Promise.resolve(found ?? null);
    },
    listByConversation(scope, id) {
      return Promise.resolve(
        values(db.tables.outbound)
          .filter((a) => a.accountId === scope.accountId && a.conversationId === id)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      );
    },
  };
}

/**
 * Append-only in memory too, so the contract is the same one the Postgres grants enforce: the
 * review log is written once and never rewritten.
 */
export function createMemoryOutboundActionReviewRepository(
  db: MemoryDatabase,
): OutboundActionReviewRepository {
  return {
    save(scope, review) {
      const violation = scopeViolation(scope, review, 'outbound_action_review');
      if (violation) return Promise.reject(violation);
      db.tables.outboundReviews.push(review);
      return Promise.resolve();
    },
    listByAction(scope, id) {
      return Promise.resolve(
        db.tables.outboundReviews.filter(
          (r) => r.accountId === scope.accountId && r.outboundActionId === id,
        ),
      );
    },
    listByConversation(scope, id) {
      return Promise.resolve(
        db.tables.outboundReviews.filter(
          (r) => r.accountId === scope.accountId && r.conversationId === id,
        ),
      );
    },
  };
}

export function createMemoryHandoffRepository(db: MemoryDatabase): HandoffRepository {
  return {
    save(scope, handoff) {
      return writeInScope(scope, handoff, 'handoff', () => {
        db.tables.handoffs.set(handoff.id, handoff);
      });
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.handoffs.get(id), 'handoff');
    },
    listOpenByConversation(scope, id) {
      return Promise.resolve(
        values(db.tables.handoffs).filter(
          (h) =>
            h.accountId === scope.accountId &&
            h.conversationId === id &&
            (h.state === 'REQUESTED' || h.state === 'ASSIGNED' || h.state === 'ACCEPTED'),
        ),
      );
    },
  };
}

export function createMemoryKnowledgeRepository(db: MemoryDatabase): KnowledgeRepository {
  return {
    findApproved(scope, query) {
      const matched = values(db.tables.knowledge).filter((entry) => {
        if (entry.accountId !== scope.accountId) return false;
        if (entry.status !== 'APPROVED') return false;
        if (entry.locale !== query.locale) return false;
        const intentHit = entry.intentCodes.some((code) => query.intentCodes.includes(code));
        const tagHit = entry.tags.some((tag) => query.tags.includes(tag));
        return intentHit || tagHit;
      });
      return Promise.resolve(matched.slice(0, query.limit));
    },
    findByIds(scope, ids) {
      return Promise.resolve(
        ids
          .map((id) => db.tables.knowledge.get(id))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
          .filter((entry) => entry.accountId === scope.accountId),
      );
    },
    save(scope, entry) {
      return writeInScope(scope, entry, 'knowledge_entry', () => {
        db.tables.knowledge.set(entry.id, entry);
      });
    },
  };
}

export function createMemoryAccountPackRepository(db: MemoryDatabase): AccountPackRepository {
  return {
    findActive(scope) {
      const found = values(db.tables.packs).find(
        (p) => p.accountId === scope.accountId && p.status === 'ACTIVE',
      );
      return Promise.resolve(found ?? null);
    },
    findById(scope, id) {
      return readInScope(scope, db.tables.packs.get(id), 'account_pack_version');
    },
    save(scope, pack) {
      const violation = scopeViolation(scope, pack, 'account_pack_version');
      if (violation) return Promise.reject(violation);
      // Mirrors the partial unique index: exactly one ACTIVE version per account (ADR-010).
      if (pack.status === 'ACTIVE') {
        for (const other of values(db.tables.packs)) {
          if (
            other.accountId === pack.accountId &&
            other.id !== pack.id &&
            other.status === 'ACTIVE'
          ) {
            db.tables.packs.set(other.id, { ...other, status: 'SUPERSEDED' });
          }
        }
      }
      db.tables.packs.set(pack.id, pack);
      return Promise.resolve();
    },
  };
}

export function createMemoryKnowledgeGapRepository(db: MemoryDatabase): KnowledgeGapRepository {
  return {
    record(_scope, gap) {
      db.tables.knowledgeGaps.push(gap);
      return Promise.resolve();
    },
    list(scope) {
      return Promise.resolve(
        db.tables.knowledgeGaps.filter((g) => g.accountId === scope.accountId),
      );
    },
  };
}

export function createMemoryEventOutbox(db: MemoryDatabase): EventOutbox {
  return {
    append(scope, event) {
      const violation = scopeViolation(scope, event, 'domain_event');
      if (violation) return Promise.reject(violation);
      assertPublishable(event);
      db.tables.outbox.push(event);
      return Promise.resolve();
    },
    listPending(scope) {
      return Promise.resolve(
        db.tables.outbox.filter(
          (e) => e.accountId === scope.accountId && !db.tables.relayedEventIds.has(e.eventId),
        ),
      );
    },
    listAll(scope) {
      return Promise.resolve(db.tables.outbox.filter((e) => e.accountId === scope.accountId));
    },
    markRelayed(eventId: DomainEventId) {
      db.tables.relayedEventIds.add(eventId);
      return Promise.resolve();
    },
  };
}

export function createMemoryAuditLog(db: MemoryDatabase, ids: IdFactory): AuditLog {
  return {
    append(scope, event) {
      const record: AuditEvent = {
        ...event,
        id: ids.next<AuditEventId>(ID_PREFIX.auditEvent),
        accountId: scope.accountId,
      };
      db.tables.audit.push(record);
      return Promise.resolve();
    },
    list(scope) {
      return Promise.resolve(db.tables.audit.filter((e) => e.accountId === scope.accountId));
    },
  };
}

export function createMemoryDeadLetterStore(db: MemoryDatabase): DeadLetterStore {
  return {
    record(entry: DeadLetter) {
      db.tables.deadLetters.push(entry);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve([...db.tables.deadLetters]);
    },
    count() {
      return Promise.resolve(db.tables.deadLetters.length);
    },
  };
}

/** Secrets by reference. In production this is a KMS/secret-manager client, never a table. */
/**
 * Secrets, held in memory and resolved by reference.
 *
 * A bare string is shorthand for "app secret only, no subscription handshake configured" — which
 * is what every Phase 0/1 fixture meant and still means. Supplying the object form adds the
 * verify token without changing a single existing caller.
 */
export function createMemorySecretResolver(
  secrets: ReadonlyMap<string, string | ChannelSecrets>,
): SecretResolver {
  return {
    resolve(credentialsRef) {
      const entry = secrets.get(credentialsRef);
      if (entry === undefined) return Promise.resolve(null);
      return Promise.resolve(typeof entry === 'string' ? { appSecret: entry } : entry);
    },
  };
}

/**
 * The in-memory relay store.
 *
 * Cross-tenant by construction — there is no RLS to work around here, which is exactly why the
 * Postgres twin needs its own role and this one does not. The behaviour that must match is the
 * conditional watermark: `markRelayed` returns false for an event already relayed, so the
 * idempotency assertions in the shared tests mean the same thing against both adapters.
 */
export function createMemoryOutboxRelayStore(db: MemoryDatabase): OutboxRelayStore {
  const pending = (): DomainEventEnvelope[] =>
    db.tables.outbox
      .filter((event) => !db.tables.relayedEventIds.has(event.eventId))
      .sort((a, b) => {
        const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
        return byTime !== 0 ? byTime : a.eventId.localeCompare(b.eventId);
      });

  return {
    listPending(limit) {
      return Promise.resolve(pending().slice(0, limit));
    },
    markRelayed(eventId) {
      if (db.tables.relayedEventIds.has(eventId)) return Promise.resolve(false);
      db.tables.relayedEventIds.add(eventId);
      return Promise.resolve(true);
    },
    backlog() {
      const waiting = pending();
      return Promise.resolve({
        pending: waiting.length,
        oldestAt: waiting[0]?.occurredAt ?? null,
      });
    },
  };
}

/**
 * The in-memory health probe.
 *
 * `ping` succeeds unconditionally, and that is the honest answer: an in-process Map cannot be
 * unreachable. A probe that faked a failure mode the store does not have would make the health
 * tests prove something about the fake rather than about the service.
 */
export function createMemoryStoreProbe(db: MemoryDatabase): StoreProbe {
  const relay = createMemoryOutboxRelayStore(db);
  return {
    ping: () => Promise.resolve(),
    inboundBacklog() {
      const waiting = values(db.tables.rawEvents)
        .filter((event) => event.state === 'RECEIVED' || event.state === 'NORMALIZING')
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
      return Promise.resolve({
        pending: waiting.length,
        oldestAt: waiting[0]?.receivedAt ?? null,
      });
    },
    outboxBacklog: () => relay.backlog(),
  };
}

/** Exposed for tests that need to assert on usable knowledge without going through the gate. */
export function usableKnowledgeCount(db: MemoryDatabase, scope: AccountScope, now: Date): number {
  return values(db.tables.knowledge).filter(
    (entry) => entry.accountId === scope.accountId && isUsable(entry, now),
  ).length;
}

export type { DomainEventEnvelope };
