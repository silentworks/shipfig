import { guardAction } from "@/lib/auth";
import { after } from "next/server";
import { errorResponse } from "@/lib/http";
import { startJobInBackground } from "@/lib/jobs/background";
import { jobIdSchema } from "@/lib/jobs/ids";
import { jobStore } from "@/lib/jobs/store";

export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/cancel">) {
  const guard = await guardAction(request);
  if (!guard.ok) return guard.response;
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    const job = jobStore().cancel(id, "user_canceled");
    // The runner deletes the job's sprite once it sees the terminal state.
    after(() => startJobInBackground(id));
    return Response.json({ job });
  } catch (error) {
    return errorResponse(error);
  }
}
