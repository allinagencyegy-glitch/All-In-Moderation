# Meta receive-only connection — operator checklist

**Status: nothing in this checklist has been performed.** No Meta app exists, no credential has
been requested, and no real connection has been attached. This document is the boundary Phase 02B
stops at: everything on the software side is built and proved offline, and every remaining step
needs a human with access to a Meta account.

Read the whole document before starting. Step 0 is the one that matters.

---

## 0. Before anything else — what you are agreeing to

You are about to point a real Facebook Page, Instagram professional account or WhatsApp Business
number at this system. Read these four statements and confirm each one is what you intend.

1. **The platform will receive real customer messages.** They will be stored, in full, in the
   inbound ledger and as conversation messages. If the account carries real customer traffic, this
   is a processing activity with the obligations that implies.
2. **The platform will not send anything.** There is no outbound HTTP client anywhere in `src/`, no
   Meta API base URL, and no access token is stored or requested. Every moderator decision is
   recorded as `SIMULATED`. This is asserted by `tests/architecture/no-outbound-meta.test.ts`,
   which fails the build if the capability ever appears.
3. **You should use a test or explicitly authorised account first.** A Meta app in Development
   mode, with a Page you control and no live customers, proves the whole chain with nothing at
   stake. Do that before pointing a client's real Page at anything.
4. **The client must have agreed.** If the account belongs to a client, you need their explicit
   permission to receive and store their customers' messages before you subscribe.

If any of the four is not true yet, stop here.

---

## 1. What you need to have

| Thing                                                                                | Why                                                                    | Where it comes from                          |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------- |
| A Meta developer account                                                             | Everything below lives in one                                          | developers.facebook.com                      |
| A Meta **app**                                                                       | Owns the webhook subscription and the app secret                       | App Dashboard → Create App                   |
| A **public HTTPS URL** for this service                                              | Meta will not call a private address, and requires a valid certificate | Your deployment; a tunnel is fine for a test |
| A test/authorised **Page**, **IG professional account**, or **WhatsApp test number** | The surface being shadowed                                             | You control it                               |
| Admin rights on that surface                                                         | Subscribing requires them                                              | You already have them, or ask                |
| A running deployment with a database                                                 | The ledger is where the proof lands                                    | `npm start` against PostgreSQL               |

### App type

Create a **Business** app. Add only the products you actually need:

| Channel                            | Meta product to add | Webhook object              |
| ---------------------------------- | ------------------- | --------------------------- |
| Facebook Messenger + Page comments | Messenger, Webhooks | `page`                      |
| Instagram DMs + comments           | Instagram, Webhooks | `instagram`                 |
| WhatsApp                           | WhatsApp, Webhooks  | `whatsapp_business_account` |

Keep the app in **Development mode** for the first connection. Development mode still delivers
real webhooks for surfaces whose admins are app roles — which is exactly the shadow you want.

---

## 2. Permissions and scopes, per channel

These are the permissions Meta requires to _subscribe_ to the fields below. They are read
permissions; none of them is a send permission, and none should be requested.

| Channel            | Permissions to request                                                                                                                                         | Deliberately **not** requested                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Facebook Messenger | `pages_manage_metadata` (subscribe the Page), `pages_messaging` (receive messages), `pages_read_engagement`                                                    | `pages_messaging_subscriptions` beyond receipt   |
| Facebook comments  | `pages_manage_metadata`, `pages_read_engagement`, `pages_read_user_content`                                                                                    | `pages_manage_engagement` (hide/delete comments) |
| Instagram          | `instagram_basic`, `instagram_manage_messages` (receive DMs), `instagram_manage_comments` (receive comment events), `pages_manage_metadata`, `pages_show_list` | —                                                |
| WhatsApp           | `whatsapp_business_messaging`, `whatsapp_business_management`                                                                                                  | —                                                |

