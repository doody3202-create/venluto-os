import { createDemoJob, tamDashboard } from "@/lib/tam";
export const dynamic="force-dynamic";
export async function GET(){return Response.json(await tamDashboard())}
export async function POST(request:Request){const body=await request.json().catch(()=>({})) as{action?:string};if(body.action!=="run_demo")return Response.json({error:"Only the safe demo is enabled in this release"},{status:400});const jobId=await createDemoJob();return Response.json({ok:true,jobId,demo:true,liveOutreach:false})}
