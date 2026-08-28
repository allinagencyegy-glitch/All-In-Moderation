import type { Channel } from '../../core/channel.ts';
import type { NormalizedInboundItem } from '../../moderation/domain/inbound.ts';
import type { ProviderIdentity } from '../../moderation/domain/provider.ts';
import { asRecord, asString, attachment, idOf, item, nested, timestampFrom } from './payload.ts';

/**
 * Public comments, on both Facebook Pages and Instagram.
 *
 * These are two different payloads wearing the same name, and the differences are exactly the
 * kind that a single "good enough" parser gets wrong:
 *
 *   Facebook (`field: "feed"`)   `{item, verb, comment_id, post_id, parent_id, from, message,
 *                                 created_time}` — `item` says what kind of feed activity this is
 *                                 (comment, post, reaction, share) and `verb` says add/edit/remove.
 *   Instagram (`field: "comments"`) `{id, parent_id, text, from, media: {id, media_product_type}}`
 *                                 — no `item`, no `verb`, no `created_time`, and the comment id is
 *                                 `id` rather than `comment_id`.
 *
 * Phase 02A had one parser that required `item === 'comment'` and `verb === 'add'`, so every real
 * Instagram comment would have been classified as an unsupported change and silently ignored.
 *
 * Both parsers refuse to produce an actionable item for a comment authored by the connected
 * surface itself. That is the public-surface half of the echo loop-breaker: a page replying to its
 * own comment is delivered back through this same webhook, and without the check the moderator
 * would answer itself in public (objective 9).
 */

export interface CommentParseContext {
  readonly channel: Channel;
  readonly routing: ProviderIdentity;
  readonly entryExternalId: string;
  readonly receivedAt: Date;
  /** Every identity the connected surface itself may post as. */
  readonly selfIds: readonly string[];
}

export function parseFacebookFeedChange(
  value: unknown,
  context: CommentParseContext,
): NormalizedInboundItem | null {
  const record = asRecord(value);
  if (!record) return null;

  const kindOfItem = asString(record['item']);
  const verb = asString(record['verb']);
  const base = baseFor(
    context,
    timestampFrom(record['created_time'], 'SECONDS', context.receivedAt),
  );

  // Feed activity that is not a comment: posts, shares, likes, reactions on our own content. Real
  // events, recorded under their own classification rather than mislabelled as comments.
  if (kindOfItem !== 'comment') {
    return item({
      ...base,
      kind: 'UNSUPPORTED',
      classification: 'UNKNOWN_FIELD',
      senderExternalId: idOf(record['from']) ?? context.routing.externalId,
      recipientExternalId: context.routing.externalId,
      contentType: 'SYSTEM_NOTE',
      derivedFrom: `feed:${kindOfItem ?? 'unknown'}:${verb ?? 'unknown'}`,
    });
  }

  const commentId = asString(record['comment_id']);
  const from = idOf(record['from']);
  if (!commentId || !from) {
    return item({
      ...base,
      kind: 'UNSUPPORTED',
      classification: 'MALFORMED',
      senderExternalId: from ?? context.routing.externalId,
      recipientExternalId: context.routing.externalId,
      derivedFrom: `feed:comment:${verb ?? 'unknown'}`,
    });
  }

  if (verb === 'edit' || verb === 'edited') {
    return marker(base, context, from, commentId, 'COMMENT_EDIT', record);
  }
  if (verb === 'remove' || verb === 'removed' || verb === 'hide' || verb === 'unhide') {
    return marker(base, context, from, commentId, 'COMMENT_REMOVE', record);
  }
  if (verb !== 'add') {
    return item({
      ...base,
      kind: 'UNSUPPORTED',
      classification: 'UNKNOWN_FIELD',
      senderExternalId: from,
      recipientExternalId: context.routing.externalId,
      providerMessageId: commentId,
      dedupeKey: `feed:${verb ?? 'unknown'}:${commentId}`,
      contentType: 'SYSTEM_NOTE',
      derivedFrom: `feed:comment:${verb ?? 'unknown'}`,
    });
  }

  if (context.selfIds.includes(from)) {
    return selfComment(base, context, from, commentId, record['post_id']);
  }

  const text = asString(record['message']);
  const photo = asString(record['photo']);
  const video = asString(record['video']);
  const attachments = photo
    ? [attachment({ kind: 'IMAGE', url: photo })]
    : video
      ? [attachment({ kind: 'VIDEO', url: video })]
      : [];

  return item({
    ...base,
    kind: 'COMMENT',
    classification: 'COMMENT',
    senderExternalId: from,
    senderDisplayName: asString(nested(record['from'], 'name')),
    recipientExternalId: context.routing.externalId,
    providerMessageId: commentId,
    dedupeKey: commentId,
    contentType: text !== null ? 'TEXT' : attachments.length > 0 ? 'IMAGE' : 'UNSUPPORTED',
    text,
    attachments,
    threadRef: asString(record['post_id']),
    parentRef: parentCommentRef(asString(record['parent_id']), asString(record['post_id'])),
  });
}

