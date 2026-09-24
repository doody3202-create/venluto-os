import {sql} from "./db";

const numberFrom=(value:unknown)=>Number(value??0)||0;
const pickNumber=(source:Record<string,unknown>,keys:string[])=>{
  for(const key of keys){if(source[key]!==undefined&&source[key]!==null)return numberFrom(source[key]);}
  return 0;
};

export async function syncVenlutoSmartleadCampaigns(force=false){
 const apiKey=process.env.SMARTLEAD_API_KEY;
 if(!apiKey)return {ok:false,skipped:true,reason:"SMARTLEAD_API_KEY is not configured"};
 const latest=await sql`SELECT MAX((metadata_json->>'synced_at')::timestamptz) synced_at FROM campaigns WHERE provider='smartlead' AND LOWER(name) LIKE '%venluto%'`;
 if(!force&&latest[0]?.synced_at&&Date.now()-new Date(latest[0].synced_at as string).getTime()<15*60*1000)return {ok:true,skipped:true,reason:"fresh"};
 const response=await fetch(`https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(apiKey)}`,{cache:"no-store"});
 if(!response.ok)throw new Error(`Smartlead campaign discovery failed (${response.status})`);
 const payload=await response.json() as unknown;
 const raw=Array.isArray(payload)?payload:(payload as {campaigns?:unknown[];data?:unknown[]}).campaigns??(payload as {data?:unknown[]}).data??[];
 const campaigns=(raw as Array<Record<string,unknown>>).filter(c=>String(c.name??"").toLowerCase().includes("venluto"));
 const clients=await sql`SELECT id FROM clients WHERE LOWER(name)='venluto' LIMIT 1`;
 if(!clients[0])return {ok:false,skipped:true,reason:"Venluto workspace is missing"};
 const clientId=Number(clients[0].id);let synced=0;
 for(const item of campaigns){
  const externalId=String(item.id??item.campaign_id??"");if(!externalId)continue;
  let stats:Record<string,unknown>={};
  try{const statsResponse=await fetch(`https://server.smartlead.ai/api/v1/campaigns/${externalId}/statistics?api_key=${encodeURIComponent(apiKey)}`,{cache:"no-store"});if(statsResponse.ok)stats=await statsResponse.json() as Record<string,unknown>;}catch{}
  const merged={...item,...stats};
  const metrics={people_contacted:pickNumber(merged,["unique_sent_count","people_contacted","unique_leads_contacted","contacted_count"]),emails_sent:pickNumber(merged,["sent_count","emails_sent","total_sent"]),uncontacted_leads:pickNumber(merged,["uncontacted_leads","pending_count","not_started_count"]),replies:pickNumber(merged,["reply_count","replies","total_replies"]),positive_replies:pickNumber(merged,["positive_reply_count","positive_replies"]),opportunities:pickNumber(merged,["opportunity_count","opportunities"]),synced_at:new Date().toISOString(),status:String(item.status??item.state??"unknown")};
  const rows=await sql`INSERT INTO campaigns(provider,external_id,name,metadata_json) VALUES ('smartlead',${externalId},${String(item.name??`Smartlead ${externalId}`)},${sql.json(metrics)}) ON CONFLICT(provider,external_id) DO UPDATE SET name=EXCLUDED.name,metadata_json=campaigns.metadata_json||EXCLUDED.metadata_json RETURNING id`;
  await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${clientId},${rows[0].id},'name:Venluto') ON CONFLICT DO NOTHING`;synced++;
 }
 return {ok:true,synced};
}
