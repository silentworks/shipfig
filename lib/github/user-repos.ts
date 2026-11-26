import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { repoRefSchema, repoSlug } from "@/lib/validation";

/**
 * Per-user selected GitHub repositories (SIL-543).
 *
 * When a user has one or more rows in `user_repository`, Shipfig restricts
 * repo listing, issue reads, and job creation for that user to those selected
 * repositories (still intersected with any server-wide `SHIPFIG_ALLOWED_REPOS`).
 * When a user has no rows, all eligible repositories from their GitHub
 * connection are available.
 */

/** Normalize and validate an array of `owner/repo` strings into unique lowercase slugs. */
export function normalizeRepoSelection(repos: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of repos) {
    const trimmed = raw.trim();
    const parts = trimmed.split("/");
    if (parts.length !== 2) {
      throw new Error(`Invalid repository name "${raw}" (expected owner/repo)`);
    }
    const slug = repoSlug(repoRefSchema.parse({ owner: parts[0], repo: parts[1] })).toLowerCase();
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * Combine the server-wide allowlist with a user's selected repositories.
 * A user selection can only narrow (never widen) `SHIPFIG_ALLOWED_REPOS`.
 */
export function combineAllowlists(
  serverAllowlist: readonly string[],
  userSelectedRepos?: readonly string[],
): string[] {
  const server = serverAllowlist.map((s) => s.toLowerCase());
  const selected = (userSelectedRepos ?? []).map((s) => s.toLowerCase());
  if (selected.length === 0) return server;
  if (server.length === 0) return selected;
  const serverSet = new Set(server);
  return selected.filter((s) => serverSet.has(s));
}

/** Return the user's selected repository slugs (lowercase), or `[]` if unrestricted. */
export async function getUserSelectedRepos(userId: string): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  const rows = await db()
    .select({ repoFullName: schema.userRepository.repoFullName })
    .from(schema.userRepository)
    .where(eq(schema.userRepository.userId, userId));
  return rows.map((r) => r.repoFullName.toLowerCase()).sort((a, b) => a.localeCompare(b));
}

/** Replace the user's selected repositories atomically. Empty list clears the filter. */
export async function setUserSelectedRepos(userId: string, repos: readonly string[]): Promise<string[]> {
  const normalized = normalizeRepoSelection(repos);
  if (!process.env.DATABASE_URL) return normalized;
  await db().transaction(async (tx) => {
    await tx.delete(schema.userRepository).where(eq(schema.userRepository.userId, userId));
    if (normalized.length > 0) {
      await tx.insert(schema.userRepository).values(
        normalized.map((repoFullName) => ({
          id: randomUUID(),
          userId,
          repoFullName,
        })),
      );
    }
  });
  return normalized;
}

/** Clear all saved repository selections for a user (e.g. when disconnecting GitHub). */
export async function clearUserSelectedRepos(userId: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  await db().delete(schema.userRepository).where(eq(schema.userRepository.userId, userId));
}
