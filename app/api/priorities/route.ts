import { ensureDatabase, sql } from "@/lib/db";
import { readSession } from "@/lib/portal-auth";

export const dynamic = "force-dynamic";
const allowedBuckets = new Set(["top", "monday", "tuesday", "wednesday", "thursday", "friday"]);

async function venluto(request: Request) {
  const auth = readSession(request);
  if (auth?.role !== "admin") return null;
  const [client] = await sql`SELECT id FROM clients WHERE LOWER(name)='venluto' AND status='active' LIMIT 1`;
  return client?.id ? Number(client.id) : null;
}

export async function GET(request: Request) {
  await ensureDatabase();
  const clientId = await venluto(request);
  if (!clientId) return Response.json({ error: "Venluto access required" }, { status: 403 });
  const requested = new URL(request.url).searchParams.get("week");
  const [current] = await sql`SELECT DATE_TRUNC('week',CURRENT_DATE)::date::text week`;
  const week = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : String(current.week);
  const [items, weeks] = await Promise.all([
    sql`SELECT id,title,status,week_start::text week_start,day_bucket,position,created_at FROM operation_tasks WHERE client_id=${clientId} AND week_start=${week}::date ORDER BY CASE day_bucket WHEN 'top' THEN 0 WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 ELSE 5 END,position,id`,
    sql`SELECT DISTINCT week_start::text week_start FROM operation_tasks WHERE client_id=${clientId} AND week_start IS NOT NULL ORDER BY week_start DESC`,
  ]);
  return Response.json({ week, items, weeks: weeks.map(row => row.week_start) });
}

export async function POST(request: Request) {
  await ensureDatabase();
  const clientId = await venluto(request);
  if (!clientId) return Response.json({ error: "Venluto access required" }, { status: 403 });
  const body = await request.json() as { title?: string; week?: string; bucket?: string };
  const title = body.title?.trim(), bucket = String(body.bucket ?? "top").toLowerCase();
  if (!title || !body.week || !/^\d{4}-\d{2}-\d{2}$/.test(body.week) || !allowedBuckets.has(bucket)) return Response.json({ error: "Invalid priority" }, { status: 400 });
  const [{ count }] = bucket === "top" ? await sql`SELECT COUNT(*)::int count FROM operation_tasks WHERE client_id=${clientId} AND week_start=${body.week}::date AND day_bucket='top' AND status<>'done'` : [{ count: 0 }];
  if (bucket === "top" && Number(count) >= 2) return Response.json({ error: "Complete or move one of the Top 2 priorities first." }, { status: 409 });
  const [item] = await sql`INSERT INTO operation_tasks(client_id,title,priority,status,week_start,day_bucket,position) VALUES (${clientId},${title},'weekly','open',${body.week}::date,${bucket},COALESCE((SELECT MAX(position)+1 FROM operation_tasks WHERE client_id=${clientId} AND week_start=${body.week}::date AND day_bucket=${bucket}),0)) RETURNING id,title,status,week_start::text week_start,day_bucket,position`;
  return Response.json({ item }, { status: 201 });
}

export async function PATCH(request: Request) {
  await ensureDatabase();
  const clientId = await venluto(request);
  if (!clientId) return Response.json({ error: "Venluto access required" }, { status: 403 });
  const body = await request.json() as { id?: number; status?: string };
  const status = body.status === "done" ? "done" : "open";
  const [item] = await sql`UPDATE operation_tasks SET status=${status},updated_at=NOW() WHERE id=${body.id ?? 0} AND client_id=${clientId} RETURNING id,status`;
  return item ? Response.json({ item }) : Response.json({ error: "Priority not found" }, { status: 404 });
}

export async function DELETE(request: Request) {
  await ensureDatabase();
  const clientId = await venluto(request);
  if (!clientId) return Response.json({ error: "Venluto access required" }, { status: 403 });
  const body = await request.json() as { id?: number };
  await sql`DELETE FROM operation_tasks WHERE id=${body.id ?? 0} AND client_id=${clientId}`;
  return Response.json({ ok: true });
}
