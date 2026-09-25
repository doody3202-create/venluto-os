import { sql } from "./db";
import { syncSmartleadOpportunityReplies } from "./smartlead-replies";

type RangeKey = "7d" | "30d" | "60d" | "90d" | "all";
type Json = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0) || 0;
const pick = (row: Json, keys: string[]) => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return n(row[key]);
  return 0;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const smartleadFetch = async (url: string) => {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(url, { cache: "no-store" });
    if (response.ok || response.status !== 429) return response;
    const retryAfter = Number(response.headers.get("retry-after") ?? 0);
    await wait(retryAfter > 0 ? retryAfter * 1000 : 750 * 2 ** attempt);
  }
  return response!;
};
const dates = (range: RangeKey) => {
  const days = range === "7d" ? 7 : range === "60d" ? 60 : range === "90d" ? 90 : 30;
  const end = new Date(), start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};
const windows = (range: RangeKey) => {
  if (range === "all") return [];
  const { start, end } = dates(range), result: Array<{ start: string; end: string }> = [];
  let cursor = new Date(`${start}T00:00:00Z`), last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 29);
    if (windowEnd > last) windowEnd.setTime(last.getTime());
    result.push({ start: cursor.toISOString().slice(0, 10), end: windowEnd.toISOString().slice(0, 10) });
    cursor = new Date(windowEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
};

