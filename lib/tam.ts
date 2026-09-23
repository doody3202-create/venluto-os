import { randomUUID } from "node:crypto";
import { ensureDatabase, sql } from "./db";

export async function ensureDemoTam(){
 await ensureDatabase();
 const [client]=await sql`INSERT INTO clients(name) VALUES ('Northstar Growth — Demo Client') ON CONFLICT(name) DO UPDATE SET status='active' RETURNING id,name`;
 const [batch]=await sql`INSERT INTO source_batches(client_id,provider,external_batch_id,label,raw_count,metadata_json) VALUES (${client.id},'demo','tam-50000','Imported master TAM · 50,000 companies',50000,${JSON.stringify({safeDemo:true,generated:true})}::jsonb) ON CONFLICT(client_id,provider,external_batch_id) DO UPDATE SET raw_count=EXCLUDED.raw_count RETURNING id`;
 const [{count}]=await sql`SELECT COUNT(*)::int count FROM client_companies WHERE client_id=${client.id}`;
 if(count<50000){
  await sql.begin(async tx=>{
   await tx`INSERT INTO companies(name,domain) SELECT 'Demo Company '||g, 'tam-'||g||'.example.com' FROM generate_series(1,50000) g ON CONFLICT(domain) DO NOTHING`;
   await tx`INSERT INTO client_companies(client_id,company_id,source_batch_id,icp_status,icp_reason,attributes_json) SELECT ${client.id},c.id,${batch.id},CASE WHEN n.n<=45000 THEN 'fit' ELSE 'hold' END,CASE WHEN n.n<=45000 THEN 'Matches broad B2B services ICP' ELSE 'Held for another offer' END,jsonb_build_object('employees',20+(n.n%980),'country',CASE WHEN n.n%3=0 THEN 'UK' ELSE 'US' END,'industry','B2B Services') FROM (SELECT id,row_number() OVER(ORDER BY id) n FROM companies WHERE domain LIKE 'tam-%.example.com' LIMIT 50000) n JOIN companies c ON c.id=n.id ON CONFLICT(client_id,company_id) DO NOTHING`;
   await tx`INSERT INTO tam_contacts(client_id,company_id,source_batch_id,first_name,last_name,title,email,normalized_email,linkedin_url,email_status,verification_provider,verified_at,eligibility_status,eligibility_reason)
    SELECT ${client.id},cc.company_id,${batch.id},'Contact',g::text,CASE WHEN g%2=0 THEN 'Founder' ELSE 'CEO' END,
    CASE WHEN g<=1500 OR (g>1800 AND g<=2800) THEN 'contact'||g||'@tam-'||g||'.example.com' ELSE NULL END,
    CASE WHEN g<=1500 OR (g>1800 AND g<=2800) THEN 'contact'||g||'@tam-'||g||'.example.com' ELSE NULL END,
    'https://linkedin.com/in/venluto-demo-'||g,
    CASE WHEN g<=1500 THEN 'valid' WHEN g<=1800 THEN 'missing' WHEN g<=2000 THEN 'unverified' WHEN g<=2800 THEN 'valid' ELSE 'invalid' END,
    CASE WHEN g<=1500 OR (g>2000 AND g<=2800) THEN 'Reoon' ELSE NULL END,
    CASE WHEN g<=1500 OR (g>2000 AND g<=2800) THEN NOW()-INTERVAL '4 days' ELSE NULL END,
    CASE WHEN g<=2800 THEN 'eligible' ELSE 'held' END,
    CASE WHEN g<=2800 THEN NULL ELSE 'Held for another offer — not deleted' END
    FROM generate_series(1,3000) g JOIN client_companies cc ON cc.client_id=${client.id} AND cc.company_id=(SELECT id FROM companies WHERE domain='tam-'||g||'.example.com')
    ON CONFLICT DO NOTHING`;
   await tx`INSERT INTO contact_usage(client_id,contact_id,campaign_ref,usage_type,used_at) SELECT ${client.id},id,'historical-demo','contacted',NOW()-INTERVAL '60 days' FROM tam_contacts WHERE client_id=${client.id} AND split_part(first_name||last_name,'Contact',2)::int BETWEEN 2001 AND 2800 AND NOT EXISTS(SELECT 1 FROM contact_usage u WHERE u.client_id=${client.id} AND u.contact_id=tam_contacts.id)`;
  });
 }
 return client;
}