> Some of these permissions technically also authorise sending. Meta does not offer receive-only
> variants for Messenger or Instagram. The receive-only guarantee is therefore enforced **on our
> side**, structurally: no HTTP client exists, no token is stored, and the architecture test fails
> the build if either changes. Do not treat the permission grant as the safety boundary.

`pages_manage_engagement` is the one to be careful about: it is what would let something hide or
delete a customer's comment. Do not request it in this phase.

---

## 3. Secrets — what they are and where they go

Three distinct secrets, with three different blast radii. None of them is ever written to the
database, and none appears in a log.

| Secret                                | What it does                                                                                                  | Where it lives                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **App secret**                        | Meta signs every webhook body with it (`X-Hub-Signature-256`). We verify.                                     | `WEBHOOK_SECRETS` env, under a `secret://` reference |
| **Verify token**                      | A string _you invent_. Meta echoes it once during the subscription handshake so we can prove the URL is ours. | Same bundle                                          |
| **Page / IG / WhatsApp access token** | Would authorise sending.                                                                                      | **Not needed. Do not obtain one. Do not store one.** |

### Choosing a verify token

Generate a random one; do not reuse anything. It travels in a query string, so treat it as
lower-sensitivity than the app secret but still a secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

### The environment variable

`WEBHOOK_SECRETS` is a JSON object keyed by the `credentials_ref` on the connection row:

```bash
export WEBHOOK_SECRETS='{"secret://<client>/meta":{"appSecret":"<from the app dashboard>","verifyToken":"<the one you just generated>"}}'
```

A connection whose reference resolves to nothing rejects every delivery; a connection whose bundle
has no `verifyToken` refuses the handshake rather than accepting any token. Both are checked at
provisioning time so you find out now rather than during the handshake.

> **This is a stop-gap.** Secrets are resolved through the `SecretResolver` port. Reading them from
> the environment is one implementation; swapping in a real secret manager changes
> `src/runtime/main.ts` and nothing else. Do not let the environment variable become permanent.

---

## 4. Environment for a receive-only deployment

```bash
# --- safety: unchanged from every prior phase -----------------------------------------------
OUTBOUND_MODE=SIMULATE          # LIVE is refused at boot with OUTBOUND_LIVE_NOT_AUTHORIZED

# --- the three database roles: separate on purpose, no single-URL fallback -------------------
PG_RUNTIME_URL=postgres://app_runtime_login:...@host:5432/all_in_moderation
PG_WORKER_URL=postgres://app_worker_login:...@host:5432/all_in_moderation
PG_RELAY_URL=postgres://app_relay_login:...@host:5432/all_in_moderation

# --- the webhook secret bundle ---------------------------------------------------------------
WEBHOOK_SECRETS={"secret://<client>/meta":{"appSecret":"...","verifyToken":"..."}}

# --- http ------------------------------------------------------------------------------------
HTTP_PORT=8080
HTTP_HOST=0.0.0.0
APP_ROLE=all                     # or run `web` and `worker` as separate processes
LOG_LEVEL=info
```

### The exact safe command to start receive-only mode

```bash
npm ci
node --run start          # or: npm start
```

That is the whole command. There is no receive-only flag, because there is nothing to turn off:
receive-only is the default `transport_mode` on every connection, it is what provisioning writes,
and a database CHECK constraint refuses a receive-only row that holds a send capability.

Confirm before continuing:

```bash
curl -s localhost:8080/health/status | jq '{status, process, transport}'
```

`process.outboundMode` must read `SIMULATE`.

---

## 5. Migrate the database

```bash
# As the migrator role — never as app_runtime, which cannot change the schema by design.
PG_MIGRATOR_URL=postgres://app_migrator:...@host:5432/all_in_moderation \
  node src/runtime/cli/migrate.ts

# To see what is applied and what is pending, without changing anything:
PG_MIGRATOR_URL=... node src/runtime/cli/migrate.ts --status
```

