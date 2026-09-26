import { sql } from "./db";
import { syncSmartleadOpportunityReplies } from "./smartlead-replies";

type RangeKey = "7d" | "30d" | "60d" | "90d" | "all";
type Json = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0) || 0;
const pick = (row: Json, keys: string[]) => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return n(row[key]);
  return 0;
};
const positiveReplies = (stats: Json) => pick(stats, ["positive_reply_count", "positive_replies"]) || n((stats.campaign_lead_stats as Json | undefined)?.interested);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const smartleadFetch = async (url: string, init?: RequestInit) => {
  let response = await fetch(url, { ...init, cache: "no-store" });
  if (response.status === 429) {
    const retryAfterSeconds = Math.max(1, Number(response.headers.get("retry-after") ?? 60) || 60);
    await wait(Math.min(65, retryAfterSeconds) * 1000);
    response = await fetch(url, { ...init, cache: "no-store" });
  }
  return response;
};
const dates = (range: RangeKey) => {
  const days = range === "7d" ? 7 : range === "60d" ? 60 : range === "90d" ? 90 : 30;
  const end = new Date(), start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};
const dateChunks = (range: Exclude<RangeKey, "all">) => {
  const window = dates(range), chunks: Array<{ start: string; end: string }> = [];
  let cursor = new Date(`${window.start}T00:00:00.000Z`), final = new Date(`${window.end}T00:00:00.000Z`);
  while (cursor <= final) {
    const chunkEnd = new Date(Math.min(final.getTime(), cursor.getTime() + 29 * 86400000));
    chunks.push({ start: cursor.toISOString().slice(0, 10), end: chunkEnd.toISOString().slice(0, 10) });
    cursor = new Date(chunkEnd.getTime() + 86400000);
  }
  return chunks;
};
const opportunityRangeSyncs = new Map<number, Promise<Map<RangeKey, Map<string, number>>>>();
const smartleadOpportunityCounts = (apiKey: string, campaignIds: number[], clientId: number) => {
  const current = opportunityRangeSyncs.get(clientId);
  if (current) return current;
  const run = (async () => {
  const rowsByCampaign: Array<{ campaignId: string; repliedAt: number }> = [];
  for (let index = 0; index < campaignIds.length; index += 5) {
    const group = campaignIds.slice(index, index + 5);
    let offset = 0;
    while (offset < 5000) {
      const response = await smartleadFetch(
        `https://server.smartlead.ai/api/v1/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=false`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset, limit: 20, filters: { emailStatus: "Replied", campaignId: group, leadCategories: { categoryIdsIn: [1, 2, 5] } }, sortBy: "REPLY_TIME_DESC" }),
        },
      );
      if (!response.ok) throw new Error(`Smartlead opportunity analytics failed (${response.status}). Previous snapshot preserved.`);
      const payload = await response.json() as Json;
      const rows = ((payload.data ?? payload.messages ?? []) as Json[]);
      for (const row of rows) {
        const repliedAt = new Date(String(row.last_reply_time ?? "")).getTime();
        const campaignId = String(row.email_campaign_id ?? (row.campaign as Json | undefined)?.id ?? "");
        if (campaignId && Number.isFinite(repliedAt)) rowsByCampaign.push({ campaignId, repliedAt });
      }
      if (rows.length < 20) break;
      offset += rows.length;
    }
  }
  const result = new Map<RangeKey, Map<string, number>>();
  for (const range of ["7d", "30d", "60d", "90d", "all"] as RangeKey[]) {
    const counts = new Map<string, number>();
    const window = range === "all" ? null : dates(range);
    const start = window ? new Date(`${window.start}T00:00:00.000Z`).getTime() : Number.NEGATIVE_INFINITY;
    const end = window ? new Date(`${window.end}T00:00:00.000Z`).getTime() + 86400000 : Number.POSITIVE_INFINITY;
    for (const row of rowsByCampaign) {
      if (row.repliedAt < start || row.repliedAt >= end) continue;
      counts.set(row.campaignId, (counts.get(row.campaignId) ?? 0) + 1);
    }
    result.set(range, counts);
  }
  return result;
  })();
  opportunityRangeSyncs.set(clientId, run);
  void run.finally(() => opportunityRangeSyncs.delete(clientId));
  return run;
};
export function syncVenlutoSmartleadCampaigns(force = false, range: RangeKey = "30d", requestedClientId?:number) {
  return performSmartleadCampaignSync(force, range, requestedClientId);
}

