import { ensureDatabase, sql } from "./db";

export async function tamDashboard(){
 await ensureDatabase();
 const [client]=await sql`INSERT INTO clients(name) VALUES ('Venluto') ON CONFLICT(name) DO UPDATE SET status='active' RETURNING id,name`;
 const [counts]=await sql`SELECT (SELECT COUNT(*)::int FROM client_companies WHERE client_id=${client.id}) companies,(SELECT COUNT(*)::int FROM tam_contacts WHERE client_id=${client.id}) contacts,(SELECT COUNT(*)::int FROM tam_contacts WHERE client_id=${client.id} AND email_status='valid' AND eligibility_status='eligible' AND NOT EXISTS(SELECT 1 FROM contact_usage u WHERE u.client_id=${client.id} AND u.contact_id=tam_contacts.id AND u.usage_type IN ('contacted','exported'))) ready,(SELECT COUNT(*)::int FROM tam_contacts WHERE client_id=${client.id} AND email_status='missing') need_email,(SELECT COUNT(*)::int FROM tam_contacts WHERE client_id=${client.id} AND email_status='unverified') need_verification,(SELECT COUNT(DISTINCT contact_id)::int FROM contact_usage WHERE client_id=${client.id} AND usage_type='contacted') contacted,(SELECT COUNT(*)::int FROM client_companies WHERE client_id=${client.id} AND icp_status='hold') held`;
 const jobs=await sql`SELECT j.*,c.name client_name,(SELECT json_agg(s ORDER BY s.id) FROM list_job_steps s WHERE s.job_id=j.id) steps,(SELECT row_to_json(e) FROM list_exports e WHERE e.job_id=j.id ORDER BY e.id DESC LIMIT 1) export FROM list_jobs j JOIN clients c ON c.id=j.client_id WHERE j.client_id=${client.id} ORDER BY j.created_at DESC`;
 const batches=await sql`SELECT id,provider,label,raw_count,created_at FROM source_batches WHERE client_id=${client.id} ORDER BY created_at DESC`;
 const segments=await sql`SELECT s.id,s.name,COUNT(cs.client_company_id)::int company_count FROM tam_segments s LEFT JOIN company_segments cs ON cs.segment_id=s.id WHERE s.client_id=${client.id} GROUP BY s.id ORDER BY company_count DESC,s.name`;
 const imports=await sql`SELECT id,external_batch_key,label,source,status,received_count,committed_count,counts_json,created_at,updated_at FROM tam_import_batches WHERE client_id=${client.id} ORDER BY created_at DESC LIMIT 10`;
 return {client,counts,jobs,batches,segments,imports,demoMode:process.env.DEMO_MODE!=="false"};
}
