import { errorResponse } from "@/lib/http";
import { jobIdSchema } from "@/lib/jobs/ids";
import { jobStore } from "@/lib/jobs/store";

export async function POST(_request: Request, ctx: RouteContext<"/api/jobs/[id]/retry">) {
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    return Response.json({ job: jobStore().retry(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
