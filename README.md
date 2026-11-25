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
| `DATABASE_URL` | yes | Postgres connection string used by Drizzle ORM and Better Auth. |
| `BETTER_AUTH_SECRET` | yes | Secret key for Better Auth session signing (`openssl rand -base64 32`). |
| `BETTER_AUTH_URL` | yes | Canonical base URL of the Shipfig app (e.g. `http://localhost:3000`). |
| `GITHUB_CLIENT_ID` | no | Optional GitHub OAuth client ID to enable "Continue with GitHub" sign-in. |
| `GITHUB_CLIENT_SECRET` | no | Optional GitHub OAuth client secret. |
| `SHIPFIG_OPERATOR_TOKEN` | no | Optional headless/CLI Bearer or Basic token (at least 16 characters) alongside Better Auth user sessions. |
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
| `npm run db:generate` | Generate Drizzle SQL migrations for Postgres (`drizzle/`) |
| `npm run db:migrate` | Apply Drizzle migrations to `DATABASE_URL` |
| `npm run db:push` | Push Drizzle schema directly to `DATABASE_URL` (dev) |
| `npm run spike -- owner/repo N` | Live Sprites + GitHub connector proof (SIL-527) |
| `npm run connector -- list\|show\|apply-policy` | Inspect or restrict the GitHub connector |
| `npm run sandbox-tools-smoke` | Live check of the agent's file tools and policies on a scratch repo in a real sprite (SIL-532) |
| `npm run workspace-smoke -- owner/repo` | Live job-workspace check: provision, prove isolation, run the repo's tests, delete (SIL-530) |

## Architecture

```text
 Browser (operator token) ── Next.js app + in-process job runner ── SQLite (/data)
                                    │
           ┌────────────────────────┼─────────────────────────┐
           ▼                        ▼                         ▼
   Model API (Claude or     Job sprite (one per job)    Gateway sprite (trusted)
   OpenAI): plan, edit,     clone pinned SHA, npm ci,   curl → Sprites connector
   review                   edit, run checks, diff      → GitHub API (read, and
                            no credentials; egress      write after approval)
                            only github.com + npm
                                    └──────── approved bundle ───────┘
                                                     ▼
                                            Draft PR on GitHub
```

The job sprite runs untrusted code and has no way to reach GitHub's write
API. The gateway sprite never runs repository code. The approval, the diff
hash and the published bundle all live server-side.

## Demo

