import { ensureDatabase, sql } from "@/lib/db";
export const dynamic="force-dynamic";

const cell=(value:unknown)=>{const text=value==null?"":typeof value==="string"?value:JSON.stringify(value);return `"${text.replaceAll('"','""')}"`};

export async function GET(request:Request){
 await ensureDatabase();
 const clientId=Number(new URL(request.url).searchParams.get("clientId")??0);if(!clientId)return Response.json({error:"clientId is required"},{status:400});
 const [client]=await sql`SELECT id,name FROM clients WHERE id=${clientId} AND status='active'`;if(!client)return Response.json({error:"Client workspace not found"},{status:404});
 const rows=await sql`WITH segment_data AS (
   SELECT cs.client_company_id,json_agg(s.name ORDER BY s.name) segments
   FROM company_segments cs JOIN tam_segments s ON s.id=cs.segment_id GROUP BY cs.client_company_id
  ), signal_data AS (
   SELECT client_id,company_id,count(*)::int signal_count,json_agg(json_build_object('type',signal_type,'title',title,'summary',summary,'source_url',source_url,'observed_at',observed_at,'metadata',metadata_json) ORDER BY observed_at DESC NULLS LAST,id DESC) signals
   FROM company_signals GROUP BY client_id,company_id
  )
  SELECT cl.name client,cc.id client_company_id,c.id company_id,c.name company_name,c.domain,
   cc.icp_status,cc.icp_reason,cc.attributes_json,COALESCE(sd.segments,'[]'::json) segments,
   COALESCE(sig.signal_count,0) signal_count,COALESCE(sig.signals,'[]'::json) signals,
   tc.id contact_id,tc.first_name,tc.last_name,tc.title,tc.email,tc.linkedin_url contact_linkedin_url,
   tc.source_provider,tc.email_status,tc.eligibility_status,tc.eligibility_reason,tc.verified_at,
   sb.label source_batch,(SELECT count(*)::int FROM contact_usage u WHERE u.contact_id=tc.id) prior_use_count
  FROM client_companies cc JOIN clients cl ON cl.id=cc.client_id JOIN companies c ON c.id=cc.company_id
  LEFT JOIN tam_contacts tc ON tc.client_id=cc.client_id AND tc.company_id=cc.company_id
  LEFT JOIN source_batches sb ON sb.id=tc.source_batch_id LEFT JOIN segment_data sd ON sd.client_company_id=cc.id
  LEFT JOIN signal_data sig ON sig.client_id=cc.client_id AND sig.company_id=cc.company_id
  WHERE cl.id=${clientId} ORDER BY c.domain,tc.id`;
 const columns=["client","client_company_id","company_id","company_name","domain","icp_status","icp_reason","company_attributes","segments","signal_count","signals","contact_id","first_name","last_name","title","email","contact_linkedin_url","source_provider","email_status","eligibility_status","eligibility_reason","verified_at","source_batch","prior_use_count"];
 const csv=[columns.join(','),...rows.map(row=>columns.map(column=>cell(column==="company_attributes"?row.attributes_json:row[column])).join(','))].join('\n');
 const filename=`TAM-${String(client.name).replace(/[^a-z0-9_-]+/gi,'-')}.csv`;
 return new Response(csv,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${filename}"`,"cache-control":"no-store"}});
}
