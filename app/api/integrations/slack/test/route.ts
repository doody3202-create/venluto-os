import { notifySlack } from "@/lib/slack";

export async function GET() {
  if (!process.env.SLACK_WEBHOOK_URL) {
    return Response.json({ ok: false, error: "SLACK_WEBHOOK_URL is not configured" }, { status: 503 });
  }
  await notifySlack(`slack:test:${Date.now()}`, "✅ *Venluto OS is connected*\nSlack alerts are ready for positive Smartlead replies, Cal.com bookings, and integration failures.");
  return Response.json({ ok: true, message: "Test notification sent to Slack" });
}
