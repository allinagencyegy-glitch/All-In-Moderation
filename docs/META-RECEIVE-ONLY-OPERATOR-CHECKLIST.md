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
   Meta API base URL, and the service stores no access token and has no field to store one in.
   Every moderator decision is recorded as `SIMULATED`. This is asserted by
   `tests/architecture/no-outbound-meta.test.ts`, which fails the build if the capability ever
   appears. You will, however, need a send-capable token **in your own hands, briefly** to subscribe
   the surface in step 8 — Meta has no unauthenticated way to do that. §3 separates the three kinds
   of credential and says exactly where each may and may not live.
3. **You should use a test or explicitly authorised account first.** A Meta app in Development
   mode, with a Page you control and no live customers, proves the whole chain with nothing at
   stake. Do that before pointing a client's real Page at anything.
4. **The client must have agreed.** If the account belongs to a client, you need their explicit
   permission to receive and store their customers' messages before you subscribe.

If any of the four is not true yet, stop here.

---

## 1. What you need to have

| Thing                                                                                | Why                                                                    | Where it comes from                                                                                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A Meta developer account                                                             | Everything below lives in one                                          | developers.facebook.com                                                                                                                       |
| A Meta **app**                                                                       | Owns the webhook subscription and the app secret                       | App Dashboard → Create App                                                                                                                    |
| A **public HTTPS URL** for this service                                              | Meta will not call a private address, and requires a valid certificate | Your deployment; a tunnel is fine for a test                                                                                                  |
| A test/authorised **Page**, **IG professional account**, or **WhatsApp test number** | The surface being shadowed                                             | You control it                                                                                                                                |
| Admin rights on that surface                                                         | Subscribing requires them                                              | You already have them, or ask                                                                                                                 |
| A running deployment with a database                                                 | The ledger is where the proof lands                                    | **`docs/DEPLOYMENT-BOOTSTRAP.md`** — an empty cluster is not enough: four database credentials have to be created before `npm start` can work |

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

## 3. Credentials — three kinds, and only one of them reaches this service

Phase 02B's version of this section said a Page / IG / WhatsApp access token was "not needed. Do
not obtain one." That is right about the **runtime** and wrong about the **setup**, and the
difference matters: step 8 below subscribes a Page or a WhatsApp Business Account by calling the
Graph API, and Meta will not accept that call unauthenticated. An operator who follows the old text
literally gets stuck at step 8 with no explanation, and the natural next move — pasting a token
into an environment file "just to get past it" — is exactly the outcome the sentence was written to
prevent.

So the three kinds are separated by name.

### A. SETUP CREDENTIAL — temporary, operator-held, never reaches this service

|                              |                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What**                     | A Page access token, an Instagram-linked Page token, or a WhatsApp system-user token — whichever the surface needs.                                                                                                                      |
| **Why**                      | Subscribing an app to a surface is an authenticated Graph API write: `POST /{page-id}/subscribed_apps`, `POST /{waba-id}/subscribed_apps`. The dashboard's Page-subscription control does the same call for you with the same authority. |
| **Where it lives**           | In the Graph API Explorer session, or in **your** shell for the length of one `curl`. Nowhere else.                                                                                                                                      |
| **Where it must never live** | `WEBHOOK_SECRETS`. `.env`. Any table in PostgreSQL. Any field of `channel_connections`. Any argument to `meta-connection provision`. There is no field for it, and adding one is out of scope for this phase by design.                  |
| **Lifetime**                 | Minutes. Use a short-lived token and let it expire; if you used a long-lived one, revoke or invalidate it once step 8 succeeds. Rotating the app secret invalidates outstanding tokens.                                                  |
| **Blast radius if leaked**   | Large — it authorises sending as the surface. That is precisely why it does not live anywhere this service can reach.                                                                                                                    |

The service never sees it, never asks for it, and could not use it: there is no outbound HTTP
client in `src/` and no Meta API base URL, which `tests/architecture/no-outbound-meta.test.ts`
fails the build over.

> If your organisation forbids an operator holding a send-capable token even briefly, the
> alternative is to have whoever administers the Page perform step 8 in the App Dashboard UI. Same
> authority, same audit trail, no token in a terminal.

### B. RUNTIME WEBHOOK SECRETS — long-lived, held by the service, receive-only

| Secret           | What it does                                                                                                    | Where it lives                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **App secret**   | Meta signs every webhook body with it (`X-Hub-Signature-256`). We verify, in constant time, over the raw bytes. | `WEBHOOK_SECRETS`, under a `secret://` reference |
| **Verify token** | A string _you invent_. Meta echoes it once during the subscription handshake so we can prove the URL is ours.   | The same bundle                                  |

