import { formatApprover, guardAction } from "@/lib/auth";
import { after } from "next/server";
import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/http";
import { startJobInBackground } from "@/lib/jobs/background";
import { jobIdSchema } from "@/lib/jobs/ids";
import { jobStore } from "@/lib/jobs/store";

const decisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  /** The job version the user was looking at. */
  version: z.number().int().positive(),
  /** sha256 of the diff the user reviewed; publishing is bound to it. */
  diffHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Required to publish a change whose requested checks could not all run. */
  acknowledgeUnverified: z.boolean().optional(),
});

/**
 * Approve or reject publishing. Approval is bound server-side to the exact
 * diff hash Shipfig recorded, and is stored on the job before anything is
 * written to GitHub. The approver is recorded from the authenticated session.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/publish">) {
  const guard = await guardAction(request);
  if (!guard.ok) return guard.response;
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_input", "Request body must be JSON with decision, version and diffHash");
    }
    const input = decisionSchema.parse(body);
    const store = jobStore();
    let job;
    if (input.decision === "approve") {
      if (!input.diffHash) return jsonError(400, "invalid_input", "diffHash is required to approve publishing");
      job = store.approvePublish(id, {
        expectedVersion: input.version,
        diffHash: input.diffHash,
        approvedBy: formatApprover(guard.identity),
        acknowledgeUnverified: input.acknowledgeUnverified,
      });
    } else {
      job = store.rejectPublish(id, input.version);
    }
    after(() => startJobInBackground(id));
    return Response.json({ job });
  } catch (error) {
    return errorResponse(error);
  }
}
