import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { redact } from "@/lib/redact";

/**
 * Management API for Sprites connectors (`/v1/oauth/connections`).
 *
 * This is called from the orchestrator with SPRITES_TOKEN. It only manages
 * connector metadata and access policies; it never sees the provider token.
 * Provider API calls go through the gateway from inside a Sprite (see
 * `gateway.ts`).
 */

export const accessPolicySchema = z.object({
  allow_all: z.boolean().optional(),
  name_prefix: z.string().optional(),
  sprite_labels: z.array(z.string()).optional(),
  allowed_endpoints: z.array(z.string()).optional(),
  blocked_endpoints: z.array(z.string()).optional(),
});
export type AccessPolicy = z.infer<typeof accessPolicySchema>;

export const connectionSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    provider_account_id: z.string().nullish(),
    provider_account_name: z.string().nullish(),
    connection_type: z.string().nullish(),
    scopes: z.string().nullish(),
    token_expires_at: z.string().nullish(),
    access_policy: accessPolicySchema.nullish(),
    inserted_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .loose();
export type Connection = z.infer<typeof connectionSchema>;

async function managementRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const env = serverEnv();
  const response = await fetch(`${env.SPRITES_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.SPRITES_TOKEN}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Sprites connector API ${init.method ?? "GET"} ${path} failed (${response.status}): ${redact(text, [env.SPRITES_TOKEN]).slice(0, 500)}`,
    );
  }
  return text ? JSON.parse(text) : undefined;
}

export async function listConnections(provider?: string): Promise<Connection[]> {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  const body = await managementRequest(`/v1/oauth/connections${query}`);
  return z.object({ connections: z.array(connectionSchema) }).parse(body).connections;
}

export async function getConnection(id: string): Promise<Connection> {
  const body = await managementRequest(`/v1/oauth/connections/${encodeURIComponent(id)}`);
  // The API may wrap the object; accept both shapes.
  const wrapped = z.object({ connection: connectionSchema }).safeParse(body);
  return wrapped.success ? wrapped.data.connection : connectionSchema.parse(body);
}

export async function updateAccessPolicy(id: string, policy: AccessPolicy): Promise<void> {
  await managementRequest(`/v1/oauth/connections/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ access_policy: accessPolicySchema.parse(policy) }),
  });
}

/** Label carried only by the trusted gateway sprite. Job sprites never get it. */
export const GATEWAY_SPRITE_LABEL = "shipfig-gateway";

/**
 * The access policy Shipfig expects on its GitHub connector:
 * - only sprites that have the gateway label AND the gateway name prefix;
 * - only the GitHub endpoints Shipfig needs (repo-scoped + listing the user's repos).
 *
 * Connector policies only support exact paths and trailing-`*` prefixes and are
 * not method-scoped, so `/repos/*` also covers e.g. `DELETE /repos/{o}/{r}`.
 * The finer method + route allowlist is enforced client-side in `gateway.ts`
 * (`assertAllowedGitHubRoute`), and the gateway sprite never runs untrusted code.
 */
export function recommendedGitHubPolicy(gatewaySpriteName: string): AccessPolicy {
  return {
    allow_all: false,
    name_prefix: gatewaySpriteName,
    sprite_labels: [GATEWAY_SPRITE_LABEL],
    allowed_endpoints: ["/user", "/user/repos", "/repos/*"],
  };
}