These two are the only credentials this service holds for Meta, and neither can send anything. The
database stores a `credentials_ref` pointer and never the secret — asserted by the security suite,
which fails if any column name matching `%secret%`, `%token%` or `%password%` appears without a
`_ref` suffix.

### C. FUTURE OUTBOUND CREDENTIAL — does not exist yet

A stored, refreshable Page / IG / WhatsApp access token behind the `SecretResolver` port is what a
future sending phase would need. It does not exist, there is no schema for it, and introducing one
is explicitly out of scope here. See §12.

### The distinction in one line

> **A** authorises Meta to start calling us, and is yours for five minutes.
> **B** proves the calls are really from Meta, and is the service's forever.
> **C** would authorise us to call Meta, and does not exist.

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

# --- the three runtime database identities: separate on purpose, no single-URL fallback ------
# Created by the bootstrap in step 5. These are *login identities*; the privilege roles they are
# members of (app_runtime, app_worker, app_relay) are NOLOGIN and cannot appear in a URL.
PG_RUNTIME_URL=postgres://app_runtime_login:...@host:5432/all_in_moderation
PG_WORKER_URL=postgres://app_worker_login:...@host:5432/all_in_moderation
PG_RELAY_URL=postgres://app_relay_login:...@host:5432/all_in_moderation

# NOT here, deliberately: PG_MIGRATOR_URL and PG_BOOTSTRAP_URL. A process that can change the
# schema while serving webhooks is one compromise away from a data-loss event rather than a
# data-exposure one. See docs/DEPLOYMENT-BOOTSTRAP.md.

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

That is the whole command **once the database exists**. From a genuinely empty PostgreSQL cluster
the full sequence — `CREATE DATABASE`, bootstrap, migrate, three credentials, start, verify — is
`docs/DEPLOYMENT-BOOTSTRAP.md` §4, and step 5 below is the short form of it. There is no receive-only flag, because there is nothing to turn off:
receive-only is the default `transport_mode` on every connection, it is what provisioning writes,
and a database CHECK constraint refuses a receive-only row that holds a send capability.

Confirm before continuing:

```bash
curl -s localhost:8080/health/status | jq '{status, process, transport}'
```

`process.outboundMode` must read `SIMULATE`.

---

## 5. Create the database roles, then migrate

An empty PostgreSQL cluster is not a deployable one. The migrations create four **privilege roles**
— `app_migrator`, `app_runtime`, `app_worker`, `app_relay` — and every one of them is `NOLOGIN`:
they hold grants, they are not credentials. The identities that actually connect
(`app_migrator_login` and friends) are created by a separate, privileged bootstrap step.

Phase 02B's version of this section showed `PG_MIGRATOR_URL=postgres://app_migrator:...`, which can
never work — that role has no `LOGIN` attribute and no password. The full procedure, the privilege
it needs, and how long that privilege has to be held, are in:

> **`docs/DEPLOYMENT-BOOTSTRAP.md`**

The short version:

```bash
# Once per database, with a privileged credential. Creates the four privilege roles, the four login
# identities, their memberships, pgcrypto and the schema grants — idempotently, in one transaction.
export PG_MIGRATOR_PASSWORD="$(openssl rand -hex 24)"
export PG_RUNTIME_PASSWORD="$(openssl rand -hex 24)"
export PG_WORKER_PASSWORD="$(openssl rand -hex 24)"
export PG_RELAY_PASSWORD="$(openssl rand -hex 24)"
PG_BOOTSTRAP_URL=postgres://<admin>:...@host:5432/all_in_moderation   node src/runtime/cli/bootstrap.ts

# Then migrate, as the migrator *identity*, which assumes the app_migrator privilege role.
PG_MIGRATOR_URL="postgres://app_migrator_login:${PG_MIGRATOR_PASSWORD}@host:5432/all_in_moderation"   node src/runtime/cli/migrate.ts

# To see what is applied and what is pending, without changing anything:
PG_MIGRATOR_URL=... node src/runtime/cli/migrate.ts --status
```

`0008_meta_transport.sql` must have applied. It adds the transport columns, the
`channel_connection_identities` table whose primary key is what prevents two clients claiming one
page, and the `normalization` / `provider_context` columns.

Neither `PG_BOOTSTRAP_URL` nor `PG_MIGRATOR_URL` belongs in the running service's environment. The
runtime gets three credentials and none of them can change the schema.

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

> **This is the step that needs the SETUP CREDENTIAL from §3A.** Every `POST .../subscribed_apps`
> below is an authenticated Graph API write; the dashboard's Page-subscription control makes the
> same call with the same authority. Hold the token in the Graph API Explorer or in your own shell,
> use it here, and let it expire. It must not reach `WEBHOOK_SECRETS`, `.env`, or any database
> column — there is no column for it.

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
- obtains and **stores** page/IG/WhatsApp access tokens behind the `SecretResolver` port — the
  FUTURE OUTBOUND CREDENTIAL of §3C, which is a different thing from the short-lived setup token of
  §3A both in lifetime and in where it is allowed to live,
