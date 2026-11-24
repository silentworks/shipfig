import { guardAction } from "@/lib/auth";
import { after, connection } from "next/server";
import { z } from "zod";
import { getAllowedIssue } from "@/lib/github/connector";
import { errorResponse, jsonError } from "@/lib/http";
import { startJobInBackground } from "@/lib/jobs/background";
import { jobStore } from "@/lib/jobs/store";
import { issueRefSchema } from "@/lib/validation";

/** List recent jobs (newest first). Expires timed-out jobs first so states are honest. */
export async function GET() {
  await connection();
  try {
    const store = jobStore();
    for (const expired of store.expireTimedOut()) after(() => startJobInBackground(expired.id));
    return Response.json({ jobs: store.list(50), activeJobId: store.activeJob()?.id ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}

const createJobSchema = z.strictObject({
  owner: issueRefSchema.shape.owner,
  repo: issueRefSchema.shape.repo,
  issueNumber: issueRefSchema.shape.issueNumber,
});

/**
 * Start a job for one explicitly selected issue. Only the issue reference is
 * accepted from the client; title and URL are re-fetched server-side from
 * GitHub so the stored snapshot cannot be spoofed.
 */
export async function POST(request: Request) {
  const denied = guardAction(request);
  if (denied) return denied;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_input", "Request body must be JSON with owner, repo and issueNumber");
    }
    const ref = createJobSchema.parse(body);
    const store = jobStore();
    store.expireTimedOut();
    const active = store.activeJob();
    if (active) {
      return jsonError(409, "active_job_exists", `Job ${active.id} is already active; only one job may run at a time`, {
        activeJobId: active.id,
      });
    }
    const issue = await getAllowedIssue(ref);
    if (issue.state !== "open") return jsonError(409, "issue_not_open", `Issue #${issue.number} is ${issue.state}`);
    const job = store.create({ ...ref, issueTitle: issue.title, issueUrl: issue.url });
    after(() => startJobInBackground(job.id));
    return Response.json({ job }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
