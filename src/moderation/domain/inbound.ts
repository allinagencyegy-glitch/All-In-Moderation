import type { Channel, Surface } from '../../core/channel.ts';
import type { ContentType } from './message.ts';

/**
 * The channel-neutral shape of an inbound item, and the two ports that produce it.
 *
 * These types live in `moderation` rather than in a provider adapter on purpose. The domain must
 * be able to normalise an inbound event without knowing that Meta exists — otherwise adding
 * WhatsApp or TikTok would mean editing the conversation module, and "Meta shapes leaking into
 * the domain" (the coupling risk named in ARCHITECTURE-REVIEW §6) would already have happened.
 *
 * `integrations/meta` implements both ports. Nothing here knows about `entry`, `messaging`,
 * `mid`, or `psid`.
 */

export type InboundItemKind = 'MESSAGE' | 'COMMENT' | 'ECHO' | 'RECEIPT' | 'UNSUPPORTED';

export interface ParsedAttachment {
  readonly kind: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'OTHER';
  readonly url: string | null;
}

export interface NormalizedInboundItem {
  readonly kind: InboundItemKind;
  readonly channel: Channel;
  readonly surface: Surface;
  /** The provider's id for the connected surface; matched against the channel connection. */
  readonly connectionExternalId: string;
  readonly senderExternalId: string;
  readonly recipientExternalId: string;
  readonly providerMessageId: string | null;
  /** Stable per-item key; falls back to a derived hash when the provider supplies no id. */
  readonly dedupeKey: string;
  readonly dedupeSource: 'PROVIDER_ID' | 'DERIVED';
  readonly providerTs: Date;
  readonly contentType: ContentType;
  readonly text: string | null;
  readonly attachments: readonly ParsedAttachment[];
  /** Post/comment thread for public surfaces; null for direct messages. */
  readonly threadRef: string | null;
}

export interface ParseResult {
  readonly items: readonly NormalizedInboundItem[];
  /** Echoes and delivery/read receipts: normal and non-actionable, counted rather than dropped. */
  readonly ignored: number;
  readonly issues: readonly string[];
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
