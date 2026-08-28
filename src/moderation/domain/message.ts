import type {
  AccountId,
  ConversationId,
  MessageId,
  OutboundActionId,
  RawInboundEventId,
  UserId,
} from '../../platform/ids.ts';
import type { Channel } from '../../core/channel.ts';

export const CONTENT_TYPES = [
  'TEXT',
  'IMAGE',
  'AUDIO',
  'VIDEO',
  'DOCUMENT',
  'STICKER',
  'LOCATION',
  'SYSTEM_NOTE',
  'UNSUPPORTED',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type AuthorKind = 'CUSTOMER' | 'AI' | 'HUMAN_AGENT' | 'SYSTEM';

/** Whether the item-level dedupe key came from the provider or had to be derived (ADR-006). */
export type DedupeSource = 'PROVIDER_ID' | 'DERIVED';

export interface MessageAttachment {
  readonly id: string;
  readonly kind: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'STICKER' | 'OTHER';
  readonly providerUrl: string | null;
  readonly storageRef: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly checksum: string | null;
  /** Transcripts, captions, OCR — each stamped with the model and version that produced it. */
  readonly derivedArtifacts: Readonly<Record<string, unknown>>;
}

/**
 * Append-only. A message is never edited; redaction blanks `text` in place and stamps
 * `redactedAt`, so the retention story does not require deleting rows the ledger references.
 */
export interface Message {
  readonly id: MessageId;
  readonly accountId: AccountId;
  readonly conversationId: ConversationId;
  /** Gapless, per-conversation, allocated under the conversation lock. Processing order. */
  readonly seq: number;
  readonly direction: MessageDirection;
  readonly authorKind: AuthorKind;
  readonly authorUserId: UserId | null;
  readonly channel: Channel;
  readonly providerMessageId: string | null;
  readonly dedupeKey: string;
  readonly dedupeSource: DedupeSource;
  readonly contentType: ContentType;
  readonly text: string | null;
  readonly attachments: readonly MessageAttachment[];
  /** What the provider claims. Never trusted for ordering decisions. */
  readonly providerTs: Date;
  /** What we observed. Always ours. */
  readonly receivedAt: Date;
  readonly rawInboundEventId: RawInboundEventId | null;
  readonly outboundActionId: OutboundActionId | null;
  /**
   * Provider provenance for an inbound message: reply context, ad referral, the envelope id it
   * arrived under, the identity kind it was routed on.
   *
   * Deliberately open-shaped and deliberately *not* interpreted by the domain. Meta supplies some
   * of these facts exactly once — an ad referral arrives with the first message and never again —
   * so the choice is between keeping them at the moment of arrival or losing them permanently.
   * Anything the platform needs to reason about is promoted to a typed field first.
   */
  readonly providerContext: Readonly<Record<string, unknown>>;
  readonly redactedAt: Date | null;
}

/**
 * Orders a transcript for presentation to the model and to operators.
 *
 * `provider_ts` first, `seq` as the tiebreaker: the customer's intended order is what makes the
 * conversation readable. Note that this is *presentation* order only — processing order is `seq`
 * alone, so a late-arriving message can never fall below the watermark and be skipped (ADR-005).
 */
export function orderForTranscript(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const byTime = a.providerTs.getTime() - b.providerTs.getTime();
    return byTime !== 0 ? byTime : a.seq - b.seq;
  });
}

export function isOutOfOrder(incoming: Message, newestExisting: Message | undefined): boolean {
  if (!newestExisting) return false;
  return incoming.providerTs.getTime() < newestExisting.providerTs.getTime();
}

/** Compact transcript rendering for prompts. Redacted messages are marked, never silently empty. */
export function renderTranscript(messages: readonly Message[]): string {
  return orderForTranscript(messages)
    .map((m) => {
      const who =
        m.authorKind === 'CUSTOMER'
          ? 'CUSTOMER'
          : m.authorKind === 'HUMAN_AGENT'
            ? 'AGENT'
            : m.authorKind;
      if (m.redactedAt) return `[${who}] (content removed under retention policy)`;
      if (m.contentType !== 'TEXT') return `[${who}] (sent ${m.contentType.toLowerCase()})`;
      return `[${who}] ${m.text ?? ''}`;
    })
    .join('\n');
}
