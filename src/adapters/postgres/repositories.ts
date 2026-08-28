import type { Account, AccountRepository, AccountScope } from '../../core/account/index.ts';
import { readInScope } from '../../core/account/index.ts';
import type { Channel, Surface } from '../../core/channel.ts';
import type { AuditEvent, AuditLog } from '../../operations/audit.ts';
import type { DeadLetter, DeadLetterStore } from '../../operations/dead-letter.ts';
import type {
  AccountId,
  AccountPackVersionId,
  AuditEventId,
  ChannelConnectionId,
  ChannelIdentityId,
  ContactIdentityId,
  ConversationId,
  DeadLetterId,
  DomainEventId,
  HandoffId,
  IdFactory,
  JobId,
  KnowledgeEntryId,
  MessageId,
  ModeratorRunId,
  OutboundActionId,
  RawInboundEventId,
  TraceId,
  UserId,
} from '../../platform/ids.ts';
import { ID_PREFIX, asId } from '../../platform/ids.ts';
import { ConcurrencyConflictError, NotImplementedError } from '../../platform/errors.ts';
import type {
  AccountPackRepository,
  KnowledgeGapRecord,
  KnowledgeGapRepository,
  KnowledgeRepository,
} from '../../knowledge/ports.ts';
import type { KnowledgeEntry } from '../../knowledge/domain/knowledge-entry.ts';
import type { AccountPackVersion, PackSectionKey } from '../../knowledge/domain/account-pack.ts';
import type { DomainEventEnvelope, DomainEventType } from '../../operations/events/contracts.ts';
import type { EventOutbox } from '../../operations/events/outbox.ts';
import type { OutboxRelayStore } from '../../operations/events/relay.ts';
import type { StoreProbe } from '../../operations/health.ts';
import { assertPublishable } from '../../operations/events/outbox.ts';
import type { ChannelConnection } from '../../moderation/domain/channel.ts';
import type {
  Conversation,
  OwnershipTransitionRecord,
} from '../../moderation/domain/conversation.ts';
import type { Handoff } from '../../moderation/domain/handoff.ts';
import type { ChannelIdentity } from '../../moderation/domain/identity.ts';
import type { Message, MessageAttachment } from '../../moderation/domain/message.ts';
import type { ModeratorRun } from '../../moderation/domain/moderator-run.ts';
import type { OutboundAction } from '../../moderation/domain/outbound-action.ts';
import type { RawInboundEvent } from '../../moderation/domain/raw-event.ts';
import type {
  ChannelConnectionRepository,
  ChannelIdentityRepository,
  ConversationRepository,
  HandoffRepository,
  MessageRepository,
  ModeratorRunRepository,
  OutboundActionRepository,
  RawInboundEventRepository,
} from '../../moderation/ports.ts';
import type { PostgresDatabase } from './client.ts';
import { isUniqueViolation } from './errors.ts';

/**
 * PostgreSQL repositories.
 *
 * Three rules run through the whole file.
 *
 * **Every scoped call opens a tenant transaction.** The `AccountScope` is not just an argument
 * check here — it becomes `SET LOCAL app.account_id`, which is what makes RLS the second,
 * independent line of defence promised by ADR-002. A query with a forgotten `account_id`
 * predicate returns nothing rather than another tenant's rows.
 *
 * **`insertIfNew` is a real `ON CONFLICT`, never a read-then-write.** A `SELECT` followed by an
 * `INSERT` is not deduplication under concurrency; it is a race with a comfortable-looking shape.
 * The unique index is the arbiter, and losing the race is a normal, non-alerting outcome (F-01).
 *
 * **Read-modify-write on counters happens in one statement.** `next_seq` is allocated with
 * `UPDATE ... RETURNING`, which takes the row lock, instead of being read into JavaScript and
 * written back — the classic lost update.
 */

type Json = string;
const json = (value: unknown): Json => JSON.stringify(value);

/** `text[]` round-trips natively; this only guards against a null column. */
const textArray = (value: readonly string[] | null | undefined): string[] => [...(value ?? [])];

interface CodedError {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------------------------

interface AccountRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  default_locale: string;
  timezone: string;
  created_at: Date;
}

const toAccount = (row: AccountRow): Account => ({
  id: asId<AccountId>(row.id),
  slug: row.slug,
  name: row.name,
  status: row.status as Account['status'],
  defaultLocale: row.default_locale,
  timezone: row.timezone,
  createdAt: row.created_at,
});

