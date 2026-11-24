import { connection } from "next/server";
import { errorResponse } from "@/lib/http";
import { jobIdSchema } from "@/lib/jobs/ids";
import { jobStore } from "@/lib/jobs/store";
import { findSprite } from "@/lib/sprites/client";

/**
 * Live status of the job's sprite from the Sprites API (e.g. running, warm,
 * cold), or "deleted" once the job has cleaned it up. Read-only.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/jobs/[id]/sprite">) {
  await connection();
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    const job = jobStore().get(id);
    if (!job.spriteName) return Response.json({ name: null, status: "none", checkedAt: new Date().toISOString() });
    const sprite = await findSprite(job.spriteName);
    return Response.json({
      name: job.spriteName,
      status: sprite ? (sprite.status ?? "unknown") : "deleted",
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
