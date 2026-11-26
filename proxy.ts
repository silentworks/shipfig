import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  authenticateRequest,
  checkAction,
  deniedResponse,
  type AccessEnv,
  type SessionLookup,
} from "@/lib/auth";

const AUTH_PAGES = new Set(["/sign-in", "/sign-up"]);

function isPublicApi(pathname: string): boolean {
  return pathname === "/api/health" || pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.has(pathname);
}

/**
 * Every page and API request (except `/api/health`, `/api/auth/*`, `/sign-in`,
 * and `/sign-up`) requires a valid Better Auth session (or optional operator
 * token). State-changing API requests also require `X-Shipfig-Action: 1` and
 * same-origin checks; route handlers repeat `guardAction` for defence in depth.
 */
export async function handleProxy(
  request: NextRequest,
  options: { env?: AccessEnv; getSession?: SessionLookup } = {},
): Promise<Response> {
  const { pathname, search } = request.nextUrl;

  if (isPublicApi(pathname)) {
    return NextResponse.next();
  }

  const authResult = await authenticateRequest(request.headers, options);

  if (isAuthPage(pathname)) {
    if (authResult.ok) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (!authResult.ok) {
    if (pathname.startsWith("/api/")) {
      return deniedResponse(authResult);
    }
    const signInUrl = new URL("/sign-in", request.url);
    const nextPath = `${pathname}${search}`;
    if (nextPath && nextPath !== "/") {
      signInUrl.searchParams.set("next", nextPath);
    }
    return NextResponse.redirect(signInUrl);
  }

  if (pathname.startsWith("/api/")) {
    const action = checkAction(request.method, request.headers, request.nextUrl);
    if (!action.ok) return deniedResponse(action);
  }

  return NextResponse.next();
}

export async function proxy(request: NextRequest) {
  return handleProxy(request);
}

export const config = {
  // /api/health and /api/auth/* stay open; static assets and app icons are skipped.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|api/health$|api/auth(?:/.*)?$).*)"],
};
