# Phase 02C — client knowledge, a real model, and human review

Phase 02B connected a real Meta Page in receive-only mode. Messages arrived, were verified,
normalised and moderated by a deterministic mock, and every outcome was recorded as `SIMULATED`.

Phase 02C makes the moderator useful without making it autonomous. It does three things:

1. Publishes a real client's Account Pack and knowledge, with the rule that an unapproved fact is
   invisible to the model.
2. Connects a real language model behind the existing port, through exactly one allowlisted
   network egress.
3. Makes `REQUIRE_APPROVAL` produce a draft a named person reviews — and **approval still does not
   send.**

**The system still has no way to reply to a customer.** An approved draft ends in
`APPROVED_FOR_MANUAL_SEND`, which is terminal. A person copies the text into Meta Inbox and sends
it themselves.

---

## 1. Slice 1 — the client pack

### 1.1 What was approved, and what was not

The source workbook holds a great deal about the account. Four facts met all three approval
conditions (see `KNOWLEDGE-APPROVAL-PROCEDURE.md`):

| Approved entry                    | Kind    | Why it qualified                                     |
| --------------------------------- | ------- | ---------------------------------------------------- |
| `kne_contact-whatsapp`            | FAQ     | Published on the client's own page and still visible |
| `kne_product-roson-r2-pro`        | PRODUCT | Existence only — the product is publicly listed      |
| `kne_product-fomos-autoclave`     | PRODUCT | Existence only                                       |
| `kne_product-full-clinic-package` | PRODUCT | Existence only                                       |

**None of them carries a price.** Nine further entries are tracked as `DRAFT` and are invisible to
the model: the Fomos discount offer, instalment terms, warranty terms, maintenance response times,
delivery and installation, two marketing claims (exclusive agency, best-selling), business hours,
and the proposed response-time SLA. Each states what is blocking it.

The `sla` section is marked `status: PROPOSED`. It came from our audit, not from the client;
publishing it as fact would invent a promise they never made.

The Fomos offer is the clearest illustration of the rule working. It has a real price
(20,000 EGP) and no stated end date, so `loadKnowledgeFile` refuses to approve it and the database
would refuse it independently. That was left as a refusal rather than worked around.

### 1.2 The authority matrix

Every customer-visible action is `REQUIRE_APPROVAL` on every surface. Only three actions are
`ALLOW`, and a customer sees none of them: `NO_ACTION`, `ADD_TAG`, `REQUEST_HUMAN_HANDOFF`.
`CAPTURE_FIELD`, `CREATE_LEAD_CANDIDATE`, `HIDE_COMMENT`, `DELETE_COMMENT` and `BLOCK_USER` are
`DENY`.

`insufficient_knowledge_action` is `REQUEST_HUMAN_HANDOFF` rather than `ASK_CLARIFICATION`: with
almost no approved commercial knowledge, a clarifying question stalls the customer instead of
reaching someone who can answer.

### 1.3 Arabic normalisation

Retrieval is exact tag matching, which only works if both sides are spelled identically — and
Arabic as typed by real people is not. `src/platform/text/normalize-arabic.ts` folds alef, yeh, ta
marbuta, waw hamza and the Farsi letter forms; strips tatweel, diacritics and invisible joiners;
converts both Arabic-Indic digit ranges; and emits a token both with and without its definite
article. The same function runs on a tag at import time and on a customer's message at retrieval
time, so they cannot drift.

Without it, retrieval appears to work — Arabic tokenises fine through `\p{L}` — and silently
under-recalls, degrading into "ask a human" rather than a visible error. Silent under-recall was
the worst available failure here because nobody would ever have investigated it.

---

## 2. Slice 2 — the real model

`src/integrations/llm/anthropic-provider.ts` implements the existing `LlmProvider` port. It is the
**only** file in `src/` permitted to open a socket, and it may name one host.

The full reasoning is ADR-012. The three things worth knowing here:

- **It is built on raw `fetch`, not `@anthropic-ai/sdk`, deliberately.** The receive-only guarantee
  is enforced by a textual scan over `src/`. An SDK would move the socket into `node_modules`,
  where the scan cannot see it — every assertion would keep passing while egress quietly existed.
  Keeping the call visible in `src/` is what keeps the rule honest. This is a deviation from the
  usual SDK default and is flagged here for that reason.
