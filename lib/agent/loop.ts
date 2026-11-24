import type { z } from "zod";
import { sanitizeOutput } from "@/lib/redact";
import type { AgentModel, ModelInput, ToolSpec } from "./model";

/**
 * Bounded tool-calling loop. The model may only call the tools it is given;
 * every argument is schema-validated before a handler runs; tool output is
 * redacted and capped; and the loop stops at a turn limit and token budget.
 */

export interface Tool<S extends z.ZodObject = z.ZodObject> extends ToolSpec {
  parameters: S;
  handler(args: z.infer<S>): Promise<string>;
}

export function defineTool<S extends z.ZodObject>(tool: Tool<S>): Tool {
  return tool as unknown as Tool;
}

export interface LoopLimits {
  maxTurns: number;
  /** Total input+output tokens across the loop. */
  maxTotalTokens: number;
  maxOutputTokensPerTurn: number;
  /** Max characters of a single tool result returned to the model. */
  maxToolOutputChars: number;
}

export const DEFAULT_LIMITS: LoopLimits = {
  maxTurns: 16,
  maxTotalTokens: 250_000,
  maxOutputTokensPerTurn: 8_000,
  maxToolOutputChars: 24_000,
};

export interface LoopEvent {
  kind: "tool_call" | "tool_error" | "model";
  message: string;
}

export interface LoopRequest<O extends z.ZodObject | undefined> {
  model: AgentModel;
  instructions: string;
  input: string;
  tools: Tool[];
  output?: O extends z.ZodObject ? { name: string; schema: O } : undefined;
  limits?: Partial<LoopLimits>;
  onEvent?(event: LoopEvent): void;
  /** Checked before every turn; return a reason to stop early (e.g. job canceled). */
  shouldStop?(): string | null;
}

export interface LoopResult<T> {
  output: T;
  text: string;
  turns: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
}

export class AgentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLimitError";
  }
}

export class AgentOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentOutputError";
  }
}

export class AgentStoppedError extends Error {
  constructor(reason: string) {
    super(`Agent stopped: ${reason}`);
    this.name = "AgentStoppedError";
  }
}

function describeArgs(args: unknown): string {
  const text = JSON.stringify(args);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export async function runToolLoop<O extends z.ZodObject | undefined>(
  request: LoopRequest<O>,
): Promise<LoopResult<O extends z.ZodObject ? z.infer<O> : null>> {
  const limits = { ...DEFAULT_LIMITS, ...request.limits };
  const tools = new Map(request.tools.map((t) => [t.name, t]));
  const usage = { inputTokens: 0, outputTokens: 0 };
  let input: ModelInput[] = [{ type: "message", content: request.input }];
  let previousResponseId: string | undefined;
  let toolCalls = 0;
  let outputRetries = 0;

  for (let turn = 1; turn <= limits.maxTurns; turn++) {
    const stop = request.shouldStop?.();
    if (stop) throw new AgentStoppedError(stop);

    const response = await request.model.respond({
      instructions: request.instructions,
      input,
      tools: request.tools,
      output: request.output as { name: string; schema: z.ZodObject } | undefined,
      previousResponseId,
      maxOutputTokens: limits.maxOutputTokensPerTurn,
    });
    previousResponseId = response.id;
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    if (usage.inputTokens + usage.outputTokens > limits.maxTotalTokens) {
      throw new AgentLimitError(`Token budget exceeded (${usage.inputTokens + usage.outputTokens} > ${limits.maxTotalTokens})`);
    }

    if (response.toolCalls.length === 0) {
      if (!request.output) {
        return { output: null as never, text: response.text, turns: turn, toolCalls, usage };
      }
      let parsed: unknown;
      try {
        parsed = request.output.schema.parse(JSON.parse(response.text));
      } catch (error) {
        if (outputRetries++ >= 1) throw new AgentOutputError(`Model returned invalid ${request.output.name}: ${(error as Error).message.slice(0, 300)}`);
        input = [{ type: "message", content: `Your reply was not a valid ${request.output.name} object. Reply again with only the JSON object.` }];
        continue;
      }
      return { output: parsed as never, text: response.text, turns: turn, toolCalls, usage };
    }

    const results: ModelInput[] = [];
    for (const call of response.toolCalls) {
      toolCalls++;
      const tool = tools.get(call.name);
      let output: string;
      if (!tool) {
        output = `Error: unknown tool "${call.name}". Available: ${[...tools.keys()].join(", ")}`;
        request.onEvent?.({ kind: "tool_error", message: `unknown tool ${call.name}` });
      } else {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          args = undefined;
        }
        const valid = tool.parameters.safeParse(args);
        if (!valid.success) {
          output = `Error: invalid arguments for ${call.name}: ${valid.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
          request.onEvent?.({ kind: "tool_error", message: `${call.name}: invalid arguments` });
        } else {
          request.onEvent?.({ kind: "tool_call", message: `${call.name} ${describeArgs(valid.data)}` });
          try {
            output = await tool.handler(valid.data);
          } catch (error) {
            output = `Error: ${(error as Error).message}`;
            request.onEvent?.({ kind: "tool_error", message: `${call.name}: ${(error as Error).message}` });
          }
        }
      }
      results.push({ type: "tool_result", callId: call.callId, output: sanitizeOutput(output, limits.maxToolOutputChars) });
    }
    input = results;
  }
  throw new AgentLimitError(`Turn limit reached (${limits.maxTurns})`);
}
