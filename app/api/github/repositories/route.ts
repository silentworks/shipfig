import { connection } from "next/server";
import { z } from "zod";
import { authenticateRequest, deniedResponse, guardAction } from "@/lib/auth";
import { listAllowedRepos } from "@/lib/github/connector";
import { resolveGitHubRequest } from "@/lib/github/user-client";
import { getUserSelectedRepos, setUserSelectedRepos } from "@/lib/github/user-repos";
import { errorResponse, jsonError } from "@/lib/http";

export function manageOnGitHubUrl(): string {
  const slug = process.env.GITHUB_APP_SLUG?.trim();
  if (slug && /^[A-Za-z0-9-]+$/.test(slug)) {
    return `https://github.com/apps/${slug}/installations/new`;
  }
  return "https://github.com/settings/installations";
}

/**
 * List all eligible repositories available from the user's connected GitHub
 * account (ignoring the user's own selection filter) alongside their currently
 * selected repository slugs so they can pick which repos Shipfig pulls in.
 */
export async function GET(request: Request) {
  await connection();
  const authResult = await authenticateRequest(request.headers);
  if (!authResult.ok) return deniedResponse(authResult);

  const identity = authResult.identity ?? { kind: "operator" as const, name: "operator" };
  try {
    const gh = await resolveGitHubRequest(identity);
    const [listing, selected] = await Promise.all([
      listAllowedRepos(gh),
      identity.kind === "user" && identity.userId ? getUserSelectedRepos(identity.userId) : Promise.resolve([]),
    ]);
    return Response.json({
      repos: listing.repos,
      excluded: listing.excluded,
      source: listing.source ?? "oauth",
      selected,
      manageOnGitHubUrl: manageOnGitHubUrl(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

const updateSelectionSchema = z.strictObject({
  repos: z.array(z.string().min(3).max(140)).max(200),
});

/** Save the signed-in user's selected repositories (empty array = allow all eligible repos). */
export async function PUT(request: Request) {
  const guard = await guardAction(request);
  if (!guard.ok) return guard.response;

  if (guard.identity.kind !== "user" || !guard.identity.userId) {
    return jsonError(400, "invalid_input", "Only user accounts can save a repository selection");
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_input", "Request body must be JSON with a repos array");
    }
    const { repos } = updateSelectionSchema.parse(body);
    const selected = await setUserSelectedRepos(guard.identity.userId, repos);
    return Response.json({ selected });
  } catch (error) {
    return errorResponse(error);
  }
}
