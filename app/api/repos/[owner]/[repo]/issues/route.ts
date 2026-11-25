import { authenticateRequest, deniedResponse } from "@/lib/auth";
import { listOpenIssues } from "@/lib/github/connector";
import { resolveGitHubRequest } from "@/lib/github/user-client";
import { errorResponse } from "@/lib/http";
import { repoRefSchema } from "@/lib/validation";

export async function GET(request: Request, ctx: RouteContext<"/api/repos/[owner]/[repo]/issues">) {
  const authResult = await authenticateRequest(request.headers);
  if (!authResult.ok) return deniedResponse(authResult);
  try {
    const ref = repoRefSchema.parse(await ctx.params);
    const gh = await resolveGitHubRequest(authResult.identity ?? { kind: "operator", name: "operator" });
    return Response.json({ issues: await listOpenIssues(ref, gh) });
  } catch (error) {
    return errorResponse(error);
  }
}
