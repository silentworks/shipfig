import type { z } from "zod";
import { agentEnv } from "@/lib/env";
import { AnthropicModel } from "./providers/anthropic";
import { OpenAIModel } from "./providers/openai";

/**
 * The narrow model interface the agent needs. Provider adapters live in
 * ./providers (OpenAI Responses API, Anthropic Messages API); tests use a
 * scripted fake. Pick one with SHIPFIG_AGENT_PROVIDER.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: z.ZodObject;
}

export interface ToolCall {
  callId: string;
  name: string;
  /** Raw JSON arguments as produced by the model (validated by the loop). */
  arguments: string;
}

export type ModelInput = { type: "message"; content: string } | { type: "tool_result"; callId: string; output: string };

export interface ModelRequest {
  instructions: string;
  input: ModelInput[];
  tools: ToolSpec[];
  /** Structured final output (strict JSON schema). */
  output?: { name: string; schema: z.ZodObject };
  /**
   * Continue the conversation from this response. Stateless providers keep
   * the history themselves, keyed by the response id they returned.
   */
  previousResponseId?: string;
  maxOutputTokens: number;
}

export interface ModelResponse {
  id: string;
  toolCalls: ToolCall[];
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgentModel {
  readonly name: string;
  respond(request: ModelRequest): Promise<ModelResponse>;
}

let defaultModel: AgentModel | undefined;

/** The configured agent model (SHIPFIG_AGENT_PROVIDER and that provider's settings). */
export function agentModel(): AgentModel {
  if (!defaultModel) {
    const env = agentEnv();
    defaultModel =
      env.SHIPFIG_AGENT_PROVIDER === "anthropic"
        ? new AnthropicModel(env.SHIPFIG_ANTHROPIC_MODEL, { apiKey: env.ANTHROPIC_API_KEY || undefined, effort: env.SHIPFIG_ANTHROPIC_EFFORT })
        : new OpenAIModel(env.SHIPFIG_OPENAI_MODEL, env.OPENAI_API_KEY ?? "");
  }
  return defaultModel;
}
