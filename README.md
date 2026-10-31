# AI Platform (wa-platform)

A multi-tenant WhatsApp Business messaging API built on the WhatsApp Cloud API and the Supabase Postgres project **wa-platform** (`wbrkkiqttxvhjrwuaipw`).

Tenants (your customers) get API keys and send WhatsApp messages from their own numbers. The platform enforces WhatsApp's rules (24-hour service window, approved templates, opt-outs), charges prepaid credits per message, refunds failed sends, and forwards delivery events to each tenant's webhook.

- Node.js 22, ES modules, one runtime dependency (`pg`)
- Plain `node:http` server and `node:test` tests
- No Supabase client keys are used. The server connects to Postgres directly, and RLS (enabled, no policies) blocks the public `anon`/`authenticated` roles.

## Dashboard

| Page | Who |
| --- | --- |
| `/signup`, `/login` | Businesses create a workspace (trial tenant + owner account) and sign in with email and password. |
| `/app` | The workspace: Dashboard (7-day stats, setup checklist), Broadcasts (CSV upload, scheduling, delivery and read rates), Inbox (shared conversations, replies, templates, notes, resolve/block, media), Contacts, Templates (sync), Wallet (ledger), Developers (API keys, webhooks; owners/admins), Team (add teammates, roles, remove access), Settings (password, numbers). |
| `/console` | Platform operator (ADMIN_TOKEN): tenants, credits, connecting WhatsApp numbers, keys, webhooks. |

Sessions are HttpOnly, SameSite=Lax cookies (7 days, sliding); only a SHA-256 of the token is stored. Cookie-authenticated writes need `X-Requested-With: fetch` and a same-origin `Origin`, which blocks cross-site requests. Passwords use scrypt. Roles: **owner** (everything), **admin** (everything except owners), **agent** (inbox, contacts, templates, wallet). The pages are plain HTML, CSS and ES modules with no build step, served under a CSP that forbids inline script and style.

## Deploy on Vercel

`api/index.js` wraps the same app for Vercel Functions, and `vercel.json` rewrites every path to it. Set these Environment Variables on the Vercel project:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Supabase wa-platform → Connect → **Transaction pooler** (port 6543) URI with the database password |
| `TOKEN_ENCRYPTION_KEY`, `API_KEY_PEPPER`, `ADMIN_TOKEN` | Random secrets (see `.env.example`); never rotate the first two casually |
| `CRON_SECRET` | ≥ 16 chars. Vercel Cron sends it to `/internal/cron` |
| `META_APP_SECRET`, `META_VERIFY_TOKEN` | Optional until WhatsApp is connected; the webhook answers 503 without them |
| `SIGNUP_CREDITS`, `ALLOW_SIGNUP`, `PRICE_*` | Optional |

Vercel Hobby crons run once a day, which only covers cleanup. Scheduled messages and the stuck-send sweeper need `/internal/cron` called every minute: use a Pro cron (`* * * * *`), Supabase `pg_cron` + `pg_net`, or any external scheduler sending `Authorization: Bearer $CRON_SECRET`. If any required variable is missing, every request returns 503 listing the missing names.

## Run locally

```bash
npm install
cp .env.example .env   # fill in the values
npm test               # unit + service + HTTP tests (in-process Postgres, no network)
npm run test:smoke     # starts the real server against a local Postgres + fake Graph API
npm run test:ui        # Chromium journey: signup → inbox → team → API keys → password change
npm run migrate        # applies db/migrations to DATABASE_URL (a no-op on wa-platform today)
npm start              # serves on PORT and runs the background workers
```

