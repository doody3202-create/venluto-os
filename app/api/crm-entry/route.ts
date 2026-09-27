import { GET as getManualEntry, POST as postManualEntry } from "../manual-opportunity/route";

export const dynamic = "force-dynamic";
export async function GET(request: Request) { return getManualEntry(request); }
export async function POST(request: Request) { return postManualEntry(request); }
