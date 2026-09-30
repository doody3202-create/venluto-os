import { scopedClientId } from "@/lib/portal-auth";
import { syncInstantly } from "@/lib/instantly-sync";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const url = new URL(request.url), value = url.searchParams.get("range");
  const clientId = scopedClientId(request, Number(url.searchParams.get("clientId")));
  const range = (["7d", "30d", "60d", "90d", "all"].includes(value ?? "") ? value : "30d") as "7d" | "30d" | "60d" | "90d" | "all";
  if (!clientId) return Response.json({ error: "Workspace access denied" }, { status: 403 });
  try { return Response.json(await syncInstantly(range, clientId)); }
  catch (error) { console.error("[Instantly sync] failed", error); return Response.json({ error: error instanceof Error ? error.message : "Instantly sync failed" }, { status: 500 }); }
}
