import { ensureDatabase, sql } from "@/lib/db";
import { scopedClientId } from "@/lib/portal-auth";
export const dynamic = "force-dynamic";
type RangeKey = "7d" | "30d" | "60d" | "90d" | "all";
const daysFor = (range: RangeKey) => range === "7d" ? 7 : range === "60d" ? 60 : range === "90d" ? 90 : range === "all" ? 3650 : 30;
const pct = (current: number, prior: number) => prior === 0 ? (current > 0 ? 100 : 0) : Math.round((current - prior) / prior * 1000) / 10;

export async function GET(request: Request) {
  await ensureDatabase();
  const url = new URL(request.url);
  const clientId = scopedClientId(request,Number(url.searchParams.get("clientId")));
  const range = (url.searchParams.get("range") ?? "30d") as RangeKey;
  if (!clientId) return Response.json({ error: "Workspace access denied" }, { status: 403 });
  const [client] = await sql`SELECT id,name FROM clients WHERE id=${clientId} AND status='active'`;
  if (!client) return Response.json({ error: "Client workspace not found" }, { status: 404 });

  const days = daysFor(range), end = new Date(), start = new Date(end.getTime() - days * 86400000), prior = new Date(start.getTime() - days * 86400000);
  const startIso = start.toISOString(), endIso = end.toISOString(), priorIso = prior.toISOString();
  await sql`INSERT INTO client_campaigns(client_id,campaign_id,matched_by) SELECT ${clientId},ca.id,'campaign_name' FROM campaigns ca WHERE LOWER(ca.name) LIKE ${`%${String(client.name).toLowerCase()}%`} ON CONFLICT DO NOTHING`;

  const metricTotals = async (from: string, to: string) => (await sql`
    SELECT COALESCE(SUM(people_contacted),0)::int people_contacted,
      COALESCE(SUM(emails_sent),0)::int emails_sent,
      COALESCE(SUM(uncontacted_leads),0)::int uncontacted_leads,
      COALESCE(SUM(replies),0)::int replies,
      COALESCE(SUM(positive_replies),0)::int positive_replies,
      COALESCE(SUM(opportunities),0)::int opportunities,
      COALESCE(SUM(meetings_booked),0)::int meetings_booked,
      COALESCE(SUM(meetings_completed),0)::int meetings_completed,
      COALESCE(SUM(closed_won),0)::int closed_won,
      COALESCE(SUM(revenue_cents),0)::bigint revenue_cents
    FROM campaign_daily_metrics
    WHERE client_id=${clientId} AND metric_date>=${from}::date AND metric_date<${to}::date+1
  `)[0];
  const liveTotals = async (from: string, to: string) => (await sql`
    SELECT COUNT(DISTINCT r.id)::int replies,
      COUNT(DISTINCT r.id) FILTER(WHERE r.sentiment='positive')::int positive_replies,
      COUNT(DISTINCT r.id) FILTER(WHERE LOWER(COALESCE(r.reply_category,'')) IN ('interested','information request','meeting request'))::int opportunities,
      COUNT(DISTINCT m.id) FILTER(WHERE m.status IN ('confirmed','booked'))::int meetings_booked,
      COUNT(DISTINCT m.id) FILTER(WHERE m.status IN ('completed','showed'))::int meetings_completed,
      COUNT(DISTINCT p.id) FILTER(WHERE p.status IN ('closed_won','won'))::int closed_won
    FROM client_campaigns cc
    JOIN campaigns ca ON ca.id=cc.campaign_id
    LEFT JOIN replies r ON r.campaign_id=ca.id AND r.received_at>=${from} AND r.received_at<${to}
    LEFT JOIN prospects p ON p.id=r.prospect_id
    LEFT JOIN meetings m ON m.prospect_id=p.id AND m.starts_at>=${from} AND m.starts_at<${to}
    WHERE cc.client_id=${clientId}
  `)[0];
  const pipelineTotals = async (from: string, to: string) => (await sql`
    SELECT
      COUNT(DISTINCT p.id) FILTER(WHERE EXISTS(SELECT 1 FROM prospect_transitions pt WHERE pt.prospect_id=p.id AND pt.to_status='meeting_booked' AND pt.created_at>=${from} AND pt.created_at<${to}))::int meetings_booked,
      COUNT(DISTINCT p.id) FILTER(WHERE EXISTS(SELECT 1 FROM prospect_transitions pt WHERE pt.prospect_id=p.id AND pt.to_status IN ('showed','completed') AND pt.created_at>=${from} AND pt.created_at<${to}))::int meetings_completed,
      COUNT(DISTINCT p.id) FILTER(WHERE p.pipeline_tag='closed_won' AND p.closed_at>=${from} AND p.closed_at<${to})::int closed_won,
      COALESCE(SUM(p.deal_value_cents) FILTER(WHERE p.pipeline_tag='closed_won' AND p.closed_at>=${from} AND p.closed_at<${to}),0)::bigint revenue_cents
    FROM client_prospects cp JOIN prospects p ON p.id=cp.prospect_id WHERE cp.client_id=${clientId}
  `)[0];
  const [current, priorRows, nowLive, priorLive, nowPipeline, priorPipeline] = await Promise.all([
    metricTotals(startIso, endIso), metricTotals(priorIso, startIso),
    liveTotals(startIso, endIso), liveTotals(priorIso, startIso),
    pipelineTotals(startIso, endIso), pipelineTotals(priorIso, startIso),
  ]);
  const combine = (row: Record<string, unknown>, live: Record<string, unknown>) => ({
    peopleContacted: Number(row.people_contacted), emailsSent: Number(row.emails_sent), uncontactedLeads: Number(row.uncontacted_leads),
    replies: Math.max(Number(row.replies), Number(live.replies)), positiveReplies: Math.max(Number(row.positive_replies), Number(live.positive_replies)),
    opportunities: Math.max(Number(row.opportunities), Number(live.opportunities)), meetingsBooked: Math.max(Number(row.meetings_booked), Number(live.meetings_booked)),
    meetingsCompleted: Math.max(Number(row.meetings_completed), Number(live.meetings_completed)), closedWon: Math.max(Number(row.closed_won), Number(live.closed_won)),
    revenueCents: Number(row.revenue_cents),
  });
  let totals = combine(current, nowLive), previous = combine(priorRows, priorLive);
  totals.closedWon = Number(nowPipeline.closed_won);
  totals.revenueCents = Number(nowPipeline.revenue_cents);
  totals.meetingsBooked = Math.max(totals.meetingsBooked, Number(nowPipeline.meetings_booked));
  totals.meetingsCompleted = Math.max(totals.meetingsCompleted, Number(nowPipeline.meetings_completed));
  previous.closedWon = Number(priorPipeline.closed_won);
  previous.revenueCents = Number(priorPipeline.revenue_cents);
  previous.meetingsBooked = Math.max(previous.meetingsBooked, Number(priorPipeline.meetings_booked));
  previous.meetingsCompleted = Math.max(previous.meetingsCompleted, Number(priorPipeline.meetings_completed));

  const peopleKey = `people_contacted_${range}`, emailsKey = `emails_sent_${range}`, uncontactedKey = `uncontacted_leads_${range}`, repliesKey = `replies_${range}`, positiveKey = `positive_replies_${range}`;
  const campaigns = await sql`
    SELECT ca.id,ca.name,ca.external_id,ca.metadata_json->>'status' status,
      GREATEST(COALESCE((ca.metadata_json->>${peopleKey})::int,0),COALESCE(SUM(dm.people_contacted),0)::int) contacted,
      GREATEST(COALESCE((ca.metadata_json->>${emailsKey})::int,0),COALESCE(SUM(dm.emails_sent),0)::int) emails_sent,
      GREATEST(COALESCE((ca.metadata_json->>${uncontactedKey})::int,0),COALESCE(SUM(dm.uncontacted_leads),0)::int) uncontacted,
      GREATEST(COALESCE((ca.metadata_json->>${repliesKey})::int,0),COUNT(DISTINCT r.id)::int) replies,
      GREATEST(COALESCE((ca.metadata_json->>${positiveKey})::int,0),COUNT(DISTINCT r.id) FILTER(WHERE r.sentiment='positive')::int) positive_replies,
      GREATEST(COALESCE((ca.metadata_json->>${positiveKey})::int,0),COUNT(DISTINCT r.id) FILTER(WHERE LOWER(COALESCE(r.reply_category,'')) IN ('interested','information request','meeting request'))::int) opportunities,
      GREATEST(COUNT(DISTINCT m.id) FILTER(WHERE m.status IN ('confirmed','booked'))::int,(SELECT COUNT(DISTINCT pt.prospect_id)::int FROM prospect_transitions pt JOIN replies r2 ON r2.prospect_id=pt.prospect_id WHERE r2.campaign_id=ca.id AND pt.to_status='meeting_booked' AND pt.created_at>=${startIso} AND pt.created_at<${endIso})) booked,
      GREATEST(COUNT(DISTINCT m.id) FILTER(WHERE m.status IN ('completed','showed'))::int,(SELECT COUNT(DISTINCT pt.prospect_id)::int FROM prospect_transitions pt JOIN replies r2 ON r2.prospect_id=pt.prospect_id WHERE r2.campaign_id=ca.id AND pt.to_status IN ('showed','completed') AND pt.created_at>=${startIso} AND pt.created_at<${endIso})) completed,
      (SELECT COUNT(DISTINCT p2.id)::int FROM replies r2 JOIN prospects p2 ON p2.id=r2.prospect_id WHERE r2.campaign_id=ca.id AND p2.pipeline_tag='closed_won' AND p2.closed_at>=${startIso} AND p2.closed_at<${endIso}) closed_won,
      (SELECT COALESCE(SUM(pipeline.deal_value_cents),0)::bigint FROM (SELECT DISTINCT p2.id,p2.deal_value_cents FROM replies r2 JOIN prospects p2 ON p2.id=r2.prospect_id WHERE r2.campaign_id=ca.id AND p2.pipeline_tag='closed_won' AND p2.closed_at>=${startIso} AND p2.closed_at<${endIso} AND p2.deal_value_cents>0) pipeline) revenue_cents
    FROM client_campaigns cc JOIN campaigns ca ON ca.id=cc.campaign_id
    LEFT JOIN campaign_daily_metrics dm ON dm.campaign_id=ca.id AND dm.metric_date>=${startIso}::date AND dm.metric_date<${endIso}::date+1
    LEFT JOIN replies r ON r.campaign_id=ca.id AND r.received_at>=${startIso} AND r.received_at<${endIso}
    LEFT JOIN prospects p ON p.id=r.prospect_id
    LEFT JOIN meetings m ON m.prospect_id=p.id AND m.starts_at>=${startIso} AND m.starts_at<${endIso}
    WHERE cc.client_id=${clientId}
    GROUP BY ca.id ORDER BY opportunities DESC,ca.name
  `;
  if (campaigns.length) totals = {
    ...totals,
    peopleContacted: Math.max(totals.peopleContacted, campaigns.reduce((sum, row) => sum + Number(row.contacted), 0)),
    emailsSent: Math.max(totals.emailsSent, campaigns.reduce((sum, row) => sum + Number(row.emails_sent), 0)),
    uncontactedLeads: Math.max(totals.uncontactedLeads, campaigns.reduce((sum, row) => sum + Number(row.uncontacted), 0)),
    replies: Math.max(totals.replies, campaigns.reduce((sum, row) => sum + Number(row.replies), 0)),
    positiveReplies: Math.max(totals.positiveReplies, campaigns.reduce((sum, row) => sum + Number(row.positive_replies), 0)),
    opportunities: Math.max(totals.opportunities, campaigns.reduce((sum, row) => sum + Number(row.opportunities), 0)),
  };
  const [snapshot] = await sql`SELECT metrics_json,synced_at FROM campaign_analytics_snapshots WHERE client_id=${clientId} AND range_key=${range}`;
  if (snapshot?.metrics_json) {
    const metrics = typeof snapshot.metrics_json === "string" ? JSON.parse(snapshot.metrics_json) : snapshot.metrics_json;
    totals = {
      ...totals,
      peopleContacted: Number(metrics.peopleContacted ?? totals.peopleContacted),
      emailsSent: Number(metrics.emailsSent ?? totals.emailsSent),
      uncontactedLeads: Number(metrics.uncontactedLeads ?? totals.uncontactedLeads),
      replies: Number(metrics.replies ?? totals.replies),
      positiveReplies: Number(metrics.positiveReplies ?? totals.positiveReplies),
      opportunities: Number(metrics.opportunities ?? totals.opportunities),
    };
  }
  // Protect the UI from legacy/partial wider snapshots while a corrected sync is
  // running. A wider cumulative range can never be below its narrower range.
  const floorRange = range === "60d" ? "30d" : range === "90d" ? "60d" : range === "all" ? "90d" : null;
  if (floorRange) {
    const [floorSnapshot] = await sql`SELECT metrics_json FROM campaign_analytics_snapshots WHERE client_id=${clientId} AND range_key=${floorRange}`;
    if (floorSnapshot?.metrics_json) {
      const floor = typeof floorSnapshot.metrics_json === "string" ? JSON.parse(floorSnapshot.metrics_json) : floorSnapshot.metrics_json;
      for (const key of ["peopleContacted", "emailsSent", "replies", "positiveReplies", "opportunities"] as const) {
        totals[key] = Math.max(totals[key], Number(floor[key] ?? 0));
      }
    }
  }
  const inbox = await sql`
    SELECT r.id,r.body,r.sentiment,r.reply_category,r.received_at,p.first_name,p.last_name,p.email,c.name company_name,c.domain company_domain,ca.name campaign_name
    FROM client_campaigns cc JOIN campaigns ca ON ca.id=cc.campaign_id
    JOIN replies r ON r.campaign_id=ca.id AND LOWER(COALESCE(r.reply_category,'')) IN ('interested','information request','meeting request')
    JOIN prospects p ON p.id=r.prospect_id LEFT JOIN companies c ON c.id=p.company_id
    WHERE cc.client_id=${clientId} ORDER BY r.received_at DESC LIMIT 1000
  `;
  const comparison = Object.fromEntries(Object.keys(totals).map((key) => [key, pct(totals[key as keyof typeof totals], previous[key as keyof typeof previous])]));
  return Response.json({ client, range, totals, syncedAt: snapshot?.synced_at ?? null, comparison, ratios: { positiveReply: totals.opportunities ? Math.round(totals.peopleContacted / totals.opportunities) : null, meeting: totals.meetingsBooked ? Math.round(totals.emailsSent / totals.meetingsBooked) : null }, campaigns, inbox, demoMode: process.env.DEMO_MODE !== "false" });
}
