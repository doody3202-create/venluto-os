import { tamDashboard } from "@/lib/tam";
export const dynamic="force-dynamic";
export async function GET(request:Request){const id=Number(new URL(request.url).searchParams.get("clientId")??0);try{return Response.json(await tamDashboard(id||undefined))}catch{return Response.json({error:"Client workspace not found"},{status:404})}}
