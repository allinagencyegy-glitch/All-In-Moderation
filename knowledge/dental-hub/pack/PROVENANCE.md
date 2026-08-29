# Dental Hub pack — provenance

Every fact in this directory traces to a cell in
`../source/Dental_Hub_Performance_and_Moderation_Audit.xlsx` (2026-08-26, Africa/Cairo,
13 sheets, Arabic). **The workbook itself is not committed** — it is excluded through
`.git/info/exclude`, because it carries a real client's Page ID, Business ID, operational-weakness
inventory and performance figures. What is committed is the derived, reviewed artefact.

The workbook grades its own rows on a five-level `Data_Confidence` scale
(`بيانات مؤكدة` confirmed · `بيانات محسوبة` calculated · `استنتاج تحليلي` inferred ·
`بيانات غير متاحة` unavailable · `تحتاج Export أو صلاحية إضافية` needs export/permission).
That grading is carried through to every entry here and is the rule that decides APPROVED
versus DRAFT.

## The approval rule

An entry may be `APPROVED` only if **all three** hold:

1. It is directly evidenced by a cited cell.
2. Its `Data_Confidence` is `بيانات مؤكدة`.
3. It contains no commercial term — price, discount, warranty duration, instalment condition,
   delivery date, response-time commitment — that Dental Hub has not confirmed in writing.

Rule 3 is why `knowledge.approved.json` has four entries and `knowledge.draft.json` has nine.
That ratio is the correct outcome of an audit that found no published prices, no documented SLA
and no visible warranty terms. It is not a gap in the extraction.

## Section sources

The same mapping is carried inside the pack itself, at `sections.evidence_log.section_sources`,
so a published pack answers "where did this come from" without this file. It lives there rather
than on each section because `brand_voice`, `intent_taxonomy`, `routing`, `authority_matrix` and
`escalation` have strict schemas that reject unknown properties — an unrecognised key in a section
is an instruction the moderator would silently ignore, and the schema refuses one rather than
dropping it.

| Pack section                | Source                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `profile`                   | Executive Dashboard; Audit Scope & Limitations                                                            |
| `brand_voice.must_not_say`  | Reply Library column G (`ما يجب تجنبه`) across RL-01…RL-20, plus the placeholder rule at Reply Library r2 |
| `intent_taxonomy`           | Taxonomy & Lists column A (`Comment_Category`), 17 values, r5:r21                                         |
| `routing.intent_routes`     | Reply Library column H (`Owner`) mapped to Taxonomy & Lists column Q (`Owner_Role`)                       |
| `authority_matrix`          | Not from the workbook. Audit posture: no autonomous authority anywhere                                    |
| `escalation.handoff_sla_ms` | SLA Tracker §A r11 — complaint first reply, 1 business hour (the tightest proposed target)                |
| `public_comment_rules`      | Reply Library RL-11, RL-12, RL-16, RL-18                                                                  |
| `sla`                       | SLA Tracker §A r6:r13 — marked `PROPOSED`, never a commitment                                             |
| `qualification`             | Reply Library RL-02, RL-08, RL-16; Taxonomy & Lists columns F, G, H                                       |
| `data_collection`           | Reply Library RL-16                                                                                       |
| `products.categories`       | Taxonomy & Lists column H (`Product_Category`), 11 values                                                 |
| `evidence_log`              | Audit Scope & Limitations (sheet 13); Data Dictionary (sheet 12)                                          |
| `evaluation_cases`          | Comments Log C-001…C-006 + two synthetic cases                                                            |

## APPROVED entries

| Key                           | Kind    | Source                                       | Why it clears the rule                                                                                                                          |
| ----------------------------- | ------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `contact-whatsapp`            | FAQ     | Reply Library r2                             | The number is published by Dental Hub on their own page. The audit states explicitly that it did not supply or invent it. Not a commercial term |
| `product-roson-r2-pro`        | PRODUCT | Post caption                                 | Existence of the product line only. The caption's own exclusivity and best-selling claims are stripped out and held as DRAFT                    |
| `product-fomos-autoclave`     | PRODUCT | Meta Ad Library, active ad since 2026-08-11  | Existence only. The "خصم 20 الف" is stripped out and held as DRAFT                                                                              |
| `product-full-clinic-package` | PRODUCT | Clinic-package post; Product Demand evidence | Existence of the service only. RL-08's price range is two placeholders                                                                          |

## What is deliberately excluded, and why

Held as DRAFT (invisible to the model — the Knowledge Gate filters to `APPROVED` before
retrieval):

- **Every bracketed placeholder in RL-01…RL-20** — roughly 40 of them: `[السعر]`, `[المدة]`,
  `[النسبة]%`, `[جهة التمويل]`, `[القسط]`, `[عدد] شهور`, `[ما يشمله]`, `[المسؤول]`, `[الاسم]`,
  `[الرقم]`, `[التاريخ]`.
- **RL-04's opening `أيوه فيه`** — an affirmative assertion that instalments exist. The audit
  found no evidence they are offered at all.
- **RL-07's delivery claims** — nationwide coverage, free installation and training.
- **RL-05/RL-06 warranty and maintenance terms** — duration, coverage, response time,
  genuine-spare-parts and annual-contract claims.
- **The Roson exclusivity and best-selling claims** — confirmed as things the _client said_,
  not as things that are _true_. Both are legally substantiable statements in Egypt.
- **The Fomos 20,000 discount** — an `OFFER` whose ad carries no end date.
  `knowledge_commercial_requires_expiry` (migration 0004) refuses an approved OFFER without
  `valid_until`. That constraint is honoured, not worked around.
- **The proposed SLA targets** — the sheet states Dental Hub has no documented SLA.
- **Business hours** — the SLA sheet's measurement windows, not published hours.

Never entered as knowledge at all:

- **The six drafted "Suggested Reply" texts** in Comments Log column P. Never published, and they
  imply price availability. They are evaluation _inputs_ only.
- **Every zero** in Messages Log, Lead Pipeline, SLA §B and Product Demand columns B/C. These are
  `COUNTIF` over an empty range. Zero here means _not measured_, never _none occurred_ — no
  conversation was ever opened during the audit.
- **`Unanswered Rate = 100%`** — denominator 6, drawn from a "needs attention" list, so biased by
  construction. The Data Dictionary marks it `لا تُعمَّم` (do not generalise).
- **Every back-calculated previous-period figure** in Monthly Summary.
- **Content Score, Hook Strength, Offer Clarity, CTA Clarity, Purchase-Intent labels** — reviewer
  judgement at n=5 and n=6.
- **Any inference about photo or carousel formats** — the five fully-recorded posts are all Reels
  from a single week.
- **Any coverage percentage** — the denominator is unknown (Audit Scope r22).
- **Any personal data.** The Comments Log uses `Customer-00N` aliases and masked excerpts;
  the Messages Log is empty. Nothing here reintroduces a real name, handle or customer number.

## Promotion procedure

```
node src/runtime/cli/knowledge.ts import \
  --account acc_... --file knowledge/dental-hub/pack/knowledge.approved.json --approve --approver usr_...
```

`--approve` is refused for a `PRICE` or `OFFER` entry with no `validUntil`, and the database
enforces the same rule independently. Promoting a DRAFT entry means moving it into
`knowledge.approved.json` with a cited written confirmation from Dental Hub recorded in its
`evidence` field — never by editing a flag.