- **The egress rule was narrowed, not weakened.** Before: zero files may open a socket. Now: one
  file, by name, to `api.anthropic.com`, which must actually contain the call, which may not name
  a Meta host, and which no module in `moderation/`, `knowledge/`, `policy/`, `core/`,
  `operations/` or `platform/` may import. All five clauses are asserted in
  `tests/architecture/llm-egress.test.ts` and repeated as a standalone CI step.
- **No tools, no streaming, no prefill, no temperature, no thinking budget.** The first two are
  safety properties — the model is given no callable surface and there is no partial-output path.
  The last three are 400s on current models.

`mock` remains the default. An unrecognised `LLM_PROVIDER` is refused at boot rather than falling
back to anything. `ANTHROPIC_API_KEY` is read at the boot edge and never lands on `RuntimeConfig`.

---

## 3. Slice 3 — human review

### 3.1 The defect

`REQUIRE_APPROVAL` used to throw the reply away. The gate refused to mint an `AuthorizedAction`,
and the moderator fell back to a handoff — safe, and it discarded the draft. For the first client,
whose every customer-visible action is `REQUIRE_APPROVAL`, that meant the only effect the account
uses did nothing.

### 3.2 A second defect, found on the way

`createOutboundAction` collapsed every delivery mode to `SIMULATED` whenever the runtime was
simulating — and `OUTBOUND_MODE=LIVE` is refused at boot, so it always is. Even after fixing the
gate, every suggestion would have been filed as a pretend send and **the review queue would have
been permanently, silently empty.**

`SUGGESTED` now survives simulation. The two modes answer different questions: simulation is about
transport, suggestion is about authority.

### 3.3 What a reviewer gets

