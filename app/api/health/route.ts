import { sql } from "@/lib/db";
export const dynamic="force-dynamic";
export async function GET(){try{await sql`SELECT 1`;return Response.json({ok:true,service:"venluto-os",database:"connected"})}catch{return Response.json({ok:false,database:"unavailable"},{status:503})}}
