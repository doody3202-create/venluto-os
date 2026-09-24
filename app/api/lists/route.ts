import { tamDashboard } from "@/lib/tam";
import { scopedClientId } from "@/lib/portal-auth";
export const dynamic="force-dynamic";
export async function GET(request:Request){const requested=Number(new URL(request.url).searchParams.get("clientId")??0),id=scopedClientId(request,requested);if(!id)return Response.json({error:'Workspace access denied'},{status:403});try{return Response.json(await tamDashboard(id))}catch{return Response.json({error:"Client workspace not found"},{status:404})}}
