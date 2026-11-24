import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { redact } from "@/lib/redact";
import type { FailureReason } from "./states";

/**
 * Turn an unexpected error from a stage into a failure reason and a short,
 * readable, redacted message for the job history (SIL-536). URLs lose their
 * query strings (which can carry command lines and environment) and long
 * messages are capped.
 */

const MAX_MESSAGE = 600;

export function tidyMessage(message: string): string {
  const withoutQueries = message.replace(/\b((?:wss?|https?):\/\/[^\s?#)]+)\?[^\s)]*/g, "$1?…");
  const text = redact(withoutQueries).replace(/\s+/g, " ").trim();
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

function providerError(error: unknown): { provider: string; status: number | undefined; message: string } | null {
  if (error instanceof Anthropic.APIError) return { provider: "Anthropic", status: error.status, message: error.message };
  if (error instanceof OpenAI.APIError) return { provider: "OpenAI", status: error.status, message: error.message };
  return null;
}

const SPRITE_TRANSPORT = /WebSocket error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|EAI_AGAIN|fetch failed/i;

export function classifyStageError(error: unknown): { reason: FailureReason; message: string } {
  const provider = providerError(error);
  if (provider) {
    const hint =
      provider.status === 401 || provider.status === 403
        ? " Check the API key."
        : provider.status === 429
          ? " Rate limited or out of credit; retry later."
          : provider.status !== undefined && provider.status >= 500
            ? " The provider had an outage; retry later."
            : "";
    return { reason: "agent_error", message: tidyMessage(`${provider.provider} API error${provider.status ? ` (${provider.status})` : ""}: ${provider.message}.${hint}`) };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (SPRITE_TRANSPORT.test(message)) {
    return { reason: "sprite_error", message: tidyMessage(`Lost the connection to the job's sprite: ${message}. Retry to start again.`) };
  }
  return { reason: "error", message: tidyMessage(message) };
}
