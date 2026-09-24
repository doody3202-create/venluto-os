import {syncVenlutoSmartleadCampaigns} from "../../../../../lib/smartlead-sync";
export async function POST(){try{return Response.json(await syncVenlutoSmartleadCampaigns(true));}catch(error){return Response.json({error:error instanceof Error?error.message:"Smartlead sync failed"},{status:500})}}
