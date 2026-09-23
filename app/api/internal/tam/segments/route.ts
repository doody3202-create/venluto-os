import { createHash, timingSafeEqual } from "node:crypto";
import { ensureDatabase, sql } from "@/lib/db";
export const dynamic="force-dynamic";

type Signal={key?:string;type?:string;title?:string;summary?:string;source_url?:string;observed_at?:string;metadata?:Record<string,unknown>};
type Update={domain?:string;segments?:string[];attributes?:Record<string,unknown>;signals?:Signal[]};
type Input={clientName?:string;batchKey?:string;updates?:Update[]};
const domain=(value:string)=>value.trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].split(':')[0];
const safe=(value:string,expected:string)=>{const a=Buffer.from(value),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b)};
function authorized(request:Request){const expected=process.env.TAM_API_KEY??"",provided=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??request.headers.get("x-api-key")??"";return Boolean(expected)&&safe(provided,expected)}

export async function GET(request:Request){
 if(!authorized(request))return Response.json({error:"Unauthorized"},{status:401});
 return Response.json({schemaVersion:"2026-09-23",purpose:"Attach Claude-researched segments, company attributes and public evidence to companies already in the Master TAM",method:"POST",limits:{updatesPerRequest:1000,signalsPerCompany:20},identity:"normalized company domain",body:{clientName:"Venluto",batchKey:"google-ads-hiring-2026-09",updates:[{domain:"example.com",segments:["service:google_ads","vertical:saas","signal:hiring_ppc"],attributes:{sub_niche:"Google Ads for SaaS",research_status:"researched"},signals:[{key:"job:example:ppc-1",type:"job_posting",title:"Hiring PPC Specialist",summary:"Public job post matched to the company's target vertical.",source_url:"https://example.com/job",observed_at:"2026-09-23T00:00:00Z",metadata:{role:"PPC Specialist",vertical:"saas"}}]}]},rules:["Only existing TAM companies are updated; unknown domains are returned as missing.","POST is idempotent: segments and signal keys are upserted.","Use stable batchKey and signal keys so interrupted work can be safely resumed.","No Smartlead upload or outreach is performed."]});
}

export async function POST(request:Request){
 if(!authorized(request))return Response.json({error:"Unauthorized"},{status:401});
 await ensureDatabase();const body=await request.json() as Input;
 if(!body.clientName?.trim()||!body.batchKey?.trim()||!Array.isArray(body.updates))return Response.json({error:"clientName, batchKey and updates are required"},{status:400});
 if(body.updates.length<1||body.updates.length>1000)return Response.json({error:"updates must contain 1 to 1,000 records"},{status:400});
 const batchKey=body.batchKey.trim(),[client]=await sql`SELECT id FROM clients WHERE name=${body.clientName.trim()}`;if(!client)return Response.json({error:"Client not found"},{status:404});
 const result={received:body.updates.length,matched:0,missing:0,segmentsApplied:0,signalsUpserted:0,attributesUpdated:0,missingDomains:[] as string[]};
 await sql.begin(async tx=>{for(const update of body.updates!){const normalized=domain(update.domain??"");if(!normalized){result.missing++;if(result.missingDomains.length<50)result.missingDomains.push(update.domain??"");continue}
   const [company]=await tx`SELECT cc.id client_company_id,c.id company_id FROM client_companies cc JOIN companies c ON c.id=cc.company_id WHERE cc.client_id=${client.id} AND c.domain=${normalized}`;
   if(!company){result.missing++;if(result.missingDomains.length<50)result.missingDomains.push(normalized);continue}result.matched++;
   if(update.attributes&&typeof update.attributes==='object'&&!Array.isArray(update.attributes)){await tx`UPDATE client_companies SET attributes_json=attributes_json||${JSON.stringify(update.attributes)}::jsonb,updated_at=NOW() WHERE id=${company.client_company_id}`;result.attributesUpdated++}
   for(const name of [...new Set((update.segments??[]).map(value=>value.trim()).filter(Boolean))]){const [segment]=await tx`INSERT INTO tam_segments(client_id,name) VALUES (${client.id},${name}) ON CONFLICT(client_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`;const inserted=await tx`INSERT INTO company_segments(client_company_id,segment_id,source) VALUES (${company.client_company_id},${segment.id},${batchKey}) ON CONFLICT(client_company_id,segment_id) DO UPDATE SET source=EXCLUDED.source RETURNING client_company_id`;result.segmentsApplied+=inserted.length}
   const signals=(update.signals??[]).slice(0,20);for(const signal of signals){const type=signal.type?.trim();if(!type)continue;const key=signal.key?.trim()||createHash('sha256').update(`${normalized}|${type}|${signal.source_url??''}|${signal.title??''}`).digest('hex').slice(0,32);await tx`INSERT INTO company_signals(client_id,company_id,signal_key,signal_type,title,summary,source_url,observed_at,metadata_json) VALUES (${client.id},${company.company_id},${key},${type},${signal.title?.trim()||null},${signal.summary?.trim()||null},${signal.source_url?.trim()||null},${signal.observed_at||null},${JSON.stringify(signal.metadata??{})}::jsonb) ON CONFLICT(client_id,company_id,signal_key) DO UPDATE SET signal_type=EXCLUDED.signal_type,title=EXCLUDED.title,summary=EXCLUDED.summary,source_url=EXCLUDED.source_url,observed_at=EXCLUDED.observed_at,metadata_json=EXCLUDED.metadata_json,updated_at=NOW()`;result.signalsUpserted++}
  }});
 return Response.json({ok:true,batchKey,...result,resumable:true});
}
