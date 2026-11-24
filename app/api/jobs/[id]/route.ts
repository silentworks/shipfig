import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { jobIdSchema } from "@/lib/jobs/ids";
import { jobStore } from "@/lib/jobs/store";

/** Job detail plus its event log. `?after=<eventId>` returns only newer events (for polling). */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  try {
    const id = jobIdSchema.parse((await ctx.params).id);
    const after = z.coerce.number().int().min(0).default(0).parse(request.nextUrl.searchParams.get("after") ?? undefined);
    const store = jobStore();
    store.expireTimedOut();
    return Response.json({ job: store.get(id), events: store.events(id, after) });
  } catch (error) {
    return errorResponse(error);
  }
}
