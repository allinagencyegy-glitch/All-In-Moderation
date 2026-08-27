import type { AccountScope } from '../../core/account/index.ts';
import type { KnowledgeEntryId } from '../../platform/ids.ts';
import { asId } from '../../platform/ids.ts';
import type { KnowledgeEntry } from '../domain/knowledge-entry.ts';
import { isCommercial, isUsable } from '../domain/knowledge-entry.ts';
import type { KnowledgeQuery, KnowledgeRepository } from '../ports.ts';

/**
 * The Knowledge Gate (ADR-010).
 *
 * It runs twice around every model call, and the two passes exist for different reasons:
 *
 *   BEFORE — the model is only ever shown approved, in-validity, in-scope entries. It cannot
 *            present an expired price as current because it was never given one. That is a much
 *            stronger guarantee than instructing a model to check dates.
 *
 *   AFTER  — citations are checked for *containment* (was this id actually supplied?) and cited
 *            commercial entries are re-validated, because a price can expire between the start of
 *            a run and its commit.
 *
 * Neither pass asks the model whether it is confident. Confidence is an input to routing; it is
 * never the authority for a commercial claim.
 */

export interface RetrievalRequest {
  readonly locale: string;
  readonly intentCodes: readonly string[];
  readonly tags: readonly string[];
  readonly limit?: number;
}

export interface KnowledgeCandidateSet {
  readonly entries: readonly KnowledgeEntry[];
  readonly suppliedIds: ReadonlySet<string>;
  /** Entries that matched the query but were filtered out, with the reason. Feeds diagnostics. */
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
}

export interface KnowledgeVerification {
  readonly verified: boolean;
  readonly reason: string;
  readonly usedIds: readonly string[];
}

export interface KnowledgeGate {
  retrieve(
    scope: AccountScope,
    request: RetrievalRequest,
    now: Date,
  ): Promise<KnowledgeCandidateSet>;
  verifyCitations(
    candidates: KnowledgeCandidateSet,
    refs: readonly string[],
    now: Date,
  ): KnowledgeVerification;
}

const DEFAULT_LIMIT = 12;

export function createKnowledgeGate(repository: KnowledgeRepository): KnowledgeGate {
  return {
    async retrieve(scope, request, now) {
      const query: KnowledgeQuery = {
        locale: request.locale,
        intentCodes: request.intentCodes,
        tags: request.tags,
        limit: request.limit ?? DEFAULT_LIMIT,
      };
      const found = await repository.findApproved(scope, query);

      const entries: KnowledgeEntry[] = [];
      const rejected: { id: string; reason: string }[] = [];
      for (const entry of found) {
        // Defence in depth: the repository contract says APPROVED and in-scope only, but the gate
        // does not take that on trust. A bug in one adapter must not become a wrong price.
        if (entry.accountId !== scope.accountId) {
          rejected.push({ id: entry.id, reason: 'CROSS_ACCOUNT' });
          continue;
        }
        if (entry.status !== 'APPROVED') {
          rejected.push({ id: entry.id, reason: 'NOT_APPROVED' });
          continue;
        }
        if (!isUsable(entry, now)) {
          rejected.push({ id: entry.id, reason: 'OUTSIDE_VALIDITY_WINDOW' });
          continue;
        }
        entries.push(entry);
      }

      const ranked = rankBySpecificity(entries, request);
      return {
        entries: ranked,
        suppliedIds: new Set(ranked.map((e) => e.id as string)),
        rejected,
      };
    },

    verifyCitations(candidates, refs, now) {
      if (refs.length === 0) {
        return { verified: true, reason: 'no citations', usedIds: [] };
      }
      // Containment: a citation the run was never given is a hallucination, caught structurally
      // rather than by judging whether it looks plausible.
      const invented = refs.filter((ref) => !candidates.suppliedIds.has(ref));
      if (invented.length > 0) {
        return {
          verified: false,
          reason: `cited knowledge not supplied to this run: ${invented.slice(0, 3).join(', ')}`,
          usedIds: [],
        };
      }
      const byId = new Map(candidates.entries.map((e) => [e.id as string, e]));
      for (const ref of refs) {
        const entry = byId.get(ref);
        if (!entry) {
          return { verified: false, reason: `citation ${ref} could not be resolved`, usedIds: [] };
        }
        // Re-check validity: a price can expire between run start and commit.
        if (!isUsable(entry, now)) {
          return {
            verified: false,
            reason: `cited ${entry.kind} ${ref} is no longer approved or in validity`,
            usedIds: [],
          };
        }
      }
      return { verified: true, reason: 'all citations resolved and valid', usedIds: [...refs] };
    },
  };
}

/**
 * Deterministic ranking (ADR-010, open decision D1).
 *
 * Intent match beats tag match beats recency. No embeddings yet: with no real client corpus we
 * cannot evaluate recall, and an unevaluated retriever that silently returns the wrong thing is
 * worse than a lookup that returns nothing loudly.
 */
function rankBySpecificity(
  entries: readonly KnowledgeEntry[],
  request: RetrievalRequest,
): KnowledgeEntry[] {
  const intents = new Set(request.intentCodes);
  const tags = new Set(request.tags);
  const score = (entry: KnowledgeEntry): number => {
    let value = 0;
    if (entry.intentCodes.some((code) => intents.has(code))) value += 100;
    value += entry.tags.filter((tag) => tags.has(tag)).length * 10;
    if (entry.locale === request.locale) value += 5;
    // A commercial claim outranks general prose when both match: it is the more specific answer.
    if (isCommercial(entry)) value += 3;
    return value;
  };
  return [...entries].sort((a, b) => {
    const delta = score(b) - score(a);
    if (delta !== 0) return delta;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}

export function toKnowledgeEntryIds(refs: readonly string[]): KnowledgeEntryId[] {
  return refs.map((ref) => asId<KnowledgeEntryId>(ref));
}