export function createPostgresAccountRepository(db: PostgresDatabase): AccountRepository {
  return {
    async findById(id) {
      // The account row is readable exactly by the account it describes: RLS on `accounts` keys on
      // `id`, so establishing the context *is* the lookup's authorisation.
      return await db.scoped(
        id,
        async (client) => {
          const result = await client.query<AccountRow>(
            'SELECT id, slug, name, status, default_locale, timezone, created_at FROM accounts WHERE id = $1',
            [id],
          );
          const row = result.rows[0];
          return row ? toAccount(row) : null;
        },
        'accounts:findById',
      );
    },

    findBySlug() {
      /*
       * Not implementable under the tenancy model as it stands, and failing loudly is the only
       * honest option.
       *
       * RLS on `accounts` is keyed on the account id. Resolving a *slug* means asking "which
       * tenant is this?" before a tenant context exists — the same question the webhook path asks,
       * which 0005 answers with one narrow SECURITY DEFINER function over an unguessable id. A
       * slug is guessable and this lookup is a control-plane operation (an operator choosing an
       * account), so it wants a control-plane role rather than a hole in the runtime's policy.
       *
       * There is no caller in `src/`. Returning `null` would be worse than throwing: a login
       * screen that silently cannot find any account looks like bad credentials.
       */
      return Promise.reject(
        new NotImplementedError('AccountRepository.findBySlug on PostgreSQL', 'Phase 2'),
      );
    },

    async save(account: Account) {
      await db.scoped(
        account.id,
        async (client) => {
          await client.query(
            `INSERT INTO accounts (id, slug, name, status, default_locale, timezone, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO UPDATE SET
               slug = EXCLUDED.slug, name = EXCLUDED.name, status = EXCLUDED.status,
               default_locale = EXCLUDED.default_locale, timezone = EXCLUDED.timezone,
               updated_at = now()`,
            [
              account.id,
              account.slug,
              account.name,
              account.status,
              account.defaultLocale,
              account.timezone,
              account.createdAt,
            ],
          );
        },
        'accounts:save',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// channel_connections
// ---------------------------------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  account_id: string;
  channel: string;
  supported_surfaces: string[];
  external_id: string;
  public_webhook_id: string;
  credentials_ref: string;
  status: string;
  settings: Record<string, unknown>;
}

const CONNECTION_COLUMNS = `id, account_id, channel, supported_surfaces, external_id,
  public_webhook_id, credentials_ref, status, settings`;

const toConnection = (row: ConnectionRow): ChannelConnection => ({
  id: asId<ChannelConnectionId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  channel: row.channel as Channel,
  supportedSurfaces: textArray(row.supported_surfaces) as Surface[],
  externalId: row.external_id,
  publicWebhookId: row.public_webhook_id,
  credentialsRef: row.credentials_ref,
  status: row.status as ChannelConnection['status'],
  settings: row.settings,
});

export function createPostgresChannelConnectionRepository(
  db: PostgresDatabase,
): ChannelConnectionRepository {
  return {
    async findByPublicWebhookId(publicWebhookId) {
      /*
       * Tenancy resolution, in two deliberate steps (ADR-006 + migration 0005).
       *
       * Step one asks the SECURITY DEFINER function for two identifiers and nothing else — no
       * credentials_ref, no settings, no payload. Step two re-reads the full row *inside* the
       * tenant context those identifiers establish, so the connection row itself is never read
       * outside RLS. An attacker guessing webhook ids learns only that an id exists.
       */
      const resolved = await db.unscoped(async (client) => {
        const result = await client.query<{ connection_id: string; account_id: string }>(
          'SELECT connection_id, account_id FROM app_resolve_webhook_connection($1)',
          [publicWebhookId],
        );
        return result.rows[0] ?? null;
      }, 'connections:resolveWebhook');
      if (!resolved) return null;

      return await db.scoped(
        asId<AccountId>(resolved.account_id),
        async (client) => {
          const result = await client.query<ConnectionRow>(
            `SELECT ${CONNECTION_COLUMNS} FROM channel_connections WHERE id = $1`,
            [resolved.connection_id],
          );
          const row = result.rows[0];
          return row ? toConnection(row) : null;
        },
        'connections:findByPublicWebhookId',
      );
    },

    async findById(scope, id) {
      const row = await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<ConnectionRow>(
            `SELECT ${CONNECTION_COLUMNS} FROM channel_connections WHERE id = $1`,
            [id],
          );
          return result.rows[0] ?? null;
        },
        'connections:findById',
      );
      return await readInScope(scope, row ? toConnection(row) : null, 'channel_connection');
    },

    async findByExternalId(scope, channel, externalId) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<ConnectionRow>(
            `SELECT ${CONNECTION_COLUMNS} FROM channel_connections
              WHERE channel = $1 AND external_id = $2`,
            [channel, externalId],
          );
          const row = result.rows[0];
          return row ? toConnection(row) : null;
        },
        'connections:findByExternalId',
      );
    },

    async save(connection) {
      await db.scoped(
        connection.accountId,
        async (client) => {
          await client.query(
            `INSERT INTO channel_connections (id, account_id, channel, supported_surfaces,
                external_id, public_webhook_id, credentials_ref, status, settings)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (id) DO UPDATE SET
               supported_surfaces = EXCLUDED.supported_surfaces,
               credentials_ref = EXCLUDED.credentials_ref,
               status = EXCLUDED.status, settings = EXCLUDED.settings`,
            [
              connection.id,
              connection.accountId,
              connection.channel,
              textArray(connection.supportedSurfaces),
              connection.externalId,
              connection.publicWebhookId,
              connection.credentialsRef,
              connection.status,
              json(connection.settings),
            ],
          );
        },
        'connections:save',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// raw_inbound_events
// ---------------------------------------------------------------------------------------------

interface RawEventRow {
  id: string;
  account_id: string;
  channel_connection_id: string;
  delivery_key: string;
  payload: unknown;
  headers: Record<string, string>;
  signature_valid: boolean;
  state: string;
  received_at: Date;
  normalized_at: Date | null;
  produced_message_ids: string[];
  error: CodedError | null;
  trace_id: string;
}

const RAW_EVENT_COLUMNS = `id, account_id, channel_connection_id, delivery_key, payload, headers,
  signature_valid, state, received_at, normalized_at, produced_message_ids, error, trace_id`;

const toRawEvent = (row: RawEventRow): RawInboundEvent => ({
  id: asId<RawInboundEventId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  channelConnectionId: asId<ChannelConnectionId>(row.channel_connection_id),
  deliveryKey: row.delivery_key,
  payload: row.payload,
  headers: row.headers,
  signatureValid: row.signature_valid,
  state: row.state as RawInboundEvent['state'],
  receivedAt: row.received_at,
  normalizedAt: row.normalized_at,
  producedMessageIds: textArray(row.produced_message_ids).map((id) => asId<MessageId>(id)),
  error: row.error,
  traceId: asId<TraceId>(row.trace_id),
});

export function createPostgresRawInboundEventRepository(
  db: PostgresDatabase,
): RawInboundEventRepository {
  return {
    async insertIfNew(scope, event) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const inserted = await client.query<RawEventRow>(
            `INSERT INTO raw_inbound_events (id, account_id, channel_connection_id, delivery_key,
                payload, headers, signature_valid, state, received_at, normalized_at,
                produced_message_ids, error, trace_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (channel_connection_id, delivery_key) DO NOTHING
             RETURNING ${RAW_EVENT_COLUMNS}`,
            [
              event.id,
              event.accountId,
              event.channelConnectionId,
              event.deliveryKey,
              json(event.payload),
              json(event.headers),
              event.signatureValid,
              event.state,
              event.receivedAt,
              event.normalizedAt,
              textArray(event.producedMessageIds),
              event.error ? json(event.error) : null,
              event.traceId,
            ],
          );
          const row = inserted.rows[0];
          if (row) return { inserted: true, record: toRawEvent(row) };

          // A duplicate webhook delivery. Normal and non-alerting — but the *existing* row is what
          // the caller needs, so it can report which event this delivery collided with.
          const existing = await client.query<RawEventRow>(
            `SELECT ${RAW_EVENT_COLUMNS} FROM raw_inbound_events
              WHERE channel_connection_id = $1 AND delivery_key = $2`,
            [event.channelConnectionId, event.deliveryKey],
          );
          return { inserted: false, record: toRawEvent(existing.rows[0]!) };
        },
        'rawEvents:insertIfNew',
      );
    },

    async findById(scope, id) {
      const row = await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<RawEventRow>(
            `SELECT ${RAW_EVENT_COLUMNS} FROM raw_inbound_events WHERE id = $1`,
            [id],
          );
          return result.rows[0] ?? null;
        },
        'rawEvents:findById',
      );
      return await readInScope(scope, row ? toRawEvent(row) : null, 'raw_inbound_event');
    },

    async save(scope, event) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          // Only the four columns 0002 grants UPDATE on. The ledger is append-only; this is its
          // lifecycle, not an edit, and the grant is what enforces that rather than convention.
          await client.query(
            `UPDATE raw_inbound_events
                SET state = $2, normalized_at = $3, produced_message_ids = $4, error = $5
              WHERE id = $1`,
            [
              event.id,
              event.state,
              event.normalizedAt,
              textArray(event.producedMessageIds),
              event.error ? json(event.error) : null,
            ],
          );
        },
        'rawEvents:save',
      );
    },

    async listByConnection(scope, id) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<RawEventRow>(
            `SELECT ${RAW_EVENT_COLUMNS} FROM raw_inbound_events
              WHERE channel_connection_id = $1 ORDER BY received_at, id`,
            [id],
          );
          return result.rows.map(toRawEvent);
        },
        'rawEvents:listByConnection',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// channel_identities
// ---------------------------------------------------------------------------------------------

interface IdentityRow {
  id: string;
  account_id: string;
  channel: string;
  external_id: string;
  contact_identity_id: string | null;
  display_name: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
}

const IDENTITY_COLUMNS = `id, account_id, channel, external_id, contact_identity_id, display_name,
  first_seen_at, last_seen_at`;

const toIdentity = (row: IdentityRow): ChannelIdentity => ({
  id: asId<ChannelIdentityId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  channel: row.channel as Channel,
  externalId: row.external_id,
  contactIdentityId: row.contact_identity_id
    ? asId<ContactIdentityId>(row.contact_identity_id)
    : null,
  displayName: row.display_name,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
});

