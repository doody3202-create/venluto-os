import { scopedClientId } from "@/lib/portal-auth";
import { syncClientSmartleadOpportunities } from "@/lib/smartlead-sync";

export async function POST(request: Request) {
  const clientId = scopedClientId(request, Number(new URL(request.url).searchParams.get("clientId")));
  if (!clientId) return Response.json({ error: "Workspace access denied" }, { status: 403 });
  try {
    const synced = await syncClientSmartleadOpportunities(clientId);
    return Response.json({ ok: true, synced });
  } catch (error) {
    console.error("[Smartlead opportunities] failed", error);
    return Response.json({ error: error instanceof Error ? error.message : "Opportunity sync failed" }, { status: 500 });
  }
}
