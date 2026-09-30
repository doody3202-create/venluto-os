import { ensureDatabase, normalizeEmail, sql } from "@/lib/db";

type RangeKey = "7d" | "30d" | "60d" | "90d" | "all";
type Json = Record<string, unknown>;
const API = "https://api.instantly.ai/api/v2";

const rangeDates = (range: RangeKey) => {
  const end = new Date(), start = new Date();
  if (range === "all") start.setUTCFullYear(2020, 0, 1);
  else start.setUTCDate(start.getUTCDate() - Number(range.slice(0, -1)));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

async function instantly(path: string, init?: RequestInit) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) throw new Error("INSTANTLY_API_KEY is not configured");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Instantly ${path} returned ${response.status}: ${(await response.text()).slice(0, 240)}`);
  return response.json();
}

async function campaigns() {
  const rows: Json[] = [];
  let cursor = "";
  do {
    const result = await instantly(`/campaigns?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`) as { items?: Json[]; next_starting_after?: string };
    rows.push(...(result.items ?? [])); cursor = result.next_starting_after ?? "";
  } while (cursor);
  return rows;
}

const textBody = (email: Json) => {
  const body = email.body as Json | undefined;
  return String(body?.text ?? email.content_preview ?? "").trim();
};

async function interestedLeads(campaignId: string) {
  const filters = ["FILTER_LEAD_INTERESTED", "FILTER_LEAD_MEETING_BOOKED", "FILTER_LEAD_MEETING_COMPLETED", "FILTER_LEAD_CLOSED"];
  const found = new Map<string, Json>();
  for (const filter of filters) {
    let cursor = "";
    do {
      const result = await instantly("/leads/list", { method: "POST", body: JSON.stringify({ campaign: campaignId, filter, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }) }) as { items?: Json[]; next_starting_after?: string };
      for (const lead of result.items ?? []) if (lead.email) found.set(String(lead.id ?? lead.email), lead);
      cursor = result.next_starting_after ?? "";
    } while (cursor);
  }
  return [...found.values()];
}

async function leadConversation(campaignId: string, email: string) {
  const result = await instantly(`/emails?limit=100&campaign_id=${encodeURIComponent(campaignId)}&search=${encodeURIComponent(email)}`) as { items?: Json[] };
  return (result.items ?? []).filter(row => normalizeEmail(String(row.lead ?? "")) === email).sort((a, b) => String(a.timestamp_email).localeCompare(String(b.timestamp_email)));
}

async function saveLead(clientId: number, campaignId: number, externalCampaignId: string, lead: Json) {
  const email = normalizeEmail(String(lead.email ?? ""));
  if (!email) return false;
  const domain = String(lead.company_domain ?? lead.website ?? email.split("@")[1] ?? "unknown").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const [company] = await sql`INSERT INTO companies(name,domain) VALUES (${String(lead.company_name ?? domain)},${domain}) ON CONFLICT(domain) DO UPDATE SET name=COALESCE(NULLIF(EXCLUDED.name,''),companies.name) RETURNING id`;
  const phone = String(lead.phone ?? (lead.payload as Json | undefined)?.phone ?? "").trim() || null;
  const linkedin = String((lead.payload as Json | undefined)?.linkedin_url ?? (lead.payload as Json | undefined)?.linkedin ?? "").trim() || null;
  let [prospect] = await sql`SELECT id FROM prospects WHERE normalized_email=${email}`;
  if (!prospect) [prospect] = await sql`INSERT INTO prospects(first_name,last_name,email,normalized_email,title,source,status,pipeline_tag,company_id,next_action,deadline_at,phone,linkedin_url) VALUES (${String(lead.first_name ?? "")},${String(lead.last_name ?? "")},${email},${email},${String((lead.payload as Json | undefined)?.job_title ?? "")},'Instantly','action_due','opportunity',${company.id},'Respond to positive reply',NOW(),${phone},${linkedin}) RETURNING id`;
  else await sql`UPDATE prospects SET first_name=COALESCE(NULLIF(${String(lead.first_name ?? "")},''),first_name),last_name=COALESCE(NULLIF(${String(lead.last_name ?? "")},''),last_name),company_id=${company.id},phone=COALESCE(${phone},phone),linkedin_url=COALESCE(${linkedin},linkedin_url),updated_at=NOW() WHERE id=${prospect.id}`;
  await sql`INSERT INTO client_prospects(client_id,prospect_id) VALUES (${clientId},${prospect.id}) ON CONFLICT DO NOTHING`;
  const thread = await leadConversation(externalCampaignId, email);
  for (const message of thread) {
    const inbound = Number(message.ue_type) === 2;
    await sql`INSERT INTO conversation_messages(prospect_id,campaign_id,external_id,direction,sender_name,sender_email,body,sent_at) VALUES (${prospect.id},${campaignId},${`instantly:${String(message.id)}`},${inbound ? "inbound" : "outbound"},${inbound ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || email : "Venluto team"},${inbound ? email : String(message.from_address_email ?? "") || null},${textBody(message) || String(message.subject ?? "Email")},${String(message.timestamp_email ?? new Date().toISOString())}) ON CONFLICT(external_id) DO UPDATE SET body=EXCLUDED.body,sent_at=EXCLUDED.sent_at`;
  }
  const latestInbound = [...thread].reverse().find(message => Number(message.ue_type) === 2);
  if (!latestInbound) return false;
  const interest = Number(lead.lt_interest_status ?? 1), category = interest === 2 ? "Meeting Request" : interest >= 3 ? "Interested" : "Interested";
  await sql`INSERT INTO replies(prospect_id,campaign_id,provider_reply_id,body,sentiment,reply_category,received_at) VALUES (${prospect.id},${campaignId},${`instantly:${String(latestInbound.id)}`},${textBody(latestInbound) || "Positive reply in Instantly"},'positive',${category},${String(latestInbound.timestamp_email ?? lead.timestamp_last_reply ?? new Date().toISOString())}) ON CONFLICT(provider_reply_id) DO UPDATE SET body=EXCLUDED.body,reply_category=EXCLUDED.reply_category,received_at=EXCLUDED.received_at`;
  return true;
}

async function runInstantlySync(range: RangeKey = "30d", requestedClientId?: number) {
  await ensureDatabase();
  const allCampaigns = await campaigns(), { start, end } = rangeDates(range);
  const analytics = await instantly(`/campaigns/analytics?start_date=${start}&end_date=${end}`) as Json[];
  const analyticsById = new Map(analytics.map(row => [String(row.campaign_id), row]));
  const clients = requestedClientId
    ? await sql`SELECT id,name,campaign_match_keyword FROM clients WHERE id=${requestedClientId} AND status='active'`
    : await sql`SELECT id,name,campaign_match_keyword FROM clients WHERE status='active'`;
  let matched = 0, opportunities = 0;
  for (const client of clients) {
    const keyword = String(client.campaign_match_keyword ?? client.name).toLowerCase();
    for (const campaign of allCampaigns.filter(row => String(row.name ?? "").toLowerCase().includes(keyword))) {
      const externalId = String(campaign.id), metric = analyticsById.get(externalId) ?? {};
      const metadata: Record<string, string | number | null> = {
        status: campaign.status == null ? null : String(campaign.status), [`people_contacted_${range}`]: Number(metric.contacted_count ?? 0),
        [`emails_sent_${range}`]: Number(metric.emails_sent_count ?? 0), [`uncontacted_leads_${range}`]: Math.max(0, Number(metric.leads_count ?? 0) - Number(metric.contacted_count ?? 0)),
        [`replies_${range}`]: Number(metric.reply_count_unique ?? metric.reply_count ?? 0), [`positive_replies_${range}`]: Number(metric.total_opportunities ?? 0),
      };
      const [saved] = await sql`INSERT INTO campaigns(provider,external_id,name,metadata_json) VALUES ('instantly',${externalId},${String(campaign.name)},${sql.json(metadata)}) ON CONFLICT(provider,external_id) DO UPDATE SET name=EXCLUDED.name,metadata_json=campaigns.metadata_json||EXCLUDED.metadata_json RETURNING id`;
      await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${client.id},${saved.id},${`name:${keyword}`}) ON CONFLICT DO NOTHING`;
      matched++;
      // Instantly's aggregate opportunity counter can lag behind lead interest
      // status. Reconcile the lead filters directly once per worker cycle so a
      // real positive reply is never hidden merely because analytics says 0.
      if (range === "30d") for (const lead of await interestedLeads(externalId)) if (await saveLead(Number(client.id), Number(saved.id), externalId, lead)) opportunities++;
    }
  }
  return { ok: true, provider: "instantly", range, campaigns: matched, opportunities };
}

const instantlyState = globalThis as unknown as { instantlySyncs?: Map<string, { at: number; promise: ReturnType<typeof runInstantlySync> }> };
instantlyState.instantlySyncs ??= new Map();
export function syncInstantly(range: RangeKey = "30d", requestedClientId?: number, force = false) {
  const key = `${requestedClientId ?? "all"}:${range}`, existing = instantlyState.instantlySyncs!.get(key);
  if (!force && existing && Date.now() - existing.at < 5 * 60_000) return existing.promise;
  const promise = runInstantlySync(range, requestedClientId).catch(error => { instantlyState.instantlySyncs!.delete(key); throw error; });
  instantlyState.instantlySyncs!.set(key, { at: Date.now(), promise });
  return promise;
}
