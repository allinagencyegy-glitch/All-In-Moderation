import type { Channel } from '../../core/channel.ts';
import type { ContentType } from '../../moderation/domain/message.ts';
import type {
  InboundReplyContext,
  NormalizedInboundItem,
  ParsedAttachment,
} from '../../moderation/domain/inbound.ts';
import type { ProviderIdentity } from '../../moderation/domain/provider.ts';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  attachment,
  contentTypeForAttachment,
  idOf,
  item,
  referralFrom,
  timestampFrom,
} from './payload.ts';

/**
 * `entry[].messaging[]` — Facebook Messenger and Instagram Direct.
 *
 * The two channels share this envelope exactly, which is why one parser serves both: Instagram
 * messaging is delivered through the same Messenger platform, and the only differences are the
 * `object` field (handled by the dispatcher) and a handful of Instagram-only members inside
 * `message` (`is_deleted`, `is_unsupported`, a story `reply_to`).
 *
 * Every branch below ends at an explicit classification. The ordering of the branches is the
 * safety property: **echo before content**. An echo carries a perfectly good `mid` and `text`, so
 * a parser that checks for text first turns our own outbound message into an inbound one and the
 * moderator answers itself — the classic infinite loop in messaging integrations (objective 9).
 */

export function parseMessagingItem(
  raw: unknown,
  channel: Channel,
  routing: ProviderIdentity,
  entryExternalId: string,
  receivedAt: Date,
): NormalizedInboundItem | null {
  const entry = asRecord(raw);
  if (!entry) return null;

  const sender = idOf(entry['sender']);
  const recipient = idOf(entry['recipient']);
  if (!sender || !recipient) {
    // Without both ends there is nothing to attribute the event to. Recorded as malformed against
    // the connection's own identity so it still lands somewhere an operator can find it.
    return item({
      kind: 'UNSUPPORTED',
      classification: 'MALFORMED',
      channel,
      surface: 'DIRECT_MESSAGE',
      routing,
      entryExternalId,
      senderExternalId: sender ?? routing.externalId,
      recipientExternalId: recipient ?? routing.externalId,
      providerTs: receivedAt,
      derivedFrom: JSON.stringify(entry).slice(0, 512),
    });
  }

  const providerTs = timestampFrom(entry['timestamp'], 'MILLISECONDS', receivedAt);
  const base = {
    channel,
    surface: 'DIRECT_MESSAGE' as const,
    routing,
    entryExternalId,
    senderExternalId: sender,
    recipientExternalId: recipient,
    providerTs,
  };

  // --- provider bookkeeping ---------------------------------------------------------------------
  if (entry['delivery'] !== undefined) {
    return item({
      ...base,
      kind: 'RECEIPT',
      classification: 'RECEIPT_DELIVERY',
      contentType: 'SYSTEM_NOTE',
      derivedFrom: 'delivery',
    });
  }
  if (entry['read'] !== undefined) {
    return item({
      ...base,
      kind: 'RECEIPT',
      classification: 'RECEIPT_READ',
      contentType: 'SYSTEM_NOTE',
      derivedFrom: 'read',
    });
  }

  const message = asRecord(entry['message']);

  // --- the echo check, before anything reads the content ----------------------------------------
  if (message?.['is_echo'] === true) {
    return item({
      ...base,
      kind: 'ECHO',
      classification: 'ECHO_SELF_MESSAGE',
      contentType: 'SYSTEM_NOTE',
      // Keyed on the provider's own id so a redelivered echo is still one row, not two.
      dedupeKey: asString(message['mid']) === null ? null : `echo:${asString(message['mid'])!}`,
      derivedFrom: 'echo',
    });
  }

  // --- non-message messaging events -------------------------------------------------------------
  if (!message) {
    if (entry['reaction'] !== undefined) {
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'REACTION',
        contentType: 'SYSTEM_NOTE',
        derivedFrom: JSON.stringify(entry['reaction']).slice(0, 256),
      });
    }
    if (entry['postback'] !== undefined) {
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'POSTBACK',
        contentType: 'SYSTEM_NOTE',
        providerMessageId: asString(idOf(entry['postback'])),
        referral: referralFrom(asRecord(entry['postback'])?.['referral']),
        derivedFrom: JSON.stringify(entry['postback']).slice(0, 256),
      });
    }
    if (entry['referral'] !== undefined) {
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'REFERRAL',
        contentType: 'SYSTEM_NOTE',
        referral: referralFrom(entry['referral']),
        derivedFrom: JSON.stringify(entry['referral']).slice(0, 256),
      });
    }
    if (entry['optin'] !== undefined) {
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'OPTIN',
        contentType: 'SYSTEM_NOTE',
        derivedFrom: JSON.stringify(entry['optin']).slice(0, 256),
      });
    }
    if (entry['message_edit'] !== undefined) {
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'MESSAGE_EDIT',
        contentType: 'SYSTEM_NOTE',
        providerMessageId: asString(asRecord(entry['message_edit'])?.['mid']),
        derivedFrom: 'message_edit',
      });
    }
    // A messaging member we do not recognise at all. Named for the layer that failed rather than
    // lumped in with the shapes we *do* recognise but do not act on.
    return item({
      ...base,
      kind: 'UNSUPPORTED',
      classification: 'UNKNOWN_MESSAGING',
      contentType: 'UNSUPPORTED',
      derivedFrom: Object.keys(entry).sort().join(','),
    });
  }

  const mid = asString(message['mid']);

  // Instagram marks a message the sender unsent, and one whose type it cannot render.
  if (message['is_deleted'] === true) {
    return item({
      ...base,
      kind: 'UNSUPPORTED',
      classification: 'MESSAGE_DELETE',
      contentType: 'SYSTEM_NOTE',
      providerMessageId: mid,
      dedupeKey: mid === null ? null : `deleted:${mid}`,
      derivedFrom: 'is_deleted',
    });
  }
  if (message['is_unsupported'] === true) {
    return item({
      ...base,
      kind: 'UNSUPPORTED',
      classification: 'MESSAGE_UNSUPPORTED',
      contentType: 'UNSUPPORTED',
      providerMessageId: mid,
      dedupeKey: mid === null ? null : `unsupported:${mid}`,
      derivedFrom: 'is_unsupported',
    });
  }

  // --- ordinary inbound content -----------------------------------------------------------------
  const text = asString(message['text']);
  const attachments = parseAttachments(message['attachments']);
  const replyTo = parseReplyTo(message['reply_to']);
  const referral = referralFrom(message['referral']);

  const contentType: ContentType =
    text !== null
      ? 'TEXT'
      : attachments.length > 0
        ? contentTypeForAttachment(attachments[0]!.kind)
        : 'UNSUPPORTED';

  const classification =
    text !== null
      ? 'MESSAGE_TEXT'
      : attachments.length === 0
        ? 'UNKNOWN_MESSAGE_TYPE'
        : contentType === 'STICKER'
          ? 'MESSAGE_STICKER'
          : 'MESSAGE_MEDIA';

  // A message with neither text nor an attachment is a shape we do not understand; it must not
  // reach the moderator as an empty customer turn.
  const kind = classification === 'UNKNOWN_MESSAGE_TYPE' ? 'UNSUPPORTED' : 'MESSAGE';

  return item({
    ...base,
    kind,
    classification,
    providerMessageId: mid,
    contentType,
    text,
    attachments,
    replyTo,
    referral,
    derivedFrom: text ?? JSON.stringify(attachments).slice(0, 256),
  });
}

