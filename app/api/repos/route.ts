import { connection } from "next/server";
import { authenticateRequest, deniedResponse } from "@/lib/auth";
import { listAllowedRepos } from "@/lib/github/connector";
import { resolveGitHubRequest } from "@/lib/github/user-client";
import { getUserSelectedRepos } from "@/lib/github/user-repos";
import { errorResponse } from "@/lib/http";

/** Repositories the authenticated user's connected GitHub account exposes that Shipfig may operate on. */
export async function GET(request: Request) {
  await connection();
  const authResult = await authenticateRequest(request.headers);
  if (!authResult.ok) return deniedResponse(authResult);
  const identity = authResult.identity ?? { kind: "operator" as const, name: "operator" };
  try {
    const [gh, userSelectedRepos] = await Promise.all([
      resolveGitHubRequest(identity),
      identity.kind === "user" && identity.userId ? getUserSelectedRepos(identity.userId) : Promise.resolve([]),
    ]);
    return Response.json(await listAllowedRepos(gh, { userSelectedRepos }));
  } catch (error) {
    return errorResponse(error);
  }
}