A suppressed `SUGGESTED` action carrying `payload.text` (the model's words, never rewritten) and
`payload.review`: intent and its confidence, overall confidence, risk, proposed action, policy
reason, knowledge citations, pack version, prompt version, input watermark, run id.

`review show` additionally re-validates every citation **now**. An entry that has expired or been
unapproved since the draft was written is reported as unresolved rather than shown as evidence.

### 3.4 The commands

```bash
node src/runtime/cli/review.ts list     --account acc_... [--limit 20]
node src/runtime/cli/review.ts show     --account acc_... --action oba_...
node src/runtime/cli/review.ts approve  --account acc_... --action oba_... --reviewer usr_...
node src/runtime/cli/review.ts edit     --account acc_... --action oba_... --reviewer usr_... --text "..."
node src/runtime/cli/review.ts reject   --account acc_... --action oba_... --reviewer usr_... --reason "..."
node src/runtime/cli/review.ts escalate --account acc_... --action oba_... --reviewer usr_... --reason "..."
```

Every accepted decision prints:

> `NOT SENT. Copy the text above into Meta Inbox and send it yourself — this system has no send
capability.`

`list` is ordered oldest-first and reports the wait in hours, because the audit's costliest finding
was a question that sat for five days and a newest-first queue is how that stays invisible.

### 3.5 What is persisted

`outbound_action_reviews`, append-only — `app_runtime` holds SELECT and INSERT and nothing else.
Each row: decision, **reviewer user id (NOT NULL)**, reason, original text, edited text, timestamp.

The final text is derived from the review log rather than stored a second time on the action.
`outbound:save` upserts state and delivery bookkeeping and never rewrites `payload`, so a second
copy would silently drift — and did, until a Postgres test caught it.

---

## 4. What the system can now do, end to end

```
Meta comment/message (signed)
  → signature verified → raw event persisted → deduplicated → normalised
  → conversation + message, ordered, watermarked
  → debounce → moderator run under partition exclusivity
  → Knowledge Gate pre-filter: APPROVED, in-validity, in-scope, Arabic-normalised retrieval
  → model call (mock or real Anthropic), structured JSON, no tools, no streaming
  → schema + semantic validation, one repair turn
  → Knowledge Gate post-check: citation containment + re-validation
  → action gate: matrix REQUIRE_APPROVAL → re-gated as SUGGESTED
  → outbound action: SUGGESTED / SUPPRESSED, draft + evidence bundle
  → compare-and-swap commit with staleness guard
  → human review: list → show → approve | edit | reject | escalate
  → APPROVED_FOR_MANUAL_SEND
  → a person sends it themselves from Meta Inbox
```

Zero outbound dispatch at every step. Asserted by `tests/integration/dental-hub-acceptance.test.ts`
on the actual published pack, and by the shadow trace reading only persisted state.

---

## 5. What is still simulated, and what is still manual

**Simulated**

- Outbound delivery, entirely. There is no transport of any kind.
- The model in every test and in CI (`LLM_PROVIDER=mock`). The real adapter is exercised in
  `tests/unit/anthropic-provider.test.ts` with an injected transport and no network.
- Domain event relay — the outbox relays to a simulated target.

**Manual**

- **Sending every reply.** A person copies approved text into Meta Inbox.
- Working the review queue. Nothing ages a draft out or reminds anyone.
- Promoting a draft fact to approved: ask the client, get it in writing, edit the file, re-import.
- Working the knowledge-gap list.
- Publishing a pack and importing knowledge (CLI commands run by a person).
- Meta app configuration, subscription and field selection.

---

## 6. Before the first live inbound-message trial

1. **A named reviewer, and their `usr_` id.** `reviewer_user_id` is NOT NULL. Decide who owns the
   queue before traffic arrives, or the audit's fifteenth finding recurs in a new place.
2. **`ANTHROPIC_API_KEY` provisioned**, and `LLM_PROVIDER=anthropic` set, with a spend limit on the
   key. Until then the deployment runs the mock and drafts nothing useful.
3. **`LLM_REASON_MODEL` set to a real model id.** The default `mock-model-1` is not one.
4. **The pack and knowledge published to the target database** — steps in
   `KNOWLEDGE-APPROVAL-PROCEDURE.md` §Publishing. An unpublished pack means every run is `SKIPPED`.
5. **The client asked the open questions.** Nine draft entries are blocking useful answers; the
   price and instalment questions are the ones customers actually ask. Until they are answered the
   assistant will route most commercial questions to a person — which is correct, and is also most
   of the traffic.
6. **A `PROVENANCE.md` review with the client**, confirming what we believe they said.
7. **Real cost and latency observed once.** No real call has been made from this codebase yet. The
   request shape is pinned by tests, not by a live response.
8. **A decision on who receives escalations** and how they are notified. `handoff_sla_ms` is one
   hour and nothing currently watches it.

Not blockers, but worth stating: there is no UI, no notification of any kind, and no automatic
expiry of stale drafts.

---

## 7. Files

**New**

```
knowledge/dental-hub/pack/{pack,knowledge.approved,knowledge.draft,evaluation-cases}.json
knowledge/dental-hub/pack/PROVENANCE.md
src/platform/text/normalize-arabic.ts
src/moderation/domain/review.ts
src/moderation/application/review.ts
src/integrations/llm/anthropic-provider.ts
src/runtime/admin/pack-authoring.ts
src/runtime/cli/{pack,knowledge,review}.ts
db/migrations/0009_review.sql
docs/adr/ADR-011-human-review-and-suggested-delivery.md
docs/adr/ADR-012-llm-egress-and-provider-adapter.md
docs/{KNOWLEDGE-APPROVAL-PROCEDURE,CLIENT-DATA-HANDLING,HANDOFF-PHASE-02C}.md
tests/unit/{normalize-arabic,anthropic-provider,pack-dental-hub}.test.ts
tests/integration/{suggested-delivery,review-approval,no-approved-knowledge,dental-hub-acceptance}.test.ts
tests/architecture/llm-egress.test.ts
tests/postgres/review-queue.test.ts
```

**Changed** — `src/policy/action-gate.ts`, `src/moderation/domain/outbound-action.ts`,
`src/moderation/application/{run-moderator,takeover}.ts`, `src/moderation/ports.ts`,
`src/operations/audit.ts`, `src/platform/ids.ts`, the memory and Postgres adapters,
`src/runtime/{config,container,application,main}.ts`, `src/runtime/admin/shadow-trace.ts`,
`src/runtime/cli/{context,shadow-acceptance}.ts`, `tests/architecture/no-outbound-meta.test.ts`,
`tests/support/postgres.ts`, `tests/postgres/rls.test.ts`, `.env.example`,
`.github/workflows/verify.yml`, `README.md`, `docs/adr/README.md`.

---

## 8. What is still not true

- The system cannot send a message. Not "does not"; cannot.
- No real model call has been made from this codebase.
- There is no operator UI, and no notification when a draft is waiting.
- The proposed/final corpus that would justify more autonomy is empty until traffic arrives.
- `CAPTURE_FIELD` and `CREATE_LEAD_CANDIDATE` are denied; there is no CRM.
- Nothing watches the handoff SLA.
