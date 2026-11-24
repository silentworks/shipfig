import type { AgentModel, ModelRequest, ModelResponse } from "@/lib/agent/model";

export type Step = { tools?: { name: string; args: unknown }[]; text?: string; usage?: number };

/** Model that replays a fixed script of tool calls / final answers. */
export class FakeModel implements AgentModel {
  readonly name = "fake-model";
  readonly requests: ModelRequest[] = [];
  private i = 0;

  constructor(private readonly script: Step[]) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const step = this.script[this.i++];
    if (!step) throw new Error(`FakeModel script exhausted after ${this.script.length} steps`);
    return {
      id: `resp_${this.i}`,
      toolCalls: (step.tools ?? []).map((t, n) => ({
        callId: `call_${this.i}_${n}`,
        name: t.name,
        arguments: typeof t.args === "string" ? t.args : JSON.stringify(t.args),
      })),
      text: step.text ?? "",
      usage: { inputTokens: step.usage ?? 100, outputTokens: 10 },
    };
  }

  /** Tool outputs the loop sent back in request n (0-based). */
  toolResults(n: number): string[] {
    return (this.requests[n]?.input ?? []).flatMap((i) => (i.type === "tool_result" ? [i.output] : []));
  }
}
