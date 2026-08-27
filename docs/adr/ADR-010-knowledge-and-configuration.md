# ADR-010: Knowledge and Account Configuration Model

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

Every client needs its own brand voice, intent taxonomy, knowledge, products, prices, offers,
qualification rules, routing, SLA, authority matrix and escalation policy — the "Moderator Account
Pack". The core runtime must contain none of it.

Two requirements do most of the design work:

- **An expired or unapproved price must never be presented as current.** A price is not a fact; it
  is a fact _with a validity window and an approval_.
- **If knowledge is insufficient, do not guess — clarify or escalate.** "Insufficient" must be a
  deterministic finding, not a model self-assessment.

There is also a compliance-shaped requirement hiding in plain sight: when a customer disputes what
they were told, we must be able to reproduce exactly which knowledge and configuration produced a
given reply, months later.

## Decision

**Account configuration is an immutable, versioned, schema-validated Account Pack. Knowledge is
account-scoped rows with explicit validity and approval. Every moderator run pins the pack version
it used.**

### Account Pack

- A pack is a set of **sections** (`profile`, `channels`, `brand_voice`, `intent_taxonomy`, `faq`,
  `knowledge`, `products`, `pricing`, `qualification`, `data_collection`, `routing`, `sla`,
  `authority_matrix`, `escalation`, `public_comment_rules`, `multimodal_rules`,
  `handoff_contract`, `knowledge_gaps`, `evaluation_cases`, `evidence_log`). Each section has its
  own JSON Schema and its own version.
- A **pack version** is immutable once published, content-addressed by a hash of its sections, and
  has a status: `DRAFT -> IN_REVIEW -> APPROVED -> ACTIVE -> SUPERSEDED` (plus `ROLLED_BACK`).
  Exactly one version per account may be `ACTIVE`, enforced by a partial unique index.
- Publishing validates every section against its schema **and** against cross-section rules (for
  example: every intent referenced by routing exists in the taxonomy; every action in the
  authority matrix is a known action type; every product referenced by pricing exists). An invalid
  pack cannot become `ACTIVE` — this is the enforcement point for "invalid client configuration"
  in the failure register.
- Rollback is publishing a previous version's content as a new version, so history is never
  rewritten.
- Runtime resolution is `account_id -> active pack version -> sections`, cached by
  `(account_id, pack_version_id)`. Because the cache key contains the version, publishing
  invalidates by construction; there is no cache-busting logic to get wrong.
- **Every `ModeratorRun` stores `pack_version_id`.** Nine months later, "why did it say that?" is
  answerable exactly.

### Knowledge entries

Knowledge is rows, not prose blobs:

| Field                                               | Purpose                                            |
| --------------------------------------------------- | -------------------------------------------------- | -------- | ---------------------------------------- | ------- | -------- | ----- | -------- | -------- | ------------ | ----- | ----- | ------ |
| `account_id`, `id`, `kind`                          | Tenant, identity, and `FAQ                         | POLICY   | PRODUCT                                  | SERVICE | LOCATION | HOURS | WARRANTY | DELIVERY | INSTALLATION | OFFER | PRICE | CLAIM` |
| `title`, `body`, `locale`                           | The answerable content (multi-locale from day one) |
| `status`                                            | `DRAFT                                             | APPROVED | ARCHIVED`— only`APPROVED` is retrievable |
| `valid_from`, `valid_until`                         | Nullable; `NULL` in `valid_until` means open-ended |
| `source_ref`, `evidence`                            | Where this claim came from, and who attested it    |
| `approved_by`, `approved_at`                        | Accountability                                     |
| `product_ref`, `payment_type`, `amount`, `currency` | Set for `PRICE`/`OFFER` kinds                      |
| `tags`, `intent_codes`                              | Deterministic retrieval keys                       |
| `supersedes_id`                                     | Price history without mutation                     |

Prices and offers are never edited in place. A new price supersedes the old one, so what we told a
customer in March is still reconstructable in September.

### The Knowledge Gate (the reason this ADR exists)

Deterministic code, running **twice**, before and after the model:

