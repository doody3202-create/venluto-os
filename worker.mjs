import postgres from "postgres";

const sql=postgres(process.env.DATABASE_URL,{max:3,idle_timeout:20});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const appUrl=process.env.APP_URL||"https://venluto-os-production.up.railway.app";
function errorPayload(job,message){return{text:`⚠️ Venluto OS integration failed`,attachments:[{color:"#E01E5A",blocks:[{type:"header",text:{type:"plain_text",text:"⚠️  Integration needs attention",emoji:true}},{type:"section",fields:[{type:"mrkdwn",text:`*Provider*\n${job.provider}`},{type:"mrkdwn",text:`*Operation*\n${job.operation}`}]},{type:"section",text:{type:"mrkdwn",text:`*What happened*\n\`${message}\``}},{type:"actions",elements:[{type:"button",style:"danger",text:{type:"plain_text",text:"Review in Venluto OS"},url:appUrl}]},{type:"context",elements:[{type:"mrkdwn",text:"*Venluto OS*  •  Retry safely from Today"}]}]}]}}
async function postSlack(payload){
 if(!process.env.SLACK_WEBHOOK_URL)throw new Error("SLACK_WEBHOOK_URL is not configured");
 const response=await fetch(process.env.SLACK_WEBHOOK_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(typeof payload==="string"?{text:payload}:payload)});
 if(!response.ok)throw new Error(`Slack returned ${response.status}: ${(await response.text()).slice(0,180)}`);
}

async function processClose(job){
 const payload=typeof job.payload_json==="string"?JSON.parse(job.payload_json):job.payload_json??{};
 const prospectId=payload.prospectId??payload.prospect_id;
 if(prospectId===undefined||prospectId===null||prospectId==="")throw new Error("Close sync job has no prospect ID");
 const [p]=await sql`SELECT p.*,c.name company_name FROM prospects p LEFT JOIN companies c ON c.id=p.company_id WHERE p.id=${prospectId}`;if(!p)throw new Error(`Prospect ${prospectId} not found`);
 if(process.env.DEMO_MODE!=="false"){await sql`UPDATE prospects SET close_url=${`https://app.close.com/lead/demo-${prospectId}`},updated_at=NOW() WHERE id=${prospectId}`;return}
 if(!process.env.CLOSE_API_KEY)throw new Error("CLOSE_API_KEY is not configured");
 const auth=Buffer.from(`${process.env.CLOSE_API_KEY}:`).toString("base64");
 const statusResponse=await fetch("https://api.close.com/api/v1/status/lead/?_limit=100",{headers:{authorization:`Basic ${auth}`}});
 if(!statusResponse.ok)throw new Error(`Close status lookup returned ${statusResponse.status}: ${(await statusResponse.text()).slice(0,180)}`);
 const statuses=await statusResponse.json();const interested=statuses.data?.find(status=>String(status.label).toLowerCase()==="interested");
 if(!interested?.id)throw new Error('Close has no lead status named "Interested"');
 const contact={name:[p.first_name,p.last_name].filter(Boolean).join(" ")||p.email,emails:[{email:p.email,type:"office"}]};if(p.title)contact.title=p.title;
 const response=await fetch("https://api.close.com/api/v1/lead/",{method:"POST",headers:{authorization:`Basic ${auth}`,"content-type":"application/json","idempotency-key":job.idempotency_key},body:JSON.stringify({name:p.company_name||contact.name,status_id:interested.id,contacts:[contact]})});if(!response.ok)throw new Error(`Close returned ${response.status}: ${(await response.text()).slice(0,180)}`);const result=await response.json();await sql`UPDATE prospects SET close_url=${result.html_url||`https://app.close.com/lead/${result.id}`},updated_at=NOW() WHERE id=${prospectId}`;
}

async function claim(){return sql.begin(async tx=>{const [job]=await tx`SELECT * FROM sync_jobs WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at<=NOW()) AND (locked_at IS NULL OR locked_at<NOW()-INTERVAL '10 minutes') ORDER BY updated_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`;if(!job)return null;await tx`UPDATE sync_jobs SET locked_at=NOW(),status='processing',updated_at=NOW() WHERE id=${job.id}`;return job})}
async function run(){console.log("Venluto worker started",{demo:process.env.DEMO_MODE!=="false"});while(true){let job;try{job=await claim();if(!job){await sleep(2000);continue}if(job.provider==='close'&&job.operation==='upsert_prospect')await processClose(job);else if(job.provider==='slack'&&job.operation==='send_notification')await postSlack(job.payload_json.payload??job.payload_json.text);else throw new Error(`Unsupported job ${job.provider}:${job.operation}`);await sql`UPDATE sync_jobs SET status='succeeded',attempts=attempts+1,last_error=NULL,locked_at=NULL,updated_at=NOW() WHERE id=${job.id}`;console.log("Sync succeeded",{jobId:job.id,provider:job.provider})}catch(error){console.error("Sync failed",error);if(job){const message=error instanceof Error?error.message:'Unknown error';await sql`UPDATE sync_jobs SET status='failed',attempts=attempts+1,last_error=${message},locked_at=NULL,next_retry_at=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE id=${job.id}`;if(job.provider!=='slack'&&process.env.SLACK_WEBHOOK_URL)try{await postSlack(errorPayload(job,message))}catch(slackError){console.error("Slack failure alert failed",slackError)}}await sleep(2000)}}}
process.on('SIGTERM',async()=>{await sql.end();process.exit(0)});run();
