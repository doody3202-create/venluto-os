import { sql } from "./db";

type RangeKey = "7d" | "30d" | "60d" | "90d" | "all";
type Json = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0) || 0;
const pick = (row: Json, keys: string[]) => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return n(row[key]);
  return 0;
};
const positiveReplies = (stats: Json) => pick(stats, ["positive_reply_count", "positive_replies"]) || n((stats.campaign_lead_stats as Json | undefined)?.interested);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let nextSmartleadRequestAt = 0;
const smartleadFetch = async (url: string) => {
  const delay = Math.max(0, nextSmartleadRequestAt - Date.now());
  if (delay) await wait(delay);
  nextSmartleadRequestAt = Date.now() + 500;
  return fetch(url, { cache: "no-store" });
};
const dates = (range: RangeKey) => {
  const days = range === "7d" ? 7 : range === "60d" ? 60 : range === "90d" ? 90 : 30;
  const end = new Date(), start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};
export async function syncVenlutoSmartleadCampaigns(force = false, range: RangeKey = "30d", requestedClientId?:number) {
  const apiKey = process.env.SMARTLEAD_API_KEY;
  if (!apiKey) return { ok: false, skipped: true, reason: "SMARTLEAD_API_KEY is not configured" };
  const [client] = requestedClientId?await sql`SELECT id,name,campaign_match_keyword FROM clients WHERE id=${requestedClientId} AND status='active'`:await sql`SELECT id,name,campaign_match_keyword FROM clients WHERE LOWER(name)='venluto' LIMIT 1`;
  if (!client) return { ok: false, skipped: true, reason: "Client workspace is missing" };
  const clientId = Number(client.id);
  const freshnessKey = `synced_at_${range}`;

  const discovery = await smartleadFetch(`https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(apiKey)}`);
  if (!discovery.ok) throw new Error(`Smartlead campaign discovery failed (${discovery.status})`);
  const payload = await discovery.json() as Json | Json[];
  const raw = Array.isArray(payload) ? payload : (payload.campaigns ?? payload.data ?? []) as Json[];
  const clientNeedle=String(client.campaign_match_keyword??client.name).toLowerCase();
  const campaigns = raw.filter((campaign) => String(campaign.name ?? "").toLowerCase().includes(clientNeedle));
  console.info("[Smartlead sync] campaigns discovered", { all: raw.length, client:client.name, matched:campaigns.length, range });

  // Opportunity ingestion must not depend on the much larger analytics sync.
  // Register every discovered campaign first, then reconcile the current
  // Smartlead opportunity categories even if a later analytics request is
  // rate-limited or fails.
  for (const campaign of campaigns) {
    const externalId=String(campaign.id??campaign.campaign_id??"");
    if(!externalId)continue;
    const[row]=await sql`INSERT INTO campaigns(provider,external_id,name) VALUES ('smartlead',${externalId},${String(campaign.name??`Smartlead ${externalId}`)}) ON CONFLICT(provider,external_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
    await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${clientId},${row.id},${`name:${client.name}`}) ON CONFLICT DO NOTHING`;
  }
  // Keep Overview cheap and deterministic. Opportunity inbox reconciliation is
  // deliberately performed after the analytics snapshot is committed, so a
  // large reply history can never consume the account limit before totals save.
  const [fresh] = await sql`SELECT synced_at,metrics_json FROM campaign_analytics_snapshots WHERE client_id=${clientId} AND range_key=${range}`;
  const freshMetrics = typeof fresh?.metrics_json === "string" ? JSON.parse(fresh.metrics_json) : fresh?.metrics_json as Json | undefined;
  const hasSentVolume = n(freshMetrics?.peopleContacted) > 0 || n(freshMetrics?.emailsSent) > 0 || campaigns.length === 0;
  if (!force && hasSentVolume && fresh?.synced_at && Date.now() - new Date(String(fresh.synced_at)).getTime() < 15 * 60_000) {
    return { ok: true, skipped: true, reason: "analytics fresh", opportunityRepliesSynced: 0 };
  }

  const totals = { peopleContacted: 0, emailsSent: 0, uncontactedLeads: 0, replies: 0, positiveReplies: 0, opportunities: 0 };
  const completed: Array<{ campaign: Json; externalId: string; stats: Json }> = [];
  const externalIds = campaigns.map((campaign) => String(campaign.id ?? campaign.campaign_id ?? "")).filter(Boolean);
  if (externalIds.length) {
    const dateWindow = range === "all"
      ? { start: "2000-01-01", end: new Date().toISOString().slice(0, 10) }
      : dates(range);
    const params = new URLSearchParams({
      api_key: apiKey,
      start_date: dateWindow.start,
      end_date: dateWindow.end,
      timezone: process.env.SMARTLEAD_TIMEZONE ?? "Europe/Bucharest",
      campaign_ids: externalIds.join(","),
      full_data: "true",
    });
    const performanceParams = new URLSearchParams(params);
    performanceParams.set("limit", "1000");
    performanceParams.set("offset", "0");
    const [overallResponse, performanceResponse] = await Promise.all([
      smartleadFetch(`https://server.smartlead.ai/api/v1/analytics/overall-stats-v2?${params}`),
      smartleadFetch(`https://server.smartlead.ai/api/v1/analytics/campaign/overall-stats?${performanceParams}`),
    ]);
    if (!overallResponse.ok || !performanceResponse.ok) {
      throw new Error(`Smartlead aggregate analytics failed (overall ${overallResponse.status}, campaigns ${performanceResponse.status}). Previous snapshot preserved.`);
    }
    const overallPayload = await overallResponse.json() as Json;
    const overallStats = (((overallPayload.data as Json | undefined)?.overall_stats ?? {}) as Json);
    totals.peopleContacted = n(overallStats.unique_lead_count);
    totals.emailsSent = n(overallStats.sent);
    totals.replies = n(overallStats.replied);
    totals.positiveReplies = n(overallStats.positive_replied);
    totals.opportunities = totals.positiveReplies;

    const performancePayload = await performanceResponse.json() as Json;
    const performanceRows = (((performancePayload.data as Json | undefined)?.campaign_wise_performance ?? []) as Json[]);
    const performanceById = new Map(performanceRows.map((row) => [String(row.id ?? row.campaign_id ?? ""), row]));
    for (const campaign of campaigns) {
      const externalId = String(campaign.id ?? campaign.campaign_id ?? "");
      if (!externalId) continue;
      const performance = performanceById.get(externalId) ?? {};
      completed.push({ campaign, externalId, stats: {
        unique_sent_count: n(performance.unique_lead_count),
        sent_count: n(performance.sent),
        reply_count: n(performance.replied),
        positive_reply_count: n(performance.positive_replied),
        total_count: n(performance.unique_lead_count),
      } });
    }
  }
  const synced = completed.length;

  // Persist campaign rows only after every remote request succeeded. This keeps a
  // partial attempt from looking fresh or replacing a previously complete range.
  for (const { campaign, externalId, stats } of completed) {
    const contacted = pick(stats, ["unique_sent_count", "people_contacted", "unique_leads_contacted"]);
    const values = {
      people_contacted: contacted,
      emails_sent: pick(stats, ["sent_count", "emails_sent", "total_sent"]),
      uncontacted_leads: Math.max(0, pick(stats, ["total_count"]) - contacted),
      replies: pick(stats, ["reply_count", "replies", "total_replies"]),
      positive_replies: positiveReplies(stats),
      total_leads: pick(stats, ["total_count"]),
    };
    const now = new Date().toISOString();
    const metadata = { ...values, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`${key}_${range}`, value])), synced_at: now, [freshnessKey]: now, status: String(campaign.status ?? campaign.state ?? "unknown") };
    const [row] = await sql`INSERT INTO campaigns(provider,external_id,name,metadata_json) VALUES ('smartlead',${externalId},${String(campaign.name ?? `Smartlead ${externalId}`)},${sql.json(metadata)}) ON CONFLICT(provider,external_id) DO UPDATE SET name=EXCLUDED.name,metadata_json=campaigns.metadata_json||EXCLUDED.metadata_json RETURNING id`;
    await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${clientId},${row.id},${`name:${client.name}`}) ON CONFLICT DO NOTHING`;
  }

  // Wider ranges are mathematical supersets. Never publish a snapshot that is
  // smaller than an already verified narrower range for cumulative counters.
  const narrowerRange = range === "60d" ? "30d" : range === "90d" ? "60d" : range === "all" ? "90d" : null;
  if (narrowerRange) {
    const [narrower] = await sql`SELECT metrics_json FROM campaign_analytics_snapshots WHERE client_id=${clientId} AND range_key=${narrowerRange}`;
    if (narrower?.metrics_json) {
      const metrics = typeof narrower.metrics_json === "string" ? JSON.parse(narrower.metrics_json) : narrower.metrics_json;
      for (const key of ["peopleContacted", "emailsSent", "replies", "positiveReplies", "opportunities"] as const) {
        if (totals[key] < n(metrics[key])) {
          throw new Error(`Smartlead ${range} integrity check failed: ${key} (${totals[key]}) is below ${narrowerRange} (${n(metrics[key])}). Previous snapshot preserved.`);
        }
      }
    }
  }

  await sql`INSERT INTO campaign_analytics_snapshots(client_id,range_key,metrics_json,synced_at) VALUES (${clientId},${range},${sql.json(totals)},NOW()) ON CONFLICT(client_id,range_key) DO UPDATE SET metrics_json=EXCLUDED.metrics_json,synced_at=NOW()`;
  return { ok: true, synced, opportunityRepliesSynced: 0, opportunities: totals.opportunities, totals, range };
}
