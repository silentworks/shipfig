import { and, eq } from "drizzle-orm";
import type { AuthIdentity } from "@/lib/auth";
import { db, schema } from "@/lib/db";
import { redact } from "@/lib/redact";
import {
  type GatewayRequestOptions,
  type GatewayResponse,
  GatewayError,
  assertAllowedGitHubRoute,
  githubGatewayRequest,
} from "@/lib/sprites/gateway";

/**
 * Per-user GitHub REST client & account lookup (SIL-543).
 *
 * Uses the signed-in user's OAuth access token stored by Better Auth in the
 * Drizzle `account` table. Every request still passes through Shipfig's
 * method-aware GitHub route allowlist (`assertAllowedGitHubRoute`), and tokens
 * never leave the Next.js server or enter untrusted job sprites.
 */

export type GitHubRequestFn = <T = unknown>(path: string, options?: GatewayRequestOptions) => Promise<GatewayResponse<T>>;

export class GitHubNotConnectedError extends Error {
  constructor(message = "Connect your GitHub account to access repositories and start jobs.") {
    super(message);
    this.name = "GitHubNotConnectedError";
  }
}

export interface LinkedGitHubAccount {
  id: string;
  accountId: string;
  accessToken: string | null;
  scope: string | null;
}

/** Look up the signed-in user's linked GitHub OAuth account from Postgres. */
export async function getUserGitHubAccount(userId: string): Promise<LinkedGitHubAccount | null> {
  if (!process.env.DATABASE_URL) return null;
  const rows = await db()
    .select({
      id: schema.account.id,
      accountId: schema.account.accountId,
      accessToken: schema.account.accessToken,
      scope: schema.account.scope,
    })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
    .limit(1);
  return rows[0] ?? null;
}

/** Whether the user also has an email/password login so disconnecting GitHub won't lock them out. */
export async function hasOtherAuthMethod(userId: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const rows = await db()
    .select({ providerId: schema.account.providerId })
    .from(schema.account)
    .where(eq(schema.account.userId, userId));
  return rows.some((r) => r.providerId !== "github");
}

/** Remove the user's linked GitHub OAuth account row. */
export async function disconnectUserGitHubAccount(userId: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const deleted = await db()
    .delete(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "github")))
    .returning({ id: schema.account.id });
  return deleted.length > 0;
}

const GITHUB_API_BASE = "https://api.github.com";

function buildQuery(query: GatewayRequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (!/^[a-z_]{1,32}$/.test(key)) throw new GatewayError(`Invalid query key: ${key}`, "policy");
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function classifyHttpError(status: number, body: unknown, token: string): GatewayError {
  const rawMessage =
    body && typeof body === "object" && "message" in body && typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : `GitHub API returned HTTP ${status}`;
  const message = redact(rawMessage.replaceAll(token, "[redacted]"));
  if (status === 401) return new GatewayError(`GitHub authorization expired or revoked: ${message}`, "unauthorized", status);
  if (status === 403) {
    const isRateLimit = /rate limit/i.test(message);
    return new GatewayError(message, isRateLimit ? "rate_limited" : "forbidden", status);
  }
  if (status === 404) return new GatewayError(message, "not_found", status);
  if (status === 429) return new GatewayError(message, "rate_limited", status);
  return new GatewayError(message, "http", status);
}

/**
 * Create a server-side GitHub REST client scoped to a user's OAuth token,
 * enforcing the same route allowlist and error mapping as the Sprites gateway.
 */
export function createUserGitHubRequest(
  accessToken: string,
  options: { fetchImpl?: typeof fetch; apiBase?: string } = {},
): GitHubRequestFn {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? GITHUB_API_BASE;

  return async <T = unknown>(path: string, reqOptions: GatewayRequestOptions = {}): Promise<GatewayResponse<T>> => {
    const method = reqOptions.method ?? "GET";
    assertAllowedGitHubRoute(method, path);

    const url = `${apiBase}${path}${buildQuery(reqOptions.query)}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shipfig",
    };
    let bodyStr: string | undefined;
    if (reqOptions.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(reqOptions.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: bodyStr,
        cache: "no-store",
        signal: reqOptions.timeoutMs ? AbortSignal.timeout(reqOptions.timeoutMs) : undefined,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new GatewayError(`GitHub request failed: ${redact(msg.replaceAll(accessToken, "[redacted]"))}`, "transport");
    }

    const text = await response.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) throw new GatewayError("GitHub returned non-JSON response", "invalid_response", response.status);
        data = { message: text.slice(0, 200) };
      }
    }

    if (!response.ok) {
      throw classifyHttpError(response.status, data, accessToken);
    }

    return { status: response.status, data: data as T };
  };
}

/**
 * Resolve the GitHub request transport for an authenticated caller:
 * - Signed-in users ALWAYS use their own linked GitHub account (throws
 *   `GitHubNotConnectedError` if unlinked so another user's or global repos
 *   are never leaked).
 * - Headless operator token callers use the Sprites connector gateway.
 */
export async function resolveGitHubRequest(
  identity: AuthIdentity,
  deps: {
    getAccount?: (userId: string) => Promise<LinkedGitHubAccount | null>;
    gatewayRequest?: GitHubRequestFn;
    createClient?: (token: string) => GitHubRequestFn;
  } = {},
): Promise<GitHubRequestFn> {
  if (identity.kind === "operator") {
    return deps.gatewayRequest ?? githubGatewayRequest;
  }
  if (!identity.userId) {
    throw new GitHubNotConnectedError();
  }
  const getAccount = deps.getAccount ?? getUserGitHubAccount;
  const linked = await getAccount(identity.userId);
  if (!linked?.accessToken) {
    throw new GitHubNotConnectedError();
  }
  return (deps.createClient ?? createUserGitHubRequest)(linked.accessToken);
}

/**
 * Resolve the GitHub request transport for a background job.
 * Jobs created by a signed-in user use that user's linked GitHub token;
 * operator/legacy jobs without `createdByUserId` use the Sprites gateway.
 */
export async function resolveJobGitHubRequest(
  createdByUserId: string | null,
  deps: {
    getAccount?: (userId: string) => Promise<LinkedGitHubAccount | null>;
    gatewayRequest?: GitHubRequestFn;
    createClient?: (token: string) => GitHubRequestFn;
  } = {},
): Promise<GitHubRequestFn> {
  if (!createdByUserId) {
    return deps.gatewayRequest ?? githubGatewayRequest;
  }
  const getAccount = deps.getAccount ?? getUserGitHubAccount;
  const linked = await getAccount(createdByUserId);
  if (!linked?.accessToken) {
    throw new GitHubNotConnectedError("The job owner's GitHub account is no longer connected. Reconnect GitHub and retry.");
  }
  return (deps.createClient ?? createUserGitHubRequest)(linked.accessToken);
}
