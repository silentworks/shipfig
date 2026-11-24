import { APIError, SpritesClient, type Sprite } from "@fly/sprites";
import { serverEnv } from "@/lib/env";
import { spriteNameSchema } from "@/lib/validation";

let client: SpritesClient | undefined;

/** Shared Sprites API client. The token never leaves the orchestrator process. */
export function spritesClient(): SpritesClient {
  if (!client) {
    const env = serverEnv();
    client = new SpritesClient(env.SPRITES_TOKEN, { baseURL: env.SPRITES_API_URL, timeout: 30_000 });
  }
  return client;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof APIError && error.statusCode === 404;
}

/** Fetch a sprite by name, or return undefined if it does not exist. */
export async function findSprite(name: string): Promise<Sprite | undefined> {
  spriteNameSchema.parse(name);
  try {
    return await spritesClient().getSprite(name);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}