export async function createDemoJob(){
 const client=await ensureDemoTam();
 const [existing]=await sql`SELECT id,status FROM list_jobs WHERE client_id=${client.id} AND name='September founder list · 2,000' ORDER BY id DESC LIMIT 1`;
 if(existing?.status==='ready')return existing.id as number;
 const metrics={tamCompanies:50000,requested:2000,existingReady:1500,needEmail:300,needVerification:200,alreadyContacted:800,shortfall:500,sourcedRaw:650,deduplicated:570,eligibleAfterQualification:540,verifiedNew:500,ready:2000,apiCallsUsed:1190,apiCallsAvoided:4500,estimatedMinutesWithoutReuse:137,actualSeconds:222,costAvoidedUsd:96.5};
 const [job]=existing?[existing]:await sql`INSERT INTO list_jobs(client_id,name,broad_icp,target_titles,desired_count,exclusions,status,resume_token,metrics_json,started_at) VALUES (${client.id},'September founder list · 2,000','B2B services companies, 20–1,000 employees, UK and US',${['Founder','Co-Founder','CEO']},2000,${['Previously contacted','Invalid email','Non-B2B','Agencies under 10 employees']},'running',${randomUUID()},${JSON.stringify(metrics)}::jsonb,NOW()-INTERVAL '222 seconds') RETURNING id,status`;
 const steps=[
  ['tam_reuse',50000,1500,0,{held_for_other_offer:5000,already_contacted:800,needs_email:300,needs_verification:200}],
  ['source_shortfall',500,650,650,{}],
  ['deduplicate',650,570,0,{duplicate_company_or_contact:80}],
  ['qualify',570,540,0,{excluded_or_wrong_title:30}],
  ['enrich',540,520,20,{email_not_found:20}],
  ['verify',520,500,520,{invalid_or_risky:20}],
  ['approve_export',2000,2000,0,{}]
 ] as const;
 for(const [key,input,output,calls,losses] of steps)await sql`INSERT INTO list_job_steps(job_id,step_key,status,input_count,output_count,api_calls,loss_reasons_json,checkpoint_json,started_at,completed_at) VALUES (${job.id},${key},'completed',${input},${output},${calls},${JSON.stringify(losses)}::jsonb,${JSON.stringify({resumable:true,version:1})}::jsonb,NOW()-INTERVAL '222 seconds',NOW()) ON CONFLICT(job_id,step_key) DO UPDATE SET status='completed',input_count=EXCLUDED.input_count,output_count=EXCLUDED.output_count,api_calls=EXCLUDED.api_calls,loss_reasons_json=EXCLUDED.loss_reasons_json,checkpoint_json=EXCLUDED.checkpoint_json,completed_at=NOW()`;
 const [sourceBatch]=await sql`INSERT INTO source_batches(client_id,provider,external_batch_id,label,raw_count,metadata_json) VALUES (${client.id},'demo-provider',${`job-${job.id}-shortfall`},'Shortfall source · demo provider',650,${JSON.stringify({successfulSearchReusedOnResume:true})}::jsonb) ON CONFLICT(client_id,provider,external_batch_id) DO UPDATE SET raw_count=EXCLUDED.raw_count RETURNING id`;
 await sql`INSERT INTO tam_contacts(client_id,company_id,source_batch_id,first_name,last_name,title,email,normalized_email,linkedin_url,email_status,verification_provider,verified_at,eligibility_status)
  SELECT ${client.id},c.id,${sourceBatch.id},'New','Contact '||g,CASE WHEN g%2=0 THEN 'Founder' ELSE 'CEO' END,'new-contact-'||g||'@tam-'||(3000+g)||'.example.com','new-contact-'||g||'@tam-'||(3000+g)||'.example.com','https://linkedin.com/in/venluto-demo-new-'||g,'valid','Reoon',NOW(),'eligible'
  FROM generate_series(1,500) g JOIN companies c ON c.domain='tam-'||(3000+g)||'.example.com' ON CONFLICT DO NOTHING`;
 await sql`INSERT INTO list_job_contacts(job_id,contact_id,disposition,reason_code) SELECT ${job.id},id,'approved','reused_from_tam' FROM tam_contacts tc WHERE client_id=${client.id} AND source_batch_id<>${sourceBatch.id} AND email_status='valid' AND eligibility_status='eligible' AND NOT EXISTS(SELECT 1 FROM contact_usage u WHERE u.client_id=tc.client_id AND u.contact_id=tc.id AND u.usage_type IN ('contacted','exported')) ORDER BY id LIMIT 1500 ON CONFLICT DO NOTHING`;
 await sql`INSERT INTO list_job_contacts(job_id,contact_id,disposition,reason_code) SELECT ${job.id},id,'approved','sourced_for_shortfall' FROM tam_contacts WHERE client_id=${client.id} AND source_batch_id=${sourceBatch.id} ORDER BY id LIMIT 500 ON CONFLICT DO NOTHING`;
 await sql`INSERT INTO list_exports(job_id,destination,external_list_id,contact_count,status,metadata_json) SELECT ${job.id},'Smartlead-ready CSV',NULL,2000,'approved',${JSON.stringify({demo:true,liveUpload:false,reusedContacts:1500,sourcedContacts:500})}::jsonb WHERE NOT EXISTS(SELECT 1 FROM list_exports WHERE job_id=${job.id})`;
 await sql`UPDATE list_jobs SET status='ready',metrics_json=${JSON.stringify(metrics)}::jsonb,completed_at=NOW(),updated_at=NOW() WHERE id=${job.id}`;
 return job.id as number;
}

