import { describe, expect, it } from "vitest";
import { splitUnifiedDiff } from "@/lib/verify/diff-split";

const MULTI_FILE_DIFF = [
  "diff --git a/src/paginate.ts b/src/paginate.ts",
  "index 1111111..2222222 100644",
  "--- a/src/paginate.ts",
  "+++ b/src/paginate.ts",
  "@@ -1,3 +1,5 @@",
  " export interface Page<T> {",
  "+  from: number;",
  "+  to: number;",
  "   items: T[];",
  " }",
  "diff --git a/test/paginate.test.ts b/test/paginate.test.ts",
  "index 3333333..4444444 100644",
  "--- a/test/paginate.test.ts",
  "+++ b/test/paginate.test.ts",
  "@@ -10,2 +10,3 @@",
  "-  assert.equal(page.hasNext, true);",
  "+  assert.equal(page.from, 1);",
  "+  assert.equal(page.to, 2);",
].join("\n");

describe("splitUnifiedDiff (SIL-549)", () => {
  it("splits a multi-file git diff into per-file sections with counts", () => {
    const sections = splitUnifiedDiff(MULTI_FILE_DIFF);
    expect(sections).toHaveLength(2);

    expect(sections[0].path).toBe("src/paginate.ts");
    expect(sections[0].additions).toBe(2);
    expect(sections[0].deletions).toBe(0);
    expect(sections[0].lines[0]).toBe("@@ -1,3 +1,5 @@");
    expect(sections[0].isBinary).toBe(false);

    expect(sections[1].path).toBe("test/paginate.test.ts");
    expect(sections[1].additions).toBe(2);
    expect(sections[1].deletions).toBe(1);
    expect(sections[1].lines[0]).toBe("@@ -10,2 +10,3 @@");
  });

  it("handles added, deleted, and binary files", () => {
    const diff = [
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const old = 1;",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");

    const sections = splitUnifiedDiff(diff);
    expect(sections).toHaveLength(2);
    expect(sections[0].path).toBe("old.ts");
    expect(sections[0].deletions).toBe(1);
    expect(sections[1].path).toBe("logo.png");
    expect(sections[1].isBinary).toBe(true);
  });

  it("returns an empty array for blank diffs and falls back cleanly for non-git diffs", () => {
    expect(splitUnifiedDiff("   ")).toEqual([]);
    const fallback = splitUnifiedDiff("@@ -1 +1 @@\n-a\n+b");
    expect(fallback).toHaveLength(1);
    expect(fallback[0].path).toBe("Changes");
    expect(fallback[0].additions).toBe(1);
    expect(fallback[0].deletions).toBe(1);
  });
});
