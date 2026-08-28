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
import type { MetricsRegistry } from '../../operations/metrics.ts';
import { TRANSPORT_METRICS } from '../../operations/metrics.ts';
import type { InboundEnvelopeParser, NormalizedInboundItem } from '../domain/inbound.ts';
import { isActionable } from '../domain/inbound.ts';
import type { AccountPackRepository } from '../../knowledge/ports.ts';
import type { ChannelConnection } from '../domain/channel.ts';
import { connectionOwnsIdentity, isSelfIdentity, isSurfaceEnabled } from '../domain/channel.ts';
import type { Conversation } from '../domain/conversation.ts';
import { transitionLifecycle } from '../domain/conversation.ts';
import type { Message } from '../domain/message.ts';
import type { NormalizationSummary } from '../domain/raw-event.ts';
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
 *
 * ### The four gates an item must pass to become a message
 *
 * Phase 02B is the first phase where the events are real, and every gate below exists because
 * getting it wrong has a specific, expensive failure mode:
 *
 *   1. **Actionable.** Echoes, receipts and unrecognised shapes are recorded and counted, never
 *      turned into a customer turn.
 *   2. **Routable.** The item's routing identity must be one this connection owns, matched on kind
 *      *and* id. The webhook URL proved the tenant; this proves the surface. Disagreement is
 *      refused — never resolved in favour of the URL — because the payload is the half an attacker
 *      controls.
 *   3. **Not our own voice.** A sender that is one of this connection's own identities is our
 *      traffic coming back. Meta's `is_echo` covers the messaging transport; nothing covers a page
 *      replying to its own comment, so the check is applied here where the connection's full
 *      identity set is known (objective 9).
 *   4. **On an enabled surface.** The channel supports it, the client enabled it, and the
 *      connection carries the receive capability.
 *
 * Everything refused by a gate is counted, classified and written to the ledger row. Nothing is
 * dropped, and "the AI did nothing" always has a stated reason (objective 7).
 */

export interface NormalizeResult {
  readonly rawEventId: RawInboundEventId;
  readonly createdMessageIds: readonly MessageId[];
  readonly duplicateItems: number;
  readonly ignoredItems: number;
  readonly unroutableItems: number;
  readonly surfaceDisabledItems: number;
  readonly touchedConversations: readonly ConversationId[];
  readonly summary: NormalizationSummary;
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
  readonly metrics?: MetricsRegistry;
  readonly config?: { readonly moderatorMaxAttempts: number };
}

export interface NormalizeEventService {
  normalize(rawEventId: RawInboundEventId, accountScope: AccountScope): Promise<NormalizeResult>;
}

/** Enough to diagnose a provider change, few enough that the row stays small. */
const MAX_RECORDED_ISSUES = 20;

