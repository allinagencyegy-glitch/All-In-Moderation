# Handoff — Phase 02B: Meta receive-only transport

**Branch:** `phase-02b/meta-receive-only` · **Not merged.**

Phase 02A built a webhook endpoint and a parser for one shape of one channel. Phase 02B makes that
endpoint able to receive **real** Facebook, Instagram and WhatsApp traffic, in shadow mode: events
arrive, are verified, stored, normalised and reasoned about, and produce nothing but a simulated
decision.

---

## The one-paragraph answer

Everything on the software side is built and proved. No live Meta credential has been used, no real
connection has been attached, and no customer-facing message has been sent or could be — there is
no outbound HTTP client in `src/` at all. What remains is entirely operator work: create a Meta app,
expose a public HTTPS callback, complete the subscription handshake, and subscribe a Page / IG
account / WABA. That work is written out step by step in
[`META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md`](./META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md).

---

## 1. What is implemented

| Channel            | Surface                                             | Transport                              | Status                                                   |
| ------------------ | --------------------------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| Facebook Messenger | Direct messages                                     | `entry[].messaging[]`                  | Implemented, proved offline                              |
| Facebook Page      | Public comments                                     | `entry[].changes[]`, `field: feed`     | Implemented, proved offline                              |
| Instagram Direct   | Direct messages                                     | `entry[].messaging[]`                  | Implemented, proved offline                              |
| Instagram          | Comments, live comments                             | `entry[].changes[]`, `field: comments` | Implemented, proved offline                              |
| Instagram          | Mentions                                            | `field: mentions`                      | Recorded, deliberately **not** treated as a conversation |
| WhatsApp Cloud API | Inbound messages                                    | `entry[].changes[]`, `field: messages` | Implemented, proved offline                              |
| WhatsApp           | Delivery statuses, account updates, provider errors | same `value` object                    | Recorded, never a customer turn                          |

Every parser is a total function over an unknown payload: no I/O, no decisions, no throwing on any
input. That is what allows the entire ingest path to be replayed offline, and it is what the
shadow-acceptance self-test exploits.

### What Phase 02A would have got wrong

Worth recording, because both were silent failures rather than errors:

- **Every real Instagram comment would have been dropped.** The single parser required
  `value.item === 'comment'` and `value.verb === 'add'`. Instagram sends neither, and names the
  comment `id` rather than `comment_id`. The event would have been classified as an unsupported
  change and ignored, with no alert.
- **WhatsApp could not be parsed at all.** No `messaging` array, no `sender`/`recipient` objects,
  no `mid`, and a timestamp that is a string of seconds rather than a number of milliseconds.

A third defect was found by the new fixture corpus during this phase: Meta sends `sticker_id` as a
JSON **number**, and the parser read it as a string. Every sticker was being filed as an ordinary
photo. Fixed in `src/integrations/meta/messaging.ts`.

---

## 2. The transport layer

`db/migrations/0008_meta_transport.sql`.

A connection is no longer one string. It carries a provider, a set of **typed** provider identities,
the surfaces the client has actually enabled (distinct from the surfaces the channel can carry),
its capabilities, its subscription state, and a `transport_mode`.

**The identity model is the load-bearing part**, and it exists for one hazard. A WhatsApp delivery
names the _business account_ in `entry.id` and the routable _phone number id_ in `value.metadata`.
One WABA can carry many numbers belonging to different clients under one partner app. Routing on
`entry.id` would deliver one client's messages into another client's account — the single most
expensive bug available in this system.

So:

- Items carry a typed `routing: { kind, externalId }`, matched against the connection's identity set
  on **kind and id**, not on id alone.
- `channel_connection_identities` has a **platform-wide primary key** on `(provider, kind,
external_id)`. Two accounts cannot both claim the same page, IG account, WABA or phone number,
  because the second `INSERT` fails. This is enforced by the database, not by application code.
- An item whose routing identity no connection owns is refused, classified `UNROUTABLE_IDENTITY`,
  counted, and recorded on the ledger row. It is never resolved in favour of the URL — the URL
  proves the tenant, the identity proves the surface, and the payload is the half an attacker
  controls.

`transport_mode` defaults to `RECEIVE_ONLY`, is the only value provisioning writes, and a CHECK
constraint refuses a `RECEIVE_ONLY` row that holds any send capability.

---

## 3. Nothing is silently discarded

Objective 7. Phase 02A's parser returned actionable items plus a count of everything else, which
made an echo, a delivery receipt and an unrecognised event indistinguishable downstream — all three
were "1 ignored", and those need three different people.

Now every item the parser sees is returned, each carrying one of 27 named classifications, and the
verdict is written to the ledger row as `raw_inbound_events.normalization`:

