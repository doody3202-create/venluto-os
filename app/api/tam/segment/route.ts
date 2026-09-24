import { ensureDatabase, sql } from "@/lib/db";
import { scopedClientId } from "@/lib/portal-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureDatabase();
  const url = new URL(request.url);
  const clientId = scopedClientId(request,Number(url.searchParams.get("clientId")));
  const segmentId = Number(url.searchParams.get("segmentId"));
  if (!clientId || !segmentId) {
    return Response.json({ error: "clientId and segmentId are required" }, { status: 400 });
  }
  const [segment] = await sql`
    SELECT id,name FROM tam_segments WHERE id=${segmentId} AND client_id=${clientId}
  `;
  if (!segment) return Response.json({ error: "Segment not found" }, { status: 404 });
  const companies = await sql`
    SELECT c.id,c.name,c.domain,cc.icp_status
    FROM company_segments sc
    JOIN client_companies cc ON cc.id=sc.client_company_id
    JOIN companies c ON c.id=cc.company_id
    WHERE sc.segment_id=${segmentId} AND cc.client_id=${clientId}
    ORDER BY c.name,c.domain
    LIMIT 250
  `;
  return Response.json({ segment, companies });
}
