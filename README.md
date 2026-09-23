# Venluto OS

One internal dashboard for positive replies, prospect ownership, five-minute response deadlines, meetings, and integration failures.

## Railway architecture

- **Web service:** Next.js dashboard and signed webhook endpoints
- **Worker service:** idempotent Close and future Slack synchronization
- **PostgreSQL:** canonical prospects, replies, meetings, event history, and retry queue

Both services use this repository. The web service uses `railway.json`; configure the worker's Railway config file path as `/railway.worker.json` so it starts with `npm run worker` and does not expect an HTTP health endpoint.

## Safe setup

Copy `.env.example` to `.env.local`. Keep `DEMO_MODE=true` and `SEED_DEMO_DATA=true` until staging webhooks have been verified. Demo mode never creates live Close records or modifies campaigns.

Required Railway variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
DEMO_MODE=true
SEED_DEMO_DATA=true
APP_USER=vlad@venlutogroup.com
APP_PASSWORD=<long random password>
SMARTLEAD_WEBHOOK_SECRET=<random secret>
CAL_WEBHOOK_SECRET=<random secret>
```

Add `CLOSE_API_KEY`, `SMARTLEAD_API_KEY`, `CAL_API_KEY`, and `SLACK_WEBHOOK_URL` only when their staging flows are ready.

## Client TAM and list building

The List Builder keeps a durable master TAM per client: companies, contacts, source batches, ICP decisions, prior use, verification state, resumable job checkpoints, and exact export membership. It searches stored eligible contacts first and sources only the shortfall. Demo mode never calls enrichment providers or uploads to Smartlead.

Set `TAM_API_KEY` to expose the read-only Claude Code API. Authenticate with `Authorization: Bearer <TAM_API_KEY>` and use:

- `/api/internal/tam` for clients, TAM totals, batches, jobs, funnels and checkpoints
- `/api/internal/tam?resource=companies&limit=100&offset=0`
- `/api/internal/tam?resource=contacts&limit=100&offset=0`
- `/api/internal/tam?resource=job_contacts&job_id=<id>&limit=500&offset=0` for the exact approved/exported records

### Claude Code reconciliation and import

Send up to 1,000 records per request to `POST /api/internal/tam/import` using the same `Authorization: Bearer <TAM_API_KEY>` header. Reuse one stable `batchKey` for every chunk and retry; rows are idempotent within that batch.

```json
{
  "clientName": "Venluto",
  "batchKey": "venluto-tam-2026-09",
  "label": "Venluto TAM",
  "source": "Claude Code",
  "defaultSegment": "B2B SaaS",
  "records": [{
    "company_name": "Acme",
    "domain": "acme.com",
    "linkedin_url": "https://linkedin.com/company/acme",
    "provider_id": "source-123",
    "country": "UK",
    "segments": ["B2B SaaS", "Founder-led"],
    "icp_status": "fit",
    "icp_reason": "Matches size and industry"
  }]
}
```

Preview with `GET /api/internal/tam/import?clientName=Venluto&batchKey=venluto-tam-2026-09`. The response separates new, existing, existing-with-update, existing-with-new-segment, possible duplicates, and invalid records. Nothing enters the TAM yet.

Commit safe records in resumable chunks with `PATCH /api/internal/tam/import`:

```json
{"action":"commit","confirmation":"COMMIT TAM IMPORT","clientName":"Venluto","batchKey":"venluto-tam-2026-09","limit":500}
```

Repeat until `done` is `true`. Possible duplicates and invalid rows remain staged for review and are never silently discarded.

Discard an unwanted staged or safely reversible test batch with `DELETE /api/internal/tam/import`. This refuses to remove committed companies once contacts or prospects depend on them:

```json
{"action":"discard","confirmation":"DISCARD TAM IMPORT","clientName":"Venluto","batchKey":"probe-shape-001"}
```

Contact fields are flat: `first_name`, `last_name`, `title`, `email`, and `contact_linkedin_url`. A successful `POST` only stages rows; only the explicit confirmed `PATCH` above can commit them.

Malformed orphan recovery is intentionally narrower than batch discard. It requires an exact company ID and batch tag, and refuses deletion unless both company name and domain are empty and no contacts or prospects depend on it:

```json
{"action":"cleanup_malformed_company","confirmation":"DELETE MALFORMED COMPANY","clientName":"Venluto","batchKey":"probe-shape-001","companyId":50001}
```

## Workflow

1. Smartlead posts a reply to `/api/webhooks/smartlead`.
2. The immutable event is deduplicated by provider and external event ID.
3. The prospect is matched by normalized email or created, assigned to Vlad, and given a five-minute deadline.
4. A Close upsert job is queued with a stable idempotency key.
5. The worker creates or links the Interested lead in Close and records success or a retryable failure.
6. Cal.com posts bookings, cancellations, and reschedules to `/api/webhooks/cal`; bookings match by attendee email.
7. Failures appear on Today and can be requeued safely.

## State model

`new → replied_positive → action_due → meeting_booked → meeting_completed → qualified`

Side or terminal states are `nurture`, `not_interested`, and `do_not_contact`. Transitions are recorded in `prospect_transitions`.

## Historical import

Old Outbound OS people map to `prospects`, campaigns to `campaigns`, and legacy IDs to `external_refs`. Import from a read-only copy of the SQLite database, deduplicate on `normalized_email`, run in a transaction, and reconcile source/import counts before committing.

## Local development

```bash
npm install
npm run dev
npm test
```

The health endpoint is `/api/health`.
