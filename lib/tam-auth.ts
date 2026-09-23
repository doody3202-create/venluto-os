import { createHash, timingSafeEqual } from "node:crypto";
import { ensureDatabase, sql } from "./db";

export const hashApiKey=(value:string)=>createHash("sha256").update(value).digest("hex");
export type TamAuthClient={id:number;name:string;status:string};
const equal=(left:string,right:string)=>{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b)};
export async function authenticatedTamClient(request:Request):Promise<TamAuthClient|null>{
 await ensureDatabase();
 const provided=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??request.headers.get("x-api-key")??"";
 if(!provided)return null;
 const legacy=process.env.TAM_API_KEY??"";
 if(legacy&&equal(provided,legacy)){const [client]=await sql`SELECT id,name,status FROM clients WHERE name='Venluto' AND status='active'`;return client?(client as TamAuthClient):null}
 const digest=hashApiKey(provided),[client]=await sql`SELECT id,name,status FROM clients WHERE api_key_hash=${digest} AND status='active'`;
 return client?(client as TamAuthClient):null;
}

export function sameClient(client:{name:string},requested?:string|null){return !requested||client.name.toLowerCase()===requested.trim().toLowerCase()}
