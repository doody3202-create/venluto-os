import { createHmac, timingSafeEqual } from "node:crypto";
import { ensureDatabase, iso, normalizeEmail, sql, transitionProspect } from "@/lib/db";
import { notifySlack } from "@/lib/slack";

type Payload = {
  id?: string; event_id?: string; event_type?: string; type?: string;
  reply_id?: string|number; message_id?: string; webhook_id?: string|number;
  lead_id?: string|number; sl_email_lead_id?: string|number; campaign_id?: string|number;
  campaign_name?: string; email?: string; lead_email?: string; sl_lead_email?: string;
  to_email?: string; to_name?: string; first_name?: string; last_name?: string;
  company_name?: string; company_domain?: string; reply_text?: string; message?: string;
  preview_text?: string; reply_body?: string; message_body?: string; received_at?: string; event_timestamp?: string;
  secret_key?: string; reply_category?: CategoryValue; lead_category?: CategoryValue;
  category?: CategoryValue; category_name?: string; lead_category_name?: string;
  lead_first_name?: string; lead_last_name?: string;
  reply_message?: { message_id?: string; text?: string; html?: string; time?: string };
  leadCorrespondence?: { targetLeadEmail?: string; replyReceivedFrom?: string; repliedCompanyDomain?: string };
};
type CategoryValue=string|number|Record<string,unknown>;

