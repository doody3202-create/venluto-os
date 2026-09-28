import { ensureDatabase, sql } from "@/lib/db";
import { scopedClientId } from "@/lib/portal-auth";

export const dynamic = "force-dynamic";

const plain = (value: string) => value.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n\n").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/<([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})>/g, "$1").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

const records = (payload: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (!payload || typeof payload !== "object") return [];
  const object = payload as Record<string, unknown>;
  for (const key of ["data", "leads", "results"]) {
    if (Array.isArray(object[key])) return object[key] as Array<Record<string, unknown>>;
  }
  return [object];
};

const exactEmail = (row: Record<string, unknown>, email: string) =>
  String(row.email ?? (row.lead as Record<string, unknown> | undefined)?.email ?? "").toLowerCase() === email.toLowerCase();

async function resolveSmartleadLead(apiKey: string, campaignId: string, email: string, inboxRow?: Record<string, unknown>) {
  const nestedLead = inboxRow?.lead as Record<string, unknown> | undefined;
  if (nestedLead?.id) return { id: nestedLead.id, campaignIds: [campaignId] };

  // email_lead_id and campaign_lead_map_id are relationship IDs, not the lead
  // ID required by Smartlead's definitive message-history endpoint.
  const lookup = await fetch(`https://server.smartlead.ai/api/v1/leads/?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`, { cache: "no-store" });
  if (lookup.ok) {
    const match = records(await lookup.json()).find(row => exactEmail(row, email));
    if (match?.id ?? match?.lead_id) {
      const memberships = Array.isArray(match.lead_campaign_data) ? match.lead_campaign_data as Array<Record<string, unknown>> : [];
      const campaignIds = memberships.map(item => item.campaign_id).filter(Boolean).map(String);
      return { id: match.id ?? match.lead_id, campaignIds: [...new Set([campaignId, ...campaignIds])] };
    }
  }

  // Some Smartlead accounts do not expose the global email lookup. Resolve the
  // real lead ID from the campaign itself so every client and future campaign
  // still receives the complete SENT + REPLY timeline.
  for (let offset = 0; offset < 100000; offset += 100) {
    const response = await fetch(`https://server.smartlead.ai/api/v1/campaigns/${encodeURIComponent(campaignId)}/leads?api_key=${encodeURIComponent(apiKey)}&offset=${offset}&limit=100`, { cache: "no-store" });
    if (!response.ok) break;
    const rows = records(await response.json());
    const match = rows.find(row => exactEmail(row, email));
    const matchedLead = match?.lead as Record<string, unknown> | undefined;
    if (matchedLead?.id ?? match?.id ?? match?.lead_id) return { id: matchedLead?.id ?? match?.id ?? match?.lead_id, campaignIds: [campaignId] };
    if (rows.length < 100) break;
  }
  return undefined;
}