```json
{
  "parsedItems": 2,
  "createdMessages": 0,
  "duplicateItems": 0,
  "unroutableItems": 0,
  "surfaceDisabledItems": 0,
  "byClassification": { "RECEIPT_DELIVERY": 1, "RECEIPT_READ": 1 },
  "issues": []
}
```

Counts and classification names only — no text, no identifiers. This column is read by dashboards
and pasted into tickets.

Four gates stand between an item and a conversation, each with a specific failure mode it prevents:

1. **Actionable** — echoes, receipts and unrecognised shapes are recorded, never turned into a turn.
2. **Routable** — the misrouting gate above.
3. **Not our own voice** — Meta's `is_echo` covers the messaging transport. Nothing covers a Page
   replying to its own comment, which is redelivered through the same webhook; without this gate the
   moderator would answer itself, in public, forever.
4. **On an enabled surface** — the channel supports it, the client enabled it, and the connection
   holds the receive capability.

---

## 4. Receive-only, and why it is not a flag

Two independent brakes, either one sufficient:

- `OUTBOUND_MODE` is process-wide and still refuses `LIVE` at boot.
- `transport_mode` is per connection, so one client can be shadowed without arming every tenant.
  `run-moderator` loads the conversation's connection and forces `simulate` when it is
  receive-only — **or when the connection cannot be found**, because "I could not find it" is not a
  licence to send.

Neither is the real guarantee. The real guarantee is that the capability does not exist:

- No Meta API base URL appears anywhere in `src/`.
- No `fetch`, `undici`, `axios`, `http.request` or any other client construct appears in `src/`.
  `node:http` is used to _serve_, never to call.
- No page, Instagram or WhatsApp access token is stored, requested, or has a field to live in.
- `outbound.dispatch` is deliberately absent from the worker's handler map.

`tests/architecture/no-outbound-meta.test.ts` asserts all of this by scanning the source, with
comments stripped so the prose explaining _why_ a call is not made does not trip its own tripwire.
CI repeats it as a named step. **A future phase that adds live sending has to delete assertions from
that file, and deleting an assertion is a reviewable act with a name on it.**

---

## 5. What was tested, and how

**452 tests pass. 0 fail. 0 skipped.** (Phase 02A closed at 332.)

### Fixture corpus — `fixtures/meta/`

34 canonical payloads in the shapes the official documentation specifies, plus a manifest. Each
file carries its own expectation: item count, actionable count, issue count, and the full
classification histogram. Coverage:

| Category              | Fixtures                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facebook Messenger    | text, attachment, sticker, reply + ad referral, echo, delivery/read receipts, postback                                                                                                          |
| Facebook comments     | top-level, nested reply, self-echo, edit, remove, non-comment feed activity                                                                                                                     |
| Instagram DMs         | text, story reply, unsend, standby (handover)                                                                                                                                                   |
| Instagram comments    | comment, self-echo reply, mention                                                                                                                                                               |
| WhatsApp              | text, media with caption, reply + CTWA referral, interactive list reply, statuses (sent/delivered/read), unsupported + unknown type, account update, provider errors, missing `phone_number_id` |
| Malformed / unknown   | missing sender, unknown envelope object, unknown change field, empty entry list                                                                                                                 |
| Duplicates / batching | same mid twice in one envelope, multi-entry batch                                                                                                                                               |

The corpus lives at the repository root rather than under `tests/` deliberately: `src/` may not
import from `tests/`, and two copies of "what Meta sends" would drift — leaving the offline proof
and the live proof quietly checking different things.

### Test suites added

| Suite                                                    | What it proves                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/meta-payload-contract.test.ts` (49 tests)    | Every fixture parses to its committed verdict, plus the details a histogram cannot express: WhatsApp routes on the phone number not the WABA; a story reply is distinguishable from a message reply; both referral shapes normalise to one; a WhatsApp media id survives; a top-level comment is not a reply to itself; three statuses of one message get three keys. Also totality against mutilated payloads. |
| `tests/integration/meta-receive-only.test.ts` (39 tests) | Every hazard in objective 19 — see the table below.                                                                                                                                                                                                                                                                                                                                                             |
| `tests/architecture/no-outbound-meta.test.ts` (6 tests)  | The negative proof in §4.                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/integration/shadow-acceptance.test.ts` (6 tests)  | The acceptance tool, run as a subprocess, asserting its exit code.                                                                                                                                                                                                                                                                                                                                              |
| `tests/postgres/meta-transport.test.ts` (12 tests)       | The claims the _schema_ makes: identity uniqueness is a primary key; receive-only-without-send is a CHECK constraint; `normalization` and `provider_context` round-trip; RLS isolates identities.                                                                                                                                                                                                               |

### Objective 19, hazard by hazard

