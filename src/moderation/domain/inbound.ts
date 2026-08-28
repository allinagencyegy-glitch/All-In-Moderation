import type { Channel, Surface } from '../../core/channel.ts';
import type { ContentType } from './message.ts';
import type { ProviderIdentity } from './provider.ts';

/**
 * The channel-neutral shape of an inbound item, and the two ports that produce it.
 *
 * These types live in `moderation` rather than in a provider adapter on purpose. The domain must
 * be able to normalise an inbound event without knowing that Meta exists — otherwise adding
 * WhatsApp or TikTok would mean editing the conversation module, and "Meta shapes leaking into
 * the domain" (the coupling risk named in ARCHITECTURE-REVIEW §6) would already have happened.
 *
 * `integrations/meta` implements both ports. Nothing here knows about `entry`, `messaging`,
 * `mid`, `psid` or `wamid`.
 */

/**
 * What an item *is*, at the coarse level the pipeline branches on.
 *
 * `UNSUPPORTED` is a first-class outcome rather than an absence. A provider will always send
 * something we have not taught the parser about, and the only two honest responses are to record
 * it or to record it and alert. Dropping it is how "the customer tapped a button and nothing
 * happened" becomes invisible (F-25).
 */
export type InboundItemKind = 'MESSAGE' | 'COMMENT' | 'ECHO' | 'RECEIPT' | 'UNSUPPORTED';

/**
 * Why an item has the kind it has — the explicit classification objective 7 demands.
 *
 * Every value here is a statement the parser is prepared to defend, and every branch of every
 * provider parser must end at exactly one of them. There is no "other" that means "we stopped
 * looking": the UNKNOWN_ values say precisely which layer of the envelope was not recognised,
 * which is the difference between a diagnosable gap and a shrug.
 */
export const INBOUND_CLASSIFICATIONS = [
  // Actionable customer content.
  'MESSAGE_TEXT',
  'MESSAGE_MEDIA',
  'MESSAGE_STICKER',
  'MESSAGE_LOCATION',
  'MESSAGE_CONTACTS',
  'MESSAGE_INTERACTIVE',
  'COMMENT',
  // Our own traffic coming back. Never actionable; the loop-breaker (objective 9).
  'ECHO_SELF_MESSAGE',
  'ECHO_SELF_COMMENT',
  // Provider bookkeeping. Legitimate, carries no customer intent.
  'RECEIPT_DELIVERY',
  'RECEIPT_READ',
  'STATUS_UPDATE',
  // Real customer signals we do not yet interpret. Recorded, never actioned.
  'REACTION',
  'POSTBACK',
  'REFERRAL',
  'OPTIN',
  'MESSAGE_EDIT',
  'MESSAGE_DELETE',
  'MESSAGE_UNSUPPORTED',
  'COMMENT_EDIT',
  'COMMENT_REMOVE',
  'ACCOUNT_UPDATE',
  'PROVIDER_ERROR',
  // Shapes the parser did not recognise, named by the layer that failed.
  'UNKNOWN_OBJECT',
  'UNKNOWN_FIELD',
  'UNKNOWN_MESSAGING',
  'UNKNOWN_MESSAGE_TYPE',
  'MALFORMED',
] as const;
export type InboundClassification = (typeof INBOUND_CLASSIFICATIONS)[number];

export interface ParsedAttachment {
  readonly kind: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'STICKER' | 'OTHER';
  /**
   * A direct URL when the provider supplies one (Messenger, Instagram) and null when it does not
   * (WhatsApp hands out a media id that must be exchanged for a URL). Null is meaningful: it says
   * fetching this asset requires an authenticated call, which is not something this phase makes.
   */
  readonly url: string | null;
  /** The provider's own handle for the asset — a WhatsApp media id, for instance. */
  readonly providerAssetId: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly checksum: string | null;
  /** Media captions are customer content and travel with the attachment, never into a log. */
  readonly caption: string | null;
}

/** What an inbound item is replying to, when the provider says. */
export interface InboundReplyContext {
  readonly kind: 'MESSAGE' | 'STORY' | 'COMMENT' | 'POST' | 'UNKNOWN';
  readonly externalId: string | null;
  readonly url: string | null;
}

