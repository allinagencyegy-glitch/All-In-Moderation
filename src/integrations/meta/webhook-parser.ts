import type { Channel } from '../../core/channel.ts';
import type {
  InboundEnvelopeParser,
  NormalizedInboundItem,
  ParseResult,
} from '../../moderation/domain/inbound.ts';
import type { ProviderIdentity } from '../../moderation/domain/provider.ts';
import {
  parseFacebookFeedChange,
  parseInstagramCommentChange,
  parseInstagramMentionChange,
} from './comments.ts';
import type { CommentParseContext } from './comments.ts';
import { parseMessagingItem } from './messaging.ts';
import { asArray, asRecord, asString, item } from './payload.ts';
import { parseWhatsAppValue } from './whatsapp.ts';

/**
 * The Meta envelope dispatcher.
 *
 * This is the containment boundary for provider shapes: `entry`, `messaging`, `changes`, `mid`,
 * `psid` and `wamid` appear in this directory and nowhere else. The domain speaks
 * `NormalizedInboundItem`, so a new channel is a new parser plus a branch here rather than a
 * change to the conversation model (ADR-001).
 *
 * The dispatch is two-dimensional and both dimensions matter. `object` selects the channel;
 * within an entry, `messaging` and `changes` are different transports that Meta uses for
 * different things on the *same* channel — a Facebook Page sends direct messages through
 * `messaging` and public comments through `changes`, and Instagram does the same. WhatsApp uses
 * `changes` only.
 *
 * The parser performs **no I/O and makes no decisions**. It is a total function over a payload,
 * which is what lets the whole ingest path be tested offline against captured envelopes — and
 * what lets the acceptance tooling replay a real delivery without touching a network.
 */

interface ChannelBinding {
  readonly channel: Channel;
  /** How to interpret `entry.id` for this channel. */
  readonly entryIdentityKind: ProviderIdentity['kind'];
}

function bindingFor(object: string | null): ChannelBinding | null {
  switch (object) {
    case null:
      return null;
    case 'page':
      return { channel: 'FACEBOOK', entryIdentityKind: 'FACEBOOK_PAGE' };
    case 'instagram':
      return { channel: 'INSTAGRAM', entryIdentityKind: 'INSTAGRAM_ACCOUNT' };
    case 'whatsapp_business_account':
      return { channel: 'WHATSAPP', entryIdentityKind: 'WHATSAPP_BUSINESS_ACCOUNT' };
    default:
      return null;
  }
}

export function parseMetaEnvelope(payload: unknown, receivedAt: Date): ParseResult {
  const root = asRecord(payload);
  if (!root) return { items: [], issues: ['payload is not an object'] };

  const object = asString(root['object']);
  const binding = bindingFor(object);
  if (!binding) {
    // An object type we have never seen. There is no channel to attribute it to and no identity to
    // route it on, so there is nothing to return but the fact that it happened — which the ledger
    // already holds verbatim.
    return { items: [], issues: [`unsupported envelope object '${object ?? 'missing'}'`] };
  }

  const entries = asArray(root['entry']);
  if (entries.length === 0) return { items: [], issues: ['envelope contained no entries'] };

  const items: NormalizedInboundItem[] = [];
  const issues: string[] = [];

  for (const [entryIndex, rawEntry] of entries.entries()) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      issues.push(`entry[${String(entryIndex)}] is not an object`);
      continue;
    }
    const entryExternalId = asString(entry['id']);
    if (!entryExternalId) {
      issues.push(`entry[${String(entryIndex)}] has no id`);
      continue;
    }

    // For Messenger and Instagram the entry id *is* the routable surface. For WhatsApp it is not,
    // and `parseWhatsAppValue` derives the real one from the change metadata.
    const routing: ProviderIdentity = {
      kind: binding.entryIdentityKind,
      externalId: entryExternalId,
    };

    for (const [i, rawItem] of asArray(entry['messaging']).entries()) {
      if (binding.channel === 'WHATSAPP') {
        // WhatsApp has no `messaging` transport. Something that claims to be one is a shape we do
        // not understand, not a message to be interpreted with another channel's rules.
        issues.push(`entry[${String(entryIndex)}].messaging[${String(i)}] on a whatsapp envelope`);
        continue;
      }
      const parsed = parseMessagingItem(
        rawItem,
        binding.channel,
        routing,
        entryExternalId,
        receivedAt,
      );
      if (parsed) items.push(parsed);
      else issues.push(`entry[${String(entryIndex)}].messaging[${String(i)}] is not an object`);
    }

    // Instagram delivers direct messages under `standby` when another app holds the thread. The
    // items are real; acting on them would mean two apps replying to one customer.
    for (const rawItem of asArray(entry['standby'])) {
      const parsed = parseMessagingItem(
        rawItem,
        binding.channel,
        routing,
        entryExternalId,
        receivedAt,
      );
      if (parsed)
        items.push({ ...parsed, kind: 'UNSUPPORTED', classification: 'UNKNOWN_MESSAGING' });
    }

    for (const [i, rawChange] of asArray(entry['changes']).entries()) {
      const change = asRecord(rawChange);
      if (!change) {
        issues.push(`entry[${String(entryIndex)}].changes[${String(i)}] is not an object`);
        continue;
      }
      const outcome = parseChange(change, binding, routing, entryExternalId, receivedAt);
      items.push(...outcome.items);
      issues.push(...outcome.issues.map((issue) => `entry[${String(entryIndex)}]: ${issue}`));
    }
  }

  return { items, issues };
}

