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
        "SHIPFIG_GITHUB_CONNECTION_ID is required (the GitHub connector id, e.g. conn_abc123; run `npm run connector -- list`)",
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
