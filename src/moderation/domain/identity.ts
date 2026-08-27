import type { AccountId, ChannelIdentityId, ContactIdentityId } from '../../platform/ids.ts';
import type { Channel } from '../../core/channel.ts';

/**
 * A stable address on a channel: a Messenger PSID, an Instagram-scoped id, a phone number.
 *
 * The same human on Messenger and on WhatsApp is two `ChannelIdentity` rows. That is deliberate:
 * the provider ids are not comparable, and inferring that they are the same person is exactly how
 * one customer ends up reading another customer's history.
 */
export interface ChannelIdentity {
  readonly id: ChannelIdentityId;
  readonly accountId: AccountId;
  readonly channel: Channel;
  readonly externalId: string;
  readonly contactIdentityId: ContactIdentityId | null;
  readonly displayName: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface CapturedAttribute {
  readonly value: string;
  readonly sourceMessageSeq: number;
  readonly capturedAt: Date;
}

/**
 * An account-scoped person: the merge point for channel identities.
 *
 * Explicitly NOT a CRM contact. No pipeline, no owner, no value, no stage. It exists so that a
 * returning customer is recognised — nothing more (see the three-noun rule in ARCHITECTURE-REVIEW).
 */
export interface ContactIdentity {
  readonly id: ContactIdentityId;
  readonly accountId: AccountId;
  readonly displayName: string | null;
  readonly locale: string | null;
  /** Facts the customer told us, each carrying its provenance. */
  readonly attributes: Readonly<Record<string, CapturedAttribute>>;
  readonly mergedIntoId: ContactIdentityId | null;
  readonly createdAt: Date;
}
