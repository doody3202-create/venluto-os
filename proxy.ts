import { NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/portal-auth";
export function proxy(request:NextRequest){const path=request.nextUrl.pathname;if(path==="/login"||path.startsWith("/api/auth/")||path.startsWith('/api/webhooks/')||path==='/api/health')return NextResponse.next();const auth=request.headers.get('authorization');if(path.startsWith('/api/internal/tam')&&(request.headers.has('x-api-key')||auth?.startsWith('Bearer ')))return NextResponse.next();if(readSession(request))return NextResponse.next();if(path.startsWith('/api/'))return Response.json({error:'Authentication required'},{status:401});return NextResponse.redirect(new URL('/login',request.url))}
// TAM_API_KEY and per-client API keys are validated inside the internal TAM routes.
export const config={matcher:['/((?!_next/static|_next/image|favicon.svg).*)']};
