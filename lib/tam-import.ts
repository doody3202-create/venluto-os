import { createHash } from "node:crypto";
import { ensureDatabase, normalizeEmail, sql } from "./db";

export type TamImportRecord={company_name?:string;domain?:string;linkedin_url?:string;provider_id?:string;country?:string;segment?:string;segments?:string[];icp_status?:string;icp_reason?:string;first_name?:string;last_name?:string;title?:string;email?:string;contact_linkedin_url?:string;[key:string]:unknown};
export type ImportRequest={clientName:string;batchKey:string;label?:string;source?:string;defaultSegment?:string;records:TamImportRecord[]};
const domain=(value:unknown)=>String(value??"").trim().toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split('/')[0];
const clean=(value:unknown)=>String(value??"").trim();
const jsonObject=(value:unknown):TamImportRecord=>{if(value&&typeof value==="object")return value as TamImportRecord;if(typeof value==="string"){try{const parsed=JSON.parse(value);return parsed&&typeof parsed==="object"?parsed as TamImportRecord:{}}catch{return {}}}return {}};
const nestedJsonObject=(value:unknown):TamImportRecord=>{let current=value;for(let i=0;i<2;i++){const parsed=jsonObject(current);if(Object.keys(parsed).length||typeof current!=="string")return parsed;try{current=JSON.parse(String(current))}catch{return {}}}return jsonObject(current)};
const rowKey=(record:TamImportRecord,index:number)=>clean(record.provider_id)||domain(record.domain)||clean(record.linkedin_url)||createHash("sha256").update(JSON.stringify(record)+index).digest("hex").slice(0,24);

async function refreshCounts(batchId:number){
 const rows=await sql`SELECT resolution,COUNT(*)::int count FROM tam_import_rows WHERE batch_id=${batchId} GROUP BY resolution`;
 const counts=Object.fromEntries(rows.map(r=>[r.resolution,r.count]));
 const [{received,committed}]=await sql`SELECT COUNT(*)::int received,COUNT(*) FILTER(WHERE status='committed')::int committed FROM tam_import_rows WHERE batch_id=${batchId}`;
 await sql`UPDATE tam_import_batches SET received_count=${received},committed_count=${committed},counts_json=${JSON.stringify(counts)}::jsonb,updated_at=NOW() WHERE id=${batchId}`;
 return {received,committed,...counts};
}

