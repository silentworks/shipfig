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
npm run connector -- list           # copy the conn_... id into SHIPFIG_GITHUB_CONNECTION_ID
npm run connector -- apply-policy   # restrict the connector to the gateway sprite
npm run spike -- <owner>/<repo> <issue-number>   # verify Sprites + connector end to end
npm run dev                         # http://localhost:3000
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `SPRITES_TOKEN` | yes | Sprites API token. Server-side only; never sent to any sprite. |
| `SHIPFIG_GITHUB_CONNECTION_ID` | yes | GitHub connector id used in gateway URLs. |
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

## How it fits together

- `lib/sprites/gateway.ts`: GitHub API calls go through the Sprites connector
  gateway, which accepts calls only from inside a sprite. They run as `curl` in
  one trusted gateway sprite, so the GitHub token never reaches any sprite or
  log. See [docs/github-connector.md](docs/github-connector.md).
- `lib/github/connector.ts`: typed repo and issue operations with allowlist and
  eligibility checks (public and non-archived only, for the MVP).
- `lib/jobs/*`: durable SQLite job store and guarded state machine. It enforces
  one active job, bounded repairs and retries, per-state timeouts, and
  redacted events and evidence.
- `app/api/*`: route handlers for repos, issues and jobs.
- `app/page.tsx`: repo and issue picker. `app/jobs/[id]`: job status.

Treat issue text and repository content as untrusted. They are rendered only
as plain text, and every owner, repo, issue number, path and branch value is
validated before use (`lib/validation.ts`).
