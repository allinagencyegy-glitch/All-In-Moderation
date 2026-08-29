# ADR-012: LLM Network Egress and the Provider Adapter

- Status: Accepted
- Date: 2026-08-29
- Deciders: Lead Systems Architect

## Context

Until Phase 02C this repository had **no outbound HTTP capability at all**. Not disabled, not
feature-flagged: absent. `src/` contained no `fetch(`, no HTTP client import, and no Meta API host.
That absence is what let us tell a client whose real Facebook Page is attached that the connection
is one-way, and it was enforced by a textual scan over `src/`
(`tests/architecture/no-outbound-meta.test.ts`) repeated as its own CI step.

A moderator that calls a real model needs exactly one exception to that rule. The question is how
to grant it without the guarantee decaying from "structurally impossible" into "nobody has grepped
for the right string yet".

Two facts constrain the answer:

- **The guarantee mechanism is a textual scan over `src/`.** Anything that moves the socket out of
  `src/` moves it out of the scan's sight, and the existing assertions would keep passing while
  egress quietly existed.
- **`ADR-007` already forbids vendor shapes crossing the `LlmProvider` port.** Whatever is added
  must not leak an SDK type, a content block, or a model name into any module that makes a
  decision.

## Decision

**One adapter file, `src/integrations/llm/anthropic-provider.ts`, is allowlisted for network
egress. It may name one host. Nothing else in `src/` may open a socket, and no module that makes a
decision may import it.**

This is a _narrowing_ of the previous blanket ban, not a relaxation of it. The rule changes from
"zero files may open a socket" to "one file, by name, to one host, unreachable from the pipeline",
and it is enforced positively as well as negatively.

### The four clauses, each asserted

1. `fetch(` may appear in the allowlisted file and in **no other file** under `src/`.
2. The allowlisted file **must** contain the call, and it names exactly one host,
   `api.anthropic.com`. Without the first half every other assertion passes vacuously.
3. The **Meta host ban stays global and unconditional** — no allowlist, no exception, the egress
   adapter least of all.
4. No module in `moderation/`, `knowledge/`, `policy/`, `core/`, `operations/` or `platform/` may
   so much as mention the adapter. The capability is granted to the composition root; `moderation/`
   receives an `LlmProvider` through its ports and cannot tell — or reach — which one it got.

`tests/architecture/llm-egress.test.ts` asserts all four, plus that `LLM_PROVIDER` still defaults
to `mock` and that an unrecognised value is refused at boot rather than falling back to anything.
The same four are repeated as a standalone CI step, because this is the claim a client with a real
Page attached is relying on and it should fail its own named step rather than one line in a long
log.

### Raw `fetch`, not the vendor SDK

This deviates from the usual default of using `@anthropic-ai/sdk`, deliberately.

An SDK would put the socket in `node_modules`, where the scan cannot see it. Every assertion above
would still pass, and the guarantee would be worth nothing. Keeping the call visible in `src/` is
what keeps the rule that polices it honest. It also holds the runtime dependency list at `pg`
alone.

The cost is that we own the wire format for one endpoint. That cost is small and bounded because
the request is deliberately minimal: one POST, no tools, no streaming, no files, no batching.

### What the request contains, and what it must not

`model`, `max_tokens`, a `system` array whose single text block carries `cache_control:
{type:'ephemeral'}`, and `messages`. Plus `output_config.format` as a `json_schema` constraint when
structured output is on.

Three omissions, each of which is a 400 on current models rather than a preference:

- **No `temperature`.** `LlmRequest` carries one because the port predates the models that removed
  sampling parameters. It is dropped in the adapter rather than in the port, so an older model
  behind the same interface would still work.
- **No `thinking.budget_tokens`.** Adaptive thinking is the default and an explicit budget is
  rejected. Thinking is also not _disabled_: disabling it can leak reasoning text into the visible
  response, which for a JSON-only contract means schema failures.
- **No assistant prefill.** Also rejected — which is why `structured.ts`'s repair turn is a user
  turn.

And two absences that are safety properties rather than API facts:

- **No tools, ever.** The model is given no callable surface. "The model cannot reach our database"
  is a fact about the request body, not a policy someone has to keep enforcing.
