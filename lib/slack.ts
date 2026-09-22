import { sql } from "@/lib/db";

export async function notifySlack(idempotencyKey: string, text: string) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`Slack returned ${response.status}: ${(await response.text()).slice(0, 180)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Slack error";
    await sql`INSERT INTO sync_jobs(provider,operation,idempotency_key,payload_json,status,attempts,last_error,next_retry_at)
      VALUES ('slack','send_notification',${idempotencyKey},${JSON.stringify({ text })}::jsonb,'failed',1,${message},NOW()+INTERVAL '5 minutes')
      ON CONFLICT(idempotency_key) DO UPDATE SET status='failed',last_error=EXCLUDED.last_error,next_retry_at=EXCLUDED.next_retry_at,updated_at=NOW()`;
  }
}
