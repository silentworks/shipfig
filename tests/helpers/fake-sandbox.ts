import type { CommandResult, RunOptions, Sandbox } from "@/lib/sprites/sandbox";

export type Handler = (argv: string[], options: RunOptions) => Partial<CommandResult> | undefined;

/** In-memory Sandbox that records commands and answers them from a handler. */
export class FakeSandbox implements Sandbox {
  readonly id = "spr_fake";
  readonly calls: { argv: string[]; cwd?: string }[] = [];
  readonly files = new Map<string, string>();
  checkpoints: string[] = [];

  constructor(
    readonly name: string,
    private readonly handler: Handler = () => undefined,
  ) {}

  async run(argv: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    const args = [...argv];
    this.calls.push({ argv: args, cwd: options.cwd });
    const r = this.handler(args, options) ?? {};
    return {
      argv: args,
      exitCode: r.timedOut ? null : (r.exitCode ?? 0),
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      durationMs: r.durationMs ?? 5,
      timedOut: r.timedOut ?? false,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async checkpoint(comment: string): Promise<string> {
    this.checkpoints.push(comment);
    return `v${this.checkpoints.length + 1}`;
  }

  commands(): string[] {
    return this.calls.map((c) => c.argv.join(" "));
  }
}
