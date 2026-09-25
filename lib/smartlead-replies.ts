import { sql } from "./db";

type InboxRow = {
  lead_category_id?: number;
  lead_first_name?: string;
  lead_last_name?: string;
  lead_email?: string;
  email_lead_id?: number | string;
  email_lead_map_id?: number | string;
  email_campaign_id?: number | string;
  email_campaign_name?: string;
  last_reply_time?: string;
  email_history?: Array<{
    stats_id?: number | string;
    message_id?: string;
    type?: string;
    time?: string;
    email_body?: string;
  }>;
};

const categoryNames: Record<number, string> = {
  1: "Interested",
  2: "Meeting Request",
  5: "Information Request",
};

const plain = (value: string) =>
  value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export async function syncSmartleadOpportunityReplies(args: {
  apiKey: string;
  campaignIds: number[];
  clientId: number;
  ownerId: number | null;
}) {
  const { apiKey, campaignIds, clientId, ownerId } = args;
  let synced = 0;

  for (let campaignIndex = 0; campaignIndex < campaignIds.length; campaignIndex += 5) {
    const group = campaignIds.slice(campaignIndex, campaignIndex + 5);
    let offset = 0;

    while (offset < 5000) {
      const response = await fetch(
        `https://server.smartlead.ai/api/v1/master-inbox/inbox-replies?api_key=${encodeURIComponent(apiKey)}&fetch_message_history=true`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            offset,
            limit: 20,
            filters: {
              emailStatus: "Replied",
              campaignId: group,
              leadCategories: { categoryIdsIn: [1, 2, 5] },
            },
            sortBy: "REPLY_TIME_DESC",
          }),
          cache: "no-store",
        },
      );

      if (!response.ok) {
        console.warn("[Smartlead sync] opportunity inbox rejected", {
          campaignIds: group,
          status: response.status,
        });
        break;
      }

      const payload = (await response.json()) as {
        data?: InboxRow[];
        messages?: InboxRow[];
      };
      const rows = payload.data ?? payload.messages ?? [];

      for (const row of rows) {
        const categoryName = categoryNames[Number(row.lead_category_id)];
        const email = String(row.lead_email ?? "").trim().toLowerCase();
        const externalCampaignId = String(row.email_campaign_id ?? "");
        if (!categoryName || !email || !externalCampaignId) continue;

        const domain = email.split("@")[1] ?? "unknown.local";
        const [company] = await sql`
          INSERT INTO companies(name,domain)
          VALUES (${domain},${domain})
          ON CONFLICT(domain) DO UPDATE SET name=companies.name
          RETURNING id
        `;
        const [campaign] = await sql`
          SELECT id FROM campaigns
          WHERE provider='smartlead' AND external_id=${externalCampaignId}
        `;
        if (!campaign) continue;

        const [prospect] = await sql`
          INSERT INTO prospects(first_name,last_name,email,normalized_email,source,status,owner_id,company_id,next_action,deadline_at)
          VALUES (${row.lead_first_name ?? ""},${row.lead_last_name ?? ""},${email},${email},'smartlead','action_due',${ownerId},${company.id},'Reply to opportunity',NOW()+INTERVAL '5 minutes')
          ON CONFLICT(normalized_email) DO UPDATE SET
            first_name=CASE WHEN EXCLUDED.first_name<>'' THEN EXCLUDED.first_name ELSE prospects.first_name END,
            last_name=CASE WHEN EXCLUDED.last_name<>'' THEN EXCLUDED.last_name ELSE prospects.last_name END,
            company_id=EXCLUDED.company_id,
            owner_id=COALESCE(prospects.owner_id,EXCLUDED.owner_id),
            updated_at=NOW()
          RETURNING id
        `;

        const reply = [...(row.email_history ?? [])]
          .reverse()
          .find((message) => String(message.type ?? "").toUpperCase() === "REPLY");
        const replyId = String(
          reply?.message_id ??
            reply?.stats_id ??
            row.email_lead_map_id ??
            `${externalCampaignId}:${email}:${row.last_reply_time ?? ""}`,
        );
        const body = plain(String(reply?.email_body ?? "")) || "Reply available in Smartlead";
        const receivedAt = reply?.time ?? row.last_reply_time ?? new Date().toISOString();

        await sql`
          INSERT INTO replies(prospect_id,campaign_id,provider_reply_id,body,sentiment,reply_category,received_at)
          VALUES (${prospect.id},${campaign.id},${replyId},${body},'positive',${categoryName},${receivedAt})
          ON CONFLICT(provider_reply_id) DO UPDATE SET
            prospect_id=EXCLUDED.prospect_id,
            campaign_id=EXCLUDED.campaign_id,
            body=EXCLUDED.body,
            sentiment='positive',
            reply_category=EXCLUDED.reply_category,
            received_at=EXCLUDED.received_at
        `;
        await sql`
          INSERT INTO client_campaigns(client_id,campaign_id,matched_by)
          VALUES (${clientId},${campaign.id},'smartlead:opportunity-sync')
          ON CONFLICT DO NOTHING
        `;
        await sql`
          INSERT INTO client_prospects(client_id,prospect_id)
          VALUES (${clientId},${prospect.id})
          ON CONFLICT DO NOTHING
        `;
        synced += 1;
      }

      if (rows.length < 20) break;
      offset += rows.length;
    }
  }

  return synced;
}
