import { getAllowedIssue } from "@/lib/github/connector";
import { errorResponse } from "@/lib/http";
import { issueRefSchema } from "@/lib/validation";

export async function GET(_request: Request, ctx: RouteContext<"/api/repos/[owner]/[repo]/issues/[number]">) {
  try {
    const { owner, repo, number } = await ctx.params;
    const ref = issueRefSchema.parse({ owner, repo, issueNumber: number });
    return Response.json({ issue: await getAllowedIssue(ref) });
  } catch (error) {
    return errorResponse(error);
  }
}