`0008_meta_transport.sql` must have applied. It adds the transport columns, the
`channel_connection_identities` table whose primary key is what prevents two clients claiming one
page, and the `normalization` / `provider_context` columns.

---

## 6. Provision the connection

Do this **before** configuring the callback in Meta: provisioning is what generates the webhook
path you are about to paste in.

```bash
# Facebook Page
node src/runtime/cli/meta-connection.ts provision \
  --account acc_<your account id> \
  --channel FACEBOOK \
  --external-id <page id> \
  --credentials-ref secret://<client>/meta

# Instagram professional account
node src/runtime/cli/meta-connection.ts provision \
  --account acc_<...> --channel INSTAGRAM \
  --external-id <instagram professional account id> \
  --credentials-ref secret://<client>/meta

# WhatsApp — note that --external-id is the PHONE NUMBER ID, not the WABA
node src/runtime/cli/meta-connection.ts provision \
  --account acc_<...> --channel WHATSAPP \
  --external-id <phone_number_id> \
  --identity WHATSAPP_BUSINESS_ACCOUNT:<waba id> \
  --credentials-ref secret://<client>/meta
```

The command prints `webhookPath`, e.g. `/webhooks/meta/9f2c…`. Your callback URL is:

```
https://<your public host><webhookPath>
```

**The WhatsApp case is the one to get right.** A WhatsApp delivery names the _business account_ in
`entry.id` and the routable _phone number id_ in `value.metadata`. One WABA can carry several
numbers belonging to different clients under one partner app. If you provision the WABA as the
primary `--external-id`, every delivery on that business account will fail the routing check and
be recorded as `UNROUTABLE_IDENTITY` — which is the safe failure, but it is still a failure.

To restrict which surfaces are read, add `--surfaces DIRECT_MESSAGE` (WhatsApp only supports
`DIRECT_MESSAGE`; a comment surface cannot be enabled on it).

---

## 7. Configure the webhook in the Meta app

App Dashboard → the product (Messenger / Instagram / WhatsApp) → **Webhooks** → Edit callback URL.

| Field        | Value                                               |
| ------------ | --------------------------------------------------- |
| Callback URL | `https://<host>/webhooks/meta/<the id from step 6>` |
| Verify token | The `verifyToken` you put in `WEBHOOK_SECRETS`      |

Click **Verify and Save**. Meta issues a `GET` with `hub.mode=subscribe`, `hub.verify_token` and
`hub.challenge`; the service compares the token in constant time and echoes the challenge verbatim.

If it fails, in order of likelihood:

- The URL is not reachable over public HTTPS, or the certificate is not valid.
- `WEBHOOK_SECRETS` was not exported into the running process (restart it after setting it).
- The webhook id in the URL does not match a provisioned connection — a 404, which Meta shows as a
  generic failure. Re-run `meta-connection show` to confirm the path.
- The `verifyToken` in the bundle differs from the one typed into the dashboard.

---

## 8. Subscribe the fields

Verification only proves the URL. Nothing is delivered until you subscribe fields **and** subscribe
the specific Page / IG account / WABA.

### Facebook Page

Subscribe the app to these webhook fields: `messages`, `messaging_postbacks`, `message_echoes`,
`message_deliveries`, `message_reads`, `feed`.

