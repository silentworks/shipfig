import { z } from "zod";

/**
 * Server-side environment configuration.
 *
 * Values are validated lazily (on first use) so that `next build` and pages
 * that do not touch Sprites/GitHub keep working without secrets, while any
 * code path that needs them fails with a clear message naming what is missing.
 */

const repoSlug = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

const serverEnvSchema = z.object({
  SPRITES_TOKEN: z
    .string({ error: "SPRITES_TOKEN is required (create one at https://sprites.dev or with `sprite login`)" })
    .min(1, "SPRITES_TOKEN is required"),
  SPRITES_API_URL: z.url().default("https://api.sprites.dev"),
  SHIPFIG_GITHUB_CONNECTION_ID: z
    .string({
      error:
        "SHIPFIG_GITHUB_CONNECTION_ID is required (the GitHub connector id: run `npm run connector -- list` and copy the first column)",
    })
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "SHIPFIG_GITHUB_CONNECTION_ID has an invalid format"),
  SHIPFIG_GATEWAY_SPRITE: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "SHIPFIG_GATEWAY_SPRITE must be a lowercase sprite name")
    .default("shipfig-gateway"),
  SHIPFIG_ALLOWED_REPOS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value || value.trim() === "") return [] as string[];
      const repos = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const repo of repos) {
        if (!repoSlug.test(repo)) {
          ctx.addIssue({ code: "custom", message: `SHIPFIG_ALLOWED_REPOS entry "${repo}" is not owner/name` });
          return z.NEVER;
        }
      }
      return repos.map((r) => r.toLowerCase());
    }),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid Shipfig server configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EnvError";
  }
}

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => i.message));
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

const spritesEnvSchema = serverEnvSchema.pick({ SPRITES_TOKEN: true, SPRITES_API_URL: true });
export type SpritesEnv = z.infer<typeof spritesEnvSchema>;

/**
 * Just the Sprites API credentials. Used by the Sprites client and connector
 * management, which must work before a GitHub connector id is configured
 * (e.g. `npm run connector -- list`, the way you find that id).
 */
export function spritesEnv(): SpritesEnv {
  const result = spritesEnvSchema.safeParse(process.env);
  if (!result.success) throw new EnvError(result.error.issues.map((i) => i.message));
  return result.data;
}

const modelId = (name: string) => z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/, `${name} has an invalid format`);

export const AGENT_PROVIDERS = ["openai", "anthropic"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

const agentEnvSchema = z
  .object({
    SHIPFIG_AGENT_PROVIDER: z.enum(AGENT_PROVIDERS, { error: `SHIPFIG_AGENT_PROVIDER must be one of: ${AGENT_PROVIDERS.join(", ")}` }).default("openai"),
    OPENAI_API_KEY: z.string().optional(),
    SHIPFIG_OPENAI_MODEL: modelId("SHIPFIG_OPENAI_MODEL").default("gpt-6.2-sol"),
    /** Optional: the Anthropic SDK also resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile. */
    ANTHROPIC_API_KEY: z.string().optional(),
    SHIPFIG_ANTHROPIC_MODEL: modelId("SHIPFIG_ANTHROPIC_MODEL").default("claude-opus-5-5"),
    SHIPFIG_ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  })
  .superRefine((env, ctx) => {
    if (env.SHIPFIG_AGENT_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        message: "OPENAI_API_KEY is required for planning and editing (https://platform.openai.com/api-keys), or set SHIPFIG_AGENT_PROVIDER=anthropic",
      });
    }
  });
export type AgentEnv = z.infer<typeof agentEnvSchema>;

export function parseAgentEnv(source: Record<string, string | undefined>): AgentEnv {
  const result = agentEnvSchema.safeParse(source);
  if (!result.success) throw new EnvError(result.error.issues.map((i) => i.message));
  return result.data;
}

/** Model provider configuration, validated only when the agent actually runs. */
export function agentEnv(): AgentEnv {
  return parseAgentEnv(process.env);
}
