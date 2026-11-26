import { createHash, timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db, schema } from "@/lib/db";

/**
 * Authentication and request guards (SIL-538).
 *
 * Primary authentication uses Better Auth backed by Drizzle ORM + Postgres.
 * `SHIPFIG_OPERATOR_TOKEN` remains supported as an optional headless/CLI
 * Bearer/Basic fallback when configured.
 *
 * State-changing requests (job start, plan/publish decisions, cancel, retry)
 * additionally require the `X-Shipfig-Action` header and must be same-origin,
 * blocking cross-site requests from approving or mutating jobs.
 */

export const auth = betterAuth({
  database: drizzleAdapter(db(), {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["github"],
    },
  },
  ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? {
        socialProviders: {
          github: {
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
            scope: ["read:user", "user:email", "public_repo"],
          },
        },
      }
    : {}),
  plugins: [nextCookies()],
});

export type SessionData = typeof auth.$Infer.Session;

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

export interface AuthIdentity {
  kind: "user" | "operator";
  userId?: string;
  name: string;
  email?: string;
}

export type AccessDecision =
  | { ok: true; identity?: AuthIdentity }
  | { ok: false; status: 401 | 403 | 503; code: string; message: string; challenge?: boolean };

export interface AccessEnv {
  token: string | undefined;
  production: boolean;
}

export function accessEnv(env: Record<string, string | undefined> = process.env): AccessEnv {
  return { token: env.SHIPFIG_OPERATOR_TOKEN || undefined, production: env.NODE_ENV === "production" };
}

/** Format the authenticated identity for approval audit fields. */
export function formatApprover(identity: AuthIdentity): string {
  if (identity.kind === "operator") return "operator";
  if (identity.name && identity.email) return `${identity.name} (${identity.email})`;
  return identity.email || identity.name || identity.userId || "authenticated user";
}

/** Validate the optional headless/CLI operator token, if configured and presented. */
export function checkOperator(headers: Headers, env: AccessEnv = accessEnv()): AccessDecision {
  if (!env.token) {
    return { ok: false, status: 401, code: "unauthorized", message: "Authentication required" };
  }
  if (env.token.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      status: 503,
      code: "not_configured",
      message: `SHIPFIG_OPERATOR_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
    };
  }
  const presented = presentedToken(headers.get("authorization"));
  if (presented === null || !sameSecret(presented, env.token)) {
    return { ok: false, status: 401, code: "unauthorized", message: "Operator token required", challenge: true };
  }
  return { ok: true, identity: { kind: "operator", name: "operator" } };
}

export type SessionLookup = (
  headers: Headers,
) => Promise<{ user: { id: string; name: string; email: string } } | null>;

/** Look up the Better Auth session from request headers. */
export async function getSessionFromHeaders(headers: Headers): Promise<{ user: { id: string; name: string; email: string } } | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const result = await auth.api.getSession({ headers });
    if (!result?.user) return null;
    return {
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Authenticate a request via Better Auth session or optional operator token.
 * Always requires valid credentials (no open fallback).
 */
export async function authenticateRequest(
  headers: Headers,
  options: { env?: AccessEnv; getSession?: SessionLookup } = {},
): Promise<AccessDecision> {
  const env = options.env ?? accessEnv();
  const getSession = options.getSession ?? getSessionFromHeaders;

  // 1. Optional headless/CLI fallback when SHIPFIG_OPERATOR_TOKEN is set and Authorization is sent.
  if (env.token) {
    if (env.token.length < MIN_TOKEN_LENGTH) {
      return {
        ok: false,
        status: 503,
        code: "not_configured",
        message: `SHIPFIG_OPERATOR_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
      };
    }
    const presented = presentedToken(headers.get("authorization"));
    if (presented !== null) {
      if (sameSecret(presented, env.token)) {
        return { ok: true, identity: { kind: "operator", name: "operator" } };
      }
      return { ok: false, status: 401, code: "unauthorized", message: "Invalid operator token", challenge: true };
    }
  }

  // 2. Better Auth session cookie.
  const session = await getSession(headers);
  if (session?.user) {
    return {
      ok: true,
      identity: {
        kind: "user",
        userId: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
    };
  }

  return { ok: false, status: 401, code: "unauthorized", message: "Authentication required" };
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

export type GuardResult = { ok: true; identity: AuthIdentity } | { ok: false; response: Response };

/**
 * Route-level guard (defence in depth behind proxy.ts) for state-changing handlers.
 * Verifies the Better Auth session (or optional operator token) and the same-origin
 * action header, returning the authenticated identity for audit attribution.
 */
export async function guardAction(
  request: Request,
  options: { env?: AccessEnv; getSession?: SessionLookup } = {},
): Promise<GuardResult> {
  const authResult = await authenticateRequest(request.headers, options);
  if (!authResult.ok) return { ok: false, response: deniedResponse(authResult) };
  const action = checkAction(request.method, request.headers, new URL(request.url));
  if (!action.ok) return { ok: false, response: deniedResponse(action) };
  return { ok: true, identity: authResult.identity ?? { kind: "operator", name: "operator" } };
}