- **No streaming.** There is no partial-output path, so there is no way for half a decision to
  reach the pipeline.

### Structured output is an optimisation, never the validation

`platform/llm/structured.ts` re-validates every response against our own schema regardless
(ADR-007). `LLM_STRUCTURED_OUTPUT=off` drops the vendor constraint and the pipeline keeps working,
one repair turn more often. A vendor's guarantee is not our guarantee.

### The credential

`ANTHROPIC_API_KEY` is read at the boot edge (`runtime/main.ts`, `runtime/cli/context.ts`) and
handed to the adapter. It is deliberately **not** a field on `RuntimeConfig`: a config dump cannot
contain it, and no domain code can reach it. With `LLM_PROVIDER=anthropic` and no key, the process
refuses to start with `LLM_API_KEY_MISSING` rather than silently falling back to the mock.

### The failure taxonomy

The split decides whether the job queue retries, so it is part of the design rather than an
implementation detail:

| Status                    | Error                                     | Why                                                       |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| 401, 403                  | `TerminalError LLM_UNAUTHORIZED`          | Retrying cannot mint a valid key                          |
| 400, 404, 413, 422        | `TerminalError LLM_REQUEST_REJECTED`      | An identical body will be rejected identically            |
| 408, 409, 429, 5xx        | `TransientError LLM_PROVIDER_UNAVAILABLE` | The next attempt may well succeed                         |
| anything else             | `TransientError LLM_UNEXPECTED_STATUS`    | Guessing on an unknown status is worse than retrying once |
| socket / DNS / abort      | `TransientError LLM_TRANSPORT_FAILED`     | Same                                                      |
| 200 with unparseable body | `TransientError LLM_RESPONSE_UNPARSEABLE` | Never an empty decision                                   |
| `stop_reason: 'refusal'`  | `FinishReason 'REFUSAL'`                  | Retryable, and never mistaken for an empty answer         |

Every one of these ends, on retry exhaustion, in a human handoff (F-05, F-20). None of them
produces a partial or guessed reply.

### Testability

The HTTP boundary is an injectable `HttpTransport`. The unit suite exercises the whole request
body, every status mapping and every stop reason with **no network**. A provider adapter whose
failure modes can only be reproduced by making real paid calls is one whose failure modes are
never tested.

## Options considered

| Option                                            | Verdict                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **One allowlisted file on raw `fetch` (chosen)**  | The socket stays where the scan can see it; the rule that polices egress remains checkable                        |
| `@anthropic-ai/sdk`                               | Moves the socket into `node_modules`; the existing assertions keep passing while egress exists unobserved         |
| Drop the no-outbound assertion and rely on review | Discards the only mechanical guarantee behind the receive-only promise                                            |
| A generic HTTP client module used by the adapter  | Re-introduces a reusable egress capability; the next caller would not need a new exception                        |
| A sidecar / proxy process for all egress          | Real isolation, and a second deployable, a second failure mode and a network hop for one endpoint. Revisit later. |
| Allow the adapter to use tools or streaming       | Both hand the model a capability the architecture spends its whole design refusing to grant it                    |

## Consequences

### Positive

- A real model can be used with the receive-only promise intact and mechanically enforced.
- The one place egress exists is the one place anyone has to read to audit it.
- `mock` remains the default, so no test or CI run can reach a paid API or leak content.
- The provider is swappable: another adapter plus a config entry, with no domain change.

### Negative / accepted cost

- We own the Anthropic wire format for one endpoint, including its drift. The unit suite pins the
  body shape so drift fails loudly rather than at 400-per-request in production.
- No SDK conveniences: no automatic retries, no token counting helper, no batching. The queue
  already owns retry policy, which is where it belongs.
- The allowlist is a name in two places (the architecture test and the CI step). A rename must
  update both — and the test asserts the named file exists, so a stale allowlist fails.

## Revisit trigger

- A second egress destination is genuinely needed (then the sidecar option becomes the right one;
  a second allowlist entry is not).
- The Messages API changes in a way the pinned body cannot express, or an SDK-only capability
  becomes necessary (then re-run this decision explicitly, with the scan replaced by something
  that can see into `node_modules` — not merely deleted).
- An outbound _delivery_ transport is ever authorised. That is a different decision and must not
  reuse this exception.