Then subscribe the Page itself (Graph API Explorer, or the dashboard's Page subscription control):

```
POST /v<version>/<page id>/subscribed_apps
  subscribed_fields=messages,messaging_postbacks,message_echoes,message_deliveries,message_reads,feed
```

### Instagram

Subscribe the fields `messages`, `comments`, `live_comments`, `mentions`, then subscribe the
Instagram professional account through its linked Page.

`mentions` is recorded as `UNKNOWN_FIELD` by design: a mention lives on someone else's post, so it
is not an inbound conversation for this client and must not be treated as one.

### WhatsApp

Subscribe the field `messages` on the WhatsApp Business Account. Optionally add
`phone_number_quality_update` and `account_update`; both are recorded as `ACCOUNT_UPDATE` and
carry no customer content.

---

## 9. Prove the chain

Send one message to the connected surface from a phone that is not the business.

```bash
# 1. Did anything arrive at all?
node src/runtime/cli/meta-connection.ts status \
  --account acc_<...> --connection chc_<...>
```

Read, in order:

| Field                    | What it tells you                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `totalEvents`            | Deliveries that reached the ledger. `0` → Meta is not calling us; go back to step 8.                                               |
| `signatureRejections`    | `> 0` → the app secret in `WEBHOOK_SECRETS` is wrong, or a prober found the URL.                                                   |
| `pendingNormalization`   | `> 0` for more than a moment → the worker is not running.                                                                          |
| `unroutableItems`        | `> 0` → **the identity is misconfigured.** For WhatsApp, you almost certainly provisioned the WABA instead of the phone number id. |
| `surfaceDisabledItems`   | `> 0` → the event arrived on a surface this connection has not enabled.                                                            |
| `byClassification`       | What actually came in, by name.                                                                                                    |
| `lastProducedMessagesAt` | Non-null → a real customer message became a real conversation.                                                                     |

```bash
# 2. Follow one delivery all the way, and assert nothing was sent.
node src/runtime/cli/shadow-acceptance.ts \
  --account acc_<...> --connection chc_<...> --limit 5
```

A pass prints `"ok": true` and exits `0`. It asserts, from persisted rows: the signature was
verified, the event reached a terminal normalised state, a normalisation verdict was recorded, each
produced message points back at the delivery that produced it, and **every outbound action is
`SIMULATED`**. Any failure prints why and exits `1`.

An empty result is reported as a failure, not a pass: "we checked nothing and found nothing wrong"
is exactly the shape of a green light nobody should act on.

You can run the same checks with no Meta connection at all:

```bash
node src/runtime/cli/shadow-acceptance.ts --self-test
```

---

## 10. What to watch for the first day

```bash
curl -s https://<host>/health/status | jq '{status, reasons, transport}'
```

| Signal                                                   | Meaning                                                                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `transport.unknownConnection` climbing                   | A stale or leaked webhook URL is being called. The id is a bearer credential; rotate it by re-provisioning with a new one.  |
| `transport.signatureRejected` non-zero                   | Wrong app secret, or somebody is probing.                                                                                   |
| `transport.unroutableItems` non-zero                     | Identity misconfiguration. The one number to alert on.                                                                      |
| `transport.itemsByClassification` containing `UNKNOWN_*` | Meta sent a shape the parser does not know. Nothing was lost — the payload is on the ledger row — but somebody should look. |
| `inbound.ageMs` growing                                  | The worker is behind or stopped.                                                                                            |

No customer content, account id, page id or webhook id appears on that endpoint. Per-tenant detail
requires the CLI, which authenticates against the database.

---

## 11. Turning it off

```bash
# Stop delivery at the source (preferred: Meta stops calling).
DELETE /v<version>/<page id>/subscribed_apps
```

Or disable the connection in the database (`status = 'DISABLED'`). A disabled connection answers
`200` and stores nothing — deliberately not `404`, because Meta treats repeated non-2xx as a failing
endpoint and eventually disables the subscription itself.

Do **not** delete the connection row while its ledger history matters: the raw events are the only
reconstructible record of what arrived.

---

## 12. What is still not possible after this checklist

Everything on the sending side. There is no code path that replies, comments, reacts, hides,
deletes or calls. Enabling any of that requires a new phase that:

- adds an outbound HTTP client and a Meta API base URL (and therefore deletes assertions from
  `tests/architecture/no-outbound-meta.test.ts`),
- obtains and stores page/IG/WhatsApp access tokens behind the `SecretResolver` port,
- promotes a single connection to `SEND_AND_RECEIVE` — which the database CHECK constraint refuses
  while it still holds only receive capabilities,
- and passes whatever approval that phase defines.

None of it happens by changing an environment variable.
