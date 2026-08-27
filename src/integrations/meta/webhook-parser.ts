import type { Channel } from '../../core/channel.ts';
import type { ContentType } from '../../moderation/domain/message.ts';
import type {
  InboundEnvelopeParser,
  NormalizedInboundItem,
  ParsedAttachment,
  ParseResult,
} from '../../moderation/domain/inbound.ts';
import { sha256Hex } from '../../platform/hash.ts';

/**
 * Translates a Meta-shaped webhook envelope into channel-neutral inbound items.
 *
 * This is the containment boundary for provider shapes: `entry`, `messaging`, `mid`, `psid` and
 * `changes` appear here and nowhere else. The domain speaks `ChannelIdentity` and `Message`, so a
 * new channel is a new parser rather than a change to the conversation model.
 *
 * The parser performs **no I/O and makes no decisions**. It is a total function over a payload,
 * which is what lets the whole ingest path be tested offline against captured envelopes.
 */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function parseMetaEnvelope(payload: unknown, receivedAt: Date): ParseResult {
  const root = asRecord(payload);
  if (!root) return { items: [], ignored: 0, issues: ['payload is not an object'] };

  const object = asString(root['object']);
  const channel: Channel =
    object === 'instagram'
      ? 'INSTAGRAM'
      : object === 'whatsapp_business_account'
        ? 'WHATSAPP'
        : 'FACEBOOK';

  const entries = Array.isArray(root['entry']) ? root['entry'] : [];
  if (entries.length === 0) {
    return { items: [], ignored: 0, issues: ['envelope contained no entries'] };
  }

  const items: NormalizedInboundItem[] = [];
  const issues: string[] = [];
  let ignored = 0;

  for (const [entryIndex, rawEntry] of entries.entries()) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      issues.push(`entry[${entryIndex}] is not an object`);
      continue;
    }
    const connectionExternalId = asString(entry['id']);
    if (!connectionExternalId) {
      issues.push(`entry[${entryIndex}] has no id`);
      continue;
    }

    const messaging = Array.isArray(entry['messaging']) ? entry['messaging'] : [];
    for (const [i, rawItem] of messaging.entries()) {
      const parsed = parseMessagingItem(rawItem, channel, connectionExternalId, receivedAt);
      if (!parsed) {
        issues.push(`entry[${entryIndex}].messaging[${i}] could not be parsed`);
        continue;
      }
      if (parsed.kind === 'ECHO' || parsed.kind === 'RECEIPT') {
        ignored += 1;
        continue;
      }
      items.push(parsed);
    }

    const changes = Array.isArray(entry['changes']) ? entry['changes'] : [];
    for (const [i, rawChange] of changes.entries()) {
      const parsed = parseChangeItem(rawChange, channel, connectionExternalId, receivedAt);
      if (!parsed) {
        ignored += 1;
        continue;
      }
      if (parsed.kind === 'UNSUPPORTED') {
        issues.push(`entry[${entryIndex}].changes[${i}] is an unsupported change type`);
        ignored += 1;
        continue;
      }
      items.push(parsed);
    }
  }

  return { items, ignored, issues };
}

function parseMessagingItem(
  raw: unknown,
  channel: Channel,
  connectionExternalId: string,
  receivedAt: Date,
): NormalizedInboundItem | null {
  const item = asRecord(raw);
  if (!item) return null;

  const sender = asString(asRecord(item['sender'])?.['id'] ?? null);
  const recipient = asString(asRecord(item['recipient'])?.['id'] ?? null);
  if (!sender || !recipient) return null;

  const timestampMs = asNumber(item['timestamp']);
  const providerTs = timestampMs !== null ? new Date(timestampMs) : receivedAt;

  // Delivery and read receipts are legitimate traffic that carries no customer intent.
  if (item['delivery'] !== undefined || item['read'] !== undefined) {
    return receipt(channel, connectionExternalId, sender, recipient, providerTs);
  }

  const message = asRecord(item['message']);
  if (!message) {
    // Postbacks, opt-ins, referrals: real events we do not yet interpret. Recorded as UNSUPPORTED
    // rather than dropped, so "the customer tapped a button and nothing happened" is visible.
    return {
      kind: 'UNSUPPORTED',
      channel,
      surface: 'DIRECT_MESSAGE',
      connectionExternalId,
      senderExternalId: sender,
      recipientExternalId: recipient,
      providerMessageId: null,
      ...derivedKey(sender, recipient, providerTs, JSON.stringify(item)),
      providerTs,
      contentType: 'UNSUPPORTED',
      text: null,
      attachments: [],
      threadRef: null,
    };
  }

  // An echo is our own outbound message coming back. Processing it would make the moderator
  // reply to itself — the classic infinite loop in messaging integrations.
  if (message['is_echo'] === true) {
    return receipt(channel, connectionExternalId, sender, recipient, providerTs, 'ECHO');
  }

  const mid = asString(message['mid']);
  const text = asString(message['text']);
  const attachments = parseAttachments(message['attachments']);
  const contentType: ContentType =
    text !== null
      ? 'TEXT'
      : attachments.length > 0
        ? attachmentContentType(attachments[0]!.kind)
        : 'UNSUPPORTED';

  const keying = mid
    ? { dedupeKey: mid, dedupeSource: 'PROVIDER_ID' as const }
    : derivedKey(sender, recipient, providerTs, text ?? JSON.stringify(attachments));

  return {
    kind: 'MESSAGE',
    channel,
    surface: 'DIRECT_MESSAGE',
    connectionExternalId,
    senderExternalId: sender,
    recipientExternalId: recipient,
    providerMessageId: mid,
    ...keying,
    providerTs,
    contentType,
    text,
    attachments,
    threadRef: null,
  };
}

