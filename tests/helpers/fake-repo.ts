import type { CommandResult } from "@/lib/sprites/sandbox";
import { FakeSandbox } from "./fake-sandbox";

export const ROOT = "/home/sprite/shipfig/repo";
export const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * A stateful fake checkout: serves reads, records writes, and answers
 * git status / git diff / npm scripts from the current file contents.
 * Also answers the provisioning commands.
 */
export class FakeRepo extends FakeSandbox {
  readonly original: Record<string, string>;
  readonly current: Record<string, string>;

  constructor(
    files: Record<string, string>,
    private readonly scripts: Record<string, (files: Record<string, string>) => Partial<CommandResult>> = {},
  ) {
    super("shipfig-job-x", (argv) => this.answer(argv));
    this.original = { ...files };
    this.current = { ...files };
  }

  override async writeFile(path: string, content: string): Promise<void> {
    await super.writeFile(path, content);
    this.current[path.slice(ROOT.length + 1)] = content;
  }

  changed(): string[] {
    const all = new Set([...Object.keys(this.original), ...Object.keys(this.current)]);
    return [...all].filter((f) => this.original[f] !== this.current[f]).sort();
  }

  private answer(argv: string[]): Partial<CommandResult> | undefined {
    const [cmd, ...args] = argv;
    const joined = argv.join(" ");
    if (joined === "git rev-parse HEAD") return { stdout: SHA };
    if (joined.startsWith("git ls-files --")) return { stdout: Object.keys(this.original).filter((f) => /^package(-lock)?\.json$/.test(f)).join("\n") };
    if (joined === "cat package.json") return { stdout: this.current["package.json"] ?? "{}" };
    if (cmd === "git" && args[0] === "ls-files") return { stdout: Object.keys(this.current).join("\0") + "\0" };
    if (cmd === "realpath") {
      const path = args.at(-1)!;
      const rel = path.slice(ROOT.length + 1);
      if (args[0] === "-e" && !(rel in this.current)) return { exitCode: 1 };
      return { stdout: path };
    }
    if (cmd === "head") return { stdout: this.current[args.at(-1)!.slice(ROOT.length + 1)] ?? "" };
    if (cmd === "git" && args[0] === "status") {
      return { stdout: this.changed().map((f) => `${f in this.original ? " M" : "??"} ${f}\0`).join("") };
    }
    if (cmd === "sha256sum") return { stdout: `${"ab".repeat(32)}  ${args.at(-1)}\n` };
    if (cmd === "git" && args[0] === "diff") {
      const files = this.changed();
      const status = (f: string) => (!(f in this.original) ? "A" : !(f in this.current) ? "D" : "M");
      if (args.includes("--numstat")) return { stdout: files.map((f) => `${(this.current[f] ?? "").split("\n").length}\t1\t${f}\0`).join("") };
      if (args.includes("--name-status")) return { stdout: files.map((f) => `${status(f)}\0${f}\0`).join("") };
      if (args.some((a) => a.startsWith("--output="))) return { stdout: "" };
      return {
        stdout: files
          .map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n${(this.original[f] ?? "").split("\n").filter(Boolean).map((l) => `-${l}`).join("\n")}\n${(this.current[f] ?? "").split("\n").filter(Boolean).map((l) => `+${l}`).join("\n")}`)
          .join("\n"),
      };
    }
    if (cmd === "npm") {
      const name = args[0] === "test" ? "test" : args[1];
      const script = this.scripts[name];
      if (script) return script(this.current);
      return { exitCode: 0, stdout: "ok" };
    }
    return undefined;
  }
}
