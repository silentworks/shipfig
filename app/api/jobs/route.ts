import { connection } from "next/server";
import { errorResponse } from "@/lib/http";
import { jobStore } from "@/lib/jobs/store";

/** List recent jobs (newest first). Expires timed-out jobs first so states are honest. */
export async function GET() {
  await connection();
  try {
    const store = jobStore();
    store.expireTimedOut();
    return Response.json({ jobs: store.list(50), activeJobId: store.activeJob()?.id ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}
