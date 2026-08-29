# Knowledge Approval Procedure

The rule this whole document exists to protect:

> **NO APPROVED KNOWLEDGE = NO FACTUAL INVENTION.**

The assistant may state a fact only if that fact is an `APPROVED` knowledge entry, inside its
validity window, retrieved for this run, and cited. Everything else — a price someone mentioned in
a call, a warranty term from a screenshot, a delivery promise from an old post — is `DRAFT`, and a
`DRAFT` entry is **invisible to the model**. Not deprioritised. Not shown with a caveat. Never
supplied.

Not knowing an answer is an acceptable outcome. It routes to a person and records a knowledge gap.
Inventing one is not.

## The three conditions for approval

An entry may be approved only when **all three** hold. Any one missing means it stays `DRAFT`.

1. **The client stated it.** Not us, not the workbook's inference, not a reasonable reading of a
   marketing post. A named person at the client said it, in writing, and the message is quotable.
2. **It is currently true, and we know when it stops being true.** A `PRICE` or an `OFFER` cannot
   be approved without a `validUntil`. This is refused by the importer _and_ independently by the
   database (`knowledge_commercial_requires_expiry`). Presenting last spring's promotion as this
   week's price is the single most expensive thing a commercial assistant can do.
3. **It contains no placeholder.** No `[amount]`, no `{{ }}`, no "TBC". A bracketed slot that
   reaches a customer reads as a broken mail merge; a bracketed slot the model is asked to fill
   reads as an invitation to invent.

An approval also needs a **name**: `--approve` requires `--approver <user id>`, the id lands on the
row, and the schema refuses an approved entry without one
(`knowledge_approved_requires_approver`). Approval is attribution.

## Data Confidence

Every entry carries the source workbook's confidence grade and the exact cells it came from. Both
travel into the stored `evidence` column as `[GRADE] evidence text`, so a reviewer reading a row
sees how good the evidence was rather than only what it said.

| Grade                | Meaning                                                   | Approvable                      |
| -------------------- | --------------------------------------------------------- | ------------------------------- |
| Verified – published | Stated publicly by the client and still visible           | Yes, if conditions 2 and 3 hold |
| Verified – client    | Stated to us in writing by a named person at the client   | Yes, if conditions 2 and 3 hold |
| Observed             | Seen in the client's own material, meaning inferred by us | No — confirm the meaning first  |
| Inferred             | Our reading, however reasonable                           | No                              |
| Placeholder          | A slot nobody has filled                                  | No                              |

## The files

```
knowledge/<client>/
  source/            # raw client material. Locally excluded; never committed.
  pack/
    pack.json                  # the Account Pack sections
    knowledge.approved.json    # facts that meet all three conditions
    knowledge.draft.json       # everything else, tracked and reviewable
    evaluation-cases.json      # real customer messages, masked. Evaluation only.
    PROVENANCE.md              # which cell produced which claim, and why each exclusion
```

`source/` is excluded through `.git/info/exclude`. A client's raw workbook is their material and
does not belong in the repository.

`evaluation-cases.json` is deliberately **not** loadable by the knowledge importer. A real customer
message quoted as evidence is not a statement the brand has verified.

## Publishing

```bash
# 1. Validate offline. No database, no side effects.
node src/runtime/cli/pack.ts validate --file knowledge/<client>/pack/pack.json

# 2. Publish the pack. Content-hashed, versioned, exactly one ACTIVE per account.
node src/runtime/cli/pack.ts publish --account acc_... \
  --file knowledge/<client>/pack/pack.json --version 1 --published-by usr_...

# 3. Import the draft file. Not a no-op: a DRAFT entry is a tracked statement of what the
#    client still has to confirm, and it is what the knowledge backlog is made of.
node src/runtime/cli/knowledge.ts import --account acc_... \
  --file knowledge/<client>/pack/knowledge.draft.json

# 4. Import the approved file. This is the only doorway between "a fact someone wrote down" and
#    "a fact the AI may state".
node src/runtime/cli/knowledge.ts import --account acc_... \
  --file knowledge/<client>/pack/knowledge.approved.json --approve --approver usr_...

# 5. Confirm what the model can actually reach.
node src/runtime/cli/knowledge.ts list --account acc_...
```

A large import that produces **zero** approved entries is the expected outcome for a client whose
commercial terms are unconfirmed. It is not a failure and must not be worked around.

## Promoting a draft entry to approved

1. Ask the client the specific question, in writing. Quote what we currently believe and ask them
   to confirm, correct or decline it.
2. When they answer, move the entry from `knowledge.draft.json` to `knowledge.approved.json`,
   filling in `validUntil` for anything commercial and upgrading `dataConfidence` to
   `Verified – client`.
3. Record the promotion in `PROVENANCE.md`: the date, who confirmed it, and where the message is.
4. Re-run step 4 above with `--approve --approver <your user id>`. The importer writes an audit
   entry (`knowledge.entry_approved`) naming you.

Never edit an approved entry in place to change what it says. Add the corrected entry and let the
old one expire; the audit trail is the point.

## Arabic normalisation

Retrieval is exact tag matching, so a tag only ever matches if both sides are spelled identically.
Arabic as typed by real people is not: `أسنان` / `اسنان` / `أَسنان` are one word, and `الكرسي` and
`كرسي` are one noun with and without the definite article.

`src/platform/text/normalize-arabic.ts` folds both sides through the same function — tags when an
entry is imported, and the customer's message at retrieval time — so they cannot drift apart. Alef
forms, yeh forms, ta marbuta, tatweel, diacritics, invisible joiners and Arabic-Indic digits are
all normalised, and a token contributes both its article-bearing and its bare form.

The practical consequence for an author: **tag in the words a customer would type**, in Arabic,
including the colloquial ones. `بكام` is a better tag than `سعر`. Multi-word tags are split into
their parts, so `كرسي أسنان` is stored as two tokens and matches either.

## When the assistant cannot answer

It asks for a person (`REQUEST_HUMAN_HANDOFF`) and records a knowledge gap. Work the gap list: it
is the queue of questions customers are actually asking that the client has not yet answered, and
it is the most valuable artefact this system produces before it has any autonomy at all.
