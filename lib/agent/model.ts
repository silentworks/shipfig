import OpenAI from "openai";
import { zodResponsesFunction, zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { z } from "zod";
import { openaiEnv } from "@/lib/env";

/**
 * The narrow model interface the agent needs. The OpenAI Responses API
 * implementation lives here; tests use a scripted fake.
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
  /** Continue the conversation from this response. */
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

function toInputItem(item: ModelInput): ResponseInputItem {
  if (item.type === "message") return { role: "user", content: item.content };
  return { type: "function_call_output", call_id: item.callId, output: item.output };
}

export class OpenAIModel implements AgentModel {
  private readonly client: OpenAI;

  constructor(
    readonly name: string,
    apiKey: string,
  ) {
    this.client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 2 });
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.responses.create({
      model: this.name,
      // Instructions are not inherited through previous_response_id; resend them.
      instructions: request.instructions,
      input: request.input.map(toInputItem),
      previous_response_id: request.previousResponseId,
      tools: request.tools.map((t) => zodResponsesFunction({ name: t.name, description: t.description, parameters: t.parameters })),
      parallel_tool_calls: false,
      text: request.output ? { format: zodTextFormat(request.output.schema, request.output.name) } : undefined,
      max_output_tokens: request.maxOutputTokens,
    });
    const toolCalls: ToolCall[] = [];
    for (const item of response.output) {
      if (item.type === "function_call") toolCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
    }
    return {
      id: response.id,
      toolCalls,
      text: response.output_text ?? "",
      usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 },
    };
  }
}

let defaultModel: AgentModel | undefined;

/** The configured OpenAI model (OPENAI_API_KEY, SHIPFIG_OPENAI_MODEL). */
export function agentModel(): AgentModel {
  if (!defaultModel) {
    const env = openaiEnv();
    defaultModel = new OpenAIModel(env.SHIPFIG_OPENAI_MODEL, env.OPENAI_API_KEY);
  }
  return defaultModel;
}
