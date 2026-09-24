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
`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS deal_value_cents BIGINT NOT NULL DEFAULT 0`,
`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS expected_close_date DATE`,
`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`,
`CREATE TABLE IF NOT EXISTS campaigns (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'smartlead', external_id TEXT NOT NULL, UNIQUE(provider,external_id))`,
`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'`,
`CREATE TABLE IF NOT EXISTS external_refs (id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id BIGINT NOT NULL, external_id TEXT NOT NULL, metadata_json JSONB NOT NULL DEFAULT '{}', UNIQUE(provider,entity_type,external_id))`,
`CREATE TABLE IF NOT EXISTS integration_events (id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, external_event_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json JSONB NOT NULL, processed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(provider,external_event_id))`,
`CREATE TABLE IF NOT EXISTS replies (id BIGSERIAL PRIMARY KEY, prospect_id BIGINT NOT NULL REFERENCES prospects(id), campaign_id BIGINT REFERENCES campaigns(id), provider_reply_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, sentiment TEXT NOT NULL DEFAULT 'positive', received_at TIMESTAMPTZ NOT NULL)`,
`ALTER TABLE replies ADD COLUMN IF NOT EXISTS reply_category TEXT`,
`CREATE TABLE IF NOT EXISTS meetings (id BIGSERIAL PRIMARY KEY, prospect_id BIGINT REFERENCES prospects(id), booking_uid TEXT NOT NULL UNIQUE, title TEXT NOT NULL, starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ, status TEXT NOT NULL, attendee_email TEXT NOT NULL, booking_url TEXT)`,
`CREATE TABLE IF NOT EXISTS sync_jobs (id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload_json JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_retry_at TIMESTAMPTZ, locked_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS prospect_transitions (id BIGSERIAL PRIMARY KEY, prospect_id BIGINT NOT NULL REFERENCES prospects(id), from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS operation_tasks (id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'today', status TEXT NOT NULL DEFAULT 'open', due_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS playbook_items (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', url TEXT, tag TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS roadmap_items (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', position INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS clients (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`ALTER TABLE clients ADD COLUMN IF NOT EXISTS api_key_hash TEXT`,
`CREATE TABLE IF NOT EXISTS source_batches (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), provider TEXT NOT NULL, external_batch_id TEXT, label TEXT NOT NULL, raw_count INTEGER NOT NULL DEFAULT 0, metadata_json JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(client_id,provider,external_batch_id))`,
`CREATE TABLE IF NOT EXISTS client_companies (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), company_id BIGINT NOT NULL REFERENCES companies(id), source_batch_id BIGINT REFERENCES source_batches(id), icp_status TEXT NOT NULL DEFAULT 'unreviewed', icp_reason TEXT, attributes_json JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(client_id,company_id))`,
`CREATE TABLE IF NOT EXISTS tam_contacts (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), company_id BIGINT NOT NULL REFERENCES companies(id), source_batch_id BIGINT REFERENCES source_batches(id), first_name TEXT NOT NULL, last_name TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', email TEXT, normalized_email TEXT, linkedin_url TEXT, email_status TEXT NOT NULL DEFAULT 'missing', verification_provider TEXT, verified_at TIMESTAMPTZ, eligibility_status TEXT NOT NULL DEFAULT 'eligible', eligibility_reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`ALTER TABLE tam_contacts ADD COLUMN IF NOT EXISTS source_provider TEXT`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_tam_contacts_client_email ON tam_contacts(client_id,normalized_email) WHERE normalized_email IS NOT NULL`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_tam_contacts_client_linkedin ON tam_contacts(client_id,linkedin_url) WHERE linkedin_url IS NOT NULL`,
`CREATE TABLE IF NOT EXISTS icp_decisions (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), company_id BIGINT REFERENCES companies(id), contact_id BIGINT REFERENCES tam_contacts(id), decision TEXT NOT NULL, reason_code TEXT NOT NULL, reason_text TEXT, criteria_json JSONB NOT NULL DEFAULT '{}', decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS contact_usage (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), contact_id BIGINT NOT NULL REFERENCES tam_contacts(id), campaign_ref TEXT, usage_type TEXT NOT NULL, used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), metadata_json JSONB NOT NULL DEFAULT '{}')`,
`CREATE TABLE IF NOT EXISTS list_jobs (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, broad_icp TEXT NOT NULL, target_titles TEXT[] NOT NULL DEFAULT '{}', desired_count INTEGER NOT NULL, exclusions TEXT[] NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', resume_token TEXT NOT NULL UNIQUE, metrics_json JSONB NOT NULL DEFAULT '{}', started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
`CREATE TABLE IF NOT EXISTS list_job_steps (id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES list_jobs(id), step_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', input_count INTEGER NOT NULL DEFAULT 0, output_count INTEGER NOT NULL DEFAULT 0, api_calls INTEGER NOT NULL DEFAULT 0, loss_reasons_json JSONB NOT NULL DEFAULT '{}', checkpoint_json JSONB NOT NULL DEFAULT '{}', started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, UNIQUE(job_id,step_key))`,
`CREATE TABLE IF NOT EXISTS list_job_contacts (job_id BIGINT NOT NULL REFERENCES list_jobs(id), contact_id BIGINT NOT NULL REFERENCES tam_contacts(id), disposition TEXT NOT NULL, reason_code TEXT, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(job_id,contact_id))`,
`CREATE TABLE IF NOT EXISTS list_exports (id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES list_jobs(id), destination TEXT NOT NULL, external_list_id TEXT, contact_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'approved', exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), metadata_json JSONB NOT NULL DEFAULT '{}')`,
`CREATE TABLE IF NOT EXISTS tam_segments (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, description TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(client_id,name))`,
`CREATE TABLE IF NOT EXISTS company_segments (client_company_id BIGINT NOT NULL REFERENCES client_companies(id), segment_id BIGINT NOT NULL REFERENCES tam_segments(id), source TEXT NOT NULL DEFAULT 'import', added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(client_company_id,segment_id))`,
`CREATE TABLE IF NOT EXISTS company_signals (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), company_id BIGINT NOT NULL REFERENCES companies(id), signal_key TEXT NOT NULL, signal_type TEXT NOT NULL, title TEXT, summary TEXT, source_url TEXT, observed_at TIMESTAMPTZ, metadata_json JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(client_id,company_id,signal_key))`,
`CREATE TABLE IF NOT EXISTS tam_import_batches (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), external_batch_key TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'staging', received_count INTEGER NOT NULL DEFAULT 0, committed_count INTEGER NOT NULL DEFAULT 0, counts_json JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(client_id,external_batch_key))`,
`CREATE TABLE IF NOT EXISTS tam_import_rows (id BIGSERIAL PRIMARY KEY, batch_id BIGINT NOT NULL REFERENCES tam_import_batches(id), row_key TEXT NOT NULL, payload_json JSONB NOT NULL, resolution TEXT NOT NULL, matched_company_id BIGINT REFERENCES companies(id), reason TEXT, status TEXT NOT NULL DEFAULT 'staged', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(batch_id,row_key))`,
`CREATE TABLE IF NOT EXISTS client_campaigns (client_id BIGINT NOT NULL REFERENCES clients(id), campaign_id BIGINT NOT NULL REFERENCES campaigns(id), matched_by TEXT NOT NULL DEFAULT 'campaign_name', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(client_id,campaign_id))`,
`CREATE TABLE IF NOT EXISTS campaign_daily_metrics (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL REFERENCES clients(id), campaign_id BIGINT REFERENCES campaigns(id), metric_date DATE NOT NULL, people_contacted INTEGER NOT NULL DEFAULT 0, emails_sent INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0, positive_replies INTEGER NOT NULL DEFAULT 0, meetings_booked INTEGER NOT NULL DEFAULT 0, meetings_completed INTEGER NOT NULL DEFAULT 0, closed_won INTEGER NOT NULL DEFAULT 0, revenue_cents BIGINT NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'smartlead', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(client_id,campaign_id,metric_date))`,
`CREATE TABLE IF NOT EXISTS campaign_analytics_snapshots (client_id BIGINT NOT NULL REFERENCES clients(id), range_key TEXT NOT NULL, metrics_json JSONB NOT NULL DEFAULT '{}', synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(client_id,range_key))`,
`ALTER TABLE campaign_daily_metrics ADD COLUMN IF NOT EXISTS uncontacted_leads INTEGER NOT NULL DEFAULT 0`,
`ALTER TABLE campaign_daily_metrics ADD COLUMN IF NOT EXISTS opportunities INTEGER NOT NULL DEFAULT 0`,
`CREATE INDEX IF NOT EXISTS idx_prospects_status_deadline ON prospects(status,deadline_at)`,
`CREATE INDEX IF NOT EXISTS idx_replies_prospect_received ON replies(prospect_id,received_at)`,
`CREATE INDEX IF NOT EXISTS idx_replies_campaign_received ON replies(campaign_id,received_at)`,
`CREATE INDEX IF NOT EXISTS idx_meetings_prospect_starts ON meetings(prospect_id,starts_at)`,
`CREATE INDEX IF NOT EXISTS idx_meetings_starts_status ON meetings(starts_at,status)`,
`CREATE INDEX IF NOT EXISTS idx_sync_jobs_ready ON sync_jobs(status,next_retry_at,updated_at)`,
`CREATE INDEX IF NOT EXISTS idx_operation_tasks_status_due ON operation_tasks(status,due_at,created_at)`,
`CREATE INDEX IF NOT EXISTS idx_tam_contacts_eligibility ON tam_contacts(client_id,eligibility_status,email_status)`,
`CREATE INDEX IF NOT EXISTS idx_contact_usage_lookup ON contact_usage(client_id,contact_id,usage_type)`,
`CREATE INDEX IF NOT EXISTS idx_list_jobs_client_status ON list_jobs(client_id,status,updated_at)`,
`CREATE INDEX IF NOT EXISTS idx_tam_import_rows_batch_status ON tam_import_rows(batch_id,status,id)`,
`CREATE INDEX IF NOT EXISTS idx_company_segments_segment ON company_segments(segment_id,client_company_id)`,
`CREATE INDEX IF NOT EXISTS idx_company_signals_lookup ON company_signals(client_id,company_id,signal_type)`,
`CREATE INDEX IF NOT EXISTS idx_campaign_daily_metrics_client_date ON campaign_daily_metrics(client_id,metric_date)`,
`UPDATE tam_contacts tc SET eligibility_status='held',eligibility_reason='Company ICP status is hold',updated_at=NOW() FROM client_companies cc WHERE cc.client_id=tc.client_id AND cc.company_id=tc.company_id AND cc.icp_status IN ('hold','held') AND tc.eligibility_status='eligible'`,
`CREATE OR REPLACE FUNCTION sync_tam_contact_eligibility_from_company() RETURNS TRIGGER AS $$ BEGIN IF NEW.icp_status IN ('hold','held','excluded','rejected','not_fit') THEN UPDATE tam_contacts SET eligibility_status='held',eligibility_reason='Company ICP status is '||NEW.icp_status,updated_at=NOW() WHERE client_id=NEW.client_id AND company_id=NEW.company_id AND (eligibility_status='eligible' OR eligibility_reason LIKE 'Company ICP status is %'); ELSIF TG_OP='UPDATE' AND OLD.icp_status IN ('hold','held','excluded','rejected','not_fit') THEN UPDATE tam_contacts SET eligibility_status='eligible',eligibility_reason=NULL,updated_at=NOW() WHERE client_id=NEW.client_id AND company_id=NEW.company_id AND eligibility_status='held' AND eligibility_reason LIKE 'Company ICP status is %'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_sync_tam_contact_eligibility ON client_companies`,
`CREATE TRIGGER trg_sync_tam_contact_eligibility AFTER INSERT OR UPDATE OF icp_status ON client_companies FOR EACH ROW EXECUTE FUNCTION sync_tam_contact_eligibility_from_company()`,
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
