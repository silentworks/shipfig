import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { AgentModel, ModelInput, ModelRequest, ModelResponse, ToolCall } from "../model";

/**
 * Anthropic Messages API adapter (Claude).
 *
 * The Messages API is stateless, so this adapter keeps each conversation's
 * history itself, keyed by the id of the last response it returned. The tool
 * loop always continues from the latest response, so each entry is consumed
 * once; the map is capped so abandoned loops cannot grow it without bound.
 *
 * Assistant turns are stored exactly as returned (including thinking blocks),
 * which the API requires when a conversation continues.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Thinking tokens count against max_tokens, so never go below this per turn. */
export const MIN_MAX_TOKENS = 16_000;
const MAX_CONVERSATIONS = 200;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class ModelRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`The model declined this request${category ? ` (${category})` : ""}`);
    this.name = "ModelRefusalError";
  }
}

/** The single SDK call this adapter makes; injectable for tests. */
export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

function toolSchema(parameters: z.ZodObject): Anthropic.Beta.BetaTool.InputSchema {
  const schema = z.toJSONSchema(parameters, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return { ...schema, type: "object" } as Anthropic.Beta.BetaTool.InputSchema;
}

function jsonFormat(schema: z.ZodObject): Anthropic.Beta.BetaJSONOutputFormat {
  const { type, schema: jsonSchema } = zodOutputFormat(schema);
  return { type, schema: jsonSchema };
}

function toContent(input: ModelInput[]): Anthropic.Beta.BetaContentBlockParam[] {
  return input.map((item) =>
    item.type === "message"
      ? { type: "text", text: item.content }
      : { type: "tool_result", tool_use_id: item.callId, content: item.output },
  );
}

export class AnthropicModel implements AgentModel {
  private readonly create: CreateMessage;
  private readonly effort: Effort;
  private readonly conversations = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

  constructor(
    readonly name: string,
    options: { apiKey?: string; effort?: Effort; create?: CreateMessage } = {},
  ) {
    this.effort = options.effort ?? "high";
    if (options.create) {
      this.create = options.create;
    } else {
      // With no apiKey the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
      const client = new Anthropic({ ...(options.apiKey ? { apiKey: options.apiKey } : {}), timeout: 300_000, maxRetries: 2 });
      this.create = (params) => client.beta.messages.create(params);
    }
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    let history: Anthropic.Beta.BetaMessageParam[] = [];
    if (request.previousResponseId) {
      const previous = this.conversations.get(request.previousResponseId);
      if (!previous) throw new Error(`Unknown conversation ${request.previousResponseId}`);
      this.conversations.delete(request.previousResponseId);
      history = previous;
    }
    const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: "user", content: toContent(request.input) }];

    const response = await this.create({
      model: this.name,
      max_tokens: Math.max(request.maxOutputTokens, MIN_MAX_TOKENS),
      system: request.instructions,
      messages,
      tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: toolSchema(t.parameters) })),
      // One call per turn keeps the loop's ordering and budgets simple.
      tool_choice: request.tools.length > 0 ? { type: "auto", disable_parallel_tool_use: true } : undefined,
      output_config: {
        effort: this.effort,
        // Only the JSON schema is sent; the loop validates the reply with zod itself.
        ...(request.output ? { format: jsonFormat(request.output.schema) } : {}),
      },
      // Cache the growing conversation prefix between turns.
      cache_control: { type: "ephemeral" },
      // If a safety classifier declines, retry on a fallback model the API picks.
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") throw new ModelRefusalError(response.stop_details?.category ?? null);
    if (response.stop_reason === "max_tokens") throw new Error(`Model output hit max_tokens (${Math.max(request.maxOutputTokens, MIN_MAX_TOKENS)})`);

    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") toolCalls.push({ callId: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      else if (block.type === "text") text.push(block.text);
    }

    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    this.conversations.set(response.id, messages);
    while (this.conversations.size > MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);

    const u = response.usage;
    return {
      id: response.id,
      toolCalls,
      text: text.join(""),
      usage: {
        // Count cached input too, so the loop's token budget means the same thing for every provider.
        inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens,
      },
    };
  }
}
