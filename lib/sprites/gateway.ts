import { randomUUID } from "node:crypto";
import { ExecError, type Sprite } from "@fly/sprites";
import { serverEnv } from "@/lib/env";
import { redact } from "@/lib/redact";
import { gatewayPathSchema } from "@/lib/validation";
import { findSprite, spritesClient } from "./client";
import { GATEWAY_SPRITE_LABEL } from "./connections";

/**
 * GitHub access through the Sprites connector gateway.
 *
 * The gateway (`https://api.sprites.dev/v1/gateway/<provider>/<connection>/<path>`)
 * only accepts requests that originate from inside a running Sprite: it
 * identifies the caller from Fly.io's request signature and injects the stored
 * GitHub OAuth token itself. So the orchestrator runs `curl` inside one
 * dedicated, *trusted* gateway sprite:
 *
 * - the gateway sprite never clones repos or runs agent/untrusted code;
 * - the connector access policy only admits sprites with the gateway label and
 *   name prefix, so per-job sprites (which do run untrusted code) cannot use it;
 * - the raw GitHub token never exists in any sprite environment or in our logs;
 * - all arguments are passed as argv (no shell), and request bodies are written
 *   to a temp file rather than interpolated.
 */

export type HttpMethod = "GET" | "POST" | "PATCH";

/**
 * Client-side allowlist of GitHub routes Shipfig may call. The connector policy
 * can only express path prefixes, not methods, so this is the method-aware
 * second layer. Notably absent: any DELETE, merges, settings, hooks, keys,
 * collaborators, secrets.
 */
const SEG = "[A-Za-z0-9._-]+";
const allowedRoutes: ReadonlyArray<{ method: HttpMethod; pattern: RegExp; purpose: string }> = [
  { method: "GET", pattern: /^\/user$/, purpose: "identify connected account" },
  { method: "GET", pattern: /^\/user\/repos$/, purpose: "list repositories" },
  { method: "GET", pattern: new RegExp(`^/repos/${SEG}/${SEG}$`), purpose: "repository metadata" },
  { method: "GET", pattern: new RegExp(`^/repos/${SEG}/${SEG}/issues$`), purpose: "list issues" },
  { method: "GET", pattern: new RegExp(`^/repos/${SEG}/${SEG}/issues/\\d+$`), purpose: "issue detail" },
  { method: "GET", pattern: new RegExp(`^/repos/${SEG}/${SEG}/issues/\\d+/comments$`), purpose: "issue comments" },
  { method: "GET", pattern: new RegExp(`^/repos/${SEG}/${SEG}/readme$`), purpose: "repository README" },
  { method: "GET", pattern: new RegExp(`^/repos/${SEG}/${SEG}/branches/${SEG}$`), purpose: "base branch head" },
  { method: "GET", pattern: new RegExp(`^/repos/${SEG}/${SEG}/git/ref/heads/[A-Za-z0-9._/-]+$`), purpose: "read branch ref" },
  { method: "GET", pattern: new RegExp(`^/repos/${SEG}/${SEG}/git/commits/[0-9a-f]{40}$`), purpose: "read commit" },
  // Publishing via the Git database API (used only after explicit human approval, SIL-534).
  { method: "POST", pattern: new RegExp(`^/repos/${SEG}/${SEG}/git/blobs$`), purpose: "publish: create blob" },
  { method: "POST", pattern: new RegExp(`^/repos/${SEG}/${SEG}/git/trees$`), purpose: "publish: create tree" },
  { method: "POST", pattern: new RegExp(`^/repos/${SEG}/${SEG}/git/commits$`), purpose: "publish: create commit" },
  { method: "POST", pattern: new RegExp(`^/repos/${SEG}/${SEG}/git/refs$`), purpose: "publish: create branch" },
  { method: "POST", pattern: new RegExp(`^/repos/${SEG}/${SEG}/pulls$`), purpose: "publish: open draft PR" },
];

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly kind: "policy" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "http" | "transport" | "invalid_response",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function assertAllowedGitHubRoute(method: HttpMethod, path: string): void {
  gatewayPathSchema.parse(path);
  if (!allowedRoutes.some((r) => r.method === method && r.pattern.test(path))) {
    throw new GatewayError(`GitHub route not allowed by Shipfig policy: ${method} ${path}`, "policy");
  }
}

export type QueryValue = string | number | boolean | undefined;

