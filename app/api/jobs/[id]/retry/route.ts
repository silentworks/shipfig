import { guardAction } from "@/lib/auth";
import { after } from "next/server";
import { errorResponse } from "@/lib/http";
import { jobIdSchema } from "@/lib/jobs/ids";
import { startJobInBackground } from "@/lib/jobs/background";
import { jobStore } from "@/lib/jobs/store";

export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/retry">) {
  const guard = await guardAction(request);
  if (!guard.ok) return guard.response;
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    const store = jobStore();
    const job = store.retry(id);
    const queuePosition = store.queuePosition(job.id);
    if (queuePosition === null) {
      after(() => startJobInBackground(id));
    }
    return Response.json({ job, queued: queuePosition !== null, queuePosition });
  } catch (error) {
    return errorResponse(error);
  }
}