/**
 * Ad and entry-point provenance, when Meta supplies it.
 *
 * Kept because "this conversation started from an ad" changes what a good answer looks like, and
 * because it is the one piece of attribution that cannot be reconstructed later — Meta sends it
 * once, on the first message, and never again.
 */
export interface InboundReferral {
  readonly source: string | null;
  readonly type: string | null;
  readonly ref: string | null;
  readonly adId: string | null;
  /** WhatsApp's click-to-WhatsApp click id. Its own field because it joins to ad reporting. */
  readonly ctwaClickId: string | null;
  readonly sourceUrl: string | null;
}

export interface NormalizedInboundItem {
  readonly kind: InboundItemKind;
  readonly classification: InboundClassification;
  readonly channel: Channel;
  readonly surface: Surface;
  /**
   * The identity that must own this item for it to be routable.
   *
   * Typed rather than a bare string because the identifier in `entry.id` is not always the thing
   * a delivery is addressed to: a WhatsApp event names a WABA there and the routable phone number
   * in its metadata. Matching on kind *and* id is what stops one client's event being accepted by
   * another client's connection on the same business account.
   */
  readonly routing: ProviderIdentity;
  /** The provider's envelope id (`entry.id`), kept as provenance even when routing differs. */
  readonly entryExternalId: string;
  readonly senderExternalId: string;
  /** Present on comments and WhatsApp contacts. Customer content: never logged. */
  readonly senderDisplayName: string | null;
  readonly recipientExternalId: string;
  readonly providerMessageId: string | null;
  /** Stable per-item key; falls back to a derived hash when the provider supplies no id. */
  readonly dedupeKey: string;
  readonly dedupeSource: 'PROVIDER_ID' | 'DERIVED';
  readonly providerTs: Date;
  readonly contentType: ContentType;
  readonly text: string | null;
  readonly attachments: readonly ParsedAttachment[];
  /** Post/media thread for public surfaces; null for direct messages. */
  readonly threadRef: string | null;
  /** Parent comment, for threaded replies under a post. */
  readonly parentRef: string | null;
  readonly replyTo: InboundReplyContext | null;
  readonly referral: InboundReferral | null;
}

/** True for the two kinds that may become a customer-visible message. */
export function isActionable(item: NormalizedInboundItem): boolean {
  return item.kind === 'MESSAGE' || item.kind === 'COMMENT';
}

export interface ParseResult {
  /**
   * **Every** item the parser saw, actionable or not.
   *
   * Phase 02A returned actionable items and a count of everything else, which meant an echo and
   * an unrecognised event were indistinguishable downstream — both were "1 ignored". Returning
   * all of them, each carrying its classification, is what makes "never silently discarded"
   * structural rather than a promise in a comment.
   */
  readonly items: readonly NormalizedInboundItem[];
  /** Envelope-level problems: a malformed entry, a missing id. Never customer content. */
  readonly issues: readonly string[];
}

/** Counts by classification. The shape persisted on the ledger row and exported as metrics. */
export function classificationCounts(
  items: readonly NormalizedInboundItem[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.classification] = (counts[item.classification] ?? 0) + 1;
  return counts;
}

/**
 * Translates a provider envelope into channel-neutral items.
 *
 * Implementations must be **total and side-effect free**: no I/O, no decisions, no throwing on
 * unexpected shapes. That is what allows the whole ingest path to be tested offline against
 * captured envelopes.
 */
export interface InboundEnvelopeParser {
  parse(payload: unknown, receivedAt: Date): ParseResult;
}

export type SignatureFailureReason = 'MISSING' | 'MALFORMED' | 'MISMATCH';

export type SignatureVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: SignatureFailureReason };

/**
 * Verifies that a webhook body really came from the provider.
 *
 * A port rather than a direct call because every channel signs differently, and because the
 * verification must run over the **raw bytes** — a detail each implementation has to honour.
 */
export interface WebhookSignatureVerifier {
  verify(input: {
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly appSecret: string;
  }): SignatureVerification;
}
