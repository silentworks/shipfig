import { after } from "next/server";
import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/http";
import { startJobInBackground } from "@/lib/jobs/background";
import { jobIdSchema } from "@/lib/jobs/ids";
import { jobStore } from "@/lib/jobs/store";

const decisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  /** The job version the user was looking at; a changed plan cannot be approved blind. */
  version: z.number().int().positive(),
});

/**
 * Approve or reject the plan. Approval moves the job to editing; nothing is
 * changed in the workspace before this. The MVP has no user accounts, so the
 * approver is recorded as the local operator.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/plan">) {
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_input", "Request body must be JSON with decision and version");
    }
    const { decision, version } = decisionSchema.parse(body);
    const store = jobStore();
    const job = decision === "approve" ? store.approvePlan(id, version, "local operator") : store.rejectPlan(id, version);
    after(() => startJobInBackground(id));
    return Response.json({ job });
  } catch (error) {
    return errorResponse(error);
  }
}
