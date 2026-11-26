import { ZodError } from "zod";
import { EnvError } from "@/lib/env";
import { GatewayError } from "@/lib/sprites/gateway";
import { ActiveJobExistsError, InvalidTransitionError, JobNotFoundError, QueueFullError } from "@/lib/jobs/store";
import { redact } from "@/lib/redact";
import { RepoNotAllowedError } from "@/lib/github/connector";
import { GitHubNotConnectedError } from "@/lib/github/user-client";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function jsonError(status: number, code: string, message: string, details?: unknown): Response {
  const body: ApiErrorBody = { error: { code, message: redact(message), ...(details === undefined ? {} : { details }) } };
  return Response.json(body, { status });
}

/** Map known domain errors to HTTP responses; never leak stack traces or secrets. */
export function errorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return jsonError(400, "invalid_input", "Invalid input", error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  if (error instanceof JobNotFoundError) return jsonError(404, "not_found", error.message);
  if (error instanceof ActiveJobExistsError) {
    return jsonError(409, "active_job_exists", error.message, { activeJobId: error.activeJobId });
  }
  if (error instanceof QueueFullError) {
    return jsonError(409, "queue_full", error.message, { limit: error.limit });
  }
  if (error instanceof InvalidTransitionError) return jsonError(409, "invalid_transition", error.message);
  if (error instanceof RepoNotAllowedError) return jsonError(403, "repo_not_allowed", error.message);
  if (error instanceof GitHubNotConnectedError) return jsonError(412, "github_not_connected", error.message);
  if (error instanceof EnvError) return jsonError(503, "not_configured", error.message);
  if (error instanceof GatewayError) {
    const status =
      error.kind === "unauthorized"
        ? 401
        : error.kind === "forbidden"
          ? 403
          : error.kind === "not_found"
            ? 404
            : error.kind === "rate_limited"
              ? 429
              : error.kind === "policy"
                ? 400
                : 502;
    return jsonError(status, `github_${error.kind}`, error.message);
  }
  console.error("[shipfig] unexpected API error:", redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  return jsonError(500, "internal_error", "Unexpected server error");
}
