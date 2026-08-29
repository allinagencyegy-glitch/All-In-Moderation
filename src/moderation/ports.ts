import type { AccountScope } from '../core/account/index.ts';
import type { Channel, Surface } from '../core/channel.ts';
import type {
  ChannelConnectionId,
  ChannelIdentityId,
  ConversationId,
  HandoffId,
  MessageId,
  ModeratorRunId,
  OutboundActionId,
  RawInboundEventId,
} from '../platform/ids.ts';
import type { ChannelConnection } from './domain/channel.ts';
import type { ChannelIdentity } from './domain/identity.ts';
import type { Conversation, OwnershipTransitionRecord } from './domain/conversation.ts';
import type { Handoff } from './domain/handoff.ts';
import type { Message } from './domain/message.ts';
import type { ModeratorRun } from './domain/moderator-run.ts';
import type { OutboundAction } from './domain/outbound-action.ts';
import type { OutboundActionReview } from './domain/review.ts';
import type { RawInboundEvent } from './domain/raw-event.ts';

/**
 * Repository ports for the moderation module.
 *
 * Every method takes an `AccountScope` first — except `findByPublicWebhookId`, which is the
 * operation that *establishes* tenancy from an opaque URL id before a request body is parsed
 * (ADR-006). That single exception is the reason it is called out here rather than buried.
 */

export interface ChannelConnectionRepository {
  /** Tenancy resolution path. Deliberately unscoped; every caller must scope what it does next. */
  findByPublicWebhookId(publicWebhookId: string): Promise<ChannelConnection | null>;
  findById(scope: AccountScope, id: ChannelConnectionId): Promise<ChannelConnection | null>;
  findByExternalId(
    scope: AccountScope,
    channel: Channel,
    externalId: string,
  ): Promise<ChannelConnection | null>;
  save(connection: ChannelConnection): Promise<void>;
}

export interface InsertResult<T> {
  readonly inserted: boolean;
  readonly record: T;
}

export interface RawInboundEventRepository {
  /**
   * Insert-or-return, keyed on `(channelConnectionId, deliveryKey)`.
   *
   * `inserted: false` means a duplicate webhook delivery — a normal, non-alerting outcome that
   * must be reported rather than swallowed (F-01).
   */
  insertIfNew(scope: AccountScope, event: RawInboundEvent): Promise<InsertResult<RawInboundEvent>>;
  findById(scope: AccountScope, id: RawInboundEventId): Promise<RawInboundEvent | null>;
  save(scope: AccountScope, event: RawInboundEvent): Promise<void>;
  listByConnection(
    scope: AccountScope,
    id: ChannelConnectionId,
  ): Promise<readonly RawInboundEvent[]>;
}

export interface ChannelIdentityRepository {
  findOrCreate(
    scope: AccountScope,
    input: { channel: Channel; externalId: string; displayName: string | null; now: Date },
  ): Promise<ChannelIdentity>;
  findById(scope: AccountScope, id: ChannelIdentityId): Promise<ChannelIdentity | null>;
}

export interface ConversationLookup {
  readonly channelConnectionId: ChannelConnectionId;
  readonly channelIdentityId: ChannelIdentityId;
  readonly surface: Surface;
  readonly threadRef: string | null;
}

export interface ConversationRepository {
  /** The reopen rule lives here: a CLOSED conversation is still the right one to return. */
  findActiveFor(scope: AccountScope, lookup: ConversationLookup): Promise<Conversation | null>;
  findById(scope: AccountScope, id: ConversationId): Promise<Conversation | null>;
  /**
   * Unconditional write. Only safe when the caller holds the conversation's job partition for the
   * whole read-modify-write, which is true of the ingest path and of nothing that awaits a model.
   */
  save(scope: AccountScope, conversation: Conversation): Promise<void>;
  /**
   * Compare-and-swap on `ownershipVersion` — returns false when someone else moved first.
   *
   * Ownership is contended between the job queue and the operator UI, and the queue's partition
   * key serialises only the former. A moderator run that read the conversation before a slow model
   * call must write through here, or it will silently overwrite a takeover that landed while it was
   * thinking (ADR-008, F-13). Postgres implements this as
   * `UPDATE ... WHERE id = $1 AND ownership_version = $2`.
   */
  saveIfUnchanged(
    scope: AccountScope,
    conversation: Conversation,
    expectedOwnershipVersion: number,
  ): Promise<boolean>;
  appendOwnershipTransition(scope: AccountScope, record: OwnershipTransitionRecord): Promise<void>;
  listOwnershipTransitions(
    scope: AccountScope,
    id: ConversationId,
  ): Promise<readonly OwnershipTransitionRecord[]>;
}

