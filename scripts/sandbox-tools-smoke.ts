/**
 * Live check of the agent's file tools on a real job sprite (no GitHub, no
 * model): builds a scratch git repo in a locked-down sprite, then exercises
 * read/write/edit/policy/symlink handling and change detection.
 *
 *   npm run sandbox-tools-smoke
 */
import { randomBytes } from "node:crypto";
import { writeTools } from "@/lib/agent/executor";
import { readOnlyTools } from "@/lib/agent/workspace-tools";
import { createJobSandbox, destroyJobSandbox } from "@/lib/sprites/sandbox";
import { changedFiles, runCheck } from "@/lib/verify/checks";

const ROOT = "/home/sprite/shipfig/repo";

async function main() {
  const name = `shipfig-smoke-${randomBytes(4).toString("hex")}`;
  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures++;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${msg}`);
  };
  const sb = await createJobSandbox(name);
  try {
    const sh = (argv: string[]) => sb.run(argv, { cwd: ROOT });
    await sb.run(["mkdir", "-p", `${ROOT}/src`], { cwd: "/" });
    await sb.writeFile(`${ROOT}/package.json`, JSON.stringify({ scripts: { test: "node --test" } }));
    await sb.writeFile(`${ROOT}/src/sum.js`, "exports.sum = (a, b) => a - b;\n");
    await sb.writeFile(`${ROOT}/src/sum.test.js`, "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sum', () => assert.strictEqual(sum(1, 2), 3));\n");
    await sb.writeFile(`${ROOT}/.env`, "API_KEY=supersecret\n");
    await sh(["git", "init", "-q"]);
    await sh(["ln", "-s", "/etc", "src/escape"]);
    await sh(["git", "-c", "user.email=s@x", "-c", "user.name=s", "add", "-A"]);
    await sh(["git", "-c", "user.email=s@x", "-c", "user.name=s", "commit", "-qm", "base"]);

    const session = { written: new Set<string>(), checkRuns: [], refusals: [] as string[] };
    const tools = new Map([...readOnlyTools(sb, ROOT), ...writeTools(sb, ROOT, ["test"], session)].map((t) => [t.name, t]));
    const call = (tool: string, args: object) => tools.get(tool)!.handler(args as never).then((r) => r, (e: Error) => `ERROR ${e.message}`);

    check((await call("list_files", { directory: null })).includes("src/sum.js"), "list_files lists tracked files");
    check((await call("read_file", { path: "src/sum.js", startLine: null, endLine: null })).includes("a - b"), "read_file reads source");
    check((await call("read_file", { path: ".env", startLine: null, endLine: null })).startsWith("ERROR"), "read_file refuses .env");
    check((await call("read_file", { path: "src/escape/passwd", startLine: null, endLine: null })).includes("outside the repository"), "read_file refuses symlink escape");
    check((await call("write_file", { path: "src/escape/evil", content: "x" })).includes("outside the repository"), "write_file refuses symlink escape");
    check((await call("write_file", { path: "package.json", content: "{}" })).includes("refused"), "write_file refuses package.json");
    const search = await call("search_code", { query: "API_KEY", directory: null });
    check(!search.includes("supersecret"), "search_code hides secret files");

    const before = await runCheck(sb, ROOT, "test");
    check(before.status === "failed" && before.exitCode !== 0, `npm test fails before the fix (exit ${before.exitCode})`);
    console.log("   ", (await call("edit_file", { path: "src/sum.js", oldText: "a - b", newText: "a + b" })));
    console.log("   ", (await call("write_file", { path: "test/new dir/regression.test.js", content: "// new file\n" })));
    const after = await runCheck(sb, ROOT, "test");
    check(after.status === "passed" && after.exitCode === 0, `npm test passes after the fix (exit ${after.exitCode}, ${after.durationMs}ms)`);

    const files = await changedFiles(sb, ROOT);
    check(JSON.stringify(files.sort()) === JSON.stringify(["src/sum.js", "test/new dir/regression.test.js"]), `changedFiles = ${JSON.stringify(files)}`);
    const diff = await call("get_diff", {});
    check(diff.includes("+exports.sum = (a, b) => a + b;") && diff.includes("new file mode"), "get_diff shows the edit and the new file");
    const timeout = await sb.run(["sleep", "5"], { timeoutMs: 1000 });
    check(timeout.timedOut && timeout.exitCode === null, "timeouts are reported as timed out with no exit code");
  } catch (error) {
    failures++;
    console.log(`[FAIL] ${(error as Error).stack}`);
  } finally {
    await destroyJobSandbox(name).catch(() => {});
    console.log(`[INFO] deleted ${name}`);
  }
  console.log(failures === 0 ? "\nSandbox tools smoke PASSED" : `\nSandbox tools smoke FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
