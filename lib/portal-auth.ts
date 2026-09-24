import { createHmac, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

export type PortalSession={email:string;role:"admin"|"client";clientId:number|null;exp:number};
const secret=()=>process.env.AUTH_SECRET||process.env.APP_PASSWORD||"";
const signature=(payload:string)=>createHmac("sha256",secret()).update(payload).digest("base64url");

export function signSession(session:PortalSession){const payload=Buffer.from(JSON.stringify(session)).toString("base64url");return `${payload}.${signature(payload)}`}
export function readSession(request:Request):PortalSession|null{
 const auth=request.headers.get("authorization");
 if(auth?.startsWith("Basic ")){try{const [email,password]=Buffer.from(auth.slice(6),"base64").toString().split(":");if(email===process.env.APP_USER&&password===process.env.APP_PASSWORD)return{email,role:"admin",clientId:null,exp:Date.now()+86400000}}catch{}}
 const raw=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith("venluto_session="))?.slice(16);if(!raw||!secret())return null;
 const [payload,sig]=raw.split(".");if(!payload||!sig)return null;const expected=signature(payload);if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
 try{const value=JSON.parse(Buffer.from(payload,"base64url").toString()) as PortalSession;return value.exp>Date.now()?value:null}catch{return null}
}
export function hashPassword(password:string){const salt=randomUUID();return `${salt}:${scryptSync(password,salt,64).toString("hex")}`}
export function verifyPassword(password:string,stored:string){const [salt,hex]=stored.split(":");if(!salt||!hex)return false;const actual=scryptSync(password,salt,64),expected=Buffer.from(hex,"hex");return actual.length===expected.length&&timingSafeEqual(actual,expected)}
export function scopedClientId(request:Request,requested:number){const session=readSession(request);if(!session)return null;if(session.role==="client")return session.clientId===requested?requested:null;return requested}
