import { connection } from "next/server";
import { authenticateRequest, deniedResponse } from "@/lib/auth";
import { listAllowedRepos } from "@/lib/github/connector";
import { resolveGitHubRequest } from "@/lib/github/user-client";
import { errorResponse } from "@/lib/http";

/** Repositories the authenticated user's connected GitHub account exposes that Shipfig may operate on. */
export async function GET(request: Request) {
  await connection();
  const authResult = await authenticateRequest(request.headers);
  if (!authResult.ok) return deniedResponse(authResult);
  try {
    const gh = await resolveGitHubRequest(authResult.identity ?? { kind: "operator", name: "operator" });
    return Response.json(await listAllowedRepos(gh));
  } catch (error) {
    return errorResponse(error);
  }
}
