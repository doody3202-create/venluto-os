import { ensureDatabase, sql } from "@/lib/db";
import { readSession } from "@/lib/portal-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await ensureDatabase();
  const auth = readSession(request);
  if (auth?.role !== "admin") return Response.json({ error: "Admin access required" }, { status: 403 });

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin" }, { status: 403 });

  const form = await request.formData();
  const clientId = Number(form.get("clientId"));
  if (!Number.isSafeInteger(clientId) || clientId < 1) return Response.json({ error: "Invalid workspace" }, { status: 400 });

  const [client] = await sql`SELECT id,name,status FROM clients WHERE id=${clientId}`;
  if (!client) return Response.json({ error: "Workspace not found" }, { status: 404 });
  if (String(client.name).toLowerCase() === "venluto") return Response.json({ error: "The primary Venluto workspace cannot be deleted" }, { status: 400 });

  await sql.begin(async tx => {
    await tx`UPDATE workspace_users SET status='disabled' WHERE client_id=${client.id}`;
    await tx`UPDATE clients SET status='archived',api_key_hash=NULL WHERE id=${client.id}`;
  });

  return Response.redirect(new URL("/?workspaceRemoved=1", request.url), 303);
}