export async function tamDashboard(){
 const client=await ensureDemoTam();
 const [counts]=await sql`SELECT (SELECT COUNT(*)::int FROM client_companies WHERE client_id=${client.id}) companies,(SELECT COUNT(*)::int FROM tam_contacts WHERE client_id=${client.id}) contacts,(SELECT COUNT(*)::int FROM tam_contacts WHERE client_id=${client.id} AND email_status='valid' AND eligibility_status='eligible' AND NOT EXISTS(SELECT 1 FROM contact_usage u WHERE u.client_id=${client.id} AND u.contact_id=tam_contacts.id AND u.usage_type IN ('contacted','exported'))) ready,(SELECT COUNT(*)::int FROM tam_contacts WHERE client_id=${client.id} AND email_status='missing') need_email,(SELECT COUNT(*)::int FROM tam_contacts WHERE client_id=${client.id} AND email_status='unverified') need_verification,(SELECT COUNT(DISTINCT contact_id)::int FROM contact_usage WHERE client_id=${client.id} AND usage_type='contacted') contacted,(SELECT COUNT(*)::int FROM client_companies WHERE client_id=${client.id} AND icp_status='hold') held`;
 const jobs=await sql`SELECT j.*,c.name client_name,(SELECT json_agg(s ORDER BY s.id) FROM list_job_steps s WHERE s.job_id=j.id) steps,(SELECT row_to_json(e) FROM list_exports e WHERE e.job_id=j.id ORDER BY e.id DESC LIMIT 1) export FROM list_jobs j JOIN clients c ON c.id=j.client_id WHERE j.client_id=${client.id} ORDER BY j.created_at DESC`;
 const batches=await sql`SELECT id,provider,label,raw_count,created_at FROM source_batches WHERE client_id=${client.id} ORDER BY created_at DESC`;
 const segments=await sql`SELECT s.id,s.name,COUNT(cs.client_company_id)::int company_count FROM tam_segments s LEFT JOIN company_segments cs ON cs.segment_id=s.id WHERE s.client_id=${client.id} GROUP BY s.id ORDER BY company_count DESC,s.name`;
 const imports=await sql`SELECT id,external_batch_key,label,source,status,received_count,committed_count,counts_json,created_at,updated_at FROM tam_import_batches WHERE client_id=${client.id} ORDER BY created_at DESC LIMIT 10`;
 return {client,counts,jobs,batches,segments,imports,demoMode:process.env.DEMO_MODE!=="false"};
}