const opportunityImportByClient = new Map<number, Promise<number>>();
export function syncClientSmartleadOpportunities(requestedClientId: number) {
  const current = opportunityImportByClient.get(requestedClientId);
  if (current) return current;
  const run = (async () => {
    const apiKey = process.env.SMARTLEAD_API_KEY;
    if (!apiKey) throw new Error("SMARTLEAD_API_KEY is not configured");
    const [client] = await sql`SELECT id,name,campaign_match_keyword FROM clients WHERE id=${requestedClientId} AND status='active'`;
    if (!client) throw new Error("Client workspace is missing");
    const discovery = await smartleadFetch(`https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(apiKey)}`);
    if (!discovery.ok) throw new Error(`Smartlead campaign discovery failed (${discovery.status})`);
    const payload = await discovery.json() as Json | Json[];
    const raw = Array.isArray(payload) ? payload : (payload.campaigns ?? payload.data ?? []) as Json[];
    const needle = String(client.campaign_match_keyword ?? client.name).toLowerCase();
    const campaigns = raw.filter(campaign => String(campaign.name ?? "").toLowerCase().includes(needle));
    for (const campaign of campaigns) {
      const externalId = String(campaign.id ?? campaign.campaign_id ?? "");
      if (!externalId) continue;
      const [row] = await sql`INSERT INTO campaigns(provider,external_id,name) VALUES ('smartlead',${externalId},${String(campaign.name ?? `Smartlead ${externalId}`)}) ON CONFLICT(provider,external_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`;
      await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) VALUES (${requestedClientId},${row.id},${`name:${client.name}`}) ON CONFLICT DO NOTHING`;
    }
    const [owner] = await sql`SELECT id FROM owners WHERE LOWER(email)=LOWER(${process.env.APP_USER ?? "vlad@venlutogroup.com"}) LIMIT 1`;
    return syncSmartleadOpportunityReplies({
      apiKey,
      campaignIds: campaigns.map(campaign => Number(campaign.id ?? campaign.campaign_id)).filter(Number.isFinite),
      clientId: requestedClientId,
      ownerId: owner?.id ? Number(owner.id) : null,
    });
  })();
  opportunityImportByClient.set(requestedClientId, run);
  void run.finally(() => opportunityImportByClient.delete(requestedClientId));
  return run;
}

async function performSmartleadCampaignSync(force = false, range: RangeKey = "30d", requestedClientId?:number) {
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
  const campaigns = raw
    .filter((campaign) => String(campaign.name ?? "").toLowerCase().includes(clientNeedle))
    .sort((a, b) => n(b.id ?? b.campaign_id) - n(a.id ?? a.campaign_id));
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
  const hasDatedOpportunities = freshMetrics?.opportunitySource === "smartlead-categories-v7";
  const analyticsComplete = freshMetrics?.analyticsComplete === true;
  if (!force && hasSentVolume && hasDatedOpportunities && analyticsComplete && fresh?.synced_at && Date.now() - new Date(String(fresh.synced_at)).getTime() < 15 * 60_000) {
    return { ok: true, skipped: true, reason: "analytics fresh", opportunityRepliesSynced: 0 };
  }

  // Opportunity replies are reconciled by syncClientSmartleadOpportunities and
  // the analytics route counts those imported records by reply date. Repeating
  // the complete master-inbox pagination here delayed large workspaces long
  // enough that their send-volume request never committed.
  const opportunityCounts = new Map<string, number>();
  const opportunityTotal = n(freshMetrics?.opportunities);
  const earlyTotals: {
    peopleContacted: number; emailsSent: number; uncontactedLeads: number;
    replies: number; positiveReplies: number; opportunities: number;
    opportunitySource: string; opportunityRecordsSource?: string; analyticsComplete: boolean;
  } = {
    peopleContacted: n(freshMetrics?.peopleContacted),
    emailsSent: n(freshMetrics?.emailsSent),
    uncontactedLeads: n(freshMetrics?.uncontactedLeads),
    replies: n(freshMetrics?.replies),
    positiveReplies: opportunityTotal,
    opportunities: opportunityTotal,
    opportunitySource: "smartlead-categories-v7",
    analyticsComplete: false,
  };
  await sql`INSERT INTO campaign_analytics_snapshots(client_id,range_key,metrics_json,synced_at) VALUES (${clientId},${range},${sql.json(earlyTotals)},NOW()) ON CONFLICT(client_id,range_key) DO UPDATE SET metrics_json=EXCLUDED.metrics_json,synced_at=NOW()`;

  const totals: {
    peopleContacted: number; emailsSent: number; uncontactedLeads: number;
    replies: number; positiveReplies: number; opportunities: number;
    opportunitySource: string; opportunityRecordsSource?: string; analyticsComplete: boolean;
  } = { peopleContacted: 0, emailsSent: 0, uncontactedLeads: 0, replies: 0, positiveReplies: 0, opportunities: 0, opportunitySource: "smartlead-categories-v7", analyticsComplete: true };
  const completed: Array<{ campaign: Json; externalId: string; stats: Json }> = [];
  const recentlySyncedRows = await sql`
    SELECT external_id FROM campaigns
    WHERE provider='smartlead'
      AND NULLIF(metadata_json->>${freshnessKey},'')::timestamptz > NOW() - INTERVAL '10 minutes'
  `;
  const recentlySynced = new Set(recentlySyncedRows.map(row => String(row.external_id)));
  const candidateCampaigns = range === "7d"
    ? campaigns.filter(campaign => {
        const createdAt = new Date(String(campaign.created_at ?? campaign.createdAt ?? "")).getTime();
        const state = String(campaign.status ?? campaign.state ?? "").toLowerCase();
        return (Number.isFinite(createdAt) && createdAt >= new Date(`${dates("7d").start}T00:00:00.000Z`).getTime())
          || state === "active" || state === "started" || state === "running";
      })
    : campaigns;
  const analyticsCampaigns = candidateCampaigns.filter(campaign => !recentlySynced.has(String(campaign.id ?? campaign.campaign_id ?? "")));
  if (analyticsCampaigns.length) {
    const jobs = analyticsCampaigns.flatMap((campaign) => {
      const externalId = String(campaign.id ?? campaign.campaign_id ?? "");
      if (!externalId) return [];
      const urls = range === "all"
        ? [`https://server.smartlead.ai/api/v1/campaigns/${externalId}/analytics?api_key=${encodeURIComponent(apiKey)}`]
        : dateChunks(range).map(window => `https://server.smartlead.ai/api/v1/campaigns/${externalId}/analytics-by-date?start_date=${window.start}&end_date=${window.end}&api_key=${encodeURIComponent(apiKey)}`);
      return urls.map(url => ({ campaign, externalId, url }));
    });
    const rowsByCampaign = new Map<string, { campaign: Json; rows: Json[] }>();
    // Five requests per batch stays within Smartlead's documented campaign
    // filter limit and was verified without throttling across all 55 Celadonsoft
    // campaigns. This keeps 60/90-day refreshes inside the route window.
    for (let index = 0; index < jobs.length; index += 5) {
      const batch = jobs.slice(index, index + 5);
      const results = await Promise.all(batch.map(async job => {
        const response = await smartleadFetch(job.url);
        if (!response.ok) throw new Error(`Smartlead campaign ${job.externalId} analytics failed (${response.status}). Previous snapshot preserved.`);
        return { ...job, stats: await response.json() as Json };
      }));
      for (const result of results) {
        const entry = rowsByCampaign.get(result.externalId) ?? { campaign: result.campaign, rows: [] };
        entry.rows.push(result.stats);
        rowsByCampaign.set(result.externalId, entry);
        const expectedRows = range === "all" ? 1 : dateChunks(range).length;
        // Commit every campaign as soon as all its date chunks are complete.
        // A large refresh can then make durable progress even if the request
        // ends before the remaining historical campaigns finish.
        if (entry.rows.length === expectedRows) {
          const aggregate: Json = {
            unique_sent_count: entry.rows.reduce((sum, row) => sum + pick(row, ["unique_sent_count", "people_contacted", "unique_leads_contacted"]), 0),
            sent_count: entry.rows.reduce((sum, row) => sum + pick(row, ["sent_count", "emails_sent", "total_sent"]), 0),
            reply_count: entry.rows.reduce((sum, row) => sum + pick(row, ["reply_count", "replies", "total_replies"]), 0),
            total_count: Math.max(0, ...entry.rows.map(row => pick(row, ["total_count"]))),
          };
          const contacted = pick(aggregate, ["unique_sent_count", "people_contacted", "unique_leads_contacted"]);
          const values = {
            people_contacted: contacted,
            emails_sent: pick(aggregate, ["sent_count", "emails_sent", "total_sent"]),
            uncontacted_leads: Math.max(0, pick(aggregate, ["total_count"]) - contacted),
            replies: pick(aggregate, ["reply_count", "replies", "total_replies"]),
            positive_replies: 0,
            total_leads: pick(aggregate, ["total_count"]),
          };
          const now = new Date().toISOString();
          const metadata = { ...values, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [`${key}_${range}`, value])), synced_at: now, [freshnessKey]: now, status: String(result.campaign.status ?? result.campaign.state ?? "unknown") };
          await sql`UPDATE campaigns SET metadata_json=metadata_json||${sql.json(metadata)} WHERE provider='smartlead' AND external_id=${result.externalId}`;
        }
      }
      if (index + 5 < jobs.length) await wait(500);
    }
    for (const [externalId, { campaign, rows }] of rowsByCampaign) {
      const stats: Json = {
        unique_sent_count: rows.reduce((sum, row) => sum + pick(row, ["unique_sent_count", "people_contacted", "unique_leads_contacted"]), 0),
        sent_count: rows.reduce((sum, row) => sum + pick(row, ["sent_count", "emails_sent", "total_sent"]), 0),
        reply_count: rows.reduce((sum, row) => sum + pick(row, ["reply_count", "replies", "total_replies"]), 0),
        total_count: Math.max(0, ...rows.map((row) => pick(row, ["total_count"]))),
      };
      completed.push({ campaign, externalId, stats });
    }
    for (const item of completed) item.stats.positive_reply_count = opportunityCounts.get(item.externalId) ?? 0;
    for (const { stats } of completed) {
      totals.peopleContacted += pick(stats, ["unique_sent_count", "people_contacted", "unique_leads_contacted"]);
      totals.emailsSent += pick(stats, ["sent_count", "emails_sent", "total_sent"]);
      totals.replies += pick(stats, ["reply_count", "replies", "total_replies"]);
      totals.positiveReplies += positiveReplies(stats);
    }
    totals.opportunities = totals.positiveReplies;
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
      for (const key of ["peopleContacted", "emailsSent", "replies"] as const) {
        if (totals[key] < n(metrics[key])) {
          throw new Error(`Smartlead ${range} integrity check failed: ${key} (${totals[key]}) is below ${narrowerRange} (${n(metrics[key])}). Previous snapshot preserved.`);
        }
      }
    }
  }

  await sql`INSERT INTO campaign_analytics_snapshots(client_id,range_key,metrics_json,synced_at) VALUES (${clientId},${range},${sql.json(totals)},NOW()) ON CONFLICT(client_id,range_key) DO UPDATE SET metrics_json=EXCLUDED.metrics_json,synced_at=NOW()`;
  return { ok: true, synced, opportunities: totals.opportunities, totals, range };
}
