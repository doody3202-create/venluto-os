import { ensureDatabase, sql } from "@/lib/db";
import { scopedClientId } from "@/lib/portal-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const clientId = scopedClientId(request, Number(new URL(request.url).searchParams.get("clientId")));
  if (!clientId) return new Response("Workspace access denied", { status: 403 });
  return new Response(`<!doctype html><html><body><form method="post">
    <input type="hidden" name="clientId" value="${clientId}">
    <label>Lead name <input name="name" required></label>
    <label>Email <input name="email" type="email" required></label>
    <label>Company <input name="company" required></label>
    <label>Exact campaign <input name="campaign" required></label>
    <label>Positive reply <textarea name="reply" required></textarea></label>
    <button type="submit">Save positive opportunity</button>
  </form><style>body{font:16px system-ui;background:#f4f1ff;padding:40px;color:#17142e}form{max-width:620px;margin:auto;padding:28px;border-radius:20px;background:white;display:grid;gap:16px;box-shadow:0 25px 70px #44338822}label{display:grid;gap:7px;font-weight:700}input,textarea,button{font:inherit;padding:13px;border:1px solid #d8cff4;border-radius:10px}textarea{min-height:110px}button{background:#6746df;color:white;font-weight:800;border:0}</style></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const form = await request.formData();
  const clientId = scopedClientId(request, Number(form.get("clientId")));
  if (!clientId) return Response.json({ error: "Workspace access denied" }, { status: 403 });
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const name = String(form.get("name") ?? "").trim();
  const companyName = String(form.get("company") ?? "").trim();
  const campaignName = String(form.get("campaign") ?? "").trim();
  const reply = String(form.get("reply") ?? "").trim();
  if (!email || !name || !companyName || !campaignName || !reply) return Response.json({ error: "Every field is required" }, { status: 400 });
  const [campaign] = await sql`SELECT ca.id FROM campaigns ca JOIN client_campaigns cc ON cc.campaign_id=ca.id AND cc.client_id=${clientId} WHERE LOWER(ca.name)=LOWER(${campaignName}) LIMIT 1`;
  if (!campaign) return Response.json({ error: "Campaign not found in this workspace" }, { status: 404 });
  const domain = email.split("@")[1] ?? email;
  const [company] = await sql`INSERT INTO companies(name,domain) VALUES (${companyName},${domain}) ON CONFLICT(domain) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
  const parts = name.split(/\s+/), firstName = parts.shift() ?? name, lastName = parts.join(" ");
  let [prospect] = await sql`SELECT id FROM prospects WHERE normalized_email=${email}`;
  if (!prospect) [prospect] = await sql`INSERT INTO prospects(first_name,last_name,email,normalized_email,source,status,pipeline_tag,owner_id,company_id,next_action,deadline_at) VALUES (${firstName},${lastName},${email},${email},'Manual positive reply','action_due','opportunity',(SELECT id FROM owners WHERE email='vlad@venlutogroup.com'),${company.id},'Reply to opportunity',NOW()) RETURNING id`;
  else await sql`UPDATE prospects SET company_id=${company.id},status='action_due',pipeline_tag='opportunity',next_action='Reply to opportunity',deadline_at=NOW(),updated_at=NOW() WHERE id=${prospect.id}`;
  await sql`INSERT INTO client_prospects(client_id,prospect_id) VALUES (${clientId},${prospect.id}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO replies(prospect_id,campaign_id,provider_reply_id,body,sentiment,reply_category,received_at) VALUES (${prospect.id},${campaign.id},${`manual:${clientId}:${email}:${campaign.id}`},${reply},'positive','Interested',NOW()) ON CONFLICT(provider_reply_id) DO UPDATE SET body=EXCLUDED.body,sentiment='positive',reply_category='Interested',received_at=NOW()`;
  return Response.redirect(new URL("/", request.url), 303);
}
