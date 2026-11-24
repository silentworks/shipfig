import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Operator access control (SIL-536). Shipfig has one operator, not user
 * accounts. When SHIPFIG_OPERATOR_TOKEN is set, every request must carry it
 * (HTTP Basic with any username, or `Authorization: Bearer <token>`). In
 * production the token is mandatory: without it Shipfig refuses to serve,
 * so a deployment can never be reachable unauthenticated.
 *
 * State-changing requests (job start, plan/publish decisions, cancel,
 * retry) additionally need the `X-Shipfig-Action` header and must not come
 * from another site, which stops cross-site requests from approving
 * anything, including against a local instance.
 */

export const ACTION_HEADER = "x-shipfig-action";
export const MIN_TOKEN_LENGTH = 16;
const REALM = 'Basic realm="Shipfig", charset="UTF-8"';

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** The token presented in an Authorization header, if any. */
export function presentedToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const [scheme, value] = authorization.split(/\s+/, 2);
  if (!value) return null;
  if (/^bearer$/i.test(scheme)) return value;
  if (/^basic$/i.test(scheme)) {
    let decoded: string;
    try {
      decoded = Buffer.from(value, "base64").toString("utf8");
    } catch {
      return null;
    }
    const colon = decoded.indexOf(":");
    return colon === -1 ? null : decoded.slice(colon + 1);
  }
  return null;
}

export type AccessDecision = { ok: true } | { ok: false; status: 401 | 403 | 503; code: string; message: string; challenge?: boolean };

export interface AccessEnv {
  token: string | undefined;
  production: boolean;
}

export function accessEnv(env: Record<string, string | undefined> = process.env): AccessEnv {
  return { token: env.SHIPFIG_OPERATOR_TOKEN || undefined, production: env.NODE_ENV === "production" };
}

/** Is this request from the operator? */
export function checkOperator(headers: Headers, env: AccessEnv = accessEnv()): AccessDecision {
  if (!env.token) {
    if (env.production) {
      return { ok: false, status: 503, code: "not_configured", message: "Shipfig will not run in production without SHIPFIG_OPERATOR_TOKEN" };
    }
    return { ok: true }; // local development: open, but actions still need the header below
  }
  if (env.token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, status: 503, code: "not_configured", message: `SHIPFIG_OPERATOR_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters` };
  }
  const presented = presentedToken(headers.get("authorization"));
  if (presented === null || !sameSecret(presented, env.token)) {
    return { ok: false, status: 401, code: "unauthorized", message: "Operator token required", challenge: true };
  }
  return { ok: true };
}

/** Is this state-changing request deliberate and same-site? */
export function checkAction(method: string, headers: Headers, url: URL): AccessDecision {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { ok: true };
  if (headers.get(ACTION_HEADER) !== "1") {
    return { ok: false, status: 403, code: "forbidden", message: `State-changing requests need the ${ACTION_HEADER} header` };
  }
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return { ok: false, status: 403, code: "forbidden", message: "Cross-site requests cannot change jobs" };
  }
  const origin = headers.get("origin");
  if (origin && origin !== url.origin) {
    // Behind a proxy the request URL may be internal; compare with the forwarded host too.
    const forwarded = headers.get("x-forwarded-host") ?? headers.get("host");
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!forwarded || originHost !== forwarded) {
      return { ok: false, status: 403, code: "forbidden", message: "Cross-origin requests cannot change jobs" };
    }
  }
  return { ok: true };
}

export function deniedResponse(decision: Exclude<AccessDecision, { ok: true }>): Response {
  return Response.json(
    { error: { code: decision.code, message: decision.message } },
    { status: decision.status, headers: decision.challenge ? { "WWW-Authenticate": REALM } : undefined },
  );
}

/** Route-level guard (defence in depth behind proxy.ts) for state-changing handlers. */
export function guardAction(request: Request): Response | null {
  const operator = checkOperator(request.headers);
  if (!operator.ok) return deniedResponse(operator);
  const action = checkAction(request.method, request.headers, new URL(request.url));
  if (!action.ok) return deniedResponse(action);
  return null;
}
