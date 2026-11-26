/**
 * Split a unified `git diff` string into per-file sections so the UI can
 * render each changed file under its own header (SIL-549).
 */

export interface FileDiffSection {
  /** Repository-relative path for display (e.g. `src/paginate.ts`). */
  path: string;
  /** File-level metadata lines (`diff --git`, `index`, `---`, `+++`, etc.). */
  headerLines: string[];
  /** Hunk and content lines (`@@`, `+`, `-`, context). */
  lines: string[];
  additions: number;
  deletions: number;
  isBinary: boolean;
}

function stripGitPrefix(raw: string): string {
  const trimmed = raw.trim().replace(/^"(.*)"$/, "$1");
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

function pathFromDiffGitLine(line: string): string | null {
  // Matches `diff --git a/path/one b/path/two` (or quoted paths).
  const match = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
  if (!match) return null;
  return match[2] || match[1] || null;
}

export function splitUnifiedDiff(diff: string): FileDiffSection[] {
  const trimmed = diff.trim();
  if (!trimmed) return [];

  const allLines = diff.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].startsWith("diff --git ")) starts.push(i);
  }

  // Fallback for non-git unified diffs without `diff --git` markers.
  if (starts.length === 0) {
    let additions = 0;
    let deletions = 0;
    for (const line of allLines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return [
      {
        path: "Changes",
        headerLines: [],
        lines: allLines,
        additions,
        deletions,
        isBinary: false,
      },
    ];
  }

  const sections: FileDiffSection[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : allLines.length;
    const chunk = allLines.slice(start, end);
    // Drop a trailing empty line produced by splitting a trailing newline.
    while (chunk.length > 1 && chunk[chunk.length - 1] === "") chunk.pop();

    let path = pathFromDiffGitLine(chunk[0]) ?? `file-${s + 1}`;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let isBinary = false;
    const headerLines: string[] = [];
    const bodyLines: string[] = [];
    let inBody = false;

    for (const line of chunk) {
      if (!inBody) {
        if (line.startsWith("@@")) {
          inBody = true;
          bodyLines.push(line);
          continue;
        }
        headerLines.push(line);
        if (line.startsWith("--- ") && line !== "--- /dev/null") {
          oldPath = stripGitPrefix(line.slice(4));
        } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
          newPath = stripGitPrefix(line.slice(4));
        } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
          isBinary = true;
        }
      } else {
        bodyLines.push(line);
      }
    }

    if (newPath) path = newPath;
    else if (oldPath) path = oldPath;

    let additions = 0;
    let deletions = 0;
    for (const line of bodyLines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    sections.push({
      path,
      headerLines,
      lines: bodyLines,
      additions,
      deletions,
      isBinary,
    });
  }

  return sections;
}
