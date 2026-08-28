import type { Channel, Surface } from '../../core/channel.ts';
import type { ContentType } from '../../moderation/domain/message.ts';
import type {
  InboundClassification,
  InboundItemKind,
  InboundReferral,
  InboundReplyContext,
  NormalizedInboundItem,
  ParsedAttachment,
} from '../../moderation/domain/inbound.ts';
import type { ProviderIdentity } from '../../moderation/domain/provider.ts';
import { sha256Hex } from '../../platform/hash.ts';

/**
 * Shared machinery for the Meta parsers.
 *
 * Two things live here and nowhere else. First, the accessors: every field Meta sends is
 * `unknown` until proven otherwise, and a parser that reaches into a payload with dot notation is
 * one malformed delivery away from throwing inside a job handler. Second, `item()` — a single
 * constructor for `NormalizedInboundItem` so that adding a field to the domain shape is a change
 * to one file rather than to five parsers that each forgot a different one.
 *
 * Everything here is total: no accessor throws, on any input.
 */

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

export const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A numeric field that may arrive as a string.
 *
 * WhatsApp sends `timestamp` as `"1603059201"` while Messenger sends `1458692752478` as a number.
 * A parser that assumes one of those silently produces `receivedAt` for every message from the
 * other channel, and the conversation transcript quietly loses its ordering.
 */
export const asLooseNumber = (value: unknown): number | null => {
  const direct = asNumber(value);
  if (direct !== null) return direct;
  const text = asString(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

export const field = (record: Record<string, unknown> | null, key: string): unknown =>
  record === null ? undefined : record[key];

export const nested = (value: unknown, key: string): unknown => field(asRecord(value), key);

/** `{ id: "..." }` is the single most repeated shape in Meta's payloads. */
export const idOf = (value: unknown): string | null => asString(nested(value, 'id'));

/** Seconds, milliseconds or a numeric string, resolved to a Date. */
export function timestampFrom(
  value: unknown,
  unit: 'SECONDS' | 'MILLISECONDS',
  fallback: Date,
): Date {
  const raw = asLooseNumber(value);
  if (raw === null) return fallback;
  const ms = unit === 'SECONDS' ? raw * 1000 : raw;
  // A timestamp outside a plausible range is corruption, not data. Falling back keeps the item
  // orderable rather than parking it in 1970 or in the year 55000.
  if (!Number.isFinite(ms) || ms <= 0 || ms > 4_102_444_800_000) return fallback;
  return new Date(ms);
}

export interface ItemInput {
  readonly kind: InboundItemKind;
  readonly classification: InboundClassification;
  readonly channel: Channel;
  readonly surface: Surface;
  readonly routing: ProviderIdentity;
  readonly entryExternalId: string;
  readonly senderExternalId: string;
  readonly recipientExternalId: string;
  readonly providerTs: Date;
  readonly senderDisplayName?: string | null;
  readonly providerMessageId?: string | null;
  readonly dedupeKey?: string | null;
  readonly derivedFrom?: string;
  readonly contentType?: ContentType;
  readonly text?: string | null;
  readonly attachments?: readonly ParsedAttachment[];
  readonly threadRef?: string | null;
  readonly parentRef?: string | null;
  readonly replyTo?: InboundReplyContext | null;
  readonly referral?: InboundReferral | null;
}

/**
 * The one constructor for a normalised item.
 *
 * Keying is the part worth reading. When the provider supplies a stable id it *is* the dedupe key
 * and `dedupeSource` records that it is authoritative. When it does not, the key is a hash of the
 * fields that identify the item, and `dedupeSource: 'DERIVED'` makes the ambiguity visible in the
 * data rather than assumed away (ADR-006). The classification is folded into the derived hash so
 * that a receipt and a message that happen to share a timestamp cannot collide.
 */
export function item(input: ItemInput): NormalizedInboundItem {
  const providerMessageId = input.providerMessageId ?? null;
  const explicitKey = input.dedupeKey ?? providerMessageId;
  const keying =
    explicitKey !== null
      ? { dedupeKey: explicitKey, dedupeSource: 'PROVIDER_ID' as const }
      : {
          dedupeKey: `derived:${sha256Hex(
            [
              input.classification,
              input.routing.kind,
              input.routing.externalId,
              input.senderExternalId,
              input.recipientExternalId,
              String(input.providerTs.getTime()),
              input.derivedFrom ?? '',
            ].join('|'),
          )}`,
          dedupeSource: 'DERIVED' as const,
        };

  return {
    kind: input.kind,
    classification: input.classification,
    channel: input.channel,
    surface: input.surface,
    routing: input.routing,
    entryExternalId: input.entryExternalId,
    senderExternalId: input.senderExternalId,
    senderDisplayName: input.senderDisplayName ?? null,
    recipientExternalId: input.recipientExternalId,
    providerMessageId,
    ...keying,
    providerTs: input.providerTs,
    contentType: input.contentType ?? 'UNSUPPORTED',
    text: input.text ?? null,
    attachments: input.attachments ?? [],
    threadRef: input.threadRef ?? null,
    parentRef: input.parentRef ?? null,
    replyTo: input.replyTo ?? null,
    referral: input.referral ?? null,
  };
}

export function attachment(
  input: Partial<ParsedAttachment> & { kind: ParsedAttachment['kind'] },
): ParsedAttachment {
  return {
    kind: input.kind,
    url: input.url ?? null,
    providerAssetId: input.providerAssetId ?? null,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    checksum: input.checksum ?? null,
    caption: input.caption ?? null,
  };
}

export function contentTypeForAttachment(kind: ParsedAttachment['kind']): ContentType {
  switch (kind) {
    case 'IMAGE':
      return 'IMAGE';
    case 'AUDIO':
      return 'AUDIO';
    case 'VIDEO':
      return 'VIDEO';
    case 'DOCUMENT':
      return 'DOCUMENT';
    case 'STICKER':
      return 'STICKER';
    case 'OTHER':
      return 'UNSUPPORTED';
  }
}

/**
 * Meta's `referral` block, in the two shapes it actually arrives in.
 *
 * Messenger and Instagram send `{ref, source, type, ad_id}`; WhatsApp sends
 * `{source_url, source_type, source_id, ctwa_clid}`. Both are the same fact — where this
 * conversation came from — so they normalise to one shape rather than to two the domain would
 * have to branch on.
 */
export function referralFrom(value: unknown): InboundReferral | null {
  const record = asRecord(value);
  if (!record) return null;
  const referral: InboundReferral = {
    source: asString(record['source']) ?? asString(record['source_type']),
    type: asString(record['type']),
    ref: asString(record['ref']) ?? asString(record['source_id']),
    adId: asString(record['ad_id']),
    ctwaClickId: asString(record['ctwa_clid']),
    sourceUrl: asString(record['source_url']),
  };
  const carriesAnything = Object.values(referral).some((entry) => entry !== null);
  return carriesAnything ? referral : null;
}