The tests use [PGlite](https://pglite.dev) (Postgres compiled to WASM) loaded with the same migrations as production, so SQL, constraints, triggers and transactions are exercised for real. The WhatsApp Cloud API and tenant webhooks are always faked in tests. Nothing is sent to Meta.

## How it works

| Concern | Behaviour |
| --- | --- |
| **Auth** | `Authorization: Bearer wa_live_…`. Keys are stored as HMAC-SHA256 with `API_KEY_PEPPER`; the plaintext is shown once. A key can be bound to one number. |
| **Numbers** | Admin connects a number with its WABA id, phone number id and access token. The token is checked against the Graph API, encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`, bound to the row id) and never returned. |
| **Service window** | Free-form (text/media) messages need an inbound message from the contact in the last 24 h (72 h after a Click-to-WhatsApp ad). Outside the window only approved templates can be sent. |
| **Templates** | Synced from Meta (`/v1/templates/sync`); review results arrive by webhook. Variables are validated (named or positional) before anything is charged. |
| **Credits** | Prepaid wallet. Each send holds credits in the same transaction that creates the message; insufficient credit rolls everything back. Failed sends and failed deliveries are refunded exactly once. Every change is written to `credit_ledger` (append-only, enforced by a trigger). |
| **Pricing** | Defaults: marketing 10, utility 4, authentication 4, service 0 (override with `PRICE_*`). Utility templates inside an open window and anything inside a CTWA window are free, matching Meta's per-message pricing. |
| **Idempotency** | Send `Idempotency-Key`. A retry with the same body replays the stored response (`Idempotent-Replayed: true`); a different body gets 422; a concurrent duplicate gets 409. Keys are kept 24 h. |
| **Failures** | Permanent Graph API errors: failed and refunded. Rate limits and outages: retried up to 3 times. Timeouts (outcome unknown): kept `queued` and not resent; after 10 minutes without a WhatsApp id the sweeper marks them failed and refunds. |
| **Webhooks from Meta** | Signature (`X-Hub-Signature-256`) verified on the raw body. Each event is deduplicated and processed in its own transaction. Statuses only move forward (a late `delivered` never overrides `read`). A status that arrives before the send call returns is parked and applied when the WhatsApp id is saved. |
| **Opt-out** | Inbound `STOP`, `UNSUBSCRIBE`, … opt the contact out (sends are refused); `START` opts back in. Tenants can also block contacts. |
| **Tenant webhooks** | `message.received`, `message.status`, `contact.opted_out`, `contact.opted_in`, `template.status` are POSTed to registered https endpoints with `X-WA-Signature: t=<unix>,v1=<hmac-sha256 of "t.body">`; 3 attempts with backoff. Private, loopback and metadata addresses are refused. |
| **Workers** | Every 5 s: send due scheduled messages. Every minute: sweep stuck sends. Hourly: drop idempotency keys older than 24 h and webhook dedupe records older than 30 days. |

## API

All responses are JSON. Errors look like `{"error": {"code": "outside_service_window", "message": "…", "details": …}}`.

### Tenant API (`Authorization: Bearer <api key>`)

| Method & path | Purpose |
| --- | --- |
| `POST /v1/messages` | Send or schedule a message (see below). `202` with `{ message }`. |
| `GET /v1/messages?limit=&before=&status=&contact_id=&conversation_id=` | List, newest first. Page with `next_cursor` → `before`. |
| `GET /v1/messages/:id` | One message. |
| `POST /v1/messages/:id/cancel` | Cancel a scheduled message (credits refunded). |
| `GET /v1/messages/:id/media` | Download the image/document/audio/video of an inbound message (proxied from Meta; `410` once Meta has expired it). |
| `POST /v1/broadcasts` · `GET /v1/broadcasts[/:id]` · `POST /v1/broadcasts/:id/cancel` | Send one approved template to up to 5,000 recipients (`{ name, template: { name, language }, recipients: [{ to, variables }], schedule_at? }`). All rows are validated and the whole cost is held first; opted-out, blocked and duplicate numbers are skipped; cancelling refunds unsent messages. |
| `GET /v1/templates?status=` · `POST /v1/templates/sync` | List or sync templates (`{ "waba_connection_id"? }`). |
| `GET /v1/wallet?limit=&before=` | Balance and ledger. |
| `GET /v1/contacts?limit=&after=` · `POST /v1/contacts/:phone/block` | Contacts; `{ "blocked": true, "reason"? }`. |
| `GET /v1/conversations?status=` · `POST /v1/conversations/:id/status` | Inbox; `{ "status": "open" \| "pending" \| "resolved" }`. |
| `GET /v1/numbers` | Connected numbers (no tokens). |

```jsonc
// POST /v1/messages   (Idempotency-Key: order-1042)
{ "to": "+923001234567", "type": "template",
  "template": { "name": "order_update", "language": "en", "variables": { "1": "Ali", "2": "#1042" } } }

{ "to": "+923001234567", "type": "text", "text": { "body": "Thanks, we're on it!" } }
{ "to": "+923001234567", "type": "document", "media": { "link": "https://…/invoice.pdf", "filename": "invoice.pdf" } }
// optional: "waba_connection_id", "schedule_at": "2026-11-01T09:00:00+05:00", "client_reference"
```

Common error codes: `invalid_request` (400), `unauthorized` (401), `insufficient_credits` (402), `tenant_not_active` / `connection_not_allowed` (403), `request_in_progress` (409), `outside_service_window`, `template_not_found`, `template_invalid`, `contact_opted_out`, `contact_blocked`, `idempotency_key_reused` (422), `rate_limited` (429).

### Operator API (`Authorization: Bearer $ADMIN_TOKEN`)

| Method & path | Body |
| --- | --- |
| `POST /admin/tenants` | `{ name, status?, timezone? }` |
| `GET /admin/tenants/:id` · `PATCH /admin/tenants/:id` | `{ status }`: trial, active, pending_activation, suspended, cancelled |
| `POST /admin/tenants/:id/numbers` | `{ waba_id, phone_number_id, access_token, label?, is_default? }` |
| `GET /admin/tenants/:id/numbers` · `PATCH …/numbers/:nid` | `{ status?: "connected" \| "disconnected", is_default?: true }` |
| `POST /admin/tenants/:id/api-keys` | `{ name, waba_connection_id?, environment?: "live" \| "test" }`. Returns `key` once. |
| `GET /admin/tenants/:id/api-keys` · `DELETE …/api-keys/:kid` | Revoke. |
| `POST /admin/tenants/:id/balance` | `{ amount }` top-up, or `{ kind: "adjustment", amount: ±n, note }` |
| `POST /admin/tenants/:id/webhook-endpoints` | `{ url, events?: ["*"] }`. Returns `secret` once. |
| `GET …/webhook-endpoints` · `PATCH …/webhook-endpoints/:eid` | `{ active }` |
| `POST /admin/tenants/:id/templates/sync` | `{ waba_connection_id }` |

### Meta webhook

Set the callback URL to `https://<host>/webhooks/meta` with `META_VERIFY_TOKEN`, and subscribe the app to `messages`, `message_template_status_update` and `phone_number_quality_update`.

`GET /health` (process up) and `GET /ready` (database reachable) are unauthenticated.

## Database

`db/migrations/0001_init.sql` and `0002_enable_rls.sql` were reconstructed from the live wa-platform catalog. They carry the same names as the rows in production's `public.schema_migrations`, so `npm run migrate` there is a no-op. Add changes as new numbered files; never edit an applied one.

Notes:
- `credit_ledger` rejects UPDATE and DELETE (trigger). This also means a tenant with ledger rows cannot be hard-deleted; suspend or cancel it instead.
- Every query on tenant data filters by `tenant_id`, because the owner connection bypasses RLS.

## Deploy

```bash
docker build -t wa-platform .
docker run --env-file .env -p 8080:8080 wa-platform
```

Run one instance with `RUN_WORKERS=true`. The scheduled-send claim uses `FOR UPDATE SKIP LOCKED`, so extra instances are safe, but the rate limiter is per process.

## Status and known limits

- **Verified locally:** 220+ unit, service and HTTP tests, plus `npm run test:smoke` (the real entrypoint against a local Postgres over the wire protocol and a fake Graph API). See CI.
- **Not yet verified:** live sending through Meta, and running against the production database. That needs real credentials and a test number.
- Tenant webhook deliveries are best effort (3 attempts in-process, no durable outbox).
- Endpoint URLs are checked when registered; DNS that later resolves to a private address is not re-checked at delivery.
- Inbound media is not copied to storage; it is fetched from Meta on demand and becomes unavailable when Meta expires it.
- Teammates get an initial password from their owner; there is no email delivery, so no self-service password reset or invitations by email yet.
- Connecting a WhatsApp number is done by the operator (no Meta Embedded Signup yet).
