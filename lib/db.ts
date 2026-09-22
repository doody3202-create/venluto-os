import postgres from "postgres";

const globalDb = globalThis as unknown as { venlutoSql?: ReturnType<typeof postgres>; schemaReady?: Promise<void> };
export const sql = globalDb.venlutoSql ?? postgres(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/venluto", { max: 10, idle_timeout: 20 });
if (process.env.NODE_ENV !== "production") globalDb.venlutoSql = sql;
export const iso = (hours=0) => new Date(Date.now()+hours*3_600_000).toISOString();
export const normalizeEmail = (value:string) => value.trim().toLowerCase();

const schema = [
`CREATE TABLE IF NOT EXISTS owners (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, initials TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS companies (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, domain TEXT NOT NULL UNIQUE)`,
`CREATE TABLE IF NOT EXISTS prospects (id BIGSERIAL PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, normalized_email TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'new', owner_id BIGINT REFERENCES owners(id), company_id BIGINT REFERENCES companies(id), next_action TEXT, deadline_at TIMESTAMPTZ, close_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS campaigns (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'smartlead', external_id TEXT NOT NULL, UNIQUE(provider,external_id))`,
`CREATE TABLE IF NOT EXISTS external_refs (id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id BIGINT NOT NULL, external_id TEXT NOT NULL, metadata_json JSONB NOT NULL DEFAULT '{}', UNIQUE(provider,entity_type,external_id))`,
`CREATE TABLE IF NOT EXISTS integration_events (id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, external_event_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json JSONB NOT NULL, processed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(provider,external_event_id))`,
`CREATE TABLE IF NOT EXISTS replies (id BIGSERIAL PRIMARY KEY, prospect_id BIGINT NOT NULL REFERENCES prospects(id), campaign_id BIGINT REFERENCES campaigns(id), provider_reply_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, sentiment TEXT NOT NULL DEFAULT 'positive', received_at TIMESTAMPTZ NOT NULL)`,
`CREATE TABLE IF NOT EXISTS meetings (id BIGSERIAL PRIMARY KEY, prospect_id BIGINT REFERENCES prospects(id), booking_uid TEXT NOT NULL UNIQUE, title TEXT NOT NULL, starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ, status TEXT NOT NULL, attendee_email TEXT NOT NULL, booking_url TEXT)`,
`CREATE TABLE IF NOT EXISTS sync_jobs (id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_retry_at TIMESTAMPTZ, locked_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS prospect_transitions (id BIGSERIAL PRIMARY KEY, prospect_id BIGINT NOT NULL REFERENCES prospects(id), from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE INDEX IF NOT EXISTS idx_prospects_status_deadline ON prospects(status,deadline_at)`,
`CREATE INDEX IF NOT EXISTS idx_replies_prospect_received ON replies(prospect_id,received_at)`,
`CREATE INDEX IF NOT EXISTS idx_meetings_starts_status ON meetings(starts_at,status)`,
`CREATE INDEX IF NOT EXISTS idx_sync_jobs_ready ON sync_jobs(status,next_retry_at,updated_at)`,
];

export function ensureDatabase(){
 if(!globalDb.schemaReady) globalDb.schemaReady=(async()=>{for(const statement of schema) await sql.unsafe(statement); const [{count}]=await sql`SELECT COUNT(*)::int count FROM prospects`; if(!count&&process.env.SEED_DEMO_DATA!=="false") await seedDemo()})();
 return globalDb.schemaReady;
}

async function seedDemo(){
 await sql.begin(async tx=>{
  await tx`INSERT INTO owners(name,email,initials) VALUES ('Vlad','vlad@venlutogroup.com','VM') ON CONFLICT(email) DO NOTHING`;
  await tx`INSERT INTO companies(name,domain) VALUES ('Northstar Labs','northstarlabs.com'),('Atelier Health','atelierhealth.eu'),('Meridian Works','meridianworks.io'),('Aperture Systems','aperturesystems.com') ON CONFLICT(domain) DO NOTHING`;
  await tx`INSERT INTO campaigns(name,provider,external_id) VALUES ('Q3 · VP Sales · Process gap','smartlead','3583937'),('Founder · Lean team · EU','smartlead','3584021'),('COO · Case study · Services','smartlead','3584178') ON CONFLICT(provider,external_id) DO NOTHING`;
  const owners=await tx`SELECT id FROM owners WHERE email='vlad@venlutogroup.com'`; const owner=owners[0].id;
  const cs=await tx`SELECT id,domain FROM companies`; const cid=Object.fromEntries(cs.map(c=>[c.domain,c.id]));
  await tx`INSERT INTO prospects(first_name,last_name,email,normalized_email,title,source,status,owner_id,company_id,next_action,deadline_at,close_url) VALUES
   ('Alex','Morgan','alex@northstarlabs.com','alex@northstarlabs.com','VP Sales','Smartlead','action_due',${owner},${cid['northstarlabs.com']},'Send booking options',${iso(.08)},'https://app.close.com/lead/demo-alex'),
   ('Sophie','Laurent','sophie@atelierhealth.eu','sophie@atelierhealth.eu','Founder','Smartlead','action_due',${owner},${cid['atelierhealth.eu']},'Share relevant case study',${iso(2)},'https://app.close.com/lead/demo-sophie'),
   ('Daniel','Kim','daniel@meridianworks.io','daniel@meridianworks.io','COO','Smartlead','replied_positive',${owner},${cid['meridianworks.io']},'Respond to positive reply',${iso(.08)},NULL),
   ('Priya','Shah','priya@aperturesystems.com','priya@aperturesystems.com','Head of Growth','Referral','meeting_booked',${owner},${cid['aperturesystems.com']},'Prepare discovery notes',${iso(-2)},'https://app.close.com/lead/demo-priya') ON CONFLICT(normalized_email) DO NOTHING`;
  const ps=await tx`SELECT id,normalized_email FROM prospects`; const pid=Object.fromEntries(ps.map(p=>[p.normalized_email,p.id])); const camps=await tx`SELECT id,external_id FROM campaigns`;const camp=Object.fromEntries(camps.map(c=>[c.external_id,c.id]));
  await tx`INSERT INTO replies(prospect_id,campaign_id,provider_reply_id,body,sentiment,received_at) VALUES
   (${pid['alex@northstarlabs.com']},${camp['3583937']},'sl-reply-1001','This is interesting — we’re actually reviewing our outbound process this quarter. Could you send over a few times?','positive',${iso(-.2)}),
   (${pid['sophie@atelierhealth.eu']},${camp['3584021']},'sl-reply-1002','Happy to take a look. We’ve been trying to make this motion repeatable without adding another SDR.','positive',${iso(-.7)}),
   (${pid['daniel@meridianworks.io']},${camp['3584178']},'sl-reply-1003','Timing might be right. Can you share how you’ve approached this for another B2B services company?','positive',${iso(-1.1)}) ON CONFLICT(provider_reply_id) DO NOTHING`;
  await tx`INSERT INTO meetings(prospect_id,booking_uid,title,starts_at,ends_at,status,attendee_email,booking_url) VALUES (${pid['priya@aperturesystems.com']},'cal-demo-1001','Discovery call · Priya Shah',${iso(3)},${iso(3.5)},'confirmed','priya@aperturesystems.com','https://app.cal.com/booking/cal-demo-1001') ON CONFLICT(booking_uid) DO NOTHING`;
  await tx`INSERT INTO sync_jobs(provider,operation,idempotency_key,payload_json,status,attempts,last_error,next_retry_at) VALUES ('close','upsert_prospect','close:prospect:demo',${JSON.stringify({prospectId:pid['daniel@meridianworks.io']})}::jsonb,'failed',3,'Close returned 429 · rate limit exceeded',${iso(.25)}) ON CONFLICT(idempotency_key) DO NOTHING`;
 });
}

export async function transitionProspect(prospectId:number,toStatus:string,reason:string){const [p]=await sql`SELECT status FROM prospects WHERE id=${prospectId}`;if(!p||p.status===toStatus)return;await sql.begin(async tx=>{await tx`UPDATE prospects SET status=${toStatus},updated_at=NOW() WHERE id=${prospectId}`;await tx`INSERT INTO prospect_transitions(prospect_id,from_status,to_status,reason) VALUES (${prospectId},${p.status},${toStatus},${reason})`})}
