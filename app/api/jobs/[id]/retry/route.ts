import { guardAction } from "@/lib/auth";
import { after } from "next/server";
import { errorResponse } from "@/lib/http";
import { jobIdSchema } from "@/lib/jobs/ids";
import { startJobInBackground } from "@/lib/jobs/background";
import { jobStore } from "@/lib/jobs/store";

export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/retry">) {
  const denied = guardAction(request);
  if (denied) return denied;
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    const job = jobStore().retry(id);
    after(() => startJobInBackground(id));
    return Response.json({ job });
  } catch (error) {
    return errorResponse(error);
  }
}
