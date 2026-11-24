import { connection } from "next/server";
import { listAllowedRepos } from "@/lib/github/connector";
import { errorResponse } from "@/lib/http";

/** Repositories the connected GitHub account exposes that Shipfig may operate on. */
export async function GET() {
  await connection();
  try {
    return Response.json(await listAllowedRepos());
  } catch (error) {
    return errorResponse(error);
  }
}
