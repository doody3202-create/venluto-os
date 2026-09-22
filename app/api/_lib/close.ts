import { d1 } from "./db";

export async function syncProspectToClose(prospectId:number, jobId?:number) {
  const db=d1();
  const prospect=await db.prepare(`SELECT p.*, c.name company_name FROM prospects p LEFT JOIN companies c ON c.id=p.company_id WHERE p.id=?`).bind(prospectId).first<Record<string,unknown>>();
  if(!prospect) throw new Error("Prospect not found");
  if(process.env.DEMO_MODE!=="false"){
    const url=`https://app.close.com/lead/demo-${prospectId}`;
    await db.batch([
      db.prepare("UPDATE prospects SET close_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(url,prospectId),
      db.prepare("UPDATE sync_jobs SET status='succeeded',attempts=attempts+1,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId??0),
    ]);return {url,demo:true};
  }
  const key=process.env.CLOSE_API_KEY;if(!key)throw new Error("CLOSE_API_KEY is not configured");
  const response=await fetch("https://api.close.com/api/v1/lead/",{method:"POST",headers:{authorization:`Basic ${btoa(`${key}:`)}`,"content-type":"application/json","idempotency-key":`venluto-prospect-${prospectId}`},body:JSON.stringify({name:prospect.company_name??`${prospect.first_name} ${prospect.last_name}`,contacts:[{name:`${prospect.first_name} ${prospect.last_name}`,title:prospect.title,emails:[{email:prospect.email,type:"office"}]}]})});
  if(!response.ok)throw new Error(`Close returned ${response.status}: ${(await response.text()).slice(0,180)}`);
  const result=await response.json() as {id:string};const url=`https://app.close.com/lead/${result.id}`;
  await db.batch([db.prepare("UPDATE prospects SET close_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(url,prospectId),db.prepare("UPDATE sync_jobs SET status='succeeded',attempts=attempts+1,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(jobId??0)]);return {url,demo:false};
}