export function parseInstagramCommentChange(
  value: unknown,
  context: CommentParseContext,
  field: 'comments' | 'live_comments',
): NormalizedInboundItem | null {
  const record = asRecord(value);
  if (!record) return null;

  // Instagram sends no timestamp on a comment change. The receipt time is the honest fallback, and
  // `dedupeSource` is irrelevant here because the comment id is authoritative.
  const base = baseFor(context, context.receivedAt);
  const commentId = asString(record['id']);
  const from = idOf(record['from']);

  if (!commentId || !from) {
    return item({
      ...base,
      kind: 'UNSUPPORTED',
      classification: 'MALFORMED',
      senderExternalId: from ?? context.routing.externalId,
      recipientExternalId: context.routing.externalId,
      derivedFrom: `ig:${field}`,
    });
  }

  if (context.selfIds.includes(from)) {
    return selfComment(base, context, from, commentId, nested(record['media'], 'id'));
  }

  const text = asString(record['text']);
  return item({
    ...base,
    kind: 'COMMENT',
    classification: 'COMMENT',
    senderExternalId: from,
    // Instagram identifies commenters by username rather than by name.
    senderDisplayName: asString(nested(record['from'], 'username')),
    recipientExternalId: context.routing.externalId,
    providerMessageId: commentId,
    dedupeKey: commentId,
    contentType: text !== null ? 'TEXT' : 'UNSUPPORTED',
    text,
    threadRef: asString(nested(record['media'], 'id')),
    parentRef: asString(record['parent_id']),
  });
}

/**
 * Instagram `mentions`: someone tagged the account in *their* comment or caption.
 *
 * Deliberately not a comment. The thread belongs to another account, so replying to it is a
 * different act with different authority, and the platform has no business treating it as an
 * inbound conversation until that is modelled.
 */
export function parseInstagramMentionChange(
  value: unknown,
  context: CommentParseContext,
): NormalizedInboundItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const base = baseFor(context, context.receivedAt);
  const commentId = asString(record['comment_id']);
  const mediaId = asString(record['media_id']);
  return item({
    ...base,
    kind: 'UNSUPPORTED',
    classification: 'UNKNOWN_FIELD',
    senderExternalId: context.routing.externalId,
    recipientExternalId: context.routing.externalId,
    providerMessageId: commentId,
    dedupeKey: commentId !== null ? `mention:${commentId}` : null,
    contentType: 'SYSTEM_NOTE',
    threadRef: mediaId,
    derivedFrom: `ig:mentions:${mediaId ?? 'unknown'}`,
  });
}

function baseFor(context: CommentParseContext, providerTs: Date) {
  return {
    channel: context.channel,
    surface: 'PUBLIC_COMMENT' as const,
    routing: context.routing,
    entryExternalId: context.entryExternalId,
    providerTs,
  };
}

function selfComment(
  base: ReturnType<typeof baseFor>,
  context: CommentParseContext,
  from: string,
  commentId: string,
  threadRef: unknown,
): NormalizedInboundItem {
  return item({
    ...base,
    kind: 'ECHO',
    classification: 'ECHO_SELF_COMMENT',
    senderExternalId: from,
    recipientExternalId: context.routing.externalId,
    providerMessageId: commentId,
    // Namespaced so an echo and the comment it echoes can never collide on the dedupe key.
    dedupeKey: `echo:${commentId}`,
    contentType: 'SYSTEM_NOTE',
    threadRef: asString(threadRef),
  });
}

function marker(
  base: ReturnType<typeof baseFor>,
  context: CommentParseContext,
  from: string,
  commentId: string,
  classification: 'COMMENT_EDIT' | 'COMMENT_REMOVE',
  record: Record<string, unknown>,
): NormalizedInboundItem {
  return item({
    ...base,
    kind: 'UNSUPPORTED',
    classification,
    senderExternalId: from,
    recipientExternalId: context.routing.externalId,
    providerMessageId: commentId,
    dedupeKey: `${classification.toLowerCase()}:${commentId}`,
    contentType: 'SYSTEM_NOTE',
    threadRef: asString(record['post_id']),
  });
}

/**
 * Facebook sets `parent_id` to the *post* on a top-level comment and to the parent comment on a
 * reply. Returning the post id as a parent would make every top-level comment look like a reply
 * to itself, so it is normalised away here rather than downstream.
 */
function parentCommentRef(parentId: string | null, postId: string | null): string | null {
  if (parentId === null) return null;
  return parentId === postId ? null : parentId;
}