export function createPostgresChannelIdentityRepository(
  db: PostgresDatabase,
  ids: IdFactory,
): ChannelIdentityRepository {
  return {
    async findOrCreate(scope, input) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          // One statement, so two concurrent first messages from the same person cannot create two
          // identities — and therefore cannot create two conversations for one thread.
          const result = await client.query<IdentityRow>(
            `INSERT INTO channel_identities (id, account_id, channel, external_id, display_name,
                first_seen_at, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$6)
             ON CONFLICT (account_id, channel, external_id) DO UPDATE
               SET last_seen_at = EXCLUDED.last_seen_at
             RETURNING ${IDENTITY_COLUMNS}`,
            [
              ids.next<ChannelIdentityId>(ID_PREFIX.channelIdentity),
              scope.accountId,
              input.channel,
              input.externalId,
              input.displayName,
              input.now,
            ],
          );
          return toIdentity(result.rows[0]!);
        },
        'identities:findOrCreate',
      );
    },

    async findById(scope, id) {
      const row = await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<IdentityRow>(
            `SELECT ${IDENTITY_COLUMNS} FROM channel_identities WHERE id = $1`,
            [id],
          );
          return result.rows[0] ?? null;
        },
        'identities:findById',
      );
      return await readInScope(scope, row ? toIdentity(row) : null, 'channel_identity');
    },
  };
}

// ---------------------------------------------------------------------------------------------
// conversations
// ---------------------------------------------------------------------------------------------

interface ConversationRow {
  id: string;
  account_id: string;
  channel_connection_id: string;
  channel_identity_id: string;
  contact_identity_id: string | null;
  surface: string;
  thread_ref: string | null;
  lifecycle: string;
  ownership: string;
  ownership_version: number;
  owner_user_id: string | null;
  engagement: string;
  next_seq: number;
  last_inbound_seq: number;
  last_processed_inbound_seq: number;
  locale: string | null;
  snoozed_until: Date | null;
  closed_at: Date | null;
  first_message_at: Date | null;
  last_message_at: Date | null;
  created_at: Date;
}

const CONVERSATION_COLUMNS = `id, account_id, channel_connection_id, channel_identity_id,
  contact_identity_id, surface, thread_ref, lifecycle, ownership, ownership_version, owner_user_id,
  engagement, next_seq, last_inbound_seq, last_processed_inbound_seq, locale, snoozed_until,
  closed_at, first_message_at, last_message_at, created_at`;

const toConversation = (row: ConversationRow): Conversation => ({
  id: asId<ConversationId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  channelConnectionId: asId<ChannelConnectionId>(row.channel_connection_id),
  channelIdentityId: asId<ChannelIdentityId>(row.channel_identity_id),
  contactIdentityId: row.contact_identity_id
    ? asId<ContactIdentityId>(row.contact_identity_id)
    : null,
  surface: row.surface as Surface,
  threadRef: row.thread_ref,
  lifecycle: row.lifecycle as Conversation['lifecycle'],
  ownership: row.ownership as Conversation['ownership'],
  ownershipVersion: row.ownership_version,
  ownerUserId: row.owner_user_id ? asId<UserId>(row.owner_user_id) : null,
  engagement: row.engagement as Conversation['engagement'],
  nextSeq: row.next_seq,
  lastInboundSeq: row.last_inbound_seq,
  lastProcessedInboundSeq: row.last_processed_inbound_seq,
  locale: row.locale,
  snoozedUntil: row.snoozed_until,
  closedAt: row.closed_at,
  firstMessageAt: row.first_message_at,
  lastMessageAt: row.last_message_at,
  createdAt: row.created_at,
});

const conversationValues = (c: Conversation): unknown[] => [
  c.id,
  c.accountId,
  c.channelConnectionId,
  c.channelIdentityId,
  c.contactIdentityId,
  c.surface,
  c.threadRef,
  c.lifecycle,
  c.ownership,
  c.ownershipVersion,
  c.ownerUserId,
  c.engagement,
  c.nextSeq,
  c.lastInboundSeq,
  c.lastProcessedInboundSeq,
  c.locale,
  c.snoozedUntil,
  c.closedAt,
  c.firstMessageAt,
  c.lastMessageAt,
  c.createdAt,
];

const CONVERSATION_UPDATE_SET = `
  contact_identity_id = EXCLUDED.contact_identity_id,
  thread_ref = EXCLUDED.thread_ref,
  lifecycle = EXCLUDED.lifecycle,
  ownership = EXCLUDED.ownership,
  ownership_version = EXCLUDED.ownership_version,
  owner_user_id = EXCLUDED.owner_user_id,
  engagement = EXCLUDED.engagement,
  next_seq = EXCLUDED.next_seq,
  last_inbound_seq = EXCLUDED.last_inbound_seq,
  last_processed_inbound_seq = EXCLUDED.last_processed_inbound_seq,
  locale = EXCLUDED.locale,
  snoozed_until = EXCLUDED.snoozed_until,
  closed_at = EXCLUDED.closed_at,
  first_message_at = EXCLUDED.first_message_at,
  last_message_at = EXCLUDED.last_message_at`;

