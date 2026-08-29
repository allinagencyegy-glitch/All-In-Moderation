# Client Data Handling

Where a client's material is allowed to live, and where it is not.

## The rule

**Client business content is data. It never appears in `src/`.**

`tests/architecture/module-boundaries.test.ts` scans every file under `src/` for client
identifiers and fails the build if one appears. That is not a style preference: the runtime is
multi-tenant, and a client name in the runtime is a client-specific behaviour that would apply to
every other client on the same process. Business content belongs in an Account Pack (ADR-010),
which is versioned, approved, and swappable without a deploy.

## Where things live

| Material                                          | Location                                          | Committed | Notes                                                               |
| ------------------------------------------------- | ------------------------------------------------- | --------- | ------------------------------------------------------------------- |
| Raw client workbooks, exports, screenshots        | `knowledge/<client>/source/`                      | **No**    | Locally excluded via `.git/info/exclude`. Their material, not ours. |
| Account Pack sections                             | `knowledge/<client>/pack/pack.json`               | Yes       | Configuration we authored from their material                       |
| Approved knowledge                                | `knowledge/<client>/pack/knowledge.approved.json` | Yes       | Facts the client stated, with provenance                            |
| Draft knowledge                                   | `knowledge/<client>/pack/knowledge.draft.json`    | Yes       | The backlog of what they still have to confirm                      |
| Evaluation cases                                  | `knowledge/<client>/pack/evaluation-cases.json`   | Yes       | Real customer messages, **masked** — see below                      |
| Provenance and exclusions                         | `knowledge/<client>/pack/PROVENANCE.md`           | Yes       | Which cell produced which claim, and why each exclusion holds       |
| Customer messages, contacts, conversation content | The database only                                 | **No**    | RLS-isolated per account; never a fixture, never a log line         |
| Channel credentials                               | The secret resolver, by reference                 | **No**    | `secret://...`; a config dump cannot contain them                   |
| `ANTHROPIC_API_KEY`                               | The deploy environment, read at boot              | **No**    | Deliberately absent from `RuntimeConfig` (ADR-012)                  |

## Customer content

A customer's words are the one category with no safe committed home.

- **Never in fixtures.** `tests/support/harness.ts` is entirely synthetic, by design. The Meta
  payload corpus under `fixtures/` contains no real content and a test asserts it holds no real
  credential either.
- **Never in logs.** The shadow trace records a message's _length_, not its text, because a trace
  gets pasted into tickets.
- **Masked in evaluation cases.** A case keeps the shape of a real question — its wording, its
  ambiguity, its script — and drops every identifier: no name, no phone number, no page id, no
  profile id, no comment id, nothing that identifies which person asked. Each case names its
  source (`Comments Log C-001, 2026-08-25`) so it can be traced back through _our_ record without
  carrying the identity itself.

The reason to keep evaluation cases at all is that the assistant's failures are specific to how
these customers actually write. A synthetic corpus of polite full sentences would pass every test
and fall over on `بكام يا فندم`.

## Provenance

Every knowledge entry carries three things into the database:

- `sourceRef` — the exact cells or document location it came from.
- `evidence` — prefixed with the Data Confidence grade, as `[Verified – published] ...`.
- `approvedBy` / `approvedAt` — a named person and a time, or nulls for a draft.

Together they answer, months later, "why did the assistant say that?" — which is the question that
matters when a customer disputes what they were told.

## Deleting a client

The material is in three places, and all three must be cleared:

1. `knowledge/<client>/` in the repository, including the locally-excluded `source/`.
2. The account row in the database. `accounts` cascades to every tenant table, including
   `outbound_action_reviews`.
3. The secret bundle referenced by `credentials_ref`, in whatever store holds it.

## What we do not collect

- **No field capture.** `CAPTURE_FIELD` is denied in the first client's pack and there is no
  data-handling notice agreed with them; capturing a phone number from a message would be
  collecting personal data without a basis for it.
- **No CRM.** `CREATE_LEAD_CANDIDATE` is denied. The table exists in the schema and nothing writes
  to it.
- **No profile enrichment, no cross-account linking.** A contact identity is scoped to one account
  and one channel.