export interface MessageRepository {
  /** Item-level dedupe, keyed on `(accountId, channel, dedupeKey)` (ADR-006). */
  insertIfNew(scope: AccountScope, message: Message): Promise<InsertResult<Message>>;
  /**
   * A single message by id.
   *
   * The request path never needs this — it always works a conversation at a time — but the shadow
   * trace does: it walks forward from the message ids the ledger row recorded, which is what makes
   * "these messages exist *because* this delivery arrived" a proof rather than a correlation.
   */
  findById(scope: AccountScope, id: MessageId): Promise<Message | null>;
  listByConversation(scope: AccountScope, id: ConversationId): Promise<readonly Message[]>;
  listAboveSeq(scope: AccountScope, id: ConversationId, seq: number): Promise<readonly Message[]>;
}

export interface ModeratorRunRepository {
  save(scope: AccountScope, run: ModeratorRun): Promise<void>;
  findById(scope: AccountScope, id: ModeratorRunId): Promise<ModeratorRun | null>;
  listByConversation(scope: AccountScope, id: ConversationId): Promise<readonly ModeratorRun[]>;
}

export interface OutboundActionRepository {
  save(scope: AccountScope, action: OutboundAction): Promise<void>;
  findById(scope: AccountScope, id: OutboundActionId): Promise<OutboundAction | null>;
  findByIdempotencyKey(scope: AccountScope, key: string): Promise<OutboundAction | null>;
  listByConversation(scope: AccountScope, id: ConversationId): Promise<readonly OutboundAction[]>;
  /**
   * The review queue: suggested drafts still waiting for a person, oldest first.
   *
   * Oldest first because the audit's costliest finding was a price question that sat for five
   * days. A newest-first queue makes exactly that failure invisible.
   */
  listAwaitingReview(scope: AccountScope, limit: number): Promise<readonly OutboundAction[]>;
}

/**
 * Append-only. `save` inserts; there is no update and no delete, on this port or in the schema.
 *
 * A review is a statement a named person made at a point in time. Editing one would leave the
 * record saying something they did not say, and the whole value of the table is that it can be
 * trusted when someone asks why a particular reply went out.
 */
export interface OutboundActionReviewRepository {
  save(scope: AccountScope, review: OutboundActionReview): Promise<void>;
  listByAction(scope: AccountScope, id: OutboundActionId): Promise<readonly OutboundActionReview[]>;
  listByConversation(
    scope: AccountScope,
    id: ConversationId,
  ): Promise<readonly OutboundActionReview[]>;
}

export interface HandoffRepository {
  save(scope: AccountScope, handoff: Handoff): Promise<void>;
  findById(scope: AccountScope, id: HandoffId): Promise<Handoff | null>;
  listOpenByConversation(scope: AccountScope, id: ConversationId): Promise<readonly Handoff[]>;
}

/**
 * Secrets are resolved by reference, never stored on the connection row.
 *
 * Keeping the indirection means a database dump does not contain app secrets, and rotation is a
 * secret-store operation rather than a migration.
 */
export interface ChannelSecrets {
  /** Signs and verifies the webhook body. Never logged, never stored on the connection row. */
  readonly appSecret: string;
  /**
   * The provider's subscription-handshake token.
   *
   * Separate from `appSecret` because it is a different secret with a different blast radius: it
   * only ever proves "this URL is ours" during subscription setup, and it travels in a query
   * string — a place an app secret must never appear. Absent means this connection declines the
   * handshake rather than accepting any token.
   */
  readonly verifyToken?: string;
}

export interface SecretResolver {
  resolve(credentialsRef: string): Promise<ChannelSecrets | null>;
}
