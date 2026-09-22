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