export async function syncVenlutoSmartleadCampaigns(force = false, range: RangeKey = "30d", requestedClientId?:number) {
  const apiKey = process.env.SMARTLEAD_API_KEY;
  if (!apiKey) return { ok: false, skipped: true, reason: "SMARTLEAD_API_KEY is not configured" };
  const [client] = requestedClientId?await sql`SELECT id,name FROM clients WHERE id=${requestedClientId} AND status='active'`:await sql`SELECT id,name FROM clients WHERE LOWER(name)='venluto' LIMIT 1`;
  if (!client) return { ok: false, skipped: true, reason: "Client workspace is missing" };
  const clientId = Number(client.id);
  const freshnessKey = `synced_at_${range}`;

  const discovery = await smartleadFetch(`https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(apiKey)}`);
  if (!discovery.ok) throw new Error(`Smartlead campaign discovery failed (${discovery.status})`);
  const payload = await discovery.json() as Json | Json[];
  const raw = Array.isArray(payload) ? payload : (payload.campaigns ?? payload.data ?? []) as Json[];
  const clientNeedle=String(client.name).toLowerCase();
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
  const [opportunityOwner] = await sql`SELECT id FROM owners WHERE LOWER(email)=LOWER(${process.env.APP_USER ?? "vlad@venlutogroup.com"}) LIMIT 1`;
  const opportunityRepliesSynced = await syncSmartleadOpportunityReplies({
    apiKey,
    campaignIds: campaigns.map(campaign=>Number(campaign.id??campaign.campaign_id)).filter(Number.isFinite),
    clientId,
    ownerId: opportunityOwner?.id ? Number(opportunityOwner.id) : null,
  });
  console.info("[Smartlead sync] opportunities reconciled",{client:client.name,opportunityRepliesSynced});

  // Campaign analytics may be cached, but the operational opportunity inbox must
  // always reconcile first. Otherwise a fresh reporting snapshot makes Tasks and
  // CRM incorrectly appear empty until the analytics cache expires.
  const [fresh] = await sql`SELECT synced_at FROM campaign_analytics_snapshots WHERE client_id=${clientId} AND range_key=${range}`;
  if (!force && fresh?.synced_at && Date.now() - new Date(String(fresh.synced_at)).getTime() < 15 * 60_000) {
    return { ok: true, skipped: true, reason: "analytics fresh", opportunityRepliesSynced };
  }

  let synced = 0;
  const totals = { peopleContacted: 0, emailsSent: 0, uncontactedLeads: 0, replies: 0, positiveReplies: 0, opportunities: 0 };
  const window = dates(range), dateWindows = windows(range);
  const failedCampaigns: string[] = [];
  const completed: Array<{ campaign: Json; externalId: string; stats: Json }> = [];
  for (let index = 0; index < campaigns.length; index += 6) {
    const results = await Promise.all(campaigns.slice(index, index + 6).map(async (campaign) => {
      const externalId = String(campaign.id ?? campaign.campaign_id ?? "");
      if (!externalId) return null;
      try {
        if (range === "all") {
          const response = await smartleadFetch(`https://server.smartlead.ai/api/v1/campaigns/${externalId}/analytics?api_key=${encodeURIComponent(apiKey)}`);
          if (!response.ok) throw new Error(`all-time analytics rejected (${response.status})`);
          const stats = await response.json() as Json;
          return { campaign, externalId, stats: { ...stats, positive_reply_count: 0 } };
        }
        const parts = await Promise.all(dateWindows.map(async (dateWindow) => {
          const suffix = `start_date=${dateWindow.start}&end_date=${dateWindow.end}&api_key=${encodeURIComponent(apiKey)}`;
          const [analyticsResponse, positiveResponse] = await Promise.all([
            smartleadFetch(`https://server.smartlead.ai/api/v1/campaigns/${externalId}/analytics-by-date?${suffix}`),
            smartleadFetch(`https://server.smartlead.ai/api/v1/campaigns/${externalId}/top-level-analytics-by-date?${suffix}`),
          ]);
          if (!analyticsResponse.ok || !positiveResponse.ok) throw new Error(`dated analytics rejected (${analyticsResponse.status}/${positiveResponse.status})`);
          return { analytics: await analyticsResponse.json() as Json, positive: await positiveResponse.json() as Json };
        }));
        const stats: Json = {};
        for (const part of parts) {
          for (const key of ["sent_count", "unique_sent_count", "reply_count", "total_reply_count", "non_ooo_reply_count"]) stats[key] = n(stats[key]) + n(part.analytics[key]);
          stats.positive_reply_count = n(stats.positive_reply_count) + n(part.positive.positive_reply_count);
          stats.total_count = Math.max(n(stats.total_count), n(part.analytics.total_count));
        }
        return { campaign, externalId, stats };
      } catch (error) {
        console.warn("[Smartlead sync] analytics failed; preserving prior metrics", { campaignId: externalId, range, error: error instanceof Error ? error.message : String(error) });
        failedCampaigns.push(externalId);
        return null;
      }
    }));
    for (const result of results) {
      if (!result) continue;
      completed.push(result);
      const { campaign, externalId, stats } = result;
      const contacted = pick(stats, ["unique_sent_count", "people_contacted", "unique_leads_contacted"]);
      const values = {
        people_contacted: contacted,
        emails_sent: pick(stats, ["sent_count", "emails_sent", "total_sent"]),
        uncontacted_leads: Math.max(0, pick(stats, ["total_count"]) - contacted),
        replies: pick(stats, ["reply_count", "replies", "total_replies"]),
        positive_replies: pick(stats, ["positive_reply_count", "positive_replies"]),
        total_leads: pick(stats, ["total_count"]),
      };
      totals.peopleContacted += values.people_contacted;
      totals.emailsSent += values.emails_sent;
      totals.uncontactedLeads += values.uncontacted_leads;
      totals.replies += values.replies;
      totals.positiveReplies += values.positive_replies;
      totals.opportunities += values.positive_replies;
      synced++;
    }
  }

  if (failedCampaigns.length || synced !== campaigns.length) {
    console.error("[Smartlead sync] incomplete range rejected; previous complete snapshot preserved", {
      range, expected: campaigns.length, synced, failedCampaigns,
    });
    throw new Error(`Smartlead range incomplete: ${synced}/${campaigns.length} campaigns. Previous complete snapshot preserved.`);
  }

  // Persist campaign rows only after every remote request succeeded. This keeps a
  // partial attempt from looking fresh or replacing a previously complete range.
  for (const { campaign, externalId, stats } of completed) {
    const contacted = pick(stats, ["unique_sent_count", "people_contacted", "unique_leads_contacted"]);
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
    await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${clientId},${row.id},${`name:${client.name}`}) ON CONFLICT DO NOTHING`;
  }

  // Seed each workspace's Inbox/CRM from Smartlead's current opportunity
  // categories. Future changes still arrive through the account webhook; this
  // backfill makes a newly-created client workspace useful immediately.
  if (range === "all") {
    const [allTime] = await sql`
      SELECT COUNT(DISTINCT r.id)::int opportunities
      FROM replies r JOIN client_campaigns cc ON cc.campaign_id=r.campaign_id
      WHERE cc.client_id=${clientId}
        AND LOWER(COALESCE(r.reply_category,'')) IN ('interested','information request','meeting request')
    `;
    totals.opportunities = Number(allTime?.opportunities ?? 0);
    totals.positiveReplies = totals.opportunities;
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
  return { ok: true, synced, opportunityRepliesSynced, opportunities: totals.opportunities, totals, range };
}