export async function stageImport(input:ImportRequest){
 await ensureDatabase();
 if(!input.clientName?.trim()||!input.batchKey?.trim())throw new Error("clientName and batchKey are required");
 if(!Array.isArray(input.records)||input.records.length<1||input.records.length>1000)throw new Error("records must contain 1–1,000 rows per request");
 const [client]=await sql`INSERT INTO clients(name) VALUES (${input.clientName.trim()}) ON CONFLICT(name) DO UPDATE SET status='active' RETURNING id,name`;
 const [batch]=await sql`INSERT INTO tam_import_batches(client_id,external_batch_key,label,source) VALUES (${client.id},${input.batchKey.trim()},${input.label?.trim()||input.batchKey.trim()},${input.source?.trim()||'Claude Code'}) ON CONFLICT(client_id,external_batch_key) DO UPDATE SET updated_at=NOW() RETURNING id,status`;
 for(let index=0;index<input.records.length;index++){
  const record=input.records[index],d=domain(record.domain),name=clean(record.company_name),linkedin=clean(record.linkedin_url),providerId=clean(record.provider_id),country=clean(record.country);
  let resolution="new",matchedCompanyId:null|number=null,reason="New company domain";
  if(!d){resolution="invalid";reason="Missing company domain"}
  else{
   const [exact]=await sql`SELECT c.id FROM client_companies cc JOIN companies c ON c.id=cc.company_id WHERE cc.client_id=${client.id} AND c.domain=${d} LIMIT 1`;
   if(exact){resolution="existing";matchedCompanyId=exact.id;reason="Matched normalized domain"}
   else if(linkedin){const [byLinkedin]=await sql`SELECT c.id FROM client_companies cc JOIN companies c ON c.id=cc.company_id WHERE cc.client_id=${client.id} AND cc.attributes_json->>'linkedin_url'=${linkedin} LIMIT 1`;if(byLinkedin){resolution="existing_new_segment";matchedCompanyId=byLinkedin.id;reason="Matched LinkedIn company URL"}}
   if(!matchedCompanyId&&providerId){const [byProvider]=await sql`SELECT c.id FROM client_companies cc JOIN companies c ON c.id=cc.company_id WHERE cc.client_id=${client.id} AND cc.attributes_json->>'provider_id'=${providerId} LIMIT 1`;if(byProvider){resolution="existing_update";matchedCompanyId=byProvider.id;reason="Matched provider company ID"}}
   if(!matchedCompanyId&&name&&country){const [possible]=await sql`SELECT c.id FROM client_companies cc JOIN companies c ON c.id=cc.company_id WHERE cc.client_id=${client.id} AND LOWER(REGEXP_REPLACE(c.name,'[^a-zA-Z0-9]','','g'))=LOWER(REGEXP_REPLACE(${name},'[^a-zA-Z0-9]','','g')) AND cc.attributes_json->>'country'=${country} LIMIT 1`;if(possible){resolution="possible_duplicate";matchedCompanyId=possible.id;reason="Same normalized name and country; review required"}}
  }
  const payload={...record,domain:d,company_name:name,segments:[...new Set([...(Array.isArray(record.segments)?record.segments:[]),clean(record.segment),clean(input.defaultSegment)].filter(Boolean))]};
  await sql`INSERT INTO tam_import_rows(batch_id,row_key,payload_json,resolution,matched_company_id,reason) VALUES (${batch.id},${rowKey(record,index)},${JSON.stringify(payload)}::jsonb,${resolution},${matchedCompanyId},${reason}) ON CONFLICT(batch_id,row_key) DO UPDATE SET payload_json=EXCLUDED.payload_json,resolution=EXCLUDED.resolution,matched_company_id=EXCLUDED.matched_company_id,reason=EXCLUDED.reason,updated_at=NOW()`;
 }
 const counts=await refreshCounts(batch.id);
 return {batchId:batch.id,batchKey:input.batchKey,status:batch.status,counts,resumable:true,next:"preview"};
}

export async function importStatus(batchKey:string,clientName:string){
 await ensureDatabase();
 const [batch]=await sql`SELECT b.*,c.name client_name FROM tam_import_batches b JOIN clients c ON c.id=b.client_id WHERE b.external_batch_key=${batchKey} AND c.name=${clientName}`;
 if(!batch)return null;
 const samples=await sql`SELECT id,row_key,resolution,reason,payload_json->>'company_name' company_name,payload_json->>'domain' domain,status FROM tam_import_rows WHERE batch_id=${batch.id} ORDER BY id LIMIT 12`;
 const segments=await sql`SELECT value segment,COUNT(*)::int count FROM tam_import_rows r CROSS JOIN LATERAL jsonb_array_elements_text(r.payload_json->'segments') value WHERE r.batch_id=${batch.id} GROUP BY value ORDER BY count DESC`;
 return {...batch,samples,segments};
}