- promotes a single connection to `SEND_AND_RECEIVE` — which the database CHECK constraint refuses
  while it still holds only receive capabilities,
- and passes whatever approval that phase defines.

None of it happens by changing an environment variable.

---

## 13. The whole sequence, from an empty database to a shadowed Page

Every command, in order. Steps 1–4 need a privileged database credential and nothing after them
does. Steps 8–10 are the only ones that touch Meta, and step 9 is the only one that needs a
send-capable token — in your hands, for one call.

```bash
# ================================================================================================
# PART 1 — the database. No Meta account required. See docs/DEPLOYMENT-BOOTSTRAP.md.
# ================================================================================================
npm ci

# 1. the database itself (privileged; CREATE DATABASE cannot run in a transaction)
psql "$PG_ADMIN_URL" -c 'CREATE DATABASE all_in_moderation'

# 2. what can this credential actually do? changes nothing; exits 1 while anything is missing
export PG_BOOTSTRAP_URL="postgres://<admin>:...@$PG_HOST:5432/all_in_moderation"
node src/runtime/cli/bootstrap.ts --check || true

# 3. four privilege roles, four login identities, memberships, pgcrypto, schema grants
export PG_MIGRATOR_PASSWORD="$(openssl rand -hex 24)"
export PG_RUNTIME_PASSWORD="$(openssl rand -hex 24)"
export PG_WORKER_PASSWORD="$(openssl rand -hex 24)"
export PG_RELAY_PASSWORD="$(openssl rand -hex 24)"
node src/runtime/cli/bootstrap.ts
#    -> put all four passwords in your secret manager now; nothing prints them again
unset PG_BOOTSTRAP_URL

# 4. the schema, as the migrator identity assuming the app_migrator privilege role
export PG_MIGRATOR_URL="postgres://app_migrator_login:${PG_MIGRATOR_PASSWORD}@$PG_HOST:5432/all_in_moderation"
node src/runtime/cli/migrate.ts
unset PG_MIGRATOR_URL PG_MIGRATOR_PASSWORD

# ================================================================================================
# PART 2 — the service. Still no Meta account required.
# ================================================================================================
# 5. the runtime's three credentials, and the safety posture
export PG_RUNTIME_URL="postgres://app_runtime_login:${PG_RUNTIME_PASSWORD}@$PG_HOST:5432/all_in_moderation"
export PG_WORKER_URL="postgres://app_worker_login:${PG_WORKER_PASSWORD}@$PG_HOST:5432/all_in_moderation"
export PG_RELAY_URL="postgres://app_relay_login:${PG_RELAY_PASSWORD}@$PG_HOST:5432/all_in_moderation"
export OUTBOUND_MODE=SIMULATE
export APP_ROLE=all
export HTTP_PORT=8080

# 6. the RUNTIME WEBHOOK SECRETS of §3B — app secret and a verify token you invent
export WEBHOOK_SECRETS='{"secret://<client>/meta":{"appSecret":"<from the app dashboard>","verifyToken":"<openssl rand -hex 24>"}}'

# 7. prove the whole inbound chain offline, with no Meta account and no network
node src/runtime/cli/shadow-acceptance.ts --self-test        # "ok": true, exits 0

npm start
curl -s localhost:8080/health/status | jq '{status, process, database}'
#    process.outboundMode must read SIMULATE; database.reachable must be true

# ================================================================================================
# PART 3 — the Meta surface. Steps 0-4 and 7 of this checklist must already be done.
# ================================================================================================
# 8. provision the connection FIRST: it generates the path Meta must be pointed at (§6)
node src/runtime/cli/meta-connection.ts provision \
  --account acc_<...> --channel FACEBOOK \
  --external-id <page id> --credentials-ref secret://<client>/meta
#    -> prints webhookPath; callback URL is https://<public host><webhookPath>   (§7)

# 9. subscribe the fields and the surface. THIS is the SETUP CREDENTIAL step (§3A, §8).
#    Use the Graph API Explorer or the App Dashboard; the token stays with you and expires.
#      POST /v<version>/<page id>/subscribed_apps?subscribed_fields=messages,...

# 10. prove it against the real connection (§9)
node src/runtime/cli/meta-connection.ts status --account acc_<...> --connection chc_<...>
node src/runtime/cli/shadow-acceptance.ts --account acc_<...> --connection chc_<...> --limit 5
#    a pass prints "ok": true and asserts every outbound action is SIMULATED
```

Stop at the end of Part 2 if you do not yet have all four confirmations from §0.