```text
BEFORE the model:
  candidates = approved, in-locale, account-scoped entries matching the retrieval keys
  filter out: status != APPROVED
              valid_from > now  OR  valid_until < now       <-- time filter, in code
  if candidates is empty for a knowledge-requiring intent:
       do not call the model for an answer; record a knowledge gap;
       take the account's insufficient-knowledge route (clarify or escalate)

AFTER the model returns a decision:
  every citation must be in the candidate set        (citation containment)
  every cited PRICE/OFFER re-checked for validity    (the run may have outlived the window)
  an ANSWER action with zero citations is rejected
  a price/offer answer whose citation is not a PRICE/OFFER entry is rejected
```

Points that matter:

- **The model never sees an expired or unapproved entry.** It cannot present one as current
  because it was never given one. This is far stronger than instructing it to check dates.
- **Citation containment** turns hallucinated sources into a caught error rather than a
  plausible-looking lie.
- **The re-check after the decision** closes the window where a price expires mid-run.
- **"Insufficient knowledge" is decided by code**, not by asking the model whether it is confident.
  A model's confidence is an input to routing, never the authority for it.
- Every gate outcome writes a `knowledge_gap` row when nothing matched, which is what feeds
  `faq.unanswered` and, in turn, the client's content backlog. Gaps become a product feature
  rather than an invisible failure.

### Retrieval in Phase 0

Deterministic: exact and tag/intent-keyed lookup with locale matching, ranked by specificity and
recency. **No embeddings yet** — with no real client corpus, we cannot evaluate recall, and an
unevaluated retriever that silently returns nothing is worse than a lookup that returns nothing
loudly. The `KnowledgeRetriever` port has one implementation now; adding a `pgvector` hybrid
retriever later changes no caller. This is open decision D1.

### Where business content is allowed to exist

| Layer                            | May contain client-specific content                                          |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `src/**` core runtime            | **No** — enforced by the architecture test                                   |
| Account Pack sections (data)     | Yes                                                                          |
| Knowledge entries (data)         | Yes                                                                          |
| Prompt templates                 | Structure only; all substance is injected from the pack                      |
| Fixtures under `tests/fixtures/` | Only clearly synthetic accounts (`acme-demo`), never a real client's content |

## Options considered

| Option                                                                    | Verdict                                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Versioned immutable packs + validity-filtered knowledge rows (chosen)** | Reproducible decisions; expiry enforced in code; safe rollback                                      |
| Mutable config rows edited in place                                       | Cannot reproduce a past decision; a bad edit silently changes live behaviour with no rollback       |
| Config in environment variables / deploy files                            | Requires a deploy per client change; no approval workflow; no audit                                 |
| One big JSON blob per account                                             | No per-section validation, no partial approval, and every edit risks everything                     |
| Trust the model to respect `valid_until` in the prompt                    | Rejected on principle: correctness of a commercial claim cannot depend on a probabilistic component |
| Vector store from day one                                                 | Unevaluable without real content; adds infrastructure and a silent-failure mode                     |

## Consequences

### Positive

- Any historical reply can be explained with the exact configuration and knowledge that produced it.
- Expired or unapproved commercial claims are structurally unreachable.
- Client onboarding is a data exercise; no code changes and no deploy.

### Negative / accepted cost

- Pack authoring needs tooling (an editor with validation) before non-engineers can use it. Phase 2.
- Immutability grows the version table. Trivial volume.
- Deterministic retrieval will miss paraphrases until D1 is resolved — but it misses them _loudly_,
  producing a knowledge gap and an escalation rather than a confident wrong answer.

## Enforcement

- Sections are schema-validated on publish; an invalid pack cannot reach `ACTIVE`.
- `ModeratorRun.pack_version_id` is non-null.
- `tests/unit/knowledge-gate.test.ts` covers: expired price excluded, unapproved excluded,
  cross-account excluded, empty candidates route to clarify/escalate, citation containment
  rejects invented refs, and a price expiring mid-run is caught by the post-check.
- The architecture test asserts no client name appears in `src/`.

## Revisit trigger

- Real client corpora arrive and deterministic retrieval measurably misses (then evaluate hybrid
  retrieval against the pack's `evaluation_cases`).
- Clients need self-service pack editing (then the approval workflow needs a UI and finer RBAC).
- Knowledge volume per account exceeds what a single query can rank sensibly.
