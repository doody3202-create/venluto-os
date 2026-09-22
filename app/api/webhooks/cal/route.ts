import { d1, ensureDatabase, normalizeEmail, transitionProspect } from "../../_lib/db";

type CalPayload = { id?: string; triggerEvent?: string; type?: string; payload?: { uid?: string; title?: string; startTime?: string; endTime?: string; bookingUrl?: string; attendees?: Array<{email?:string}> } };

export async function POST(request: Request) {
  await ensureDatabase();
  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-cal-signature-256") !== secret && request.headers.get("x-venluto-webhook-secret") !== secret) return Response.json({error:"Invalid signature"},{status:401});
  const body = await request.json() as CalPayload;
  const data = body.payload ?? {};
  const uid = String(data.uid ?? body.id ?? "");
  const eventType = body.triggerEvent ?? body.type ?? "BOOKING_CREATED";
  if (!uid) return Response.json({error:"Booking UID is required"},{status:400});
  const db = d1();
  const externalEventId = `${eventType}:${uid}:${data.startTime ?? "na"}`;
  const inserted = await db.prepare("INSERT OR IGNORE INTO integration_events (provider,external_event_id,event_type,payload_json) VALUES (?,?,?,?)").bind("cal.com",externalEventId,eventType,JSON.stringify(body)).run();
  if (!inserted.meta.changes) return Response.json({ok:true,duplicate:true});
  const email = normalizeEmail(data.attendees?.[0]?.email ?? "");
  const prospect = await db.prepare("SELECT id FROM prospects WHERE normalized_email=?").bind(email).first<{id:number}>();
  if (!prospect) {
    await db.prepare("INSERT OR IGNORE INTO sync_jobs (provider,operation,idempotency_key,payload_json,status,attempts,last_error) VALUES (?,?,?,?,?,?,?)").bind("cal.com","reconcile_booking",`cal:${uid}`,JSON.stringify(body),"failed",1,"No prospect matched attendee email").run();
    return Response.json({error:"No matching prospect", surfaced:true},{status:422});
  }
  const status = eventType.includes("CANCEL") ? "cancelled" : "confirmed";
  await db.prepare(`INSERT INTO meetings (prospect_id,booking_uid,title,starts_at,ends_at,status,attendee_email,booking_url) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(booking_uid) DO UPDATE SET prospect_id=excluded.prospect_id,title=excluded.title,starts_at=excluded.starts_at,ends_at=excluded.ends_at,status=excluded.status,booking_url=excluded.booking_url`)
    .bind(prospect.id,uid,data.title ?? "Cal.com meeting",data.startTime ?? new Date().toISOString(),data.endTime ?? null,status,email,data.bookingUrl ?? null).run();
  await transitionProspect(prospect.id,status === "cancelled" ? "action_due" : "meeting_booked",`Cal.com ${eventType}`);
  await db.prepare("UPDATE integration_events SET processed_at=CURRENT_TIMESTAMP WHERE provider='cal.com' AND external_event_id=?").bind(externalEventId).run();
  return Response.json({ok:true,duplicate:false,prospectId:prospect.id,status},{status:201});
}