function parseChange(
  change: Record<string, unknown>,
  binding: ChannelBinding,
  routing: ProviderIdentity,
  entryExternalId: string,
  receivedAt: Date,
): { items: readonly NormalizedInboundItem[]; issues: readonly string[] } {
  const fieldName = asString(change['field']);
  const value = change['value'];

  if (binding.channel === 'WHATSAPP') {
    if (fieldName !== 'messages') {
      // `account_update`, `phone_number_quality_update`, `template_status_update` and friends.
      // Account-level facts an operator needs to see, that carry no customer content.
      return {
        items: [
          unknownField(
            binding.channel,
            routing,
            entryExternalId,
            receivedAt,
            fieldName,
            'ACCOUNT_UPDATE',
          ),
        ],
        issues: [],
      };
    }
    return parseWhatsAppValue(value, { entryExternalId, receivedAt });
  }

  const context: CommentParseContext = {
    channel: binding.channel,
    routing,
    entryExternalId,
    receivedAt,
    // The connected surface's own ids, as far as the envelope reveals them. The connection's full
    // identity set is applied again downstream, where it is authoritative.
    selfIds: [entryExternalId],
  };

  if (binding.channel === 'FACEBOOK') {
    if (fieldName !== 'feed') {
      return {
        items: [unknownField(binding.channel, routing, entryExternalId, receivedAt, fieldName)],
        issues: [],
      };
    }
    const parsed = parseFacebookFeedChange(value, context);
    return parsed
      ? { items: [parsed], issues: [] }
      : { items: [], issues: [`feed change value is not an object`] };
  }

  // Instagram.
  if (fieldName === 'comments' || fieldName === 'live_comments') {
    const parsed = parseInstagramCommentChange(value, context, fieldName);
    return parsed
      ? { items: [parsed], issues: [] }
      : { items: [], issues: [`${fieldName} change value is not an object`] };
  }
  if (fieldName === 'mentions') {
    const parsed = parseInstagramMentionChange(value, context);
    return parsed
      ? { items: [parsed], issues: [] }
      : { items: [], issues: ['mentions value is not an object'] };
  }
  return {
    items: [unknownField(binding.channel, routing, entryExternalId, receivedAt, fieldName)],
    issues: [],
  };
}

/**
 * A change field we do not parse, recorded rather than dropped.
 *
 * The key is derived from the field name and the receipt instant, so two different unknown fields
 * in one delivery do not collapse into one row — which would be exactly the silent loss objective
 * 7 forbids.
 */
function unknownField(
  channel: Channel,
  routing: ProviderIdentity,
  entryExternalId: string,
  receivedAt: Date,
  fieldName: string | null,
  classification: 'UNKNOWN_FIELD' | 'ACCOUNT_UPDATE' = 'UNKNOWN_FIELD',
): NormalizedInboundItem {
  return item({
    kind: 'UNSUPPORTED',
    classification,
    channel,
    surface: channel === 'WHATSAPP' ? 'DIRECT_MESSAGE' : 'PUBLIC_COMMENT',
    routing,
    entryExternalId,
    senderExternalId: routing.externalId,
    recipientExternalId: routing.externalId,
    providerTs: receivedAt,
    contentType: 'SYSTEM_NOTE',
    derivedFrom: `field:${fieldName ?? 'missing'}`,
  });
}

/** The Meta implementation of the domain's envelope-parser port. */
export const metaEnvelopeParser: InboundEnvelopeParser = {
  parse: (payload, receivedAt) => parseMetaEnvelope(payload, receivedAt),
};