function buildQuery(query: Record<string, QueryValue> | undefined): string {
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

const STATUS_MARKER = "\n__SHIPFIG_HTTP_STATUS__:";

/** Build the curl argv for a gateway request. Exported for tests. */
export function buildCurlArgs(opts: { method: HttpMethod; url: string; bodyFile?: string; timeoutSeconds: number }): string[] {
  const args = [
    "--silent",
    "--show-error",
    "--max-time",
    String(opts.timeoutSeconds),
    "--request",
    opts.method,
    "--header",
    "Accept: application/vnd.github+json",
    "--header",
    "X-GitHub-Api-Version: 2022-11-28",
    "--write-out",
    `${STATUS_MARKER}%{http_code}`,
  ];
  if (opts.bodyFile) {
    args.push("--header", "Content-Type: application/json", "--data-binary", `@${opts.bodyFile}`);
  }
  // `--` ends option parsing so the URL can never be read as a flag.
  args.push("--", opts.url);
  return args;
}

/** Split curl output into body and status. Exported for tests. */
export function parseCurlOutput(stdout: string): { status: number; text: string } {
  const idx = stdout.lastIndexOf(STATUS_MARKER);
  if (idx === -1) throw new GatewayError("Gateway response missing status marker", "invalid_response");
  const status = Number(stdout.slice(idx + STATUS_MARKER.length).trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new GatewayError("Gateway response has invalid status", "invalid_response");
  }
  return { status, text: stdout.slice(0, idx) };
}

function errorFor(status: number, text: string, method: HttpMethod, path: string): GatewayError {
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    detail = parsed.message ?? parsed.error ?? detail;
  } catch {
    // non-JSON body; keep raw excerpt
  }
  detail = redact(detail);
  const where = `${method} ${path}`;
  if (status === 401) {
    return new GatewayError(`Gateway rejected the sprite identity for ${where} (401): ${detail}`, "unauthorized", status);
  }
  if (status === 403 && /rate limit/i.test(detail)) {
    return new GatewayError(`GitHub rate limit for ${where}: ${detail}`, "rate_limited", status);
  }
  if (status === 403) {
    return new GatewayError(
      `Forbidden for ${where} (403): ${detail}. Check the connector access policy and OAuth scopes.`,
      "forbidden",
      status,
    );
  }
  if (status === 404) return new GatewayError(`Not found: ${where}`, "not_found", status);
  if (status === 429) return new GatewayError(`Rate limited for ${where}`, "rate_limited", status);
  return new GatewayError(`GitHub request ${where} failed (${status}): ${detail}`, "http", status);
}

let gatewaySpritePromise: Promise<Sprite> | undefined;

/**
 * Get (or create) the trusted gateway sprite. It carries the gateway label the
 * connector policy requires. Nothing but `curl` to the gateway runs on it.
 */
export function gatewaySprite(): Promise<Sprite> {
  gatewaySpritePromise ??= (async () => {
    const name = serverEnv().SHIPFIG_GATEWAY_SPRITE;
    const existing = await findSprite(name);
    if (existing) {
      if (!existing.labels.includes(GATEWAY_SPRITE_LABEL)) {
        await existing.update({ labels: [...existing.labels, GATEWAY_SPRITE_LABEL] });
      }
      return existing;
    }
    return spritesClient().createSprite(name, {
      config: { ramMB: 512, cpus: 1 },
      labels: [GATEWAY_SPRITE_LABEL],
      waitForCapacity: true,
    });
  })().catch((error) => {
    gatewaySpritePromise = undefined;
    throw error;
  });
  return gatewaySpritePromise;
}

export interface GatewayResponse<T = unknown> {
  status: number;
  data: T;
}

export interface GatewayRequestOptions {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Call the GitHub API through the connector gateway from the gateway sprite.
 * `path` is a GitHub API path such as `/repos/acme/web/issues/12`; callers
 * must build it from validated segments (see `pathSegment`).
 */
export async function githubGatewayRequest<T = unknown>(path: string, options: GatewayRequestOptions = {}): Promise<GatewayResponse<T>> {
  const method = options.method ?? "GET";
  assertAllowedGitHubRoute(method, path);
  if (method === "GET" && options.body) throw new GatewayError("GET requests cannot have a body", "policy");

  const env = serverEnv();
  const url = `${env.SPRITES_API_URL}/v1/gateway/github/${encodeURIComponent(env.SHIPFIG_GITHUB_CONNECTION_ID)}${path}${buildQuery(options.query)}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sprite = await gatewaySprite();

  let bodyFile: string | undefined;
  if (options.body) {
    bodyFile = `/tmp/shipfig-gateway-${randomUUID()}.json`;
    await sprite.filesystem("/").writeFile(bodyFile, JSON.stringify(options.body));
  }

  const exec = () =>
    sprite.execFile("curl", buildCurlArgs({ method, url, bodyFile, timeoutSeconds: Math.ceil(timeoutMs / 1000) }), {
      timeout: timeoutMs + 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });

  let stdout: string;
  try {
    let result;
    try {
      result = await exec();
    } catch (error) {
      // A cold gateway sprite can take longer than the exec timeout to wake.
      // GETs are idempotent, so retry those once; never retry writes.
      if (method !== "GET" || error instanceof ExecError) throw error;
      result = await exec();
    }
    stdout = String(result.stdout);
  } catch (error) {
    if (error instanceof ExecError) {
      throw new GatewayError(
        `curl failed in gateway sprite (exit ${error.exitCode}): ${redact(String(error.stderr)).slice(0, 300)}`,
        "transport",
      );
    }
    throw new GatewayError(`Gateway sprite exec failed: ${redact(error instanceof Error ? error.message : String(error))}`, "transport");
  } finally {
    if (bodyFile) await sprite.filesystem("/").rm(bodyFile, { force: true }).catch(() => undefined);
  }

  const { status, text } = parseCurlOutput(stdout);
  if (status >= 400) throw errorFor(status, text, method, path);
  try {
    return { status, data: (text ? JSON.parse(text) : undefined) as T };
  } catch {
    throw new GatewayError(`GitHub returned non-JSON for ${method} ${path}`, "invalid_response", status);
  }
}
