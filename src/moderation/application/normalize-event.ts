import type { AccountRepository } from '../../core/account/index.ts';
import { scopedPartitionKey } from '../../core/account/index.ts';
import type { AccountScope } from '../../core/account/index.ts';
import type { Clock } from '../../platform/clock.ts';
import type { Logger } from '../../platform/logger.ts';
import type {
  ConversationId,
  DomainEventId,
  IdFactory,
  MessageId,
  RawInboundEventId,
} from '../../platform/ids.ts';
import { ID_PREFIX } from '../../platform/ids.ts';
import { TerminalError } from '../../platform/errors.ts';
import type { TransactionRunner } from '../../operations/transaction.ts';
import type { JobQueue } from '../../operations/jobs/queue.ts';
import type { EventOutbox } from '../../operations/events/outbox.ts';
import { assertPublishable } from '../../operations/events/outbox.ts';
import type { InboundEnvelopeParser, NormalizedInboundItem } from '../domain/inbound.ts';
import type { AccountPackRepository } from '../../knowledge/ports.ts';
import type { Conversation } from '../domain/conversation.ts';
import { transitionLifecycle } from '../domain/conversation.ts';
import type { Message } from '../domain/message.ts';
import { transitionRawEvent } from '../domain/raw-event.ts';
import type {
  ChannelConnectionRepository,
  ChannelIdentityRepository,
  ConversationRepository,
  MessageRepository,
  RawInboundEventRepository,
} from '../ports.ts';
import { resolveRoutingPolicy } from './routing-policy.ts';

/**
 * Turns a raw ledger row into conversations and messages.
 *
 * Idempotent by construction (ADR-006): every message insert is conditional on the item-level
 * dedupe key, so redelivery of the whole job inserts nothing new, and a crash halfway through an
 * envelope is safe because the surviving rows are skipped on the retry.
 *
 * This is also where burst coalescing is armed: each new inbound message schedules a moderator
 * run under one dedupe key per conversation, so three messages in five seconds produce one run.
 */

export interface NormalizeResult {
  readonly rawEventId: RawInboundEventId;
  readonly createdMessageIds: readonly MessageId[];
  readonly duplicateItems: number;
  readonly ignoredItems: number;
  readonly touchedConversations: readonly ConversationId[];
}

export interface NormalizeEventDeps {
  readonly rawEvents: RawInboundEventRepository;
  readonly connections: ChannelConnectionRepository;
  readonly accounts: AccountRepository;
  readonly identities: ChannelIdentityRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly packs: AccountPackRepository;
  /** Injected per channel: the domain must not know that Meta exists. */
  readonly parser: InboundEnvelopeParser;
  readonly queue: JobQueue;
  readonly outbox: EventOutbox;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: Logger;
  readonly config?: { readonly moderatorMaxAttempts: number };
}

export interface NormalizeEventService {
  normalize(rawEventId: RawInboundEventId, accountScope: AccountScope): Promise<NormalizeResult>;
}

export function createNormalizeEventService(deps: NormalizeEventDeps): NormalizeEventService {
  const moderatorMaxAttempts = deps.config?.moderatorMaxAttempts ?? 5;
  return {
    async normalize(rawEventId, scope) {
      const event = await deps.rawEvents.findById(scope, rawEventId);
      if (!event) {
        throw new TerminalError('RAW_EVENT_NOT_FOUND', 'Raw inbound event does not exist', {
          rawEventId,
        });
      }

      // Redelivery after the work already committed: exit as a no-op rather than re-normalising.
      if (event.state === 'NORMALIZED' || event.state === 'IGNORED') {
        deps.logger.debug('raw event already normalized', { raw_event_id: rawEventId });
        return {
          rawEventId,
          createdMessageIds: event.producedMessageIds,
          duplicateItems: 0,
          ignoredItems: 0,
          touchedConversations: [],
        };
      }
      if (event.state === 'REJECTED') {
        throw new TerminalError('RAW_EVENT_REJECTED', 'Refusing to normalise a rejected event', {
          rawEventId,
        });
      }

      const logger = deps.logger.child({
        account_id: scope.accountId,
        raw_event_id: rawEventId,
        trace_id: event.traceId,
      });

      const connection = await deps.connections.findById(scope, event.channelConnectionId);
      if (!connection) {
        throw new TerminalError('CONNECTION_NOT_FOUND', 'Channel connection no longer exists', {
          channelConnectionId: event.channelConnectionId,
        });
      }

      const now = deps.clock.now();
      const parsed = deps.parser.parse(event.payload, now);
      if (parsed.issues.length > 0) {
        logger.warn('envelope parse issues', { issue_count: parsed.issues.length });
      }

      const pack = await deps.packs.findActive(scope);
      const routing = resolveRoutingPolicy(pack);

      const createdMessageIds: MessageId[] = [];
      const touched = new Set<ConversationId>();
      let duplicateItems = 0;
      let ignoredItems = parsed.ignored;

      await deps.transactions.run(async () => {
        for (const item of parsed.items) {
          if (item.kind === 'UNSUPPORTED') {
            // Recorded, not dropped: "the customer tapped a button and nothing happened" must be
            // visible in the data (F-25).
            ignoredItems += 1;
            logger.info('unsupported inbound item', {
              channel: item.channel,
              surface: item.surface,
            });
            continue;
          }
          if (item.connectionExternalId !== connection.externalId) {
            // The envelope claims a page this connection does not own. Never trust payload
            // contents for tenancy — the URL already told us who this is.
            ignoredItems += 1;
            logger.warn('envelope entry did not match connection', { channel: item.channel });
            continue;
          }

          const outcome = await ingestItem(deps, scope, connection.id, item, now);
          if (outcome.duplicate) {
            duplicateItems += 1;
            continue;
          }
          createdMessageIds.push(outcome.messageId);
          touched.add(outcome.conversationId);

          if (outcome.conversationCreated) {
            const started = {
              eventId: deps.ids.next<DomainEventId>(ID_PREFIX.domainEvent),
              type: 'conversation.started' as const,
              version: 1,
              occurredAt: now,
              accountId: scope.accountId,
              subject: { type: 'conversation', id: outcome.conversationId },
              traceId: event.traceId,
              data: {
                conversation_id: outcome.conversationId,
                channel: item.channel,
                surface: item.surface,
                started_at: now.toISOString(),
              },
            };
            assertPublishable(started);
            await deps.outbox.append(scope, started);
          }
        }

        // One coalesced run per touched conversation, not one per message (ADR-005 §3).
        for (const conversationId of touched) {
          await deps.queue.enqueueCoalesced(
            {
              accountId: scope.accountId,
              type: 'moderator.run',
              partitionKey: scopedPartitionKey(scope, 'conv', conversationId),
              dedupeKey: `moderator.run:${conversationId}`,
              payload: { conversationId },
              runAt: now,
              maxAttempts: moderatorMaxAttempts,
              traceId: event.traceId,
            },
            { debounceMs: routing.debounceMs, maxDelayMs: routing.maxDelayMs },
          );
        }

        const finalState = createdMessageIds.length > 0 ? 'NORMALIZED' : 'IGNORED';
        await deps.rawEvents.save(
          scope,
          transitionRawEvent(transitionRawEvent(event, 'NORMALIZING'), finalState, {
            normalizedAt: now,
            producedMessageIds: createdMessageIds,
          }),
        );
      });

      logger.info('raw event normalized', {
        created: createdMessageIds.length,
        duplicates: duplicateItems,
        ignored: ignoredItems,
      });

      return {
        rawEventId,
        createdMessageIds,
        duplicateItems,
        ignoredItems,
        touchedConversations: [...touched],
      };
    },
  };
}

