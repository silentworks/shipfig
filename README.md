# Shipfig

An autonomous software maintenance agent. You pick a GitHub issue. Shipfig
plans a fix, runs it in an isolated [Fly.io Sprite](https://sprites.dev),
verifies it, and opens a draft pull request only after you approve.

## Requirements

- Node.js 24 or later. `@fly/sprites` and the built-in `node:sqlite` both need it.
- A Sprites account and token.
- A GitHub connector added in the Sprites dashboard (Connectors → Add connector → GitHub).

## Setup

```bash
npm install
cp .env.example .env.local          # fill in SPRITES_TOKEN
npm run connector -- list           # copy the id (first column) into SHIPFIG_GITHUB_CONNECTION_ID
npm run connector -- apply-policy   # restrict the connector to the gateway sprite
npm run spike -- <owner>/<repo> <issue-number>   # verify Sprites + connector end to end
npm run dev                         # http://localhost:3000
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `SPRITES_TOKEN` | yes | Sprites API token. Server-side only; never sent to any sprite. |
| `SHIPFIG_GITHUB_CONNECTION_ID` | yes | GitHub connector id used in gateway URLs. |
| `SHIPFIG_AGENT_PROVIDER` | no (`openai`) | Model provider for planning, editing and review: `openai` or `anthropic`. |
| `OPENAI_API_KEY` | with `openai` | OpenAI key. Server-side only. |
| `SHIPFIG_OPENAI_MODEL` | no (`gpt-6.2-sol`) | OpenAI model. |
| `ANTHROPIC_API_KEY` | no | Anthropic key. If unset, the SDK uses `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile. Server-side only. |
| `SHIPFIG_ANTHROPIC_MODEL` | no (`claude-opus-5-5`) | Claude model. |
| `SHIPFIG_ANTHROPIC_EFFORT` | no (`high`) | Claude effort: `low`, `medium`, `high`, `xhigh` or `max`. |
| `SHIPFIG_GATEWAY_SPRITE` | no (`shipfig-gateway`) | Trusted sprite that makes GitHub calls. |
| `SHIPFIG_ALLOWED_REPOS` | no | Comma-separated `owner/repo` allowlist. |
| `SHIPFIG_DB_PATH` | no (`.data/shipfig.db`) | SQLite job database. |
| `SPRITES_API_URL` | no | Override the Sprites API base URL. |

Without the required variables the app still starts. API routes that need
them return `503 not_configured`, and the error names the missing variable.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` | ESLint |
| `npm run typecheck` | Generate route types, then `tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run spike -- owner/repo N` | Live Sprites + GitHub connector proof (SIL-527) |
| `npm run connector -- list\|show\|apply-policy` | Inspect or restrict the GitHub connector |
| `npm run sandbox-tools-smoke` | Live check of the agent's file tools and policies on a scratch repo in a real sprite (SIL-532) |
| `npm run workspace-smoke -- owner/repo` | Live job-workspace check: provision, prove isolation, run the repo's tests, delete (SIL-530) |

## How it fits together

- `lib/sprites/gateway.ts`: GitHub API calls go through the Sprites connector
  gateway, which accepts calls only from inside a sprite. They run as `curl` in
  one trusted gateway sprite, so the GitHub token never reaches any sprite or
  log. See [docs/github-connector.md](docs/github-connector.md).
- `lib/github/connector.ts`: typed repo and issue operations with allowlist and
  eligibility checks (public and non-archived only, for the MVP).
- `lib/sprites/sandbox.ts`: one fresh sprite per job, locked down before use:
  DNS egress allowlist (github.com and the npm registry only; the Sprites API
  and connector gateway are unreachable), a memory limit, and no privilege
  escalation. Commands are argv arrays with timeouts and redacted output.
- `lib/workspace/provision.ts`: pins the base branch head SHA, fetches exactly
  that commit anonymously, creates `shipfig/issue-<n>-<job>`, disables git
  hooks, runs `npm ci --ignore-scripts`, and checkpoints before any edit.
- `lib/agent/*`: the agent. `loop.ts` is a bounded tool loop (schema-checked
  arguments, turn and token limits, redacted tool output). `planner.ts` gives
  the model read-only tools (`list_files`, `read_file`, `search_code`) over the
  checkout and returns a structured plan. The server then checks the plan's
  paths and checks against the real repo, and a human must approve it
  (`POST /api/jobs/:id/plan`). Issue and repo text is fenced as untrusted data,
  and secret files (`.env`, keys, `.npmrc` …) are never read.
- `lib/agent/executor.ts`: after plan approval, the executor gets the read
  tools plus `write_file`, `edit_file` (exact single match), `run_check`
  (approved npm checks only) and `get_diff`. No shell, git-write, network or
  GitHub tool. Writes to credentials, CI, deployment, `package.json`,
  lockfiles, `.git` and `node_modules` are refused (`lib/agent/policy.ts`).
  Shipfig then re-runs the checks itself; the executor's own report is never
  taken as evidence. Failed checks go back to editing at most twice, then the
  job fails with `repair_limit`, keeping the diff and output.
- `lib/verify/*`: evidence. Approved checks run on the untouched checkout
  first (baseline) and again after the change. Each records the command, real
  exit code, duration and a one-line summary. Missing scripts are recorded as
  `not_run`, never as passing. The outcome is `verified`, `unverified` or
  `failed`, decided only from exit codes. The diff is captured with per-file
  stats and a sha256 of the raw diff, computed inside the sprite, for the
  publish guard. Server-side flags cover no regression test, unplanned files,
  deletions, weakened tests and pre-existing failures. A change that adds a
  secret is refused. A model review of the real diff and results can block a
  change but never approve one.
- `lib/jobs/runner.ts`: drives a job through its automated states
  (queued → provisioning → planning …) until it needs a human, and deletes the
  sprite once the job ends.
- `lib/jobs/*`: durable SQLite job store and guarded state machine. It enforces
  one active job, bounded repairs and retries, per-state timeouts, and
  redacted events and evidence.
- `app/api/*`: route handlers for repos, issues and jobs.
- `app/page.tsx`: repo and issue picker. `app/jobs/[id]`: job status.

Treat issue text and repository content as untrusted. They are rendered only
as plain text, and every owner, repo, issue number, path and branch value is
validated before use (`lib/validation.ts`).