| Hazard                                  | Proved by                                                                                                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant misrouting                       | A WhatsApp delivery for another client's number on a shared WABA is refused and recorded as `UNROUTABLE_IDENTITY`; a Facebook delivery for an unowned page likewise                                                                                |
| One client's event in another's account | Platform-wide identity primary key; a second account claiming the same page is refused with `CONNECTION_IDENTITY_CONFLICT` — asserted on both adapters and against the constraint itself                                                           |
| Signature bypass                        | A body altered by one byte after signing is rejected and stored as evidence; a rejected event refuses to normalise even if a job is forced; an unresolvable secret rejects rather than accepts; an unconfigured verify token refuses the handshake |
| Webhook replay                          | A byte-identical redelivery writes no second ledger row                                                                                                                                                                                            |
| Duplicate events                        | A re-batched redelivery writes a second ledger row but no second message; two copies inside one envelope produce one message                                                                                                                       |
| Event ordering                          | Arrival order becomes message sequence; WhatsApp string-seconds is read as an instant, not stamped with receipt time                                                                                                                               |
| Echo loops                              | Messenger echo, Instagram comment self-reply, and a page posting under a second owned identity — all three refused, all three classified                                                                                                           |
| Unsupported payload loss                | Every unsupported variant lands with a named classification and a terminal state; an unknown envelope object is recorded without inventing a channel; a disabled surface is refused and says so                                                    |
| Token leakage                           | No log line contains the app secret, the verify token or the webhook id; no credential is on the connection row; `authorization` and `cookie` headers are stripped from the ledger                                                                 |
| Raw PII in logs                         | No customer message body or commenter name reaches a log; `/health/status` carries no identifier of any kind                                                                                                                                       |
| Accidental outbound Meta call           | On a process with `OUTBOUND_MODE=LIVE`, a receive-only connection still produces only `SIMULATED` actions — and the test first asserts that actions _were_ produced, so it is not vacuously true                                                   |

The last row is the one to read twice. Several assertions of the form "nothing bad happened" are
worthless unless something happened at all; each of them is paired with a positive assertion.

---

## 6. What is proved only locally

Everything. There is no exception to this in Phase 02B.

Specifically, the following are proved against **synthetic payloads and a local (embedded)
PostgreSQL**, never against Meta:

- Envelope parsing for all five channel/surface combinations.
- HMAC verification over exact raw bytes.
- The subscription challenge handshake (a real Meta `GET` was never received).
- Persist-first ordering, delivery- and item-level dedupe, normalisation, conversation state, the
  coalesced moderator run, and the simulated decision.
- Every tenancy and safety property in §5.

**What has NOT been proved:** that Meta's live payloads match the documented shapes in every case,
that our callback URL is reachable from Meta's infrastructure, that the subscription handshake
succeeds against the real service, or that field subscriptions deliver what the documentation says
they deliver. Those require a real connection. The parsers are written to be total precisely so
that being wrong about one of them produces a recorded `UNKNOWN_*` classification rather than a
crash or a silent drop.

---

## 7. What is proved against real Meta

**Nothing.** No live Meta credential was used at any point in this phase. No Meta app was created,
no access token was requested or stored, no callback URL was registered, and no webhook from Meta
has ever reached this system.

---

## 8. What still requires operator action

The full procedure is [`META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md`](./META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md).
In brief, and in order:

1. Confirm the four statements in §0 of the checklist — in particular that the account is a test
   account or one the client has explicitly authorised.
2. Create a Meta **Business** app; add Messenger / Instagram / WhatsApp as needed. Keep it in
   Development mode for the first connection.
3. Deploy this service behind a **public HTTPS URL** with a valid certificate.
4. Generate a verify token, and put it with the app secret in `WEBHOOK_SECRETS` under a
   `secret://` reference.
5. Run the migrations — `node src/runtime/cli/migrate.ts` as `app_migrator`. `0008` must apply.
6. `meta-connection provision …` — this prints the webhook path. **For WhatsApp, `--external-id`
   is the phone number id, not the WABA.**
7. Paste the callback URL and verify token into the Meta app; click Verify and Save.
8. Subscribe the webhook fields, then subscribe the specific Page / IG account / WABA.
9. Send one message and run `meta-connection status` and `shadow-acceptance`.

**The exact next manual action is step 2**: create the Meta app. Nothing before it is blocked, and
nothing after it can be done without it.

---

## 9. Answers to the questions this handoff must answer