export function createNormalizeEventService(deps: NormalizeEventDeps): NormalizeEventService {
  const moderatorMaxAttempts = deps.config?.moderatorMaxAttempts ?? 5;
  const count = (name: string, labels: Record<string, string>): void => {
    deps.metrics?.increment(name, labels);
  };

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
          unroutableItems: 0,
          surfaceDisabledItems: 0,
          touchedConversations: [],
          summary: event.normalization ?? emptySummary(),
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
      const byClassification: Record<string, number> = {};
      let duplicateItems = 0;
      let ignoredItems = 0;
      let unroutableItems = 0;
      let surfaceDisabledItems = 0;
      // Built once, inside the transaction, and both persisted and returned. Two constructions of
      // "the same" summary is two things to keep in step, and the ledger row is the one an
      // operator reads — so the caller is handed exactly what was written, not a rebuild of it.
      const buildSummary = (): NormalizationSummary => ({
        parsedItems: parsed.items.length,
        createdMessages: createdMessageIds.length,
        duplicateItems,
        unroutableItems,
        surfaceDisabledItems,
        byClassification,
        issues: parsed.issues.slice(0, MAX_RECORDED_ISSUES),
      });
      let summary: NormalizationSummary = buildSummary();

      /**
       * Records one item under the name that explains its fate.
       *
       * `as` overrides the parser's classification when a *gate* is what decided the outcome, and
       * the override is the more useful fact: an item the parser read as a perfectly good
       * `MESSAGE_TEXT` and that this connection then refused is not a text message as far as
       * anyone reading the summary is concerned — it is `UNROUTABLE_IDENTITY`, and that is the
       * word an operator needs. So this vocabulary is `InboundClassification` plus the gate
       * verdicts (`UNROUTABLE_IDENTITY`, `SURFACE_DISABLED`), which is why the summary is typed as
       * a string map rather than as a map keyed by the parser's enum.
       */
      const classify = (item: NormalizedInboundItem, as?: string): void => {
        const key = as ?? item.classification;
        byClassification[key] = (byClassification[key] ?? 0) + 1;
        count(TRANSPORT_METRICS.inboundItem, { channel: item.channel, classification: key });
      };

      await deps.transactions.run(async () => {
        for (const item of parsed.items) {
          // Gate 1 — actionable. Every non-actionable item is still classified and counted.
          if (!isActionable(item)) {
            classify(item);
            ignoredItems += 1;
            continue;
          }

          // Gate 2 — routable. The single most expensive thing to get wrong: an item accepted
          // here on the strength of the URL alone is one client's message in another's account.
          if (!connectionOwnsIdentity(connection, item.routing)) {
            classify(item, 'UNROUTABLE_IDENTITY');
            count(TRANSPORT_METRICS.inboundUnroutable, { channel: item.channel });
            unroutableItems += 1;
            // No external ids in the line: the logger redacts `external_id` anyway, and the kind
            // is what an operator needs to tell a WABA mismatch from a page mismatch.
            logger.warn('inbound item did not match the connection identity', {
              channel: item.channel,
              identity_kind: item.routing.kind,
            });
            continue;
          }

          // Gate 3 — not our own voice. The loop-breaker Meta's flags do not cover.
          if (isSelfIdentity(connection, item.senderExternalId)) {
            classify(
              item,
              item.surface === 'PUBLIC_COMMENT' ? 'ECHO_SELF_COMMENT' : 'ECHO_SELF_MESSAGE',
            );
            ignoredItems += 1;
            logger.info('inbound item was authored by the connected surface itself', {
              channel: item.channel,
              surface: item.surface,
            });
            continue;
          }

          // Gate 4 — the surface is enabled for this connection.
          if (!isSurfaceEnabled(connection, item.surface)) {
            classify(item, 'SURFACE_DISABLED');
            count(TRANSPORT_METRICS.inboundSurfaceDisabled, { channel: item.channel });
            surfaceDisabledItems += 1;
            logger.info('inbound item arrived on a surface this connection has not enabled', {
              channel: item.channel,
              surface: item.surface,
            });
            continue;
          }

          classify(item);
          const outcome = await ingestItem(deps, scope, connection, item, event.id, now);
          if (outcome.duplicate) {
            duplicateItems += 1;
            count(TRANSPORT_METRICS.inboundDuplicateItem, { channel: item.channel });
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

        summary = buildSummary();

        const finalState = createdMessageIds.length > 0 ? 'NORMALIZED' : 'IGNORED';
        await deps.rawEvents.save(
          scope,
          transitionRawEvent(transitionRawEvent(event, 'NORMALIZING'), finalState, {
            normalizedAt: now,
            producedMessageIds: createdMessageIds,
            normalization: summary,
          }),
        );
      });

      logger.info('raw event normalized', {
        created: createdMessageIds.length,
        duplicates: duplicateItems,
        ignored: ignoredItems,
        unroutable: unroutableItems,
        surface_disabled: surfaceDisabledItems,
      });

      return {
        rawEventId,
        createdMessageIds,
        duplicateItems,
        ignoredItems,
        unroutableItems,
        surfaceDisabledItems,
        touchedConversations: [...touched],
        summary,
      };
    },
  };
}

function emptySummary(): NormalizationSummary {
  return {
    parsedItems: 0,
    createdMessages: 0,
    duplicateItems: 0,
    unroutableItems: 0,
    surfaceDisabledItems: 0,
    byClassification: {},
    issues: [],
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
  connection: ChannelConnection,
  item: NormalizedInboundItem,
  rawInboundEventId: RawInboundEventId,
  now: Date,
): Promise<ItemOutcome> {
  const identity = await deps.identities.findOrCreate(scope, {
    channel: item.channel,
    externalId: item.senderExternalId,
    displayName: item.senderDisplayName,
    now,
  });

  const existing = await deps.conversations.findActiveFor(scope, {
    channelConnectionId: connection.id,
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
      channelConnectionId: connection.id,
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
      id: `${item.dedupeKey}:${String(index)}`,
      kind: attachment.kind,
      providerUrl: attachment.url,
      // WhatsApp hands out a media id rather than a URL; keeping it is what makes the asset
      // retrievable later, by a phase that is allowed to make an authenticated call.
      storageRef: attachment.providerAssetId,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      checksum: attachment.checksum,
      derivedArtifacts: {},
    })),
    providerTs: item.providerTs,
    receivedAt: now,
    // The link back to the evidence. Null here meant a message could not be traced to the delivery
    // that produced it — the first question anyone asks about a real inbound event.
    rawInboundEventId,
    outboundActionId: null,
    /**
     * Provider provenance, verbatim as normalised (objective 6).
     *
     * Kept on the message rather than only on the ledger row because it is per-item: one envelope
     * can carry a story reply and an ad referral for two different customers, and re-deriving
     * which was which means re-parsing the payload.
     */
    providerContext: {
      classification: item.classification,
      entryExternalId: item.entryExternalId,
      routingKind: item.routing.kind,
      recipientExternalId: item.recipientExternalId,
      ...(item.parentRef !== null ? { parentRef: item.parentRef } : {}),
      ...(item.replyTo !== null ? { replyTo: item.replyTo } : {}),
      ...(item.referral !== null ? { referral: item.referral } : {}),
    },
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
