import type { AccountId, KnowledgeEntryId, UserId } from '../../platform/ids.ts';

export const KNOWLEDGE_KINDS = [
  'FAQ',
  'POLICY',
  'PRODUCT',
  'SERVICE',
  'LOCATION',
  'HOURS',
  'WARRANTY',
  'DELIVERY',
  'INSTALLATION',
  'OFFER',
  'PRICE',
  'CLAIM',
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export type KnowledgeStatus = 'DRAFT' | 'APPROVED' | 'ARCHIVED';

/** Kinds that make a commercial claim, and therefore carry stricter validity handling. */
export const COMMERCIAL_KINDS: ReadonlySet<KnowledgeKind> = new Set<KnowledgeKind>([
  'PRICE',
  'OFFER',
]);

export interface Money {
  readonly amount: string; // decimal string; never a float (ADR-003)
  readonly currency: string; // ISO-4217
}

export interface KnowledgeEntry {
  readonly id: KnowledgeEntryId;
  readonly accountId: AccountId;
  readonly kind: KnowledgeKind;
  readonly title: string;
  readonly body: string;
  readonly locale: string;
  readonly status: KnowledgeStatus;
  readonly validFrom: Date | null;
  readonly validUntil: Date | null;
  readonly sourceRef: string | null;
  readonly evidence: string | null;
  readonly approvedBy: UserId | null;
  readonly approvedAt: Date | null;
  readonly productRef: string | null;
  readonly paymentType: string | null;
  readonly price: Money | null;
  readonly tags: readonly string[];
  readonly intentCodes: readonly string[];
  /** Price history without mutation: a new entry supersedes rather than edits. */
  readonly supersedesId: KnowledgeEntryId | null;
  readonly updatedAt: Date;
}

/**
 * Time validity, evaluated in code.
 *
 * The whole reason the Knowledge Gate exists is that this check must never be delegated to a
 * language model. An expired price presented as current is a commercial claim we cannot retract,
 * so it is filtered here — deterministically — before the model ever sees the entry.
 */
export function isWithinValidity(entry: KnowledgeEntry, now: Date): boolean {
  if (entry.validFrom && entry.validFrom.getTime() > now.getTime()) return false;
  if (entry.validUntil && entry.validUntil.getTime() < now.getTime()) return false;
  return true;
}

export function isUsable(entry: KnowledgeEntry, now: Date): boolean {
  return entry.status === 'APPROVED' && isWithinValidity(entry, now);
}

export function isCommercial(entry: KnowledgeEntry): boolean {
  return COMMERCIAL_KINDS.has(entry.kind);
}

/** Entries expiring soon: the proactive half of F-08, surfaced as an operator report. */
export function expiresWithin(entry: KnowledgeEntry, now: Date, windowMs: number): boolean {
  if (!entry.validUntil) return false;
  const remaining = entry.validUntil.getTime() - now.getTime();
  return remaining >= 0 && remaining <= windowMs;
}
