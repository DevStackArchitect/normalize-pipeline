# Multi-Source Sync Pipeline

Demo video: [watch the walkthrough](https://drive.google.com/file/d/10_TcQ91-25MTBxv_8O09zjReoC4UHxNc/view?usp=sharing) &nbsp;|&nbsp; Live API: [normalize-pipeline.vercel.app](https://normalize-pipeline.vercel.app)

A backend sync pipeline that ingests records from HubSpot CRM (contacts), Razorpay test mode (payments), and Google Calendar (events) into one normalized Postgres schema. It demonstrates four properties: normalization of differently shaped APIs, automatic fallback from a stale incremental cursor to a full backfill, idempotent writes, and fault isolation between sources. There is no UI; the deliverable is an HTTP API deployed on Vercel.

Note on the payments source: the assignment specifies Stripe, but Stripe does not offer account onboarding in my region, so Razorpay stands in with identical adapter semantics (created-at cursor, corrupt-cursor fallback, webhook envelope and bare-entity mapping, amounts in the smallest currency unit). The substitution is confined to one adapter file plus configuration, which is exactly the isolation the adapter architecture is meant to prove.

## Architecture

```
 HubSpot API     Razorpay API     Google Calendar API
     |                |                  |
 hubspot.ts      razorpay.ts         gcal.ts        (adapters: fetchFull /
     |                |                  |            fetchIncremental /
     +----------------+------------------+            mapWebhookPayload)
                      |
               sync/engine.ts   runSync(): lock, cursor, fallback,
                      |          fault isolation per source
               sync/upsert.ts   validateAndUpsertBatch(): zod validation,
                      |          quarantine, single ON CONFLICT writer
                 Postgres (Supabase)
        records / sync_state / sync_runs / rejected_records
                      ^
                      |
               routes/webhooks.ts  (same upsert path as the engine)
```

## Local setup

1. Create the external accounts and collect credentials by following docs/SETUP.md.
2. `cp .env.example .env` and fill in every value.
3. Install and migrate:

```bash
npm ci
npm run db:migrate
```

4. Run in dev mode:

```bash
npm run dev
```

5. Tests and checks:

```bash
npm run test
npm run typecheck
npm run build
```

Optional: set `DATABASE_URL_TEST` to a throwaway Postgres URL to run the idempotency test against a real database.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | `{ ok: true }` after pinging the DB with `SELECT 1` |
| POST | `/sync` | Runs all adapters, returns per-source run summaries |
| POST | `/sync/:source` | Runs one adapter (`hubspot`, `razorpay`, `gcal`); 404 for unknown source |
| GET | `/sync/runs?limit=20` | Latest sync_runs rows, newest first |
| GET | `/records?source=&entity_type=&limit=50` | Normalized records, newest synced_at first, plus a `total` count honoring the filters |
| POST | `/webhooks/:source` | Maps the JSON body through the adapter's webhook mapper, then the shared upsert. Duplicate deliveries are no-ops |
| POST | `/debug/corrupt-cursor/:source` | Requires header `x-debug-secret`. Overwrites the stored cursor with `"corrupted-cursor"` to demo the fallback |

A ready-to-import Postman collection covering every endpoint (with demo payloads and expected responses) is included: [sync-pipeline-postman-collection.json](sync-pipeline-postman-collection.json). Set its `baseUrl` and `debugSecret` variables after importing.

## Live deployment

Live URL: `https://normalize-pipeline.vercel.app`

This submission is deployed on Vercel serverless instead of the spec's Render free tier (see Tradeoffs). The Express app is exposed through `api/index.ts` plus a rewrite in `vercel.json`; `src/index.ts` remains the long-running server entry, so the same code still deploys to Render per docs/SETUP.md section 5 without changes.

## Demo script

1. Idempotency: `POST /sync` twice back to back; the second run reports the same totals and `GET /records` shows identical row counts, so re-running produces zero new rows.
2. Stale cursor fallback: `POST /debug/corrupt-cursor/gcal` (with the secret header), then `POST /sync`; the gcal run reports `fallback_full`, data stays intact, no duplicates.
3. Fault isolation: break `HUBSPOT_ACCESS_TOKEN` in the environment and `POST /sync`; hubspot reports `failed` while razorpay and gcal report `ok`.
4. Webhook idempotency: `POST /webhooks/razorpay` with the same payment payload twice; exactly one row exists for that payment.
5. Normalization: `GET /records?source=hubspot`, `?source=razorpay`, `?source=gcal` show three different sources in one canonical shape.

Example calls:

```bash
BASE=https://normalize-pipeline.vercel.app
curl -X POST "$BASE/sync"
curl -X POST "$BASE/debug/corrupt-cursor/gcal" -H "x-debug-secret: $DEBUG_SECRET"
curl -X POST "$BASE/webhooks/razorpay" -H "Content-Type: application/json" \
  -d '{"entity":"event","event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_demo_1","entity":"payment","amount":1200,"currency":"INR","created_at":1767225600,"description":"Demo payment"}}}}'
curl "$BASE/records?source=razorpay&limit=10"
curl "$BASE/sync/runs?limit=10"
```

## Tradeoffs

- Razorpay replaces the spec's Stripe source because Stripe does not offer account onboarding in my region. The adapter mirrors the specified Stripe behavior exactly: unix-seconds created-at cursor, StaleCursorError on an unparseable cursor (the corrupt-cursor demo), amounts stored in the smallest currency unit, and webhook mapping for both the event envelope and the bare entity. No SDK was added; the adapter uses plain fetch with Basic auth.
- No webhook signature verification. The `/webhooks/:source` routes trust the payload; verification is intentionally out of scope for this assignment.
- HubSpot's search API has an indexing delay (recently changed records can appear late) and a 10,000 result cap per query; a production system would page by modified date windows.
- The HubSpot stale-cursor detector treats any search 400 whose body mentions invalid, timestamp, or filter as a stale cursor (per the spec). A filter-shaped bug in our own request would therefore surface as an unnecessary full backfill rather than a failed run; the backfill is idempotent, so this is safe but can hide request bugs behind extra work.
- Polling via `POST /sync` instead of a scheduled cron; an external cron service (or a Vercel cron job) can hit the endpoint.
- Deployed on Vercel serverless rather than the spec's Render free tier. Each request runs in a short-lived function invocation (60 second cap), which comfortably covers the seeded demo syncs but would bound a very large full backfill; the graceful-shutdown path in `src/index.ts` applies only to the long-running server mode. Advisory locks still work because each sync request holds its lock client within a single invocation.
- SSL certificate validation is relaxed (`rejectUnauthorized: false`) for the Supabase pooler connection.
- Soft deletes are not propagated, except Google Calendar cancelled events, which arrive through incremental sync and upsert with null title and dates.
- Advisory locks are session-scoped, so use Supabase's session mode pooler (port 5432). Transaction mode (port 6543) would break lock semantics.
- The sync engine takes its store as a parameter (plain dependency injection) so tests run against an in-memory store; the spec's `runSync(adapters)` sketch omitted the db dependency.
- `sync_runs.status` uses a fourth value `skipped_locked` when a concurrent run holds the source lock.
- Webhook payloads are accepted in each source's native record shape (Razorpay event envelope or bare payment entity, HubSpot contact object or array, Google Calendar event resource, array, or items container). Unmappable payloads become validation rejections in `rejected_records` rather than silent drops.
- `migrate.ts` requires only `DATABASE_URL` so migrations can run before the API credentials exist.
- Razorpay incremental sync re-reads payments with `from = cursor` (created_at greater than or equal to the cursor), so the boundary payment is re-fetched every run; the idempotent upsert makes this harmless.

## AI assistance disclosure

The project structure and code were written with Claude Code (Anthropic's coding agent), working from the assignment spec under my direction: I made the design and tradeoff decisions it surfaced (including the Razorpay substitution), provisioned every external account and credential, tested the flows end to end, deployed the service, and recorded the demo. Each change went through automated code review plus the test suite before landing. The Claude Code session is local to my machine and cannot be shared as a link; the commit co-author trailer reflects the assistance.

## Sources and references

- [ ] HubSpot CRM v3 contacts and search API docs (fill in the exact pages you used)

- [ ] Razorpay payments list API and authentication docs

- [ ] Google Calendar events.list sync token documentation, including the 410 GONE contract

- [ ] Neon connection pooling documentation

- [ ] Vercel deploy documentation for Node services