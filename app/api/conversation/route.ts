import { ensureDatabase, sql } from "@/lib/db";
import { scopedClientId } from "@/lib/portal-auth";

export const dynamic = "force-dynamic";

const plain = (value: string) => value.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n\n").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'").replace(/<([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})>/g, "$1").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

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
    WHERE cp.client_id=${clientId} AND p.id=${prospectId}
    ORDER BY r.received_at DESC LIMIT 1
  `;
  if (!lead) return Response.json({ error: "Lead not found" }, { status: 404 });
  const apiKey = process.env.SMARTLEAD_API_KEY;
  if (!apiKey) return Response.json({ error: "Smartlead is not configured" }, { status: 503 });
  let found: Record<string, unknown> | undefined;
  for (let offset = 0; offset < 5000 && !found; offset += 20) {
    const response = await fetch(`https://server.smartlead.ai/api/v1/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`, {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ offset, limit: 20, filters: { emailStatus: "Replied", campaignId: Number(lead.campaign_external_id), ...(String(lead.email).length <= 30 ? { search: String(lead.email) } : {}) }, sortBy: "SENT_TIME_DESC" }),
    });
    if (!response.ok) return Response.json({ error: `Smartlead conversation failed (${response.status})` }, { status: 502 });
    const payload = await response.json() as { messages?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
    const rows = payload.messages ?? payload.data ?? [];
    found = rows.find(row => String((row.lead as { email?: string } | undefined)?.email ?? row.lead_email ?? "").toLowerCase() === String(lead.email).toLowerCase());
    if (rows.length < 20) break;
  }
  let history = (found?.message_history as Array<Record<string, unknown>> | undefined) ?? [];
  const foundLead = found?.lead as { id?: string | number } | undefined;
  const smartleadLeadId = foundLead?.id ?? found?.email_lead_id;
  // Master Inbox can lag after an agent sends a reply. Smartlead's per-lead
  // history is the definitive thread and includes both SENT and REPLY events.
  if (smartleadLeadId) {
    const historyResponse = await fetch(`https://server.smartlead.ai/api/v1/campaigns/${encodeURIComponent(String(lead.campaign_external_id))}/leads/${encodeURIComponent(String(smartleadLeadId))}/message-history?api_key=${encodeURIComponent(apiKey)}`, { cache: "no-store" });
    if (historyResponse.ok) {
      const historyPayload = await historyResponse.json() as Array<Record<string, unknown>> | { history?: Array<Record<string, unknown>>; message_history?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> };
      const definitive = Array.isArray(historyPayload) ? historyPayload : historyPayload.history ?? historyPayload.message_history ?? historyPayload.data ?? [];
      if (definitive.length) history = definitive;
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
  const messages = [...liveMessages, ...savedMessages].filter((message, index, all) => all.findIndex(candidate => String(candidate.body).trim() === String(message.body).trim()) === index).sort((a, b) => new Date(String(b.sent_at)).getTime() - new Date(String(a.sent_at)).getTime());
  return Response.json({ messages });
}
