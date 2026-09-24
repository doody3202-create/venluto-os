import { sql } from "./db";

type RangeKey = "7d" | "30d" | "60d" | "all";
type Json = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0) || 0;
const pick = (row: Json, keys: string[]) => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return n(row[key]);
  return 0;
};
const dates = (range: RangeKey) => {
  const days = range === "7d" ? 7 : range === "60d" ? 60 : 30;
  const end = new Date(), start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

export async function syncVenlutoSmartleadCampaigns(force = false, range: RangeKey = "30d") {
  const apiKey = process.env.SMARTLEAD_API_KEY;
  if (!apiKey) return { ok: false, skipped: true, reason: "SMARTLEAD_API_KEY is not configured" };
  const freshnessKey = `synced_at_${range}`;
  const [fresh] = await sql`SELECT MAX((metadata_json->>${freshnessKey})::timestamptz) synced_at FROM campaigns WHERE provider='smartlead' AND LOWER(name) LIKE '%venluto%'`;
  if (!force && fresh?.synced_at && Date.now() - new Date(String(fresh.synced_at)).getTime() < 15 * 60_000) return { ok: true, skipped: true, reason: "fresh" };

  const discovery = await fetch(`https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(apiKey)}`, { cache: "no-store" });
  if (!discovery.ok) throw new Error(`Smartlead campaign discovery failed (${discovery.status})`);
  const payload = await discovery.json() as Json | Json[];
  const raw = Array.isArray(payload) ? payload : (payload.campaigns ?? payload.data ?? []) as Json[];
  const campaigns = raw.filter((campaign) => String(campaign.name ?? "").toLowerCase().includes("venluto"));
  console.info("[Smartlead sync] campaigns discovered", { all: raw.length, venluto: campaigns.length, range });

  const [client] = await sql`SELECT id FROM clients WHERE LOWER(name)='venluto' LIMIT 1`;
  if (!client) return { ok: false, skipped: true, reason: "Venluto workspace is missing" };
  const clientId = Number(client.id);

  let synced = 0;
  const totals = { peopleContacted: 0, emailsSent: 0, uncontactedLeads: 0, replies: 0, positiveReplies: 0, opportunities: 0 };
  const window = dates(range);
  for (let index = 0; index < campaigns.length; index += 12) {
    const results = await Promise.all(campaigns.slice(index, index + 12).map(async (campaign) => {
      const externalId = String(campaign.id ?? campaign.campaign_id ?? "");
      if (!externalId) return null;
      const endpoint = range === "all" ? `campaigns/${externalId}/analytics` : `campaigns/${externalId}/top-level-analytics-by-date?start_date=${window.start}&end_date=${window.end}`;
      try {
        const response = await fetch(`https://server.smartlead.ai/api/v1/${endpoint}${endpoint.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(apiKey)}`, { cache: "no-store" });
        if (!response.ok) {
          console.warn("[Smartlead sync] analytics rejected; preserving prior metrics", { campaignId: externalId, status: response.status, range });
          return null;
        }
        return { campaign, externalId, stats: await response.json() as Json };
      } catch (error) {
        console.warn("[Smartlead sync] analytics failed; preserving prior metrics", { campaignId: externalId, range, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }));
    for (const result of results) {
      if (!result) continue;
      const { campaign, externalId, stats } = result;
      const contacted = pick(stats, ["unique_sent_count", "people_contacted", "unique_leads_contacted", "sent_count"]);
      const values = {
        people_contacted: contacted,
        emails_sent: pick(stats, ["sent_count", "emails_sent", "total_sent"]),
        uncontacted_leads: Math.max(0, pick(stats, ["total_count"]) - contacted),
        replies: pick(stats, ["reply_count", "replies", "total_replies"]),
        positive_replies: pick(stats, ["positive_reply_count", "positive_replies"]),
        total_leads: pick(stats, ["total_count"]),
      };
      const now = new Date().toISOString();
      const metadata = { ...values, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`${key}_${range}`, value])), synced_at: now, [freshnessKey]: now, status: String(campaign.status ?? campaign.state ?? "unknown") };
      const [row] = await sql`INSERT INTO campaigns(provider,external_id,name,metadata_json) VALUES ('smartlead',${externalId},${String(campaign.name ?? `Smartlead ${externalId}`)},${sql.json(metadata)}) ON CONFLICT(provider,external_id) DO UPDATE SET name=EXCLUDED.name,metadata_json=campaigns.metadata_json||EXCLUDED.metadata_json RETURNING id`;
      await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${clientId},${row.id},'name:Venluto') ON CONFLICT DO NOTHING`;
      totals.peopleContacted += values.people_contacted;
      totals.emailsSent += values.emails_sent;
      totals.uncontactedLeads += values.uncontacted_leads;
      totals.replies += values.replies;
      totals.positiveReplies += values.positive_replies;
      totals.opportunities += values.positive_replies;
      synced++;
    }
  }

  await sql`INSERT INTO campaign_analytics_snapshots(client_id,range_key,metrics_json,synced_at) VALUES (${clientId},${range},${sql.json(totals)},NOW()) ON CONFLICT(client_id,range_key) DO UPDATE SET metrics_json=EXCLUDED.metrics_json,synced_at=NOW()`;
  return { ok: true, synced, opportunities: totals.opportunities, totals, range };
}
