import { formatApprover, guardAction } from "@/lib/auth";
import { after } from "next/server";
import { z } from "zod";
import { PlanEditError, type PlanRecord, applyPlanEdit, planEditSchema } from "@/lib/agent/planner";
import { errorResponse, jsonError } from "@/lib/http";
import { startJobInBackground } from "@/lib/jobs/background";
import { jobIdSchema } from "@/lib/jobs/ids";
import { jobStore } from "@/lib/jobs/store";

const decisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  /** The job version the user was looking at; a changed plan cannot be approved blind. */
  version: z.number().int().positive(),
});

const editPlanSchema = z.strictObject({
  /** The job version the user was editing; prevents overwriting concurrent changes. */
  version: z.number().int().positive(),
  plan: planEditSchema,
});

/**
 * Manually edit the proposed plan while awaiting plan approval (SIL-555).
 * Re-validates all file paths against the write policy and recomputes runnable
 * checks against the workspace's package.json scripts.
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/jobs/[id]/plan">) {
  const guard = await guardAction(request);
  if (!guard.ok) return guard.response;
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_input", "Request body must be JSON with version and plan");
    }
    const { version, plan } = editPlanSchema.parse(body);
    const store = jobStore();
    const current = store.get(id);
    if (current.state !== "awaiting_plan_approval") {
      return jsonError(409, "invalid_transition", `Job ${id} is ${current.state}, not awaiting plan approval`);
    }
    const existingRecord = current.plan as PlanRecord | null;
    if (!existingRecord?.plan) {
      return jsonError(409, "invalid_transition", `Job ${id} has no plan to edit`);
    }
    const editor = formatApprover(guard.identity);
    let updatedRecord: PlanRecord;
    try {
      updatedRecord = applyPlanEdit(existingRecord, plan, current.workspace?.scripts ?? {}, editor);
    } catch (error) {
      if (error instanceof PlanEditError) {
        return jsonError(400, "invalid_plan_edit", error.message);
      }
      throw error;
    }
    const job = store.updatePlan(id, version, updatedRecord, editor);
    return Response.json({ job });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Approve or reject the plan. Approval moves the job to editing; nothing is
 * changed in the workspace before this. The approver is recorded from the
 * authenticated session.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/jobs/[id]/plan">) {
  const guard = await guardAction(request);
  if (!guard.ok) return guard.response;
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
    const job =
      decision === "approve" ? store.approvePlan(id, version, formatApprover(guard.identity)) : store.rejectPlan(id, version);
    after(() => startJobInBackground(id));
    return Response.json({ job });
  } catch (error) {
    return errorResponse(error);
  }
}
