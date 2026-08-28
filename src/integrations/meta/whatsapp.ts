import type { NormalizedInboundItem, ParsedAttachment } from '../../moderation/domain/inbound.ts';
import type { ProviderIdentity } from '../../moderation/domain/provider.ts';
import {
  asArray,
  asLooseNumber,
  asRecord,
  asString,
  attachment,
  contentTypeForAttachment,
  item,
  nested,
  referralFrom,
  timestampFrom,
} from './payload.ts';

/**
 * WhatsApp Cloud API — `entry[].changes[].value`, `field: "messages"`.
 *
 * This is the payload Phase 02A could not have parsed at all. It shares nothing structural with
 * Messenger: no `messaging` array, no `sender`/`recipient` objects, no `mid`. Three details are
 * load-bearing and each is a way this integration is commonly got wrong:
 *
 *   1. **The routable identity is not `entry.id`.** `entry.id` is the WhatsApp Business Account,
 *      which may carry many phone numbers belonging to different clients under one partner app.
 *      The destination is `value.metadata.phone_number_id`, and routing on the WABA instead is how
 *      one client's messages land in another client's inbox. When the metadata is missing we
 *      refuse to route rather than falling back to the WABA (objective 19: tenant misrouting).
 *
 *   2. **`timestamp` is a string of seconds.** Messenger sends a number of milliseconds. A parser
 *      that assumes either one silently stamps every message from the other channel with the
 *      receipt time and the transcript loses its order.
 *
 *   3. **`statuses` are not messages.** Sent/delivered/read/failed acknowledgements arrive in the
 *      same `value` object as inbound messages. Treating them as messages would create a
 *      conversation turn for every one of our own deliveries.
 *
 * WhatsApp has no echo: a business never receives its own outbound message back as an inbound one.
 * The self-check still runs, because defence that costs nothing should not be omitted on the
 * strength of a provider's current behaviour.
 */

export interface WhatsAppParseContext {
  readonly entryExternalId: string;
  readonly receivedAt: Date;
}

export interface WhatsAppValueResult {
  readonly items: readonly NormalizedInboundItem[];
  readonly issues: readonly string[];
}

export function parseWhatsAppValue(
  value: unknown,
  context: WhatsAppParseContext,
): WhatsAppValueResult {
  const record = asRecord(value);
  if (!record) return { items: [], issues: ['whatsapp change value is not an object'] };

  const phoneNumberId = asString(nested(record['metadata'], 'phone_number_id'));
  const items: NormalizedInboundItem[] = [];
  const issues: string[] = [];

  // Fail closed. Without a phone number id there is no destination this delivery can be attributed
  // to, and guessing the WABA would be a routing decision made on missing evidence.
  const routing: ProviderIdentity =
    phoneNumberId !== null
      ? { kind: 'WHATSAPP_PHONE_NUMBER', externalId: phoneNumberId }
      : { kind: 'WHATSAPP_BUSINESS_ACCOUNT', externalId: context.entryExternalId };
  if (phoneNumberId === null) {
    issues.push('whatsapp value carried no metadata.phone_number_id');
  }

  const displayNames = contactNames(record['contacts']);
  const businessNumber = asString(nested(record['metadata'], 'display_phone_number'));

  for (const raw of asArray(record['messages'])) {
    const parsed = parseMessage(raw, {
      routing,
      entryExternalId: context.entryExternalId,
      receivedAt: context.receivedAt,
      displayNames,
      businessNumber,
    });
    if (parsed) items.push(parsed);
    else issues.push('whatsapp message entry could not be read');
  }

  for (const raw of asArray(record['statuses'])) {
    const parsed = parseStatus(raw, routing, context);
    if (parsed) items.push(parsed);
  }

  // Value-level errors: a delivery Meta itself could not construct. Recorded so an operator sees
  // "the provider told us it failed" rather than a gap in the ledger.
  for (const raw of asArray(record['errors'])) {
    const error = asRecord(raw);
    items.push(
      item({
        kind: 'UNSUPPORTED',
        classification: 'PROVIDER_ERROR',
        channel: 'WHATSAPP',
        surface: 'DIRECT_MESSAGE',
        routing,
        entryExternalId: context.entryExternalId,
        senderExternalId: routing.externalId,
        recipientExternalId: routing.externalId,
        providerTs: context.receivedAt,
        contentType: 'SYSTEM_NOTE',
        // Meta sends `code` as a number. `asLooseNumber` reads either, and the fallback is a
        // literal rather than a stringified unknown: an error object rendered as
        // "[object Object]" would collapse every unrecognised error onto one dedupe key.
        derivedFrom: `error:${errorCode(error?.['code'])}`,
      }),
    );
  }

  return { items, issues };
}

