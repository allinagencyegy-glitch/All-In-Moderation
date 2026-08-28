import type { AccountScope } from '../../core/account/index.ts';
import type { ConversationId, MessageId, RawInboundEventId } from '../../platform/ids.ts';
import { isReceiveOnly } from '../../moderation/domain/channel.ts';
import type { NormalizationSummary, RawEventState } from '../../moderation/domain/raw-event.ts';
import type {
  ChannelConnectionRepository,
  ConversationRepository,
  MessageRepository,
  ModeratorRunRepository,
  OutboundActionRepository,
  RawInboundEventRepository,
} from '../../moderation/ports.ts';

/**
 * The shadow trace: one delivery, followed all the way through, with a verdict (objective 14).
 *
 * The claim this phase has to be able to make is precise, so the check is too:
 *
 *   real Meta -> public webhook -> signature verified -> raw event persisted -> normalised ->
 *   conversation and message state -> **simulated** moderator outcome only.
 *
 * Every link is asserted from persisted state rather than from logs, and the last link is asserted
 * negatively: an outbound action whose `deliveryMode` is anything but SIMULATED, or whose state is
 * anything but SIMULATED/PENDING_DISPATCH, is a failure of the whole trace — not a warning.
 *
 * Nothing here contacts a provider. The trace is a set of reads.
 */

export interface TracedMessage {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly seq: number;
  readonly channel: string;
  readonly direction: string;
  readonly authorKind: string;
  readonly contentType: string;
  /** Length only. A trace is pasted into tickets, and the body is the customer's words. */
  readonly textLength: number;
  readonly attachmentCount: number;
  readonly dedupeSource: string;
  readonly providerContextKeys: readonly string[];
}

export interface TracedOutboundAction {
  readonly actionType: string;
  readonly deliveryMode: string;
  readonly state: string;
  readonly simulated: boolean;
}

export interface TracedConversation {
  readonly conversationId: ConversationId;
  readonly lifecycle: string;
  readonly ownership: string;
  readonly engagement: string;
  readonly moderatorRuns: readonly { readonly state: string; readonly skipReason: string | null }[];
  readonly outboundActions: readonly TracedOutboundAction[];
}

export interface ShadowTrace {
  readonly rawEventId: RawInboundEventId;
  readonly connectionId: string;
  readonly channel: string;
  readonly receiveOnly: boolean;
  readonly signatureValid: boolean;
  readonly state: RawEventState;
  readonly normalization: NormalizationSummary | null;
  readonly messages: readonly TracedMessage[];
  readonly conversations: readonly TracedConversation[];
  /** True only when every link held. */
  readonly ok: boolean;
  /** Why not, in the order the checks run. Empty on a passing trace. */
  readonly failures: readonly string[];
}

export interface ShadowTraceDeps {
  readonly connections: ChannelConnectionRepository;
  readonly rawEvents: RawInboundEventRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly runs: ModeratorRunRepository;
  readonly outboundActions: OutboundActionRepository;
}

export async function traceRawEvent(
  deps: ShadowTraceDeps,
  scope: AccountScope,
  rawEventId: RawInboundEventId,
): Promise<ShadowTrace | null> {
  const event = await deps.rawEvents.findById(scope, rawEventId);
  if (!event) return null;

  const connection = await deps.connections.findById(scope, event.channelConnectionId);
  const failures: string[] = [];

  if (!connection) {
    failures.push('the connection this event arrived on no longer exists');
  } else if (!isReceiveOnly(connection)) {
    failures.push('connection is not RECEIVE_ONLY, so this is not a shadow trace');
  }
  if (!event.signatureValid) failures.push('signature was not verified');
  if (event.state === 'RECEIVED' || event.state === 'NORMALIZING') {
    failures.push(`event has not finished normalising (state ${event.state})`);
  }
  if (event.state === 'DEAD_LETTERED') failures.push('event was dead-lettered');
  if (event.normalization === null) failures.push('no normalisation verdict was recorded');

  const messages: TracedMessage[] = [];
  const conversationIds = new Set<ConversationId>();

  // Walk from the ids the ledger row recorded, not from a query over conversations. That is what
  // proves the link: these messages exist *because* this delivery arrived.
  for (const messageId of event.producedMessageIds) {
    const found = await deps.messages.findById(scope, messageId);
    if (!found) {
      failures.push('the ledger names a message that cannot be read back');
      continue;
    }
    conversationIds.add(found.conversationId);
    messages.push({
      messageId: found.id,
      conversationId: found.conversationId,
      seq: found.seq,
      channel: found.channel,
      direction: found.direction,
      authorKind: found.authorKind,
      contentType: found.contentType,
      textLength: found.text?.length ?? 0,
      attachmentCount: found.attachments.length,
      dedupeSource: found.dedupeSource,
      providerContextKeys: Object.keys(found.providerContext).sort(),
    });
    if (found.rawInboundEventId !== event.id) {
      failures.push('a produced message does not point back at this delivery');
    }
  }

  const conversations: TracedConversation[] = [];
  for (const conversationId of conversationIds) {
    const conversation = await deps.conversations.findById(scope, conversationId);
    if (!conversation) {
      failures.push('a produced message names a conversation that cannot be read back');
      continue;
    }
    const runs = await deps.runs.listByConversation(scope, conversationId);
    const actions = await deps.outboundActions.listByConversation(scope, conversationId);

    const tracedActions = actions.map((action) => ({
      actionType: action.actionType,
      deliveryMode: action.deliveryMode,
      state: action.state,
      simulated: action.deliveryMode === 'SIMULATED',
    }));
    for (const action of tracedActions) {
      // The load-bearing assertion of the whole phase.
      if (!action.simulated) {
        failures.push(
          `outbound action ${action.actionType} is ${action.deliveryMode}, not SIMULATED`,
        );
      }
      if (action.state !== 'SIMULATED' && action.state !== 'PENDING_DISPATCH') {
        failures.push(`outbound action ${action.actionType} reached state ${action.state}`);
      }
    }

    conversations.push({
      conversationId,
      lifecycle: conversation.lifecycle,
      ownership: conversation.ownership,
      engagement: conversation.engagement,
      moderatorRuns: runs.map((run) => ({ state: run.state, skipReason: run.skipReason })),
      outboundActions: tracedActions,
    });
  }

  return {
    rawEventId,
    connectionId: event.channelConnectionId,
    channel: connection?.channel ?? 'UNKNOWN',
    receiveOnly: connection ? isReceiveOnly(connection) : false,
    signatureValid: event.signatureValid,
    state: event.state,
    normalization: event.normalization,
    messages,
    conversations,
    ok: failures.length === 0,
    failures,
  };
}
