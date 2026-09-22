# Venluto OS

Venluto's internal operations dashboard for positive replies, prospect ownership, deadlines, meetings, and integration failures.

## Run the demo

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open the local URL printed by the dev server. The relational database and realistic demo data initialize on first use. `DEMO_MODE=true` prevents external writes; retrying a failure is simulated and no emails or live campaigns are touched.

## Current workflow

1. Smartlead sends a reply to `POST /api/webhooks/smartlead`.
2. Venluto OS stores the immutable event using `provider + event_id` as its idempotency key.
3. It matches a prospect by normalized email or creates one, stores the original reply and campaign, and moves the prospect to `action_due`.
4. It safely creates or links a Close lead. In demo mode this creates a clearly fake Close URL.
5. Cal.com sends booking changes to `POST /api/webhooks/cal`. The booking is matched by normalized attendee email; cancellations move the prospect back to `action_due`.
6. Any failed operation is written to `sync_jobs`, shown on Today, and can be retried with the same idempotency key.

For local webhook tests, either leave the relevant webhook secret blank or send it as `x-venluto-webhook-secret`. Configure the production provider to send the same secret. Keep `DEMO_MODE=true` until payloads have been validated against staging data.

## State machine

`new → replied_positive → action_due → meeting_booked → meeting_completed → qualified`

Side/terminal states reserved by the model are `nurture`, `not_interested`, and `do_not_contact`. Every automatic change is recorded in `prospect_transitions`; cancellation returns a prospect to `action_due` rather than silently moving backward.

## Historical Outbound OS import

The schema separates canonical records from provider IDs. Import old people into `prospects`, campaigns into `campaigns`, and write every legacy identifier to `external_refs` using provider names such as `outbound_os`, `smartlead`, or `close`. Deduplicate people on `normalized_email` and campaigns on `(provider, external_id)`.

Use a one-time adapter that reads the old SQLite database, transforms rows into this contract, and records source row IDs in `external_refs`. Keep the original database read-only, run the adapter in a transaction, and compare source/import counts before committing. This makes imports repeatable without coupling the live schema to the old database.

## Deployment

The app uses Cloudflare D1 locally and in Sites deployment. For another host, point the same relational schema at PostgreSQL and replace the small D1 access layer. Secrets belong in the hosting environment, never in source control.

## Starter/runtime notes

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
