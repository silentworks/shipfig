import { z } from "zod";

export const jobIdSchema = z.string().regex(/^[0-9a-f]{12}$/, "Invalid job id");
