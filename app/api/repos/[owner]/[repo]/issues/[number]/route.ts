import { authenticateRequest, deniedResponse } from "@/lib/auth";
import { getAllowedIssue } from "@/lib/github/connector";
import { resolveGitHubRequest } from "@/lib/github/user-client";
import { errorResponse } from "@/lib/http";
import { issueRefSchema } from "@/lib/validation";

export async function GET(request: Request, ctx: RouteContext<"/api/repos/[owner]/[repo]/issues/[number]">) {
  const authResult = await authenticateRequest(request.headers);
  if (!authResult.ok) return deniedResponse(authResult);
  try {
    const { owner, repo, number } = await ctx.params;
    const ref = issueRefSchema.parse({ owner, repo, issueNumber: number });
    const gh = await resolveGitHubRequest(authResult.identity ?? { kind: "operator", name: "operator" });
    return Response.json({ issue: await getAllowedIssue(ref, gh) });
  } catch (error) {
    return errorResponse(error);
  }
}
