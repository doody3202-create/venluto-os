import { tamDashboard } from "@/lib/tam";
export const dynamic="force-dynamic";
export async function GET(){return Response.json(await tamDashboard())}