export async function GET(request: Request) {
  await ensureDatabase();
  const url = new URL(request.url);
  const clientId = scopedClientId(request, Number(url.searchParams.get("clientId")));
  const prospectId = Number(url.searchParams.get("prospectId"));
  if (!clientId || !prospectId) return Response.json({ error: "Workspace access denied" }, { status: 403 });
  const [lead] = await sql`
    SELECT p.id,p.email,p.first_name,p.last_name,ca.external_id campaign_external_id
    FROM client_prospects cp
    JOIN prospects p ON p.id=cp.prospect_id
    JOIN replies r ON r.prospect_id=p.id
    JOIN campaigns ca ON ca.id=r.campaign_id AND ca.provider='smartlead'
    JOIN client_campaigns cc ON cc.campaign_id=ca.id AND cc.client_id=cp.client_id
    WHERE cp.client_id=${clientId} AND p.id=${prospectId}
    ORDER BY r.received_at DESC LIMIT 1
  `;
  if (!lead) return Response.json({ error: "Lead not found" }, { status: 404 });
  const apiKey = process.env.SMARTLEAD_API_KEY;
  if (!apiKey) return Response.json({ error: "Smartlead is not configured" }, { status: 503 });
  let history: Array<Record<string, unknown>> = [];
  const smartleadLead = await resolveSmartleadLead(apiKey, String(lead.campaign_external_id), String(lead.email));
  const clientCampaignRows = await sql`SELECT ca.external_id FROM campaigns ca JOIN client_campaigns cc ON cc.campaign_id=ca.id WHERE cc.client_id=${clientId} AND ca.provider='smartlead'`;
  const clientCampaignIds = new Set(clientCampaignRows.map(row => String(row.external_id)));
  // Go straight to Smartlead's definitive per-lead history. Master Inbox can
  // lag after an agent sends a reply and must never be the primary source.
  if (smartleadLead) {
    const permittedCampaignIds = smartleadLead.campaignIds.filter(campaignId => clientCampaignIds.has(campaignId));
    const histories = await Promise.all(permittedCampaignIds.map(async campaignId => {
      const historyResponse = await fetch(`https://server.smartlead.ai/api/v1/campaigns/${encodeURIComponent(campaignId)}/leads/${encodeURIComponent(String(smartleadLead.id))}/message-history?api_key=${encodeURIComponent(apiKey)}`, { cache: "no-store" });
      if (!historyResponse.ok) return [];
      const historyPayload = await historyResponse.json() as Array<Record<string, unknown>> | { history?: Array<Record<string, unknown>>; message_history?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
      return Array.isArray(historyPayload) ? historyPayload : historyPayload.history ?? historyPayload.message_history ?? historyPayload.data ?? [];
    }));
    history = histories.flat();
  }
  // Compatibility fallback for the rare account where lead lookup/history is
  // unavailable. This is deliberately secondary because inbox history can lag.
  if (!history.length) {
    for (let offset = 0; offset < 5000 && !history.length; offset += 20) {
      const response = await fetch(`https://server.smartlead.ai/api/v1/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`, {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ offset, limit: 20, filters: { emailStatus: "Replied", campaignId: Number(lead.campaign_external_id), ...(String(lead.email).length <= 30 ? { search: String(lead.email) } : {}) }, sortBy: "SENT_TIME_DESC" }),
      });
      if (!response.ok) break;
      const payload = await response.json() as { messages?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
      const rows = payload.messages ?? payload.data ?? [];
      const found = rows.find(row => String((row.lead as { email?: string } | undefined)?.email ?? row.lead_email ?? "").toLowerCase() === String(lead.email).toLowerCase());
      history = (found?.message_history as Array<Record<string, unknown>> | undefined) ?? [];
      if (rows.length < 20) break;
    }
  }
  const liveMessages = history.map((message, index) => {
    const messageType = String(message.direction ?? message.type ?? "outbound").toLowerCase();
    const inbound = messageType === "inbound" || messageType === "reply" || messageType === "received";
    return {
    id: String(message.id ?? message.message_id ?? message.stats_id ?? `${prospectId}:${index}`),
    direction: inbound ? "inbound" : "outbound",
    sender_name: inbound ? ([lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email) : "Venluto team",
    sender_email: inbound ? lead.email : null,
    body: plain(String(message.body ?? message.email_body ?? "")),
    sent_at: String(message.received_at ?? message.sent_at ?? message.time ?? new Date().toISOString()),
  };
  }).filter(message => message.body);
  const savedMessages = await sql`SELECT id::text id,direction,sender_name,sender_email,body,sent_at::text sent_at FROM conversation_messages WHERE prospect_id=${prospectId} ORDER BY sent_at DESC`;
  const liveBodies = new Set(liveMessages.map(message => `${message.direction}:${message.body.trim()}`));
  const supplementalSaved = savedMessages.filter(message => !liveBodies.has(`${message.direction}:${String(message.body).trim()}`));
  const messages = [...liveMessages, ...supplementalSaved]
    .filter((message, index, all) => all.findIndex(candidate => `${candidate.id}:${candidate.direction}:${candidate.sent_at}` === `${message.id}:${message.direction}:${message.sent_at}`) === index)
    .sort((a, b) => new Date(String(b.sent_at)).getTime() - new Date(String(a.sent_at)).getTime());
  return Response.json({ messages });
}