interface MessageContext {
  readonly routing: ProviderIdentity;
  readonly entryExternalId: string;
  readonly receivedAt: Date;
  readonly displayNames: ReadonlyMap<string, string>;
  readonly businessNumber: string | null;
}

function parseMessage(raw: unknown, context: MessageContext): NormalizedInboundItem | null {
  const record = asRecord(raw);
  if (!record) return null;

  const from = asString(record['from']);
  const wamid = asString(record['id']);
  const providerTs = timestampFrom(record['timestamp'], 'SECONDS', context.receivedAt);

  const base = {
    channel: 'WHATSAPP' as const,
    surface: 'DIRECT_MESSAGE' as const,
    routing: context.routing,
    entryExternalId: context.entryExternalId,
    senderExternalId: from ?? context.routing.externalId,
    recipientExternalId: context.routing.externalId,
    providerTs,
    providerMessageId: wamid,
    senderDisplayName: from !== null ? (context.displayNames.get(from) ?? null) : null,
    replyTo: contextRef(record['context']),
    referral: referralFrom(record['referral']),
  };

  if (!from || !wamid) {
    return item({
      ...base,
      kind: 'UNSUPPORTED',
      classification: 'MALFORMED',
      dedupeKey: wamid,
      derivedFrom: 'whatsapp:message',
    });
  }

  // A number cannot message itself; if it appears to, the delivery is our own traffic reflected.
  if (context.businessNumber !== null && from === context.businessNumber) {
    return item({
      ...base,
      kind: 'ECHO',
      classification: 'ECHO_SELF_MESSAGE',
      dedupeKey: `echo:${wamid}`,
      contentType: 'SYSTEM_NOTE',
    });
  }

  const type = asString(record['type']) ?? 'unknown';

  switch (type) {
    case 'text':
      return item({
        ...base,
        kind: 'MESSAGE',
        classification: 'MESSAGE_TEXT',
        dedupeKey: wamid,
        contentType: 'TEXT',
        text: asString(nested(record['text'], 'body')),
      });

    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker': {
      const media = asRecord(record[type]);
      const kind = mediaKind(type);
      const parsed = attachment({
        kind,
        // Cloud API never sends a URL. The id must be exchanged for one through an authenticated
        // call this phase deliberately does not make, so it is recorded and left unresolved.
        url: null,
        providerAssetId: asString(media?.['id']),
        mimeType: asString(media?.['mime_type']),
        checksum: asString(media?.['sha256']),
        caption: asString(media?.['caption']),
      });
      return item({
        ...base,
        kind: 'MESSAGE',
        classification: kind === 'STICKER' ? 'MESSAGE_STICKER' : 'MESSAGE_MEDIA',
        dedupeKey: wamid,
        contentType: contentTypeForAttachment(kind),
        // A caption is the customer's words about the media, so it is the message text.
        text: parsed.caption,
        attachments: [parsed],
      });
    }

    case 'location':
      return item({
        ...base,
        kind: 'MESSAGE',
        classification: 'MESSAGE_LOCATION',
        dedupeKey: wamid,
        contentType: 'LOCATION',
        text: asString(nested(record['location'], 'name')),
      });

    case 'contacts':
      return item({
        ...base,
        kind: 'MESSAGE',
        classification: 'MESSAGE_CONTACTS',
        dedupeKey: wamid,
        contentType: 'UNSUPPORTED',
      });

    case 'button':
    case 'interactive': {
      // A tapped reply is a real customer turn with real text, unlike a Messenger postback.
      const text =
        asString(nested(record['button'], 'text')) ??
        asString(nested(nested(record['interactive'], 'button_reply'), 'title')) ??
        asString(nested(nested(record['interactive'], 'list_reply'), 'title'));
      return item({
        ...base,
        kind: 'MESSAGE',
        classification: 'MESSAGE_INTERACTIVE',
        dedupeKey: wamid,
        contentType: text !== null ? 'TEXT' : 'UNSUPPORTED',
        text,
      });
    }

    case 'reaction':
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'REACTION',
        dedupeKey: wamid,
        contentType: 'SYSTEM_NOTE',
      });

    case 'system':
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'ACCOUNT_UPDATE',
        dedupeKey: wamid,
        contentType: 'SYSTEM_NOTE',
      });

    case 'unsupported':
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'MESSAGE_UNSUPPORTED',
        dedupeKey: wamid,
        contentType: 'UNSUPPORTED',
      });

    default:
      return item({
        ...base,
        kind: 'UNSUPPORTED',
        classification: 'UNKNOWN_MESSAGE_TYPE',
        dedupeKey: wamid,
        contentType: 'UNSUPPORTED',
        derivedFrom: `whatsapp:${type}`,
      });
  }
}

