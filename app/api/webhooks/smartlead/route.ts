import { d1, ensureDatabase, iso, normalizeEmail, transitionProspect } from "../../_lib/db";
import { syncProspectToClose } from "../../_lib/close";

type SmartleadPayload = { event_id?: string; event_type?: string; type?: string; reply_id?: string|number; lead_id?: string|number; campaign_id?: string|number; campaign_name?: string; email?: string; lead_email?: string; first_name?: string; last_name?: string; company_name?: string; company_domain?: string; reply_text?: string; message?: string; received_at?: string };

export async function POST(request: Request) {
  await ensureDatabase();
  const secret = process.env.SMARTLEAD_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-venluto-webhook-secret") !== secret) return Response.json({error:"Invalid signature"},{status:401});
  const payload = await request.json() as SmartleadPayload;
  const eventId = String(payload.event_id ?? payload.reply_id ?? `${payload.campaign_id}:${payload.lead_id}:${payload.received_at}`);
  const db = d1();
  const inserted = await db.prepare("INSERT OR IGNORE INTO integration_events (provider,external_event_id,event_type,payload_json) VALUES (?,?,?,?)")
    .bind("smartlead", eventId, payload.event_type ?? payload.type ?? "reply_received", JSON.stringify(payload)).run();
  if (!inserted.meta.changes) return Response.json({ok:true, duplicate:true});
  const email = normalizeEmail(payload.email ?? payload.lead_email ?? "");
  if (!email) return failEvent(eventId,"Smartlead payload has no lead email");
  let prospect = await db.prepare("SELECT id FROM prospects WHERE normalized_email=?").bind(email).first<{id:number}>();
  if (!prospect) {
    const companyName = payload.company_name ?? email.split("@")[1];
    const domain = payload.company_domain ?? email.split("@")[1];
    await db.prepare("INSERT OR IGNORE INTO companies (name,domain) VALUES (?,?)").bind(companyName,domain).run();
    const company = await db.prepare("SELECT id FROM companies WHERE domain=?").bind(domain).first<{id:number}>();
    const created = await db.prepare("INSERT INTO prospects (first_name,last_name,email,normalized_email,source,status,company_id,next_action,deadline_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id")
      .bind(payload.first_name ?? email.split("@")[0],payload.last_name ?? "",email,email,"Smartlead","replied_positive",company?.id ?? null,"Review positive reply",iso(2)).first<{id:number}>();
    prospect = created!;
  }
  const campaignExternalId = String(payload.campaign_id ?? "unknown");
  await db.prepare("INSERT OR IGNORE INTO campaigns (name,provider,external_id) VALUES (?,?,?)").bind(payload.campaign_name ?? `Smartlead ${campaignExternalId}`,"smartlead",campaignExternalId).run();
  const campaign = await db.prepare("SELECT id FROM campaigns WHERE provider='smartlead' AND external_id=?").bind(campaignExternalId).first<{id:number}>();
  await db.prepare("INSERT OR IGNORE INTO replies (prospect_id,campaign_id,provider_reply_id,body,sentiment,received_at) VALUES (?,?,?,?,?,?)")
    .bind(prospect.id,campaign?.id ?? null,String(payload.reply_id ?? eventId),payload.reply_text ?? payload.message ?? "(No reply body)","positive",payload.received_at ?? new Date().toISOString()).run();
  await transitionProspect(prospect.id,"action_due","Smartlead positive reply");
  await db.prepare("INSERT OR IGNORE INTO sync_jobs (provider,operation,idempotency_key,payload_json,status,attempts) VALUES (?,?,?,?,?,?)")
    .bind("close","upsert_prospect",`close:prospect:${prospect.id}`,JSON.stringify({prospectId:prospect.id}),"pending",0).run();
  const job=await db.prepare("SELECT id FROM sync_jobs WHERE idempotency_key=?").bind(`close:prospect:${prospect.id}`).first<{id:number}>();
  try { await syncProspectToClose(prospect.id,job?.id); } catch(error) { await db.prepare("UPDATE sync_jobs SET status='failed',attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(error instanceof Error?error.message:"Close sync failed",job?.id??0).run(); }
  await db.prepare("UPDATE integration_events SET processed_at=CURRENT_TIMESTAMP WHERE provider='smartlead' AND external_event_id=?").bind(eventId).run();
  return Response.json({ok:true, duplicate:false, prospectId:prospect.id},{status:201});
}

async function failEvent(eventId:string, message:string) {
  await d1().prepare("INSERT OR IGNORE INTO sync_jobs (provider,operation,idempotency_key,payload_json,status,attempts,last_error) VALUES (?,?,?,?,?,?,?)").bind("smartlead","ingest_reply",`smartlead:error:${eventId}`,"{}","failed",1,message).run();
  return Response.json({error:message},{status:422});
}
