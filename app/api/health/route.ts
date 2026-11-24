import { connection } from "next/server";

/** Liveness for the platform health check. Unauthenticated, so it reveals nothing. */
export async function GET() {
  await connection();
  return Response.json({ ok: true });
}