[docs/demo.md](docs/demo.md) has the three-minute script, rehearsal steps
and fallbacks. [docs/demo/walkthrough.mp4](docs/demo/walkthrough.mp4) is a
54-second recording of real screens from the run that opened
[silentworks/shipfig-demo#3](https://github.com/silentworks/shipfig-demo/pull/3).

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
- `lib/publish/*` and `lib/github/publish.ts`: publishing, only after a human
  approves the exact diff (`POST /api/jobs/:id/publish` with the diff hash;
  the server refuses a mismatched hash or failed checks, and needs an explicit
  acknowledgement for an unverified change). At verification, right after
  recording the diff hash, Shipfig freezes the exact change into a bundle
  (contents, modes, git blob ids, re-checked against that hash), so
  publishing never depends on the job sprite still being reachable. A change
  that cannot be published (protected files, symlinks, oversized files) fails
  there, before anyone is asked to approve it. Publishing then creates blobs, a
  tree on the pinned base commit, a commit, the `shipfig/issue-<n>-<job>`
  branch and a draft PR through the trusted gateway sprite, using the Git
  database API (the connector does not authorize `git push`). GitHub's blob
  ids must match the hashes computed in the sprite. Retries reuse an existing
  identical branch and the existing PR, so nothing is duplicated, and a failed
  publish can be retried from the saved bundle.
  Nothing is force-pushed, deleted or merged. The PR body lists the issue
  link, summary, changed files, the exact commands with exit codes and output
  tails, missing checks and risks. Issue and model text is rendered inert
  (no @-mentions, HTML or cross-repo references).
- `lib/jobs/runner.ts`: drives a job through its automated states
  (queued → provisioning → planning …) until it needs a human, and deletes the
  sprite once the job ends.
- `lib/jobs/*`: durable SQLite job store and guarded state machine. It enforces
  one active job, bounded repairs and retries, per-state timeouts, and
  redacted events and evidence.
- `app/api/*`: route handlers for repos, issues and jobs.
- `app/page.tsx`: repo and issue picker, with a banner linking to the active
  job. `app/jobs/[id]`: the job dashboard: a step timeline built from recorded
  transitions (real timestamps and durations), live sprite status, plan and
  publish approvals, the checks Shipfig ran (with baseline), the model
  review, a terminal-style event log (filterable; everything was redacted
  when recorded) and the exact diff with its sha256. It polls every 2s while
  Shipfig works, every 6s while it waits for you, and not in a hidden tab.
  `app/jobs`: job history, including failed and canceled jobs.

Every guardrail (access control, path and write policy, redaction, limits,
failure handling and restart recovery) is listed with its file and tests in
[docs/guardrails.md](docs/guardrails.md).

Treat issue text and repository content as untrusted. They are rendered only
as plain text, and every owner, repo, issue number, path and branch value is
validated before use (`lib/validation.ts`).

## Deploy to Fly.io

Shipfig runs as a single always-on machine: the job runner is in-process
and jobs live in SQLite on a volume. `Dockerfile` builds the Next.js
standalone server, and `fly.toml` holds the configuration.

```bash
fly auth login
fly apps create <app-name>                  # then set `app` (and `primary_region`) in fly.toml
fly volumes create shipfig_data --region <region> --size 1 -a <app-name>
fly secrets set -a <app-name> \
  SPRITES_TOKEN=... \
  SHIPFIG_GITHUB_CONNECTION_ID=... \
  ANTHROPIC_API_KEY=... \
  SHIPFIG_OPERATOR_TOKEN=$(openssl rand -hex 24)
fly deploy -a <app-name> --ha=false         # exactly one machine
```

- Set secret values bare. A value copied from `.env.local` with its quotes
  keeps the quotes and fails authentication.
- Non-secret settings (`SHIPFIG_AGENT_PROVIDER`, `SHIPFIG_ALLOWED_REPOS`,
  `SHIPFIG_GATEWAY_SPRITE`) are in `fly.toml` `[env]`.
- Open `https://<app-name>.fly.dev`. The browser asks for credentials: any
  username, with the operator token as the password. Without
  `SHIPFIG_OPERATOR_TOKEN`, a production server refuses every request.
- The deployed app uses the same connector and gateway sprite as local
  development. Restart recovery only cleans up sprites of its own jobs, so
  both can share one Sprites account.
- Check the image locally first:

  ```bash
  docker build -t shipfig .
  docker run --rm -p 3000:3000 --env-file <unquoted env file> \
    -e SHIPFIG_OPERATOR_TOKEN=<16+ chars> -v "$PWD/.data:/data" shipfig
  ```

## Known limitations

- **One job at a time, one operator.** There are no user accounts, and
  approvals are recorded as "local operator". The operator token is a single
  shared secret.
- **Single instance.** The runner is in-process and the database is SQLite,
  so you can't scale out. Restart recovery resumes safe stages and stops jobs
  that were mid-edit.
- **npm projects in public repositories only.** Job sprites clone
  anonymously, and only `test`, `lint`, `typecheck` and `build` npm scripts
  can be run as checks. There is no yarn, pnpm or bun.
- **Small, well-specified issues.** The agent is limited in turns, tokens,
  files and write size. Large refactors, dependency upgrades and changes to
  CI, deployment or lockfiles are refused by design.
- **Regular files only.** The PR description is written once and is not
  updated after publishing. Symlinks, submodules and files over 1 MB can't be
  published.
- **The model review can only block.** Correctness still rests on the
  repository's own tests. A change can be "verified" against weak tests.

## Next commercial steps

1. **Accounts and teams.** Add GitHub OAuth sign-in, per-user approvals in
   the audit trail, and roles for who can approve publishing.
2. **Private repositories.** Clone through a short-lived, read-only token
   that is scoped to one job and never stored in the sprite image.
3. **Queue and workers.** Move to a durable queue and Postgres, run several
   jobs at once, and keep sprites warm per repository for faster starts.
4. **Triggers.** Start from GitHub labels or comments (`/shipfig fix`), and
   post the plan back for approval in GitHub itself.
5. **Broader ecosystems.** Add yarn, pnpm and bun, Python and Go projects,
   and custom check commands defined in a repository config file.
6. **Pricing.** Charge per verified PR, with usage limits per organisation.
   Pilot with small SaaS teams on their dependency and maintenance backlog.