export function createPostgresConversationRepository(db: PostgresDatabase): ConversationRepository {
  return {
    async findActiveFor(scope, lookup) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          // `IS NOT DISTINCT FROM` rather than `=`: thread_ref is nullable for direct messages, and
          // `NULL = NULL` is NULL, which would silently fork a new conversation on every message.
          const result = await client.query<ConversationRow>(
            `SELECT ${CONVERSATION_COLUMNS} FROM conversations
              WHERE channel_connection_id = $1 AND channel_identity_id = $2
                AND surface = $3 AND thread_ref IS NOT DISTINCT FROM $4
              ORDER BY created_at DESC, id DESC
              LIMIT 1`,
            [
              lookup.channelConnectionId,
              lookup.channelIdentityId,
              lookup.surface,
              lookup.threadRef,
            ],
          );
          const row = result.rows[0];
          return row ? toConversation(row) : null;
        },
        'conversations:findActiveFor',
      );
    },

    async findById(scope, id) {
      const row = await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<ConversationRow>(
            `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1`,
            [id],
          );
          return result.rows[0] ?? null;
        },
        'conversations:findById',
      );
      return await readInScope(scope, row ? toConversation(row) : null, 'conversation');
    },

    async save(scope, conversation) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          await client.query(
            `INSERT INTO conversations (${CONVERSATION_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
             ON CONFLICT (id) DO UPDATE SET ${CONVERSATION_UPDATE_SET}`,
            conversationValues(conversation),
          );
        },
        'conversations:save',
      );
    },

    async saveIfUnchanged(scope, conversation, expectedOwnershipVersion) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          /*
           * The compare and the write are one statement, which is the entire point (ADR-008,
           * F-13). A takeover that committed while this run was talking to the model has already
           * bumped `ownership_version`, so the predicate matches zero rows and the caller learns
           * it lost — instead of overwriting a human's claim on the conversation.
           *
           * `account_id` is in the predicate as well as in RLS. Belt and braces: a policy that is
           * ever loosened must not silently turn this into a cross-tenant write.
           */
          // Every placeholder is referenced. PostgreSQL infers a parameter's type from its use, so
          // passing one the statement never mentions fails with "could not determine data type" —
          // an error that reads like a constraint violation and is nothing of the kind.
          const result = await client.query(
            `UPDATE conversations SET
               contact_identity_id = $3, thread_ref = $4, lifecycle = $5, ownership = $6,
               ownership_version = $7, owner_user_id = $8, engagement = $9, next_seq = $10,
               last_inbound_seq = $11, last_processed_inbound_seq = $12, locale = $13,
               snoozed_until = $14, closed_at = $15, first_message_at = $16, last_message_at = $17
             WHERE id = $1 AND account_id = $2 AND ownership_version = $18`,
            [
              conversation.id,
              conversation.accountId,
              conversation.contactIdentityId,
              conversation.threadRef,
              conversation.lifecycle,
              conversation.ownership,
              conversation.ownershipVersion,
              conversation.ownerUserId,
              conversation.engagement,
              conversation.nextSeq,
              conversation.lastInboundSeq,
              conversation.lastProcessedInboundSeq,
              conversation.locale,
              conversation.snoozedUntil,
              conversation.closedAt,
              conversation.firstMessageAt,
              conversation.lastMessageAt,
              expectedOwnershipVersion,
            ],
          );
          return (result.rowCount ?? 0) === 1;
        },
        'conversations:saveIfUnchanged',
      );
    },

    async appendOwnershipTransition(scope, record) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          /*
           * A duplicate version here *is* a concurrency conflict, and must be reported as one.
           *
           * `UNIQUE (account_id, conversation_id, version)` is the audit trail refusing to tell two
           * different stories about who owned the conversation at version N. Under PostgreSQL it
           * can fire *before* the compare-and-swap at commit does — a human takeover that lands
           * while a moderator run is preparing its own ownership transition collides here first.
           *
           * The in-memory adapter appends to an array with no uniqueness, so this ordering never
           * arises there and the CAS always got to speak first. Left untranslated, the run sees a
           * generic constraint violation, `run-moderator`'s `catch` does not recognise it, and the
           * job dead-letters with the run stranded in RUNNING — a conversation abandoned by exactly
           * the mechanism meant to protect it.
           *
           * Naming the conflict lets the existing supersede path do its job.
           */
          try {
            await client.query(
              `INSERT INTO conversation_ownership_transitions (id, account_id, conversation_id,
                  from_ownership, to_ownership, version, actor_kind, actor_user_id, reason,
                  moderator_run_id, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [
                `oth_${record.conversationId}_${String(record.version)}`,
                record.accountId,
                record.conversationId,
                record.fromOwnership,
                record.toOwnership,
                record.version,
                record.actorKind,
                record.actorUserId,
                record.reason,
                record.moderatorRunId,
                record.createdAt,
              ],
            );
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new ConcurrencyConflictError('conversation', record.version);
            }
            throw error;
          }
        },
        'conversations:appendOwnershipTransition',
      );
    },

    async listOwnershipTransitions(scope, id) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<{
            account_id: string;
            conversation_id: string;
            from_ownership: string;
            to_ownership: string;
            version: number;
            actor_kind: string;
            actor_user_id: string | null;
            reason: string;
            moderator_run_id: string | null;
            created_at: Date;
          }>(
            `SELECT account_id, conversation_id, from_ownership, to_ownership, version, actor_kind,
                    actor_user_id, reason, moderator_run_id, created_at
               FROM conversation_ownership_transitions
              WHERE conversation_id = $1 ORDER BY version`,
            [id],
          );
          return result.rows.map(
            (row): OwnershipTransitionRecord => ({
              conversationId: asId<ConversationId>(row.conversation_id),
              accountId: asId<AccountId>(row.account_id),
              fromOwnership: row.from_ownership as Conversation['ownership'],
              toOwnership: row.to_ownership as Conversation['ownership'],
              version: row.version,
              actorKind: row.actor_kind as OwnershipTransitionRecord['actorKind'],
              actorUserId: row.actor_user_id ? asId<UserId>(row.actor_user_id) : null,
              reason: row.reason,
              moderatorRunId: row.moderator_run_id
                ? asId<ModeratorRunId>(row.moderator_run_id)
                : null,
              createdAt: row.created_at,
            }),
          );
        },
        'conversations:listOwnershipTransitions',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------------------------

interface MessageRow {
  id: string;
  account_id: string;
  conversation_id: string;
  seq: number;
  direction: string;
  author_kind: string;
  author_user_id: string | null;
  channel: string;
  provider_message_id: string | null;
  dedupe_key: string;
  dedupe_source: string;
  content_type: string;
  text: string | null;
  attachments: MessageAttachment[];
  provider_ts: Date;
  received_at: Date;
  raw_inbound_event_id: string | null;
  outbound_action_id: string | null;
  redacted_at: Date | null;
}

const MESSAGE_COLUMNS = `id, account_id, conversation_id, seq, direction, author_kind,
  author_user_id, channel, provider_message_id, dedupe_key, dedupe_source, content_type, text,
  attachments, provider_ts, received_at, raw_inbound_event_id, outbound_action_id, redacted_at`;

const toMessage = (row: MessageRow): Message => ({
  id: asId<MessageId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  conversationId: asId<ConversationId>(row.conversation_id),
  seq: row.seq,
  direction: row.direction as Message['direction'],
  authorKind: row.author_kind as Message['authorKind'],
  authorUserId: row.author_user_id ? asId<UserId>(row.author_user_id) : null,
  channel: row.channel as Channel,
  providerMessageId: row.provider_message_id,
  dedupeKey: row.dedupe_key,
  dedupeSource: row.dedupe_source as Message['dedupeSource'],
  contentType: row.content_type as Message['contentType'],
  text: row.text,
  attachments: row.attachments,
  providerTs: row.provider_ts,
  receivedAt: row.received_at,
  rawInboundEventId: row.raw_inbound_event_id
    ? asId<RawInboundEventId>(row.raw_inbound_event_id)
    : null,
  outboundActionId: row.outbound_action_id ? asId<OutboundActionId>(row.outbound_action_id) : null,
  redactedAt: row.redacted_at,
});

export function createPostgresMessageRepository(db: PostgresDatabase): MessageRepository {
  return {
    async insertIfNew(scope, message) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const inserted = await client.query<MessageRow>(
            `INSERT INTO messages (${MESSAGE_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             ON CONFLICT (account_id, channel, dedupe_key) DO NOTHING
             RETURNING ${MESSAGE_COLUMNS}`,
            [
              message.id,
              message.accountId,
              message.conversationId,
              message.seq,
              message.direction,
              message.authorKind,
              message.authorUserId,
              message.channel,
              message.providerMessageId,
              message.dedupeKey,
              message.dedupeSource,
              message.contentType,
              message.text,
              json(message.attachments),
              message.providerTs,
              message.receivedAt,
              message.rawInboundEventId,
              message.outboundActionId,
              message.redactedAt,
            ],
          );
          const row = inserted.rows[0];
          if (row) return { inserted: true, record: toMessage(row) };

          const existing = await client.query<MessageRow>(
            `SELECT ${MESSAGE_COLUMNS} FROM messages
              WHERE account_id = $1 AND channel = $2 AND dedupe_key = $3`,
            [message.accountId, message.channel, message.dedupeKey],
          );
          return { inserted: false, record: toMessage(existing.rows[0]!) };
        },
        'messages:insertIfNew',
      );
    },

    async listByConversation(scope, id) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<MessageRow>(
            `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = $1 ORDER BY seq`,
            [id],
          );
          return result.rows.map(toMessage);
        },
        'messages:listByConversation',
      );
    },

    async listAboveSeq(scope, id, seq) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<MessageRow>(
            `SELECT ${MESSAGE_COLUMNS} FROM messages
              WHERE conversation_id = $1 AND seq > $2 ORDER BY seq`,
            [id, seq],
          );
          return result.rows.map(toMessage);
        },
        'messages:listAboveSeq',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// moderator_runs
// ---------------------------------------------------------------------------------------------

interface RunRow {
  id: string;
  account_id: string;
  conversation_id: string;
  state: string;
  trigger: string;
  input_watermark: number;
  observed_ownership_version: number;
  pack_version_id: string;
  prompt_template_version: string;
  decision: ModeratorRun['decision'];
  llm: ModeratorRun['llm'];
  raw_response: string | null;
  skip_reason: string | null;
  error: CodedError | null;
  job_id: string | null;
  trace_id: string;
  started_at: Date;
  finished_at: Date | null;
}

const RUN_COLUMNS = `id, account_id, conversation_id, state, trigger, input_watermark,
  observed_ownership_version, pack_version_id, prompt_template_version, decision, llm,
  raw_response, skip_reason, error, job_id, trace_id, started_at, finished_at`;

const toRun = (row: RunRow): ModeratorRun => ({
  id: asId<ModeratorRunId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  conversationId: asId<ConversationId>(row.conversation_id),
  state: row.state as ModeratorRun['state'],
  trigger: row.trigger as ModeratorRun['trigger'],
  inputWatermark: row.input_watermark,
  observedOwnershipVersion: row.observed_ownership_version,
  packVersionId: asId<AccountPackVersionId>(row.pack_version_id),
  promptTemplateVersion: row.prompt_template_version,
  decision: row.decision,
  llm: row.llm,
  rawResponse: row.raw_response,
  skipReason: row.skip_reason as ModeratorRun['skipReason'],
  error: row.error,
  jobId: row.job_id ? asId<JobId>(row.job_id) : null,
  traceId: asId<TraceId>(row.trace_id),
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export function createPostgresModeratorRunRepository(db: PostgresDatabase): ModeratorRunRepository {
  return {
    async save(scope, run) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          await client.query(
            `INSERT INTO moderator_runs (${RUN_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             ON CONFLICT (id) DO UPDATE SET
               state = EXCLUDED.state, decision = EXCLUDED.decision, llm = EXCLUDED.llm,
               raw_response = EXCLUDED.raw_response, skip_reason = EXCLUDED.skip_reason,
               error = EXCLUDED.error, input_watermark = EXCLUDED.input_watermark,
               finished_at = EXCLUDED.finished_at`,
            [
              run.id,
              run.accountId,
              run.conversationId,
              run.state,
              run.trigger,
              run.inputWatermark,
              run.observedOwnershipVersion,
              run.packVersionId,
              run.promptTemplateVersion,
              run.decision ? json(run.decision) : null,
              run.llm ? json(run.llm) : null,
              run.rawResponse,
              run.skipReason,
              run.error ? json(run.error) : null,
              run.jobId,
              run.traceId,
              run.startedAt,
              run.finishedAt,
            ],
          );
        },
        'runs:save',
      );
    },

    async findById(scope, id) {
      const row = await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<RunRow>(
            `SELECT ${RUN_COLUMNS} FROM moderator_runs WHERE id = $1`,
            [id],
          );
          return result.rows[0] ?? null;
        },
        'runs:findById',
      );
      return await readInScope(scope, row ? toRun(row) : null, 'moderator_run');
    },

    async listByConversation(scope, id) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<RunRow>(
            `SELECT ${RUN_COLUMNS} FROM moderator_runs
              WHERE conversation_id = $1 ORDER BY started_at, id`,
            [id],
          );
          return result.rows.map(toRun);
        },
        'runs:listByConversation',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// outbound_actions
// ---------------------------------------------------------------------------------------------

interface OutboundRow {
  id: string;
  account_id: string;
  conversation_id: string;
  moderator_run_id: string | null;
  action_type: string;
  delivery_mode: string;
  state: string;
  idempotency_key: string;
  payload: OutboundAction['payload'];
  provider_message_id: string | null;
  attempt: number;
  last_error: CodedError | null;
  cancelled_reason: string | null;
  created_at: Date;
  delivered_at: Date | null;
}

const OUTBOUND_COLUMNS = `id, account_id, conversation_id, moderator_run_id, action_type,
  delivery_mode, state, idempotency_key, payload, provider_message_id, attempt, last_error,
  cancelled_reason, created_at, delivered_at`;

const toOutbound = (row: OutboundRow): OutboundAction => ({
  id: asId<OutboundActionId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  conversationId: asId<ConversationId>(row.conversation_id),
  moderatorRunId: row.moderator_run_id ? asId<ModeratorRunId>(row.moderator_run_id) : null,
  actionType: row.action_type as OutboundAction['actionType'],
  deliveryMode: row.delivery_mode as OutboundAction['deliveryMode'],
  state: row.state as OutboundAction['state'],
  idempotencyKey: row.idempotency_key,
  payload: row.payload,
  providerMessageId: row.provider_message_id,
  attempt: row.attempt,
  lastError: row.last_error,
  cancelledReason: row.cancelled_reason,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
});

export function createPostgresOutboundActionRepository(
  db: PostgresDatabase,
): OutboundActionRepository {
  return {
    async save(scope, action) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          await client.query(
            `INSERT INTO outbound_actions (${OUTBOUND_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (id) DO UPDATE SET
               state = EXCLUDED.state, provider_message_id = EXCLUDED.provider_message_id,
               attempt = EXCLUDED.attempt, last_error = EXCLUDED.last_error,
               cancelled_reason = EXCLUDED.cancelled_reason, delivered_at = EXCLUDED.delivered_at`,
            [
              action.id,
              action.accountId,
              action.conversationId,
              action.moderatorRunId,
              action.actionType,
              action.deliveryMode,
              action.state,
              action.idempotencyKey,
              json(action.payload),
              action.providerMessageId,
              action.attempt,
              action.lastError ? json(action.lastError) : null,
              action.cancelledReason,
              action.createdAt,
              action.deliveredAt,
            ],
          );
        },
        'outbound:save',
      );
    },

    async findByIdempotencyKey(scope, key) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<OutboundRow>(
            `SELECT ${OUTBOUND_COLUMNS} FROM outbound_actions WHERE idempotency_key = $1`,
            [key],
          );
          const row = result.rows[0];
          return row ? toOutbound(row) : null;
        },
        'outbound:findByIdempotencyKey',
      );
    },

    async listByConversation(scope, id) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<OutboundRow>(
            `SELECT ${OUTBOUND_COLUMNS} FROM outbound_actions
              WHERE conversation_id = $1 ORDER BY created_at, id`,
            [id],
          );
          return result.rows.map(toOutbound);
        },
        'outbound:listByConversation',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// handoffs
// ---------------------------------------------------------------------------------------------

interface HandoffRow {
  id: string;
  account_id: string;
  conversation_id: string;
  kind: string;
  state: string;
  reason_code: string;
  urgency: string;
  target_queue: string | null;
  assigned_user_id: string | null;
  context_summary: Record<string, unknown>;
  triggering_run_id: string | null;
  requested_at: Date;
  assigned_at: Date | null;
  accepted_at: Date | null;
  completed_at: Date | null;
  sla_due_at: Date | null;
}

const HANDOFF_COLUMNS = `id, account_id, conversation_id, kind, state, reason_code, urgency,
  target_queue, assigned_user_id, context_summary, triggering_run_id, requested_at, assigned_at,
  accepted_at, completed_at, sla_due_at`;

const toHandoff = (row: HandoffRow): Handoff => ({
  id: asId<HandoffId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  conversationId: asId<ConversationId>(row.conversation_id),
  kind: row.kind as Handoff['kind'],
  state: row.state as Handoff['state'],
  reasonCode: row.reason_code,
  urgency: row.urgency as Handoff['urgency'],
  targetQueue: row.target_queue,
  assignedUserId: row.assigned_user_id ? asId<UserId>(row.assigned_user_id) : null,
  contextSummary: row.context_summary,
  triggeringRunId: row.triggering_run_id ? asId<ModeratorRunId>(row.triggering_run_id) : null,
  requestedAt: row.requested_at,
  assignedAt: row.assigned_at,
  acceptedAt: row.accepted_at,
  completedAt: row.completed_at,
  slaDueAt: row.sla_due_at,
});

export function createPostgresHandoffRepository(db: PostgresDatabase): HandoffRepository {
  return {
    async save(scope, handoff) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          await client.query(
            `INSERT INTO handoffs (${HANDOFF_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT (id) DO UPDATE SET
               state = EXCLUDED.state, assigned_user_id = EXCLUDED.assigned_user_id,
               target_queue = EXCLUDED.target_queue, context_summary = EXCLUDED.context_summary,
               assigned_at = EXCLUDED.assigned_at, accepted_at = EXCLUDED.accepted_at,
               completed_at = EXCLUDED.completed_at, sla_due_at = EXCLUDED.sla_due_at`,
            [
              handoff.id,
              handoff.accountId,
              handoff.conversationId,
              handoff.kind,
              handoff.state,
              handoff.reasonCode,
              handoff.urgency,
              handoff.targetQueue,
              handoff.assignedUserId,
              json(handoff.contextSummary),
              handoff.triggeringRunId,
              handoff.requestedAt,
              handoff.assignedAt,
              handoff.acceptedAt,
              handoff.completedAt,
              handoff.slaDueAt,
            ],
          );
        },
        'handoffs:save',
      );
    },

    async findById(scope, id) {
      const row = await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<HandoffRow>(
            `SELECT ${HANDOFF_COLUMNS} FROM handoffs WHERE id = $1`,
            [id],
          );
          return result.rows[0] ?? null;
        },
        'handoffs:findById',
      );
      return await readInScope(scope, row ? toHandoff(row) : null, 'handoff');
    },

    async listOpenByConversation(scope, id) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<HandoffRow>(
            `SELECT ${HANDOFF_COLUMNS} FROM handoffs
              WHERE conversation_id = $1 AND state IN ('REQUESTED','ASSIGNED','ACCEPTED')
              ORDER BY requested_at, id`,
            [id],
          );
          return result.rows.map(toHandoff);
        },
        'handoffs:listOpenByConversation',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// knowledge
// ---------------------------------------------------------------------------------------------

interface KnowledgeRow {
  id: string;
  account_id: string;
  kind: string;
  title: string;
  body: string;
  locale: string;
  status: string;
  valid_from: Date | null;
  valid_until: Date | null;
  source_ref: string | null;
  evidence: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  product_ref: string | null;
  payment_type: string | null;
  price_amount: string | null;
  price_currency: string | null;
  tags: string[];
  intent_codes: string[];
  supersedes_id: string | null;
  updated_at: Date;
}

const KNOWLEDGE_COLUMNS = `id, account_id, kind, title, body, locale, status, valid_from,
  valid_until, source_ref, evidence, approved_by, approved_at, product_ref, payment_type,
  price_amount, price_currency, tags, intent_codes, supersedes_id, updated_at`;

const toKnowledge = (row: KnowledgeRow): KnowledgeEntry => ({
  id: asId<KnowledgeEntryId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  kind: row.kind as KnowledgeEntry['kind'],
  title: row.title,
  body: row.body,
  locale: row.locale,
  status: row.status as KnowledgeEntry['status'],
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  sourceRef: row.source_ref,
  evidence: row.evidence,
  approvedBy: row.approved_by ? asId<UserId>(row.approved_by) : null,
  approvedAt: row.approved_at,
  productRef: row.product_ref,
  paymentType: row.payment_type,
  // `numeric` is read as a string (see the type parser in client.ts). A price that round-trips
  // through a float is a price we would eventually have to explain to a customer.
  price:
    row.price_amount !== null && row.price_currency !== null
      ? { amount: row.price_amount, currency: row.price_currency }
      : null,
  tags: textArray(row.tags),
  intentCodes: textArray(row.intent_codes),
  supersedesId: row.supersedes_id ? asId<KnowledgeEntryId>(row.supersedes_id) : null,
  updatedAt: row.updated_at,
});

export function createPostgresKnowledgeRepository(db: PostgresDatabase): KnowledgeRepository {
  return {
    async findApproved(scope, query) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          // Status and locale are filtered in SQL; *validity* deliberately is not. The Knowledge
          // Gate owns the validity decision and re-checks it after the model answers (ADR-010),
          // so pushing `valid_until > now()` down here would split that rule across two places.
          const result = await client.query<KnowledgeRow>(
            `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge_entries
              WHERE status = 'APPROVED' AND locale = $1
                AND (tags && $2::text[] OR intent_codes && $3::text[])
              ORDER BY updated_at DESC, id
              LIMIT $4`,
            [query.locale, textArray(query.tags), textArray(query.intentCodes), query.limit],
          );
          return result.rows.map(toKnowledge);
        },
        'knowledge:findApproved',
      );
    },

    async findByIds(scope, entryIds) {
      if (entryIds.length === 0) return [];
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<KnowledgeRow>(
            `SELECT ${KNOWLEDGE_COLUMNS} FROM knowledge_entries WHERE id = ANY($1::text[])`,
            [[...entryIds]],
          );
          return result.rows.map(toKnowledge);
        },
        'knowledge:findByIds',
      );
    },

    async save(scope, entry) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          await client.query(
            `INSERT INTO knowledge_entries (${KNOWLEDGE_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
             ON CONFLICT (id) DO UPDATE SET
               title = EXCLUDED.title, body = EXCLUDED.body, status = EXCLUDED.status,
               valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until,
               approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
               price_amount = EXCLUDED.price_amount, price_currency = EXCLUDED.price_currency,
               tags = EXCLUDED.tags, intent_codes = EXCLUDED.intent_codes,
               updated_at = EXCLUDED.updated_at`,
            [
              entry.id,
              entry.accountId,
              entry.kind,
              entry.title,
              entry.body,
              entry.locale,
              entry.status,
              entry.validFrom,
              entry.validUntil,
              entry.sourceRef,
              entry.evidence,
              entry.approvedBy,
              entry.approvedAt,
              entry.productRef,
              entry.paymentType,
              entry.price?.amount ?? null,
              entry.price?.currency ?? null,
              textArray(entry.tags),
              textArray(entry.intentCodes),
              entry.supersedesId,
              entry.updatedAt,
            ],
          );
        },
        'knowledge:save',
      );
    },
  };
}

interface PackRow {
  id: string;
  account_id: string;
  version: number;
  status: string;
  content_hash: string;
  sections: Readonly<Partial<Record<PackSectionKey, unknown>>>;
  schema_version: string;
  published_by: string | null;
  published_at: Date | null;
  notes: string | null;
}

const PACK_COLUMNS = `id, account_id, version, status, content_hash, sections, schema_version,
  published_by, published_at, notes`;

const toPack = (row: PackRow): AccountPackVersion => ({
  id: asId<AccountPackVersionId>(row.id),
  accountId: asId<AccountId>(row.account_id),
  version: row.version,
  status: row.status as AccountPackVersion['status'],
  contentHash: row.content_hash,
  sections: row.sections,
  schemaVersion: row.schema_version,
  publishedBy: row.published_by ? asId<UserId>(row.published_by) : null,
  publishedAt: row.published_at,
  notes: row.notes,
});

export function createPostgresAccountPackRepository(db: PostgresDatabase): AccountPackRepository {
  return {
    async findActive(scope) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<PackRow>(
            `SELECT ${PACK_COLUMNS} FROM account_pack_versions WHERE status = 'ACTIVE'`,
          );
          const row = result.rows[0];
          return row ? toPack(row) : null;
        },
        'packs:findActive',
      );
    },

    async findById(scope, id) {
      const row = await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<PackRow>(
            `SELECT ${PACK_COLUMNS} FROM account_pack_versions WHERE id = $1`,
            [id],
          );
          return result.rows[0] ?? null;
        },
        'packs:findById',
      );
      return await readInScope(scope, row ? toPack(row) : null, 'account_pack_version');
    },

    async save(scope, pack) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          // Supersede first, in the same transaction: `account_pack_versions_one_active_idx` is a
          // partial unique index, so publishing without demoting the incumbent is a constraint
          // violation rather than two active packs. Ordering it here makes the rule enforceable.
          if (pack.status === 'ACTIVE') {
            await client.query(
              `UPDATE account_pack_versions SET status = 'SUPERSEDED'
                WHERE status = 'ACTIVE' AND id <> $1`,
              [pack.id],
            );
          }
          await client.query(
            `INSERT INTO account_pack_versions (${PACK_COLUMNS})
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (id) DO UPDATE SET
               status = EXCLUDED.status, published_by = EXCLUDED.published_by,
               published_at = EXCLUDED.published_at, notes = EXCLUDED.notes`,
            [
              pack.id,
              pack.accountId,
              pack.version,
              pack.status,
              pack.contentHash,
              json(pack.sections),
              pack.schemaVersion,
              pack.publishedBy,
              pack.publishedAt,
              pack.notes,
            ],
          );
        },
        'packs:save',
      );
    },
  };
}

export function createPostgresKnowledgeGapRepository(
  db: PostgresDatabase,
  ids: IdFactory,
): KnowledgeGapRepository {
  return {
    async record(scope, gap) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          // The schema models a gap as a *counter*, not a log: `UNIQUE (account_id,
          // question_shape, locale)` plus `occurrences`. A backlog that lists the same unanswered
          // question three hundred times is unusable; one that ranks it by frequency is a work
          // queue.
          await client.query(
            `INSERT INTO knowledge_gaps (id, account_id, conversation_id, moderator_run_id,
                question_shape, intent_code, locale, first_seen_at, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
             ON CONFLICT (account_id, question_shape, locale) DO UPDATE
               SET occurrences = knowledge_gaps.occurrences + 1,
                   last_seen_at = EXCLUDED.last_seen_at`,
            [
              ids.next(ID_PREFIX.knowledgeGap),
              scope.accountId,
              gap.conversationId,
              gap.moderatorRunId,
              gap.questionShape,
              gap.intentCode,
              gap.locale,
              gap.observedAt,
            ],
          );
        },
        'knowledgeGaps:record',
      );
    },

    async list(scope) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<{
            account_id: string;
            conversation_id: string | null;
            moderator_run_id: string | null;
            question_shape: string;
            intent_code: string;
            locale: string;
            last_seen_at: Date;
          }>(
            `SELECT account_id, conversation_id, moderator_run_id, question_shape, intent_code,
                    locale, last_seen_at
               FROM knowledge_gaps ORDER BY occurrences DESC, question_shape`,
          );
          return result.rows.map(
            (row): KnowledgeGapRecord => ({
              accountId: row.account_id,
              conversationId: row.conversation_id ?? '',
              moderatorRunId: row.moderator_run_id ?? '',
              questionShape: row.question_shape,
              intentCode: row.intent_code,
              locale: row.locale,
              observedAt: row.last_seen_at,
            }),
          );
        },
        'knowledgeGaps:list',
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// outbox, audit, dead letters
// ---------------------------------------------------------------------------------------------

interface OutboxRow {
  id: string;
  account_id: string;
  type: string;
  version: number;
  subject_type: string;
  subject_id: string;
  data: DomainEventEnvelope['data'];
  trace_id: string;
  occurred_at: Date;
}

const toEnvelope = (row: OutboxRow): DomainEventEnvelope => ({
  eventId: asId<DomainEventId>(row.id),
  type: row.type as DomainEventType,
  version: row.version,
  occurredAt: row.occurred_at,
  accountId: asId<AccountId>(row.account_id),
  subject: { type: row.subject_type, id: row.subject_id },
  traceId: asId<TraceId>(row.trace_id),
  data: row.data,
});

const OUTBOX_SELECT = `id, account_id, type, version, subject_type, subject_id, data, trace_id,
  occurred_at`;

/**
 * The tenant-scoped write side of the outbox.
 *
 * `relayDb` is the *relay* pool, and it is required rather than optional. `markRelayed` is a
 * cross-tenant write by nature — its signature carries no scope because a relay does not have one
 * — so on the runtime pool it would match zero rows under RLS and the relay would redeliver
 * forever. Phase 01 threw `NotImplementedError` here rather than fail that quietly; Phase 02
 * hands it the role that can actually do the write. See `createPostgresOutboxRelayStore`.
 */
export function createPostgresEventOutbox(
  db: PostgresDatabase,
  relayDb: PostgresDatabase,
): EventOutbox {
  const relay = createPostgresOutboxRelayStore(relayDb);
  return {
    async append(scope, event) {
      // Validate before touching the database, exactly as the in-memory outbox does: publishing an
      // unregistered type is a programming error, and a contract nobody validates is no contract.
      assertPublishable(event);
      await db.scoped(
        scope.accountId,
        async (client) => {
          await client.query(
            `INSERT INTO domain_event_outbox (id, account_id, type, version, subject_type,
                subject_id, data, trace_id, occurred_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (id) DO NOTHING`,
            [
              event.eventId,
              event.accountId,
              event.type,
              event.version,
              event.subject.type,
              event.subject.id,
              json(event.data),
              event.traceId,
              event.occurredAt,
            ],
          );
        },
        'outbox:append',
      );
    },

    async listPending(scope) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<OutboxRow>(
            `SELECT ${OUTBOX_SELECT} FROM domain_event_outbox
              WHERE relayed_at IS NULL ORDER BY occurred_at, id`,
          );
          return result.rows.map(toEnvelope);
        },
        'outbox:listPending',
      );
    },

    async listAll(scope) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<OutboxRow>(
            `SELECT ${OUTBOX_SELECT} FROM domain_event_outbox ORDER BY occurred_at, id`,
          );
          return result.rows.map(toEnvelope);
        },
        'outbox:listAll',
      );
    },

    async markRelayed(eventId) {
      // Delegates to the relay pool. The `false` return (already relayed) is swallowed here
      // because this signature cannot express it; callers that need to distinguish a first relay
      // from a duplicate use `OutboxRelayStore.markRelayed` directly, which is what the relay
      // service does.
      await relay.markRelayed(eventId, new Date());
    },
  };
}

/**
 * The cross-tenant read side of the outbox, on the relay role.
 *
 * Every statement here runs unscoped, which is only safe because of what `app_relay` is granted:
 * `SELECT` on `domain_event_outbox` and `UPDATE (relayed_at)` on the same table, and nothing
 * else in the database. Migration 0007 is the real enforcement; this file is the caller.
 */
export function createPostgresOutboxRelayStore(db: PostgresDatabase): OutboxRelayStore {
  return {
    async listPending(limit) {
      return await db.unscoped(async (client) => {
        // `(occurred_at, id)` matches the partial relay index, and the tiebreaker keeps the order
        // total: two events in the same millisecond must still relay in a stable order.
        const result = await client.query<OutboxRow>(
          `SELECT ${OUTBOX_SELECT} FROM domain_event_outbox
            WHERE relayed_at IS NULL ORDER BY occurred_at, id LIMIT $1`,
          [limit],
        );
        return result.rows.map(toEnvelope);
      }, 'relay:listPending');
    },

    async markRelayed(eventId, now) {
      return await db.unscoped(async (client) => {
        // `relayed_at IS NULL` is the idempotency guard, and it is the reason this returns a
        // boolean at all: two relays racing on the same event must produce exactly one "first
        // delivery" and one "already done", not two of either.
        const result = await client.query(
          `UPDATE domain_event_outbox SET relayed_at = $2::timestamptz
            WHERE id = $1 AND relayed_at IS NULL`,
          [eventId, now],
        );
        return (result.rowCount ?? 0) > 0;
      }, 'relay:markRelayed');
    },

    async backlog() {
      return await db.unscoped(async (client) => {
        const result = await client.query<{ pending: string; oldest: Date | null }>(
          `SELECT count(*)::text AS pending, min(occurred_at) AS oldest
             FROM domain_event_outbox WHERE relayed_at IS NULL`,
        );
        const row = result.rows[0];
        return { pending: Number(row?.pending ?? '0'), oldestAt: row?.oldest ?? null };
      }, 'relay:backlog');
    },
  };
}

/**
 * The store-shaped half of the health snapshot.
 *
 * Two pools, because the two questions belong to two roles. The queue-facing role answers "is the
 * database there?" and "how far behind is ingest?"; the relay role answers "how far behind is the
 * outbox?". Neither is given reach it did not already have for its own work — which is the point
 * of asking them separately rather than opening a third door.
 */
export function createPostgresStoreProbe(deps: {
  workerDb: PostgresDatabase;
  relayDb: PostgresDatabase;
}): StoreProbe {
  const relay = createPostgresOutboxRelayStore(deps.relayDb);
  return {
    async ping() {
      await deps.workerDb.unscoped(async (client) => {
        await client.query('SELECT 1');
      }, 'health:ping');
    },

    async inboundBacklog() {
      return await deps.workerDb.unscoped(async (client) => {
        // A SECURITY DEFINER aggregate (0007), not a table read. The worker role has no grant on
        // `raw_inbound_events` at all, so this endpoint cannot be turned into a row reader by a
        // later edit — the function returns a count and a timestamp or nothing.
        const result = await client.query<{ pending: string; oldest_received_at: Date | null }>(
          'SELECT pending, oldest_received_at FROM app_inbound_backlog()',
        );
        const row = result.rows[0];
        return {
          pending: Number(row?.pending ?? '0'),
          oldestAt: row?.oldest_received_at ?? null,
        };
      }, 'health:inboundBacklog');
    },

    outboxBacklog: () => relay.backlog(),
  };
}

export function createPostgresAuditLog(db: PostgresDatabase, ids: IdFactory): AuditLog {
  return {
    async append(scope, event) {
      await db.scoped(
        scope.accountId,
        async (client) => {
          await client.query(
            `INSERT INTO audit_events (id, account_id, action, subject_type, subject_id,
                actor_kind, actor_user_id, detail, occurred_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              ids.next<AuditEventId>(ID_PREFIX.auditEvent),
              scope.accountId,
              event.action,
              event.subjectType,
              event.subjectId,
              event.actorKind,
              event.actorUserId,
              json(event.detail),
              event.occurredAt,
            ],
          );
        },
        'audit:append',
      );
    },

    async list(scope) {
      return await db.scoped(
        scope.accountId,
        async (client) => {
          const result = await client.query<{
            id: string;
            account_id: string;
            action: string;
            subject_type: string;
            subject_id: string;
            actor_kind: string;
            actor_user_id: string | null;
            detail: AuditEvent['detail'];
            occurred_at: Date;
          }>(
            `SELECT id, account_id, action, subject_type, subject_id, actor_kind, actor_user_id,
                    detail, occurred_at
               FROM audit_events ORDER BY occurred_at, id`,
          );
          return result.rows.map(
            (row): AuditEvent => ({
              id: asId<AuditEventId>(row.id),
              accountId: row.account_id,
              action: row.action as AuditEvent['action'],
              subjectType: row.subject_type,
              subjectId: row.subject_id,
              actorKind: row.actor_kind as AuditEvent['actorKind'],
              actorUserId: row.actor_user_id ? asId<UserId>(row.actor_user_id) : null,
              detail: row.detail,
              occurredAt: row.occurred_at,
            }),
          );
        },
        'audit:list',
      );
    },
  };
}

/**
 * The dead-letter store runs on the worker database.
 *
 * `list()` and `count()` take no scope because a dead letter is an *operational* fact — the queue
 * that should be empty — and the worker that records one has no tenant context at that moment.
 * The `app_worker` role is granted these two tables and nothing else, so cross-tenant visibility
 * here does not extend one inch further.
 */
export function createPostgresDeadLetterStore(
  db: PostgresDatabase,
  ids: IdFactory,
): DeadLetterStore {
  return {
    async record(entry: DeadLetter) {
      await db.unscoped(async (client) => {
        await client.query(
          `INSERT INTO dead_letters (id, account_id, job_id, job_type, job_payload, error,
              attempts, recorded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            ids.next<DeadLetterId>(ID_PREFIX.deadLetter),
            entry.job.accountId,
            entry.job.id,
            entry.job.type,
            json(entry.job.payload),
            json(entry.error),
            entry.job.attempt,
            entry.recordedAt,
          ],
        );
      }, 'deadLetters:record');
    },

    async list() {
      return await db.unscoped(async (client) => {
        const result = await client.query<{
          job_id: string;
          account_id: string;
          job_type: string;
          job_payload: Record<string, string>;
          error: CodedError;
          attempts: number;
          recorded_at: Date;
        }>(
          `SELECT d.job_id, d.account_id, d.job_type, d.job_payload, d.error, d.attempts,
                  d.recorded_at
             FROM dead_letters d ORDER BY d.recorded_at, d.id`,
        );
        // The stored row is a *snapshot*, not a join back to `jobs`: a dead letter must stay
        // readable and replayable even after the job row is purged by retention.
        return result.rows.map(
          (row): DeadLetter => ({
            job: {
              id: asId<JobId>(row.job_id),
              accountId: asId<AccountId>(row.account_id),
              type: row.job_type as DeadLetter['job']['type'],
              partitionKey: '',
              dedupeKey: null,
              payload: row.job_payload,
              state: 'DEAD_LETTERED',
              runAt: row.recorded_at,
              attempt: row.attempts,
              maxAttempts: row.attempts,
              leaseOwner: null,
              leaseExpiresAt: null,
              firstEnqueuedAt: row.recorded_at,
              lastError: row.error,
              traceId: asId<TraceId>(''),
              seq: 0,
            },
            error: row.error,
            recordedAt: row.recorded_at,
          }),
        );
      }, 'deadLetters:list');
    },

    async count() {
      return await db.unscoped(async (client) => {
        const result = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM dead_letters',
        );
        return Number(result.rows[0]!.count);
      }, 'deadLetters:count');
    },
  };
}

/**
 * Allocates the next message sequence for a conversation.
 *
 * Exported because it is a *concurrency* primitive rather than a repository method: read-then-write
 * on `next_seq` from JavaScript is the textbook lost update, and two concurrent webhook deliveries
 * for the same conversation would both take the same seq. One statement, one row lock.
 */
export async function allocateNextSeq(
  db: PostgresDatabase,
  scope: AccountScope,
  conversationId: ConversationId,
): Promise<number> {
  return await db.scoped(
    scope.accountId,
    async (client) => {
      const result = await client.query<{ seq: number }>(
        `UPDATE conversations
            SET next_seq = next_seq + 1, last_inbound_seq = next_seq
          WHERE id = $1
          RETURNING last_inbound_seq AS seq`,
        [conversationId],
      );
      return result.rows[0]!.seq;
    },
    'conversations:allocateNextSeq',
  );
}