export async function commitImport(batchKey:string,clientName:string,limit=500){
 await ensureDatabase();
 const [batch]=await sql`SELECT b.*,c.name client_name FROM tam_import_batches b JOIN clients c ON c.id=b.client_id WHERE b.external_batch_key=${batchKey} AND c.name=${clientName}`;
 if(!batch)throw new Error("Import batch not found");
 const rows=await sql`SELECT * FROM tam_import_rows WHERE batch_id=${batch.id} AND status='staged' AND resolution NOT IN ('invalid','possible_duplicate') ORDER BY id LIMIT ${Math.min(Math.max(limit,1),1000)}`;
 for(const row of rows){
  const p=jsonObject(row.payload_json),d=domain(p.domain),name=clean(p.company_name)||d,attributes={country:clean(p.country),linkedin_url:clean(p.linkedin_url),provider_id:clean(p.provider_id),last_import_batch:batch.external_batch_key};
  if(!d)throw new Error(`Refusing to commit row ${row.id}: normalized company domain is empty`);
  const [company]=row.matched_company_id?await sql`UPDATE companies SET name=CASE WHEN ${name}<>'' THEN ${name} ELSE name END WHERE id=${row.matched_company_id} RETURNING id`:await sql`INSERT INTO companies(name,domain) VALUES (${name},${d}) ON CONFLICT(domain) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
  const [cc]=await sql`INSERT INTO client_companies(client_id,company_id,icp_status,icp_reason,attributes_json) VALUES (${batch.client_id},${company.id},${clean(p.icp_status)||'unreviewed'},${clean(p.icp_reason)||null},${JSON.stringify(attributes)}::jsonb) ON CONFLICT(client_id,company_id) DO UPDATE SET icp_status=CASE WHEN EXCLUDED.icp_status<>'unreviewed' THEN EXCLUDED.icp_status ELSE client_companies.icp_status END,icp_reason=COALESCE(EXCLUDED.icp_reason,client_companies.icp_reason),attributes_json=client_companies.attributes_json||EXCLUDED.attributes_json,updated_at=NOW() RETURNING id`;
  for(const segmentName of (Array.isArray(p.segments)?p.segments:[]).map(clean).filter(Boolean)){const [segment]=await sql`INSERT INTO tam_segments(client_id,name) VALUES (${batch.client_id},${segmentName}) ON CONFLICT(client_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`;await sql`INSERT INTO company_segments(client_company_id,segment_id,source) VALUES (${cc.id},${segment.id},${batch.source}) ON CONFLICT DO NOTHING`}
  if(clean(p.icp_status))await sql`INSERT INTO icp_decisions(client_id,company_id,decision,reason_code,reason_text,criteria_json) VALUES (${batch.client_id},${company.id},${clean(p.icp_status)},'imported_decision',${clean(p.icp_reason)||null},${JSON.stringify({batchKey:batch.external_batch_key})}::jsonb)`;
  const email=normalizeEmail(clean(p.email));if(email||clean(p.contact_linkedin_url)){await sql`INSERT INTO tam_contacts(client_id,company_id,first_name,last_name,title,email,normalized_email,linkedin_url,email_status,eligibility_status) SELECT ${batch.client_id},${company.id},${clean(p.first_name)||'Unknown'},${clean(p.last_name)},${clean(p.title)},${email||null},${email||null},${clean(p.contact_linkedin_url)||null},${email?'unverified':'missing'},'eligible' WHERE NOT EXISTS(SELECT 1 FROM tam_contacts WHERE client_id=${batch.client_id} AND ((${email||null} IS NOT NULL AND normalized_email=${email||null}) OR (${clean(p.contact_linkedin_url)||null} IS NOT NULL AND linkedin_url=${clean(p.contact_linkedin_url)||null})))`}
  await sql`UPDATE tam_import_rows SET status='committed',updated_at=NOW() WHERE id=${row.id}`;
 }
 const counts=await refreshCounts(batch.id),[{remaining}]=await sql`SELECT COUNT(*)::int remaining FROM tam_import_rows WHERE batch_id=${batch.id} AND status='staged' AND resolution NOT IN ('invalid','possible_duplicate')`;
 const done=remaining===0;if(done)await sql`UPDATE tam_import_batches SET status='committed',updated_at=NOW() WHERE id=${batch.id}`;
 return {batchId:batch.id,processed:rows.length,remaining,done,counts,resumable:!done};
}

export async function discardImport(batchKey:string,clientName:string){
 await ensureDatabase();
 return sql.begin(async tx=>{
  const [client]=await tx`SELECT id FROM clients WHERE name=${clientName}`;
  if(!client)throw new Error("Client not found");
  const [batch]=await tx`SELECT b.*,c.name client_name FROM tam_import_batches b JOIN clients c ON c.id=b.client_id WHERE b.external_batch_key=${batchKey} AND c.name=${clientName} FOR UPDATE`;
  const created=batch
   ?await tx`SELECT DISTINCT c.id FROM tam_import_rows r JOIN companies c ON c.domain=r.payload_json->>'domain' WHERE r.batch_id=${batch.id} AND r.status='committed' AND r.resolution='new'`
   :await tx`SELECT DISTINCT c.id FROM client_companies cc JOIN companies c ON c.id=cc.company_id WHERE cc.client_id=${client.id} AND cc.attributes_json->>'last_import_batch'=${batchKey} AND (c.name='' OR c.domain='')`;
  const ids=created.map(row=>row.id as number);
  if(ids.length){
   const [{count:contacts}]=await tx`SELECT COUNT(*)::int count FROM tam_contacts WHERE client_id=${client.id} AND company_id=ANY(${ids})`;
   const [{count:prospects}]=await tx`SELECT COUNT(*)::int count FROM prospects WHERE company_id=ANY(${ids})`;
   if(contacts||prospects)throw new Error("Cannot discard: committed companies now have contacts or prospects. Review them manually.");
   await tx`DELETE FROM icp_decisions WHERE client_id=${client.id} AND company_id=ANY(${ids}) AND criteria_json->>'batchKey'=${batchKey}`;
   await tx`DELETE FROM company_segments WHERE client_company_id IN (SELECT id FROM client_companies WHERE client_id=${client.id} AND company_id=ANY(${ids}))`;
   await tx`DELETE FROM client_companies WHERE client_id=${client.id} AND company_id=ANY(${ids}) AND attributes_json->>'last_import_batch'=${batchKey}`;
  }
  if(batch){await tx`DELETE FROM tam_import_rows WHERE batch_id=${batch.id}`;await tx`DELETE FROM tam_import_batches WHERE id=${batch.id}`}
  if(ids.length)await tx`DELETE FROM companies WHERE id=ANY(${ids}) AND NOT EXISTS(SELECT 1 FROM client_companies cc WHERE cc.company_id=companies.id) AND NOT EXISTS(SELECT 1 FROM prospects p WHERE p.company_id=companies.id) AND NOT EXISTS(SELECT 1 FROM tam_contacts tc WHERE tc.company_id=companies.id)`;
  return {ok:true,batchKey,discardedRows:batch?.received_count??0,removedNewCompanies:ids.length,recoveredOrphanedBatch:!batch};
 });
}

export async function cleanupMalformedCompany(companyId:number,batchKey:string,clientName:string){
 await ensureDatabase();
 return sql.begin(async tx=>{
  const [row]=await tx`SELECT c.id,c.name,c.domain,cc.id client_company_id,cc.attributes_json FROM companies c JOIN client_companies cc ON cc.company_id=c.id JOIN clients cl ON cl.id=cc.client_id WHERE c.id=${companyId} AND cl.name=${clientName} FOR UPDATE`;
  if(!row)throw new Error("Company is not linked to this client");
  const attributes=nestedJsonObject(row.attributes_json);
  if(clean(attributes.last_import_batch)!==batchKey)throw new Error("Company batch tag does not match; nothing was deleted");
  if(clean(row.name)||clean(row.domain))throw new Error("Company is not malformed; cleanup refused");
  const [{contacts}]=await tx`SELECT COUNT(*)::int contacts FROM tam_contacts WHERE company_id=${companyId}`;
  const [{prospects}]=await tx`SELECT COUNT(*)::int prospects FROM prospects WHERE company_id=${companyId}`;
  if(contacts||prospects)throw new Error("Company has contacts or prospects; cleanup refused");
  await tx`DELETE FROM icp_decisions WHERE company_id=${companyId}`;
  await tx`DELETE FROM company_segments WHERE client_company_id=${row.client_company_id}`;
  await tx`DELETE FROM client_companies WHERE id=${row.client_company_id}`;
  await tx`DELETE FROM companies WHERE id=${companyId} AND NOT EXISTS(SELECT 1 FROM client_companies cc WHERE cc.company_id=${companyId})`;
  return {ok:true,companyId,batchKey,removedMalformedCompanies:1};
 });
}