/**
 * A delivery acknowledgement for a message *we* sent.
 *
 * Keyed on `(wamid, status)` rather than on the wamid alone: sent, delivered and read all carry
 * the same message id, and a key that ignored the status would collapse three distinct facts into
 * whichever arrived first.
 */
function parseStatus(
  raw: unknown,
  routing: ProviderIdentity,
  context: WhatsAppParseContext,
): NormalizedInboundItem | null {
  const record = asRecord(raw);
  if (!record) return null;
  const wamid = asString(record['id']);
  const status = asString(record['status']) ?? 'unknown';
  const recipient = asString(record['recipient_id']);

  return item({
    kind: 'RECEIPT',
    classification: status === 'read' ? 'RECEIPT_READ' : 'STATUS_UPDATE',
    channel: 'WHATSAPP',
    surface: 'DIRECT_MESSAGE',
    routing,
    entryExternalId: context.entryExternalId,
    senderExternalId: routing.externalId,
    recipientExternalId: recipient ?? routing.externalId,
    providerTs: timestampFrom(record['timestamp'], 'SECONDS', context.receivedAt),
    providerMessageId: wamid,
    dedupeKey: wamid !== null ? `status:${status}:${wamid}` : null,
    contentType: 'SYSTEM_NOTE',
    derivedFrom: `status:${status}`,
  });
}

/** `context: {id}` marks a reply; `context: {forwarded}` does not. */
function contextRef(value: unknown) {
  const id = asString(nested(value, 'id'));
  return id === null ? null : { kind: 'MESSAGE' as const, externalId: id, url: null };
}

/** `code` arrives as a number; anything else is not an error code we can name. */
function errorCode(value: unknown): string {
  const numeric = asLooseNumber(value);
  if (numeric !== null) return String(numeric);
  return asString(value) ?? 'unknown';
}

function contactNames(value: unknown): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const raw of asArray(value)) {
    const record = asRecord(raw);
    const waId = asString(record?.['wa_id']);
    const name = asString(nested(record?.['profile'], 'name'));
    if (waId !== null && name !== null) names.set(waId, name);
  }
  return names;
}

function mediaKind(type: string): ParsedAttachment['kind'] {
  switch (type) {
    case 'image':
      return 'IMAGE';
    case 'audio':
      return 'AUDIO';
    case 'video':
      return 'VIDEO';
    case 'document':
      return 'DOCUMENT';
    case 'sticker':
      return 'STICKER';
    default:
      return 'OTHER';
  }
}