| Question                                           | Answer                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Was any live Meta credential used?                 | **No.** None was requested, obtained, stored or committed.                                                                                                                      |
| Does outbound remain disabled?                     | **Yes** — and stronger than disabled: the capability does not exist. No HTTP client, no API host, no token, no dispatch handler. `OUTBOUND_MODE=LIVE` is still refused at boot. |
| Was any customer-facing message sent?              | **No.** Every outbound action in every test and in the demo is `SIMULATED`.                                                                                                     |
| Was a real LLM connected?                          | **No.** `mock` only.                                                                                                                                                            |
| Were any Dental Hub-specific business rules added? | **No.** The forbidden-identifier check still passes; all fixtures are synthetic.                                                                                                |
| Was any CI gate weakened?                          | **No.** `MIN_TESTS` rose 332 → 445, one Postgres suite was added to the required list, and two new gates were added. Nothing was removed or relaxed.                            |
| Was anything merged?                               | **No.**                                                                                                                                                                         |

---

## 10. Readiness for the first real shadow connection

**Ready, pending operator setup.** The software side is complete and proved offline; the remaining
work is the checklist, and it is all outside this repository.

What an operator should expect on the first connection, in order of likelihood:

1. **The handshake fails.** Almost always the URL is not publicly reachable, or `WEBHOOK_SECRETS`
   was not exported into the running process. Checklist §7 lists the four causes in order.
2. **Verification succeeds but nothing arrives.** Fields were subscribed but the Page / IG account /
   WABA itself was not. Checklist §8.
3. **Events arrive and `unroutableItems` climbs.** For WhatsApp this is near-certain if the WABA was
   provisioned as the primary external id instead of the phone number id. This is the _safe_
   failure — nothing is misrouted, nothing is acted on — but it is a failure and the CLI names it.
4. **Events arrive and produce `UNKNOWN_*` classifications.** Meta sent a shape the parser does not
   know. Nothing is lost: the verbatim payload is on the ledger row and the classification names the
   layer that failed. Add a fixture, extend the parser, and the corpus test locks it in.

What cannot happen, whatever goes wrong: a reply, a comment, a reaction, a hide, a delete, or any
other call to Meta. There is no code that does it.

---

## 11. File map

```
db/migrations/0008_meta_transport.sql        transport columns, identity table, ledger verdict, provenance
fixtures/meta/                               34 canonical payloads + manifest

src/moderation/domain/provider.ts            provider types, identity kinds, capabilities, transport modes
src/moderation/domain/channel.ts             identity ownership, echo check, surface gating, validation
src/moderation/domain/inbound.ts             27 classifications, reply context, referral, parse result
src/moderation/domain/raw-event.ts           NormalizationSummary on the ledger row

src/integrations/meta/payload.ts             total accessors, the single item constructor, referral shapes
src/integrations/meta/messaging.ts           Messenger + Instagram Direct — echo checked before content
src/integrations/meta/comments.ts            Facebook feed vs Instagram comments, two different payloads
src/integrations/meta/whatsapp.ts            Cloud API; routes on phone_number_id, fails closed without it
src/integrations/meta/webhook-parser.ts      the envelope dispatcher

src/moderation/application/normalize-event.ts   the four gates
src/moderation/application/run-moderator.ts     receive-only forces SIMULATED
src/operations/metrics.ts                       closed-vocabulary transport counters

src/runtime/admin/provision.ts               receive-only provisioning; refuses unresolvable secrets
src/runtime/admin/receive-status.ts          per-connection receive status, behind a tenant scope
src/runtime/admin/shadow-trace.ts            one delivery, followed end to end, with a verdict
src/runtime/cli/migrate.ts                   apply the schema, as app_migrator
src/runtime/cli/meta-connection.ts           provision / show / status
src/runtime/cli/shadow-acceptance.ts         --self-test offline, or trace a real connection
src/runtime/cli/fixtures.ts                  the corpus loader, shared by tests and the tool

docs/META-RECEIVE-ONLY-OPERATOR-CHECKLIST.md the boundary this phase stops at
```

---

## 12. Known gaps, stated plainly

- **`WEBHOOK_SECRETS` in the environment is still a stop-gap** (carried over from Phase 02A). The
  `SecretResolver` port is right; the implementation reads a JSON blob from an environment variable
  because no secret manager is integrated. This should not survive the first real client.
- **Webhook id rotation is manual.** The id is a bearer credential. Rotating it means re-provisioning
  with a new one and updating the Meta callback URL; there is no rotation command.
- **Media is never fetched.** A WhatsApp media id is recorded and left unresolved, because
  exchanging it for a URL is an authenticated call this phase does not make. Messenger and Instagram
  supply URLs, which are stored but not retrieved.
- **`subscriptionState` is written by provisioning, never observed.** Nothing reconciles it against
  what Meta actually thinks the subscription is. An operator confirming step 8 of the checklist is
  currently the only source of truth.
- **Instagram `standby` items are recorded as `UNKNOWN_MESSAGING`.** The handover protocol is not
  modelled; the items are real and are kept, but treating them as conversations would risk two apps
  replying to one customer.
- **`mentions` are recorded, not conversed with.** The thread belongs to another account.
