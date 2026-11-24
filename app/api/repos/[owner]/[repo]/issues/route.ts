import { listOpenIssues } from "@/lib/github/connector";
import { errorResponse } from "@/lib/http";
import { repoRefSchema } from "@/lib/validation";

export async function GET(_request: Request, ctx: RouteContext<"/api/repos/[owner]/[repo]/issues">) {
  try {
    const ref = repoRefSchema.parse(await ctx.params);
    return Response.json({ issues: await listOpenIssues(ref) });
  } catch (error) {
    return errorResponse(error);
  }
}