/**
 * `reply_to`, which Meta overloads.
 *
 * `{mid}` is a reply to a message; `{story: {id, url}}` is an Instagram story reply, which is a
 * different conversational act — the customer is responding to something we published, not to
 * something we said to them. Collapsing the two would lose that distinction permanently.
 */
function parseReplyTo(value: unknown): InboundReplyContext | null {
  const record = asRecord(value);
  if (!record) return null;

  const story = asRecord(record['story']);
  if (story) {
    return { kind: 'STORY', externalId: asString(story['id']), url: asString(story['url']) };
  }
  const mid = asString(record['mid']);
  if (mid) return { kind: 'MESSAGE', externalId: mid, url: null };
  return { kind: 'UNKNOWN', externalId: null, url: null };
}

function parseAttachments(raw: unknown): readonly ParsedAttachment[] {
  const out: ParsedAttachment[] = [];
  for (const entry of asArray(raw)) {
    const record = asRecord(entry);
    if (!record) continue;
    const payload = asRecord(record['payload']);
    // Reusable stickers and templates carry an id where a URL would be. Meta sends `sticker_id`
    // as a JSON *number*, so reading it as a string finds nothing and every sticker is filed as
    // an ordinary photo — which is the difference between "the customer sent a thumbs-up" and
    // "the customer sent an image we should describe".
    const stickerId = looseId(payload?.['sticker_id']);
    out.push(
      attachment({
        // Meta types a sticker as an `image` and distinguishes it only by `sticker_id`. The
        // distinction matters: a sticker is an expression, not a photo to be described.
        kind: stickerId !== null ? 'STICKER' : attachmentKind(asString(record['type']) ?? 'other'),
        url: asString(payload?.['url']),
        providerAssetId: stickerId ?? looseId(payload?.['attachment_id']),
        caption: asString(payload?.['title']),
      }),
    );
  }
  return out;
}

/**
 * An identifier that may arrive as a string or as a number.
 *
 * Meta is inconsistent about this across payloads and across channels, and JSON numbers large
 * enough to be Meta ids are already at the edge of exact representation — so the value is
 * stringified for storage and never used for arithmetic.
 */
function looseId(value: unknown): string | null {
  const text = asString(value);
  if (text !== null) return text;
  const numeric = asNumber(value);
  return numeric === null ? null : String(numeric);
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
