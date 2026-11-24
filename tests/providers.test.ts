import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, runToolLoop } from "@/lib/agent/loop";
import { AnthropicModel, MIN_MAX_TOKENS, ModelRefusalError } from "@/lib/agent/providers/anthropic";
import { EnvError, parseAgentEnv } from "@/lib/env";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

function message(id: string, content: unknown[], stop_reason = "end_turn", extra: Record<string, unknown> = {}): Anthropic.Beta.BetaMessage {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    ...extra,
  } as unknown as Anthropic.Beta.BetaMessage;
}

function scripted(responses: Anthropic.Beta.BetaMessage[]) {
  const calls: Params[] = [];
  return {
    calls,
    create: async (params: Params) => {
      calls.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
}

const readTool = defineTool({
  name: "read_file",
  description: "Read a file",
  parameters: z.object({ path: z.string() }),
  handler: async ({ path }) => `contents of ${path}`,
});

describe("AnthropicModel", () => {
  it("threads the conversation, maps tools and returns structured output", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const s = scripted([
      message("msg_1", [thinking, { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/a.ts" } }], "tool_use"),
      message("msg_2", [{ type: "text", text: '{"answer":"done"}' }]),
    ]);
    const model = new AnthropicModel("claude-opus-5-5", { create: s.create, effort: "high" });
    const result = await runToolLoop({
      model,
      instructions: "be careful",
      input: "fix the bug",
      tools: [readTool],
      output: { name: "result", schema: z.object({ answer: z.string() }) },
    });

    expect(result.output).toEqual({ answer: "done" });
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 40 });

    const [first, second] = s.calls;
    expect(first.system).toBe("be careful");
    expect(first.max_tokens).toBe(MIN_MAX_TOKENS);
    expect(first.tools?.[0]).toMatchObject({ name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } } } });
    expect(first.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(first.output_config).toMatchObject({ effort: "high", format: { type: "json_schema" } });
    expect(first.fallbacks).toBe("default");

    // Second turn resends the full history: user, assistant (thinking kept verbatim), then the tool result.
    expect(second.system).toBe("be careful");
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: "assistant", content: [thinking, { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/a.ts" } }] });
    expect(second.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "contents of src/a.ts" }] });
  });

  it("refuses to continue an unknown conversation", async () => {
    const model = new AnthropicModel("claude-opus-5-5", { create: scripted([]).create });
    await expect(model.respond({ instructions: "", input: [], tools: [], previousResponseId: "msg_x", maxOutputTokens: 1000 })).rejects.toThrow(/Unknown conversation/);
  });

  it("surfaces refusals and truncation instead of returning partial output", async () => {
    const refused = new AnthropicModel("claude-opus-5-5", {
      create: scripted([message("msg_1", [], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } })]).create,
    });
    await expect(refused.respond({ instructions: "", input: [{ type: "message", content: "hi" }], tools: [], maxOutputTokens: 1000 })).rejects.toBeInstanceOf(ModelRefusalError);

    const truncated = new AnthropicModel("claude-opus-5-5", {
      create: scripted([message("msg_1", [{ type: "tool_use", id: "tu", name: "read_file", input: {} }], "max_tokens")]).create,
    });
    await expect(truncated.respond({ instructions: "", input: [{ type: "message", content: "hi" }], tools: [], maxOutputTokens: 1000 })).rejects.toThrow(/max_tokens/);
  });

  it("omits tool_choice when no tools are offered", async () => {
    const s = scripted([message("msg_1", [{ type: "text", text: "ok" }])]);
    await new AnthropicModel("claude-opus-5-5", { create: s.create }).respond({ instructions: "", input: [{ type: "message", content: "hi" }], tools: [], maxOutputTokens: 1000 });
    expect(s.calls[0].tool_choice).toBeUndefined();
    expect(s.calls[0].output_config).toEqual({ effort: "high" });
  });
});

describe("agent provider env", () => {
  it("defaults to OpenAI gpt-6.2-sol and requires its key", () => {
    expect(parseAgentEnv({ OPENAI_API_KEY: "sk-x" })).toMatchObject({ SHIPFIG_AGENT_PROVIDER: "openai", SHIPFIG_OPENAI_MODEL: "gpt-6.2-sol" });
    expect(() => parseAgentEnv({})).toThrow(EnvError);
    expect(() => parseAgentEnv({ OPENAI_API_KEY: "" })).toThrow(/OPENAI_API_KEY/);
  });

  it("selects Anthropic without an OpenAI key", () => {
    expect(parseAgentEnv({ SHIPFIG_AGENT_PROVIDER: "anthropic" })).toMatchObject({
      SHIPFIG_ANTHROPIC_MODEL: "claude-opus-5-5",
      SHIPFIG_ANTHROPIC_EFFORT: "high",
    });
    expect(() => parseAgentEnv({ SHIPFIG_AGENT_PROVIDER: "gemini" })).toThrow(/SHIPFIG_AGENT_PROVIDER/);
    expect(() => parseAgentEnv({ SHIPFIG_AGENT_PROVIDER: "anthropic", SHIPFIG_ANTHROPIC_EFFORT: "extreme" })).toThrow(EnvError);
  });
});
