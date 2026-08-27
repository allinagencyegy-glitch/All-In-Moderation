# ADR-007: AI Provider Abstraction and Structured Output

- Status: Accepted
- Date: 2026-08-27
- Deciders: Lead Systems Architect

## Context

We have usable Anthropic credits today, but the runtime must not depend on one vendor. Different
operations will eventually want different models (a cheap classifier, a strong reasoner, vision,
audio transcription). At the same time, the requirement is explicit that the LLM **is not the
control plane**: it may propose, it may not authorise.

The premature-abstraction trap here is real. A model router with cost optimisation, fallback
chains, and A/B routing is a product in itself. What we need now is a _boundary_, not a router.

## Decision

**A narrow `LlmProvider` port that speaks our types, with model selection by operation role, and
structured output validated by our own schema — never by a vendor feature.**

### The port

```ts
interface LlmProvider {
  readonly id: string; // 'anthropic' | 'openai' | 'mock'
  readonly capabilities: ProviderCapabilities;
  complete(request: LlmRequest, opts: LlmCallOptions): Promise<LlmResponse>;
}
```

`LlmRequest` carries a system prompt, an ordered list of neutral `{ role, content }` turns, an
optional `responseSchema`, and generation parameters. `LlmResponse` carries the raw text, usage
counters, the resolved model id, latency, and a `finishReason`. Nothing vendor-shaped crosses
this line: no Anthropic content blocks, no OpenAI tool-call objects, no provider SDK types in any
signature.

Deliberately **absent** from the port:

- **Tools / function calling.** The model gets no callable surface. Every effect the platform
  performs is chosen by application code from the model's _declarative proposal_. This is the
  single most important thing about this design: it is not a policy that the model has no
  database access, it is a fact about the interface. Tool use may be reintroduced later only for
  _read-only, account-scoped retrieval_, and would still return proposals, never effects.
- **Streaming.** Not needed for moderation; adds partial-output failure modes. Add when an
  operator-facing feature needs it.
- **Conversation memory held by the provider.** All context is assembled by us, per run, from our
  database, so runs are reproducible and auditable.

### Model selection by role

Operations name a **role**, not a model:

| Role         | Intended use                                    |
| ------------ | ----------------------------------------------- |
| `CLASSIFY`   | Cheap, high-volume intent and routing decisions |
| `REASON`     | The main moderator decision                     |
| `VISION`     | Image understanding (Phase 3)                   |
| `TRANSCRIBE` | Voice notes (Phase 3)                           |

Roles resolve to `(provider, model, params)` through configuration: platform defaults, overridden
per account in the Account Pack. Nothing in the domain names a model. Swapping vendors is a
configuration change; adding a vendor is one adapter plus one config entry.

This is intentionally _not_ a router. There is no automatic cost optimisation and no fallback
chain in Phase 0. A **provider-level fallback** (try secondary provider on a 5xx or timeout) is
pre-designed as a decorator over the port and switched on per role when we have real reliability
data. Model _quality_ fallback ("cheap model first, escalate if unsure") is explicitly rejected
for now: it doubles the evaluation surface for a saving we cannot yet measure.

### Structured output, defensively

Structured output is _our_ mechanism:

1. We define the decision schema in our own tiny schema DSL (`platform/schema.ts`), which emits
   JSON Schema for the prompt and validates the parsed response.
2. The provider adapter may use a native structured-output feature if it has one, but the result
   is **always** re-validated by us. Vendor guarantees are treated as an optimisation, never as a
   contract.
3. Parsing is tolerant of common model artefacts (fenced code blocks, leading prose) and strict
   about content: unknown fields are rejected, not ignored, because a plausible-looking unknown
   field usually means the model has invented a capability.
4. On validation failure: **one** repair attempt with the validation errors fed back, at a lower
   temperature. On second failure the run fails with a retryable error, is retried by the queue
   with backoff, and on exhaustion escalates to a human. We never accept partially valid output,
   and we never "fix it up" with heuristics.

### Reliability wrapper (applies to every provider)

- Hard timeout per call (default 20s), enforced by `AbortSignal`, with the deadline propagated
  from the job lease so a call cannot outlive its lease.
- Retry only on retryable classes (timeout, 429, 5xx) with exponential backoff and full jitter,
  bounded by attempts _and_ by a total time budget.
- Circuit breaker per `(provider, role)`: repeated failures open the circuit and calls fail fast,
  so a provider outage degrades to human handoff in seconds rather than after a queue of timeouts.
- Every call records `provider`, `model`, tokens in/out, latency, cost estimate, `finishReason`,
  and a hash of the prompt, linked to the `moderator_run`. Cost and quality are therefore
  attributable per account, per role, per model.

### Prompt and context assembly

Prompt assembly lives in `moderation/`, not in the provider adapter — the adapter must stay
ignorant of what we are asking. Every run pins `pack_version_id` and `prompt_template_version`,
so any historical decision can be explained with the exact configuration that produced it.

### Determinism for tests

`MockLlmProvider` is a first-class part of the architecture, not test scaffolding: scriptable
responses, injectable latency, injectable malformed output, and injectable timeouts. Every
failure mode in the register that involves the model is reproduced through it, with no network.

## Options considered

| Option                                          | Verdict                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Narrow port + role-based selection (chosen)** | Vendor-swappable, testable, keeps the model out of the control plane                                                        |
| Direct SDK calls in application code            | Fastest to write, impossible to swap, untestable without network                                                            |
| LangChain / framework abstraction               | A large dependency whose abstractions (agents, tools, memory) are exactly the control-plane powers we are refusing to grant |
| Full model router now (cost/quality/fallback)   | Premature; a product of its own; doubles evaluation surface                                                                 |
| Vendor-native structured output as the contract | Vendor lock-in through the back door, and it still needs our validation, so it buys nothing                                 |

## Consequences

### Positive

- Provider substitution is an adapter plus a config entry.
- The model literally cannot perform an effect: there is no mechanism through which it could.
- Model behaviour is reproducible in tests without a network.

### Negative / accepted cost

- We hand-roll structured output rather than using vendor conveniences. Small cost, large control.
- No automatic quality fallback; a degraded provider means human handoff. Deliberate: a silently
  weaker answer to a customer is worse than a human answering.
- Our schema DSL is code we own. Kept small (one file, fully tested) and replaceable by Zod plus a
  JSON Schema emitter if it ever grows.

## Enforcement

- The module boundary test forbids any `moderation/` file from importing a provider SDK.
- The decision schema is validated in `runModerator` before policy evaluation; there is no path
  from raw model text to an `OutboundAction`.
- `tests/unit/llm-malformed.test.ts` and `tests/unit/llm-timeout.test.ts` cover repair, retry,
  exhaustion, and escalation.

## Revisit trigger

- Two or more providers are in steady production use and per-call routing decisions start being
  made by hand — then build the router.
- A vendor ships a genuinely differentiating capability (e.g. server-side retrieval over our
  corpus) that cannot be expressed through this port.
- Multimodal traffic arrives, requiring `VISION`/`TRANSCRIBE` roles to become real.
