import { guardAction } from "@/lib/auth";
import { type NextRequest, after, connection } from "next/server";
import { z } from "zod";
import { getAllowedIssue } from "@/lib/github/connector";
import { resolveGitHubRequest } from "@/lib/github/user-client";
import { getUserSelectedRepos } from "@/lib/github/user-repos";
import { errorResponse, jsonError } from "@/lib/http";
import { startJobInBackground } from "@/lib/jobs/background";
import { jobStore } from "@/lib/jobs/store";
import { issueRefSchema } from "@/lib/validation";

/**
 * List recent jobs (newest first). Optional `owner`, `repo`, and `issueNumber`
 * query params filter to jobs created against a specific issue.
 */
export async function GET(request?: NextRequest) {
  await connection();
  try {
    const store = jobStore();
    for (const expired of store.expireTimedOut()) after(() => startJobInBackground(expired.id));

    const params = request?.nextUrl.searchParams;
    const owner = params?.get("owner");
    const repo = params?.get("repo");
    const issueNumberParam = params?.get("issueNumber");
    const hasAnyFilter = owner !== null && owner !== undefined || repo !== null && repo !== undefined || issueNumberParam !== null && issueNumberParam !== undefined;

    let jobs;
    if (hasAnyFilter) {
      if (!owner || !repo || !issueNumberParam) {
        return jsonError(400, "invalid_input", "owner, repo, and issueNumber query parameters must all be provided together");
      }
      const ref = issueRefSchema.parse({ owner, repo, issueNumber: Number(issueNumberParam) });
      jobs = store.listForIssue(ref, 50);
    } else {
      jobs = store.list(50);
    }

    return Response.json({
      jobs,
      activeJobId: store.activeJob()?.id ?? null,
      queuedJobIds: store.queuedJobs().map((j) => j.id),
    });
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
 * GitHub using the signed-in user's connected GitHub account (or the operator
 * gateway for headless token callers) so the stored snapshot cannot be spoofed.
 */
export async function POST(request: Request) {
  const guard = await guardAction(request);
  if (!guard.ok) return guard.response;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid_input", "Request body must be JSON with owner, repo and issueNumber");
    }
    const ref = createJobSchema.parse(body);
    const store = jobStore();
    for (const expired of store.expireTimedOut()) after(() => startJobInBackground(expired.id));
    const [gh, userSelectedRepos] = await Promise.all([
      resolveGitHubRequest(guard.identity),
      guard.identity.kind === "user" && guard.identity.userId ? getUserSelectedRepos(guard.identity.userId) : Promise.resolve([]),
    ]);
    const issue = await getAllowedIssue(ref, gh, userSelectedRepos);
    if (issue.state !== "open") return jsonError(409, "issue_not_open", `Issue #${issue.number} is ${issue.state}`);
    const createdByUserId = guard.identity.kind === "user" ? (guard.identity.userId ?? null) : null;
    const job = store.create({ ...ref, issueTitle: issue.title, issueUrl: issue.url, createdByUserId });
    const queuePosition = store.queuePosition(job.id);
    if (queuePosition === null) {
      after(() => startJobInBackground(job.id));
    }
    return Response.json({ job, queued: queuePosition !== null, queuePosition }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
