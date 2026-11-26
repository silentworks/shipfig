import { authenticateRequest, deniedResponse } from "@/lib/auth";
import { getAllowedIssue } from "@/lib/github/connector";
import { resolveGitHubRequest } from "@/lib/github/user-client";
import { getUserSelectedRepos } from "@/lib/github/user-repos";
import { errorResponse } from "@/lib/http";
import { issueRefSchema } from "@/lib/validation";

export async function GET(request: Request, ctx: RouteContext<"/api/repos/[owner]/[repo]/issues/[number]">) {
  const authResult = await authenticateRequest(request.headers);
  if (!authResult.ok) return deniedResponse(authResult);
  const identity = authResult.identity ?? { kind: "operator" as const, name: "operator" };
  try {
    const { owner, repo, number } = await ctx.params;
    const ref = issueRefSchema.parse({ owner, repo, issueNumber: number });
    const [gh, userSelectedRepos] = await Promise.all([
      resolveGitHubRequest(identity),
      identity.kind === "user" && identity.userId ? getUserSelectedRepos(identity.userId) : Promise.resolve([]),
    ]);
    return Response.json({ issue: await getAllowedIssue(ref, gh, userSelectedRepos) });
  } catch (error) {
    return errorResponse(error);
  }
}