const safeEqual=(a:string,b:string)=>{const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb)};
const plain=(value:string)=>value.replace(/<br\s*\/?>/gi,"\n").replace(/<\/(p|div|li)>/gi,"\n\n").replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/\r/g,"").replace(/[ \t]+/g," ").replace(/\n[ \t]+/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
const categoryStrings=(value:unknown,depth=0):string[]=>{if(value===undefined||value===null||depth>4)return[];if(typeof value==="string")return[value.trim()];if(typeof value==="number")return[String(value)];if(Array.isArray(value))return value.flatMap(item=>categoryStrings(item,depth+1));if(typeof value==="object")return Object.values(value as Record<string,unknown>).flatMap(item=>categoryStrings(item,depth+1));return[]};

export async function POST(request:Request){
 await ensureDatabase();
 const raw=await request.text();
 let p:Payload;try{p=JSON.parse(raw)}catch{return Response.json({error:"Invalid JSON"},{status:400})}
 const secret=process.env.SMARTLEAD_WEBHOOK_SECRET;
 if(!secret)return Response.json({error:"Webhook secret is not configured"},{status:503});
 const urlSecret=new URL(request.url).searchParams.get("secret")??"";
 const headerSecret=request.headers.get("x-venluto-webhook-secret")??request.headers.get("x-smartlead-secret")??"";
 const signature=(request.headers.get("x-smartlead-signature")??"").replace(/^sha256=/,"");
 const expected=createHmac("sha256",secret).update(raw).digest("hex");
 if(![urlSecret,headerSecret,p.secret_key??""].some(v=>v&&safeEqual(v,secret))&&!(signature&&safeEqual(signature,expected)))return Response.json({error:"Invalid signature"},{status:401});
 const eventType=String(p.event_type??p.type??"EMAIL_REPLY").toUpperCase();
 if(!["EMAIL_REPLY","LEAD_CATEGORY_UPDATED"].includes(eventType)){console.info("Smartlead event ignored",{eventType,reason:"event_type"});return Response.json({ok:true,ignored:true,eventType})}
 const allowedCategories=(process.env.SMARTLEAD_POSITIVE_CATEGORIES??"Interested,Meeting Request,Information Request").split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
 const categoryValues=categoryStrings(p.lead_category_name??p.category_name??p.lead_category??p.reply_category??p.category);
 const category=categoryValues.find(value=>allowedCategories.includes(value.toLowerCase()))??categoryValues[0]??"";
 const incomingCampaign=(p.campaign_name??"").trim();
 const [knownCampaign]=p.campaign_id?await sql`SELECT name FROM campaigns WHERE provider='smartlead' AND external_id=${String(p.campaign_id)} LIMIT 1`:[];
 const resolvedCampaign=incomingCampaign||String(knownCampaign?.name??"");
 const activeClients=await sql`SELECT id,name FROM clients WHERE status='active' ORDER BY LENGTH(name) DESC`;
 const matchedClient=activeClients.find(client=>resolvedCampaign.toLowerCase().includes(String(client.name).toLowerCase()));
 if(!matchedClient){console.info("Smartlead event ignored",{eventType,category,campaign:resolvedCampaign||null,reason:"no_client_workspace_match"});return Response.json({ok:true,ignored:true,reason:"no_client_workspace_match",campaign:resolvedCampaign})}
 if(!category||!allowedCategories.includes(category.toLowerCase())){
  // A lead can be moved out of an opportunity category in Smartlead. Reflect that
  // immediately so it disappears from Tasks and Replies instead of becoming stale.
  if(eventType==="LEAD_CATEGORY_UPDATED"){
   const changedEmail=normalizeEmail(p.leadCorrespondence?.targetLeadEmail??p.sl_lead_email??p.lead_email??p.to_email??p.email??"");
   if(changedEmail){
    const [changedProspect]=await sql`SELECT id,status FROM prospects WHERE normalized_email=${changedEmail}`;
    if(changedProspect){
     await sql.begin(async tx=>{
      await tx`UPDATE prospects SET status='not_relevant',next_action=NULL,deadline_at=NULL,updated_at=NOW() WHERE id=${changedProspect.id}`;
      await tx`UPDATE replies SET sentiment='neutral',reply_category=${category||'Uncategorized'} WHERE prospect_id=${changedProspect.id} AND campaign_id IN (SELECT id FROM campaigns WHERE provider='smartlead' AND external_id=${String(p.campaign_id??'')})`;
      await tx`INSERT INTO prospect_transitions(prospect_id,from_status,to_status,reason) VALUES (${changedProspect.id},${changedProspect.status},'not_relevant',${`Smartlead category changed to ${category||'Uncategorized'}`})`;
     });
     return Response.json({ok:true,prospectId:changedProspect.id,status:"not_relevant",category:category||null});
    }
   }
  }
  console.info("Smartlead event ignored",{eventType,category:category||null,reason:"reply_category"});return Response.json({ok:true,ignored:true,reason:"reply_category",category:category||null})
 }
 console.info("Smartlead positive event accepted",{eventType,category,campaign:incomingCampaign,leadId:String(p.sl_email_lead_id??p.lead_id??"")});
 const requestId=request.headers.get("x-request-id"),replyId=String(p.reply_message?.message_id??p.message_id??p.reply_id??"");
 const eventId=String(requestId??p.event_id??p.id??(replyId||`${p.campaign_id}:${p.sl_email_lead_id??p.lead_id}:${p.event_timestamp??p.received_at}`));
 const inserted=await sql`INSERT INTO integration_events(provider,external_event_id,event_type,payload_json) VALUES ('smartlead',${eventId},${eventType},${raw}::jsonb) ON CONFLICT(provider,external_event_id) DO NOTHING RETURNING id`;
 if(!inserted.length)return Response.json({ok:true,duplicate:true});
 const email=normalizeEmail(p.leadCorrespondence?.targetLeadEmail??p.sl_lead_email??p.lead_email??p.to_email??p.email??"");
 if(!email){await fail(eventId,"Smartlead payload has no lead email",raw);return Response.json({error:"Missing lead email"},{status:422})}
 const name=(p.to_name??"").trim().split(/\s+/);const firstName=p.first_name??p.lead_first_name??name.shift()??email.split('@')[0],lastName=p.last_name??p.lead_last_name??name.join(' ');
 let [prospect]=await sql`SELECT id FROM prospects WHERE normalized_email=${email}`;
 if(!prospect){const domain=p.company_domain??p.leadCorrespondence?.repliedCompanyDomain??email.split('@')[1];const [company]=await sql`INSERT INTO companies(name,domain) VALUES (${p.company_name??domain},${domain}) ON CONFLICT(domain) DO UPDATE SET name=EXCLUDED.name RETURNING id`;[prospect]=await sql`INSERT INTO prospects(first_name,last_name,email,normalized_email,source,status,owner_id,company_id,next_action,deadline_at) VALUES (${firstName},${lastName},${email},${email},'Smartlead','replied_positive',(SELECT id FROM owners WHERE email='vlad@venlutogroup.com'),${company.id},'Respond to positive reply',${iso(5/60)}) RETURNING id`}
 const ext=String(p.campaign_id??'unknown'),campaignName=resolvedCampaign||`Smartlead ${ext}`;
 const rawReply=p.reply_message?.text??p.message_body??p.preview_text??p.reply_text??p.message??p.reply_body??p.reply_message?.html??'(No reply body)',replyBody=plain(rawReply)||'(No reply body)';
 const [campaign]=await sql`INSERT INTO campaigns(name,provider,external_id) VALUES (${campaignName},'smartlead',${ext}) ON CONFLICT(provider,external_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
 await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${matchedClient.id},${campaign.id},${`name:${matchedClient.name}`}) ON CONFLICT DO NOTHING`;
 await sql`INSERT INTO replies(prospect_id,campaign_id,provider_reply_id,body,sentiment,reply_category,received_at) VALUES (${prospect.id},${campaign.id},${replyId||eventId},${replyBody},'positive',${category},${p.event_timestamp??p.received_at??p.reply_message?.time??new Date().toISOString()}) ON CONFLICT(provider_reply_id) DO UPDATE SET body=EXCLUDED.body,reply_category=EXCLUDED.reply_category,received_at=EXCLUDED.received_at`;
 await transitionProspect(prospect.id,'action_due',`Smartlead positive reply · ${category}`);
 await sql`UPDATE prospects SET next_action='Respond to positive reply',deadline_at=${iso(5/60)},updated_at=NOW() WHERE id=${prospect.id}`;
 await sql`INSERT INTO sync_jobs(provider,operation,idempotency_key,payload_json,status,attempts) VALUES ('close','upsert_prospect',${`close:prospect:${prospect.id}`},${JSON.stringify({prospectId:prospect.id})}::jsonb,'pending',0) ON CONFLICT(idempotency_key) DO UPDATE SET status=CASE WHEN sync_jobs.status='succeeded' THEN sync_jobs.status ELSE 'pending' END,updated_at=NOW()`;
 await notifySlack(`slack:smartlead:${replyId||`${p.campaign_id}:${p.sl_email_lead_id??p.lead_id}:${category}`}`,{kind:"reply",title:`New ${category} reply`,fields:[{label:"Prospect",value:[firstName,lastName].filter(Boolean).join(' ')||email},{label:"Owner",value:"Vlad"},{label:"Email",value:email},{label:"Action due",value:"Within 5 minutes"},{label:"Campaign",value:campaignName}],body:replyBody,actionUrl:process.env.APP_URL??"https://venluto-os-production.up.railway.app",actionLabel:"Open reply"});
 await sql`UPDATE integration_events SET processed_at=NOW() WHERE provider='smartlead' AND external_event_id=${eventId}`;
 return Response.json({ok:true,duplicate:false,prospectId:prospect.id},{status:201});
}

async function fail(eventId:string,message:string,raw:string){await sql`INSERT INTO sync_jobs(provider,operation,idempotency_key,payload_json,status,attempts,last_error) VALUES ('smartlead','ingest_reply',${`smartlead:error:${eventId}`},${raw}::jsonb,'failed',1,${message}) ON CONFLICT(idempotency_key) DO NOTHING`}
