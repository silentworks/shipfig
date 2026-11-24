import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { checkAction, checkOperator, deniedResponse } from "@/lib/auth";

/**
 * Every page and API request goes through operator auth (SIL-536); every
 * state-changing API request also needs the action header and same-origin.
 * Route handlers repeat the action check for the approval endpoints.
 */
export function proxy(request: NextRequest) {
  const operator = checkOperator(request.headers);
  if (!operator.ok) return deniedResponse(operator);
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const action = checkAction(request.method, request.headers, request.nextUrl);
    if (!action.ok) return deniedResponse(action);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
