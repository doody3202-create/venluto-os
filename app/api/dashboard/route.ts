import { d1, ensureDatabase } from "../_lib/db";

export async function GET() {
  await ensureDatabase();
  const db = d1();
  const [prospects, replies, meetings, errors] = await Promise.all([
    db.prepare(`SELECT p.*, o.name owner_name, o.initials owner_initials, c.name company_name, c.domain company_domain,
      (SELECT COUNT(*) FROM replies r WHERE r.prospect_id=p.id) reply_count,
      (SELECT COUNT(*) FROM meetings m WHERE m.prospect_id=p.id AND m.status='confirmed') meeting_count
      FROM prospects p LEFT JOIN owners o ON o.id=p.owner_id LEFT JOIN companies c ON c.id=p.company_id ORDER BY p.updated_at DESC`).all(),
    db.prepare(`SELECT r.*, p.first_name, p.last_name, p.title, p.deadline_at, p.next_action, p.close_url,
      o.name owner_name, o.initials owner_initials, c.name company_name, ca.name campaign_name
      FROM replies r JOIN prospects p ON p.id=r.prospect_id LEFT JOIN owners o ON o.id=p.owner_id
      LEFT JOIN companies c ON c.id=p.company_id LEFT JOIN campaigns ca ON ca.id=r.campaign_id
      WHERE r.sentiment='positive' ORDER BY r.received_at DESC`).all(),
    db.prepare(`SELECT m.*, p.first_name, p.last_name, c.name company_name, o.name owner_name
      FROM meetings m LEFT JOIN prospects p ON p.id=m.prospect_id LEFT JOIN companies c ON c.id=p.company_id
      LEFT JOIN owners o ON o.id=p.owner_id WHERE m.status='confirmed' ORDER BY m.starts_at ASC`).all(),
    db.prepare(`SELECT * FROM sync_jobs WHERE status='failed' ORDER BY updated_at DESC`).all(),
  ]);
  return Response.json({ prospects: prospects.results, replies: replies.results, meetings: meetings.results, errors: errors.results, demoMode: process.env.DEMO_MODE !== "false" });
}

export async function PATCH(request: Request) {
  await ensureDatabase();
  const body = await request.json() as { prospectId?: number; ownerId?: number; status?: string; nextAction?: string; deadlineAt?: string };
  if (!body.prospectId) return Response.json({error:"prospectId is required"},{status:400});
  await d1().prepare(`UPDATE prospects SET owner_id=COALESCE(?,owner_id), status=COALESCE(?,status), next_action=COALESCE(?,next_action), deadline_at=COALESCE(?,deadline_at), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(body.ownerId ?? null, body.status ?? null, body.nextAction ?? null, body.deadlineAt ?? null, body.prospectId).run();
  return Response.json({ok:true});
}
