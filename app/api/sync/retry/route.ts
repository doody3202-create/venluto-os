import { d1, ensureDatabase } from "../../_lib/db";
import { syncProspectToClose } from "../../_lib/close";

export async function POST(request: Request) {
  await ensureDatabase();
  const { jobId } = await request.json() as {jobId?:number};
  if (!jobId) return Response.json({error:"jobId is required"},{status:400});
  const db = d1();
  const job = await db.prepare("SELECT * FROM sync_jobs WHERE id=?").bind(jobId).first<{id:number;provider:string;payload_json:string;attempts:number}>();
  if (!job) return Response.json({error:"Sync job not found"},{status:404});
  if (job.provider === "close") { const payload=JSON.parse(job.payload_json) as {prospectId?:number}; try { const result=await syncProspectToClose(payload.prospectId!,jobId); return Response.json({ok:true,...result,message:result.demo?"Close retry simulated safely; no external system was modified.":"Close sync completed."}); } catch(error){await db.prepare("UPDATE sync_jobs SET status='failed',attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(error instanceof Error?error.message:"Retry failed",jobId).run();return Response.json({error:error instanceof Error?error.message:"Retry failed"},{status:502});} }
  if (process.env.DEMO_MODE !== "false") { await db.prepare("UPDATE sync_jobs SET status='succeeded', attempts=attempts+1, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId).run(); return Response.json({ok:true,demo:true,message:"Retry simulated safely; no external system was modified."}); }
  if (job.provider === "close" && !process.env.CLOSE_API_KEY) return Response.json({error:"CLOSE_API_KEY is not configured"},{status:503});
  await db.prepare("UPDATE sync_jobs SET status='pending', attempts=attempts+1, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId).run();
  return Response.json({ok:true,queued:true});
}