interface ItemOutcome {
  readonly duplicate: boolean;
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly conversationCreated: boolean;
}

async function ingestItem(
  deps: NormalizeEventDeps,
  scope: AccountScope,
  channelConnectionId: Conversation['channelConnectionId'],
  item: NormalizedInboundItem,
  now: Date,
): Promise<ItemOutcome> {
  const identity = await deps.identities.findOrCreate(scope, {
    channel: item.channel,
    externalId: item.senderExternalId,
    displayName: null,
    now,
  });

  const existing = await deps.conversations.findActiveFor(scope, {
    channelConnectionId,
    channelIdentityId: identity.id,
    surface: item.surface,
    threadRef: item.threadRef,
  });

  let conversation: Conversation;
  let conversationCreated = false;
  if (existing) {
    // A closed conversation reopens rather than spawning a parallel thread; the customer sees one
    // conversation, so we must too.
    conversation =
      existing.lifecycle === 'OPEN' ? existing : transitionLifecycle(existing, 'OPEN', now);
  } else {
    conversationCreated = true;
    conversation = {
      id: deps.ids.next<ConversationId>(ID_PREFIX.conversation),
      accountId: scope.accountId,
      channelConnectionId,
      channelIdentityId: identity.id,
      contactIdentityId: identity.contactIdentityId,
      surface: item.surface,
      threadRef: item.threadRef,
      lifecycle: 'OPEN',
      ownership: 'AI_OWNED',
      ownershipVersion: 0,
      ownerUserId: null,
      engagement: 'AWAITING_MODERATOR',
      nextSeq: 1,
      lastInboundSeq: 0,
      lastProcessedInboundSeq: 0,
      locale: null,
      snoozedUntil: null,
      closedAt: null,
      firstMessageAt: null,
      lastMessageAt: null,
      createdAt: now,
    };
  }

  const seq = conversation.nextSeq;
  const message: Message = {
    id: deps.ids.next<MessageId>(ID_PREFIX.message),
    accountId: scope.accountId,
    conversationId: conversation.id,
    seq,
    direction: 'INBOUND',
    authorKind: 'CUSTOMER',
    authorUserId: null,
    channel: item.channel,
    providerMessageId: item.providerMessageId,
    dedupeKey: item.dedupeKey,
    dedupeSource: item.dedupeSource,
    contentType: item.contentType,
    text: item.text,
    attachments: item.attachments.map((attachment, index) => ({
      id: `${item.dedupeKey}:${index}`,
      kind: attachment.kind,
      providerUrl: attachment.url,
      storageRef: null,
      mimeType: null,
      sizeBytes: null,
      checksum: null,
      derivedArtifacts: {},
    })),
    providerTs: item.providerTs,
    receivedAt: now,
    rawInboundEventId: null,
    outboundActionId: null,
    redactedAt: null,
  };

  const inserted = await deps.messages.insertIfNew(scope, message);
  if (!inserted.inserted) {
    // The same message inside a different envelope (F-02). The conversation is untouched, and in
    // particular `nextSeq` was never consumed.
    return {
      duplicate: true,
      messageId: inserted.record.id,
      conversationId: inserted.record.conversationId,
      conversationCreated: false,
    };
  }

  await deps.conversations.save(scope, {
    ...conversation,
    nextSeq: seq + 1,
    lastInboundSeq: seq,
    engagement: 'AWAITING_MODERATOR',
    firstMessageAt: conversation.firstMessageAt ?? now,
    lastMessageAt: now,
    locale: conversation.locale,
  });

  return {
    duplicate: false,
    messageId: message.id,
    conversationId: conversation.id,
    conversationCreated,
  };
}
