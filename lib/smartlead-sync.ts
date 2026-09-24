import {sql} from "./db";

const numberFrom=(value:unknown)=>Number(value??0)||0;
const pickNumber=(source:Record<string,unknown>,keys:string[])=>{
  for(const key of keys){if(source[key]!==undefined&&source[key]!==null)return numberFrom(source[key]);}
  return 0;
};
const unwrap=(payload:unknown)=>{const root=(payload&&typeof payload==='object'?payload:{}) as Record<string,unknown>;const data=root.data??root;if(Array.isArray(data))return data.reduce<Record<string,unknown>>((total,row)=>{if(!row||typeof row!=='object')return total;for(const[key,value]of Object.entries(row)){if(typeof value==='number')total[key]=numberFrom(total[key])+value;else if(value&&typeof value==='object'&&!Array.isArray(value)){const nested=(total[key]&&typeof total[key]==='object'?total[key]:{}) as Record<string,unknown>;for(const[nk,nv]of Object.entries(value))if(typeof nv==='number')nested[nk]=numberFrom(nested[nk])+nv;total[key]=nested}}return total},{});return data as Record<string,unknown>};
const positiveCategory=(name:unknown)=>['interested','meeting request','information request','positive'].includes(String(name??'').trim().toLowerCase());

export async function syncVenlutoSmartleadCampaigns(force=false){
 const apiKey=process.env.SMARTLEAD_API_KEY;
 if(!apiKey){console.warn('[Smartlead sync] skipped: SMARTLEAD_API_KEY is not configured');return {ok:false,skipped:true,reason:"SMARTLEAD_API_KEY is not configured"}}
 const latest=await sql`SELECT MAX((metadata_json->>'synced_at')::timestamptz) synced_at FROM campaigns WHERE provider='smartlead' AND LOWER(name) LIKE '%venluto%'`;
 if(!force&&latest[0]?.synced_at&&Date.now()-new Date(latest[0].synced_at as string).getTime()<15*60*1000)return {ok:true,skipped:true,reason:"fresh"};
 const response=await fetch(`https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(apiKey)}`,{cache:"no-store"});
 if(!response.ok)throw new Error(`Smartlead campaign discovery failed (${response.status})`);
 const payload=await response.json() as unknown;
 const raw=Array.isArray(payload)?payload:(payload as {campaigns?:unknown[];data?:unknown[]}).campaigns??(payload as {data?:unknown[]}).data??[];
 const campaigns=(raw as Array<Record<string,unknown>>).filter(c=>String(c.name??"").toLowerCase().includes("venluto"));
 console.info('[Smartlead sync] campaigns discovered',{all:(raw as unknown[]).length,venluto:campaigns.length});
 const clients=await sql`SELECT id FROM clients WHERE LOWER(name)='venluto' LIMIT 1`;
 if(!clients[0])return {ok:false,skipped:true,reason:"Venluto workspace is missing"};
 const [owner]=await sql`SELECT id FROM owners WHERE LOWER(email)='vlad@venlutogroup.com' ORDER BY id LIMIT 1`;
 const clientId=Number(clients[0].id),ownerId=owner?Number(owner.id):null;let synced=0;
 for(const item of campaigns){
  const externalId=String(item.id??item.campaign_id??"");if(!externalId)continue;
  let stats:Record<string,unknown>={};
  try{const statsResponse=await fetch(`https://server.smartlead.ai/api/v1/campaigns/${externalId}/analytics?api_key=${encodeURIComponent(apiKey)}`,{cache:"no-store"});if(statsResponse.ok)stats=unwrap(await statsResponse.json());else console.warn('[Smartlead sync] campaign analytics rejected',{campaignId:externalId,status:statsResponse.status});}catch(error){console.warn('[Smartlead sync] campaign analytics failed',{campaignId:externalId,error:error instanceof Error?error.message:String(error)})}
  const merged={...item,...stats};
  const leadStats=(merged.campaign_lead_stats&&typeof merged.campaign_lead_stats==='object'?merged.campaign_lead_stats:{}) as Record<string,unknown>,positive=pickNumber(leadStats,['interested']);
  const metrics={people_contacted:pickNumber(merged,["unique_sent_count","people_contacted","unique_leads_contacted","contacted_count"]),emails_sent:pickNumber(merged,["sent_count","emails_sent","total_sent"]),uncontacted_leads:pickNumber(leadStats,["notStarted","not_started"]),replies:pickNumber(merged,["reply_count","replies","total_replies"]),positive_replies:positive||pickNumber(merged,["positive_reply_count","positive_replies"]),opportunities:positive||pickNumber(merged,["opportunity_count","opportunities"]),total_leads:pickNumber(leadStats,['total'])||pickNumber(merged,['total_count']),synced_at:new Date().toISOString(),status:String(item.status??item.state??"unknown")};
  const rows=await sql`INSERT INTO campaigns(provider,external_id,name,metadata_json) VALUES ('smartlead',${externalId},${String(item.name??`Smartlead ${externalId}`)},${sql.json(metrics)}) ON CONFLICT(provider,external_id) DO UPDATE SET name=EXCLUDED.name,metadata_json=campaigns.metadata_json||EXCLUDED.metadata_json RETURNING id`;
  await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${clientId},${rows[0].id},'name:Venluto') ON CONFLICT DO NOTHING`;synced++;
 }
 const campaignIds=campaigns.map(c=>Number(c.id??c.campaign_id)).filter(Boolean);let repliesSynced=0;
 for(let groupIndex=0;groupIndex<campaignIds.length;groupIndex+=5){const group=campaignIds.slice(groupIndex,groupIndex+5);let offset=0,total=1;while(offset<total&&offset<500){const inboxResponse=await fetch(`https://server.smartlead.ai/api/v1/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=false`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({offset,limit:20,filters:{emailStatus:'Replied',campaignId:group},sortBy:'REPLY_TIME_DESC'}),cache:'no-store'});if(!inboxResponse.ok){console.warn('[Smartlead sync] inbox request rejected',{campaignIds:group,status:inboxResponse.status});break}const inbox=await inboxResponse.json() as{messages?:Array<Record<string,unknown>>;total_count?:number};const messages=inbox.messages??[];total=Number(inbox.total_count??messages.length);for(const message of messages){const category=(message.category??{}) as Record<string,unknown>;if(!positiveCategory(category.name))continue;const lead=(message.lead??{}) as Record<string,unknown>,campaign=(message.campaign??{}) as Record<string,unknown>,last=(message.last_message??{}) as Record<string,unknown>,email=String(lead.email??last.sent_from??'').trim().toLowerCase();if(!email)continue;const domain=email.split('@')[1]??'unknown.local',companyName=String(lead.company??domain),campaignExternal=String(campaign.id??'');const [companyRow]=await sql`INSERT INTO companies(name,domain) VALUES (${companyName},${domain}) ON CONFLICT(domain) DO UPDATE SET name=CASE WHEN companies.name IN ('','SameCompany') THEN EXCLUDED.name ELSE companies.name END RETURNING id`;const [campaignRow]=await sql`SELECT id FROM campaigns WHERE provider='smartlead' AND external_id=${campaignExternal}`;if(!campaignRow)continue;const [prospect]=await sql`INSERT INTO prospects(first_name,last_name,email,normalized_email,source,status,owner_id,company_id,next_action,deadline_at) VALUES (${String(lead.first_name??'')},${String(lead.last_name??'')},${email},${email},'smartlead','action_due',${ownerId},${companyRow.id},'Reply to positive lead',NOW()+INTERVAL '5 minutes') ON CONFLICT(normalized_email) DO UPDATE SET owner_id=COALESCE(prospects.owner_id,EXCLUDED.owner_id),updated_at=NOW() RETURNING id`;const replyId=String(last.id??message.id??`${campaignExternal}:${email}:${last.received_at??''}`);await sql`INSERT INTO replies(prospect_id,campaign_id,provider_reply_id,body,sentiment,received_at) VALUES (${prospect.id},${campaignRow.id},${replyId},${String(last.body??'')},'positive',${String(last.received_at??new Date().toISOString())}) ON CONFLICT(provider_reply_id) DO UPDATE SET body=EXCLUDED.body,received_at=EXCLUDED.received_at`;repliesSynced++}if(messages.length===0)break;offset+=messages.length}}
 return {ok:true,synced,repliesSynced};
}
