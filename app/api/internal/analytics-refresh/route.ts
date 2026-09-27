import { createHash, timingSafeEqual } from "node:crypto";
import { syncVenlutoSmartleadCampaigns } from "@/lib/smartlead-sync";

export const dynamic = "force-dynamic";
type RangeKey = "7d" | "30d" | "60d" | "90d" | "all";

function authorized(request: Request) {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const supplied = request.headers.get("x-venluto-worker-signature") ?? "";
  if (!databaseUrl || !supplied) return false;
  const expected = createHash("sha256").update(`venluto-analytics:${databaseUrl}`).digest("hex");
  const left = Buffer.from(supplied), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { clientId?: number; range?: RangeKey };
  const range = body.range;
  if (!body.clientId || !range || !["7d", "30d", "60d", "90d", "all"].includes(range)) {
    return Response.json({ error: "clientId and a valid range are required" }, { status: 400 });
  }
  try {
    return Response.json(await syncVenlutoSmartleadCampaigns(true, range, Number(body.clientId)));
  } catch (error) {
    console.error("[Background analytics] refresh failed", { clientId: body.clientId, range, error });
    return Response.json({ error: error instanceof Error ? error.message : "Analytics refresh failed" }, { status: 500 });
  }
}
