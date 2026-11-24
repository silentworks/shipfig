import { ExecError, type Sprite } from "@fly/sprites";
import { describe, expect, it } from "vitest";
import { isContainerMissing, SpriteSandbox } from "@/lib/sprites/sandbox";

const MISSING = "container `app` does not exist: open `/run/crun/app/status`: No such file or directory\n";

function execError(exitCode: number, stderr: string) {
  return new ExecError(`exit ${exitCode}`, { exitCode, stdout: "", stderr });
}

/** A Sprite whose execFile replays outcomes in order (an Error to throw, or a success). */
function fakeSprite(outcomes: (Error | { stdout: string })[]) {
  const calls: string[][] = [];
  const sprite = {
    name: "shipfig-job-test",
    id: "s1",
    async execFile(file: string, args: string[]) {
      calls.push([file, ...args]);
      const next = outcomes.shift();
      if (!next) throw new Error("no more outcomes");
      if (next instanceof Error) throw next;
      return { exitCode: 0, stdout: next.stdout, stderr: "" };
    },
  } as unknown as Sprite;
  return { sprite, calls };
}

describe("isContainerMissing", () => {
  it("matches the Sprites runtime error and nothing else", () => {
    expect(isContainerMissing(MISSING)).toBe(true);
    expect(isContainerMissing("fatal: not a git repository")).toBe(false);
    expect(isContainerMissing("")).toBe(false);
  });
});

describe("SpriteSandbox.run", () => {
  it("re-sends a command that hit a missing container, and reports the retry", async () => {
    const { sprite, calls } = fakeSprite([execError(1, MISSING), { stdout: "ok" }]);
    const result = await new SpriteSandbox(sprite, [0, 0]).run(["git", "init"]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", retries: 1 });
    expect(calls).toHaveLength(2);
  });

  it("gives up after the configured retries and returns the real failure", async () => {
    const { sprite, calls } = fakeSprite([execError(1, MISSING), execError(1, MISSING), execError(1, MISSING)]);
    const result = await new SpriteSandbox(sprite, [0, 0]).run(["git", "init"]);
    expect(result).toMatchObject({ exitCode: 1, retries: 2 });
    expect(result.stderr).toContain("does not exist");
    expect(calls).toHaveLength(3);
  });

  it("never retries an ordinary failure", async () => {
    const { sprite, calls } = fakeSprite([execError(2, "npm ERR! test failed")]);
    const result = await new SpriteSandbox(sprite, [0, 0]).run(["npm", "test"]);
    expect(result.exitCode).toBe(2);
    expect(result.retries).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
