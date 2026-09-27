import { randomBytes } from "node:crypto";
import { ensureDatabase,sql } from "@/lib/db";
import { readSession } from "@/lib/portal-auth";
export const dynamic="force-dynamic";

type Snapshot={client?:{id?:number;name?:string};range?:string;totals?:Record<string,number>;ratios?:Record<string,number|null>;campaigns?:Array<Record<string,unknown>>};
const allowedRanges=new Set(["7d","30d","60d","90d","all"]);

export async function POST(request:Request){
 await ensureDatabase();
 const auth=readSession(request);if(auth?.role!=="admin")return Response.json({error:"Admin access required"},{status:403});
 const body=await request.json() as{snapshot?:Snapshot},snapshot=body.snapshot,clientId=Number(snapshot?.client?.id),range=String(snapshot?.range??"");
 if(!clientId||!allowedRanges.has(range)||!snapshot?.totals||!Array.isArray(snapshot.campaigns))return Response.json({error:"A valid report snapshot is required"},{status:400});
 const [client]=await sql`SELECT id,name FROM clients WHERE id=${clientId} AND status='active'`;if(!client)return Response.json({error:"Client not found"},{status:404});
 const safe={client:{id:Number(client.id),name:String(client.name)},range,totals:snapshot.totals,ratios:snapshot.ratios??{},campaigns:snapshot.campaigns.slice(0,100),generatedAt:new Date().toISOString()};
 const token=randomBytes(18).toString("base64url");await sql`INSERT INTO report_snapshots(token,client_id,range_key,snapshot_json) VALUES (${token},${clientId},${range},${JSON.stringify(safe)}::jsonb)`;
 const base=(process.env.REPORTS_PUBLIC_URL??"https://venluto-client-reports.vercel.app").replace(/\/$/,"");return Response.json({ok:true,url:`${base}/?report=${token}`},{status:201});
}

export async function GET(request:Request){
 await ensureDatabase();const token=new URL(request.url).searchParams.get("token")??"";
 if(!/^[A-Za-z0-9_-]{20,40}$/.test(token))return Response.json({error:"Report not found"},{status:404,headers:{"access-control-allow-origin":"*"}});
 const [row]=await sql`SELECT snapshot_json,created_at FROM report_snapshots WHERE token=${token}`;if(!row)return Response.json({error:"Report not found"},{status:404,headers:{"access-control-allow-origin":"*"}});
 const snapshot=typeof row.snapshot_json==="string"?JSON.parse(row.snapshot_json):row.snapshot_json;return Response.json(snapshot,{headers:{"access-control-allow-origin":"*","cache-control":"public, max-age=60, s-maxage=300"}});
}