function parseChangeItem(
  raw: unknown,
  channel: Channel,
  connectionExternalId: string,
  receivedAt: Date,
): NormalizedInboundItem | null {
  const change = asRecord(raw);
  if (!change) return null;
  const field = asString(change['field']);
  const value = asRecord(change['value']);
  if (!value) return null;
  if (field !== 'feed' && field !== 'comments')
    return unsupportedChange(channel, connectionExternalId, receivedAt);
  if (asString(value['item']) !== 'comment')
    return unsupportedChange(channel, connectionExternalId, receivedAt);
  // Only additions are inbound events; edits and removals are moderation signals handled later.
  if (asString(value['verb']) !== 'add') return null;

  const from = asString(asRecord(value['from'])?.['id'] ?? null);
  const commentId = asString(value['comment_id']);
  const postId = asString(value['post_id']);
  if (!from || !commentId) return null;

  const createdSeconds = asNumber(value['created_time']);
  const providerTs = createdSeconds !== null ? new Date(createdSeconds * 1000) : receivedAt;
  const text = asString(value['message']);

  return {
    kind: 'COMMENT',
    channel,
    surface: 'PUBLIC_COMMENT',
    connectionExternalId,
    senderExternalId: from,
    recipientExternalId: connectionExternalId,
    providerMessageId: commentId,
    dedupeKey: commentId,
    dedupeSource: 'PROVIDER_ID',
    providerTs,
    contentType: text !== null ? 'TEXT' : 'UNSUPPORTED',
    text,
    attachments: [],
    threadRef: postId,
  };
}

function unsupportedChange(
  channel: Channel,
  connectionExternalId: string,
  receivedAt: Date,
): NormalizedInboundItem {
  return {
    kind: 'UNSUPPORTED',
    channel,
    surface: 'PUBLIC_COMMENT',
    connectionExternalId,
    senderExternalId: connectionExternalId,
    recipientExternalId: connectionExternalId,
    providerMessageId: null,
    dedupeKey: `unsupported:${sha256Hex(`${connectionExternalId}:${receivedAt.getTime()}`)}`,
    dedupeSource: 'DERIVED',
    providerTs: receivedAt,
    contentType: 'UNSUPPORTED',
    text: null,
    attachments: [],
    threadRef: null,
  };
}

function receipt(
  channel: Channel,
  connectionExternalId: string,
  sender: string,
  recipient: string,
  providerTs: Date,
  kind: 'ECHO' | 'RECEIPT' = 'RECEIPT',
): NormalizedInboundItem {
  return {
    kind,
    channel,
    surface: 'DIRECT_MESSAGE',
    connectionExternalId,
    senderExternalId: sender,
    recipientExternalId: recipient,
    providerMessageId: null,
    dedupeKey: `${kind.toLowerCase()}:${sha256Hex(`${sender}:${recipient}:${providerTs.getTime()}`)}`,
    dedupeSource: 'DERIVED',
    providerTs,
    contentType: 'SYSTEM_NOTE',
    text: null,
    attachments: [],
    threadRef: null,
  };
}

/**
 * Derived item key for providers that supply no stable id.
 *
 * `dedupeSource` records that the key is derived rather than authoritative, so the ambiguity is
 * visible in the data instead of being silently assumed away (ADR-006).
 */
function derivedKey(
  sender: string,
  recipient: string,
  providerTs: Date,
  content: string,
): { dedupeKey: string; dedupeSource: 'DERIVED' } {
  return {
    dedupeKey: `derived:${sha256Hex(`${sender}|${recipient}|${providerTs.getTime()}|${content}`)}`,
    dedupeSource: 'DERIVED',
  };
}

function parseAttachments(raw: unknown): ParsedAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedAttachment[] = [];
  for (const entry of raw) {
    const attachment = asRecord(entry);
    if (!attachment) continue;
    const type = asString(attachment['type']) ?? 'other';
    const url = asString(asRecord(attachment['payload'])?.['url'] ?? null);
    out.push({ kind: attachmentKind(type), url });
  }
  return out;
}

function attachmentKind(type: string): ParsedAttachment['kind'] {
  switch (type) {
    case 'image':
      return 'IMAGE';
    case 'audio':
      return 'AUDIO';
    case 'video':
      return 'VIDEO';
    case 'file':
      return 'DOCUMENT';
    default:
      return 'OTHER';
  }
}

function attachmentContentType(kind: ParsedAttachment['kind']): ContentType {
  switch (kind) {
    case 'IMAGE':
      return 'IMAGE';
    case 'AUDIO':
      return 'AUDIO';
    case 'VIDEO':
      return 'VIDEO';
    case 'DOCUMENT':
      return 'DOCUMENT';
    case 'OTHER':
      return 'UNSUPPORTED';
  }
}

/** The Meta implementation of the domain's envelope-parser port. */
export const metaEnvelopeParser: InboundEnvelopeParser = {
  parse: (payload, receivedAt) => parseMetaEnvelope(payload, receivedAt),
};
