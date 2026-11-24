# Guardrails

This page lists every safety control in Shipfig in one place, with the file
that enforces it and the test that covers it. If you change a guardrail,
update this page.

## Who can act

| Guardrail | Where | Tests |
| --- | --- | --- |
| **Operator token.** With `SHIPFIG_OPERATOR_TOKEN` set, every page and API request needs it, as HTTP Basic (any username) or a Bearer token. Tokens are compared in constant time and must be at least 16 characters. | `proxy.ts`, `lib/auth.ts` | `tests/guardrails.test.ts` |
| **No unauthenticated production.** With `NODE_ENV=production` and no token, Shipfig answers every request with `503` instead of serving. | `lib/auth.ts` | `tests/guardrails.test.ts` |
| **Deliberate, same-site actions.** Every state-changing request (start a job, plan or publish decision, cancel, retry) needs the `X-Shipfig-Action: 1` header and is refused when it comes from another site or origin. This blocks a web page from driving a local instance on `localhost`. The approval routes check this themselves as well as in the proxy. | `lib/auth.ts`, `app/api/jobs/**/route.ts` | `tests/guardrails.test.ts` |
| **Approvals stored server-side.** Plan approval is bound to the job version the operator saw. Publish approval is bound to the exact diff sha256 that Shipfig recorded. The server refuses failed checks, and an unverified change needs an explicit acknowledgement. | `lib/jobs/store.ts` | `tests/planner.test.ts`, `tests/publish.test.ts` |

## What can be touched

| Guardrail | Where | Tests |
| --- | --- | --- |
| **Validated inputs.** Owner, repo, issue number, branch and path segments are validated before use. | `lib/validation.ts` | `tests/redact-validation-env.test.ts` |
| **Repository allowlist.** Shipfig only works on public, non-archived repositories, and only on the allowlisted ones when `SHIPFIG_ALLOWED_REPOS` is set. | `lib/github/connector.ts` | `tests/selection.test.ts` |
| **Workspace paths.** Paths are resolved with `realpath` inside the checkout, so symlink escapes, `.git` and secret files (`.env`, keys, `.npmrc`) are refused. | `lib/agent/paths.ts` | `tests/planner.test.ts` |
| **Write policy.** Writes are refused for CI, deployment, infrastructure, `package.json`, lockfiles, `.git` and `node_modules`. | `lib/agent/policy.ts` | `tests/executor.test.ts` |
| **No shell for the model.** The model can only run approved npm checks (`test`, `lint`, `typecheck`, `build`) through `run_check`. Every command Shipfig runs is an argv array with a timeout and an output cap. | `lib/agent/executor.ts`, `lib/sprites/sandbox.ts` | `tests/executor.test.ts` |
| **GitHub routes.** The GitHub routes Shipfig may call are allowlisted by method. There is no DELETE, merge or force-update. Publishing writes only to `shipfig/*` branches and never overwrites a branch that holds different content. | `lib/sprites/gateway.ts`, `lib/github/publish.ts` | `tests/gateway.test.ts`, `tests/publish.test.ts` |

## Secrets

| Guardrail | Where | Tests |
| --- | --- | --- |
| **Redaction.** Everything that is logged, stored or shown is redacted: tokens, keys, bearer headers, URL credentials and secret-looking assignments. Failure messages also drop URL query strings. | `lib/redact.ts`, `lib/jobs/errors.ts` | `tests/redact-validation-env.test.ts`, `tests/guardrails.test.ts` |
| **No credentials in the job sprite.** Job sprites get no tokens. Their network is allowlisted to github.com and the npm registry, so the Sprites API and the connector gateway are unreachable. Only the separate gateway sprite can use the GitHub connector. | `lib/sprites/sandbox.ts`, `lib/sprites/gateway.ts` | `npm run workspace-smoke` (live) |
| **No secrets in published changes.** A change that adds a secret (an added line the redactor had to mask) is refused before approval. | `lib/verify/evidence.ts` | `tests/verification.test.ts` |

## Limits

| Limit | Value | Where |
| --- | --- | --- |
| Active jobs | 1, enforced by a unique index | `lib/jobs/db.ts`, `lib/jobs/store.ts` |
| Automated repairs after failed checks | 2 | `lib/jobs/states.ts` |
| Attempts per job | 3 | `lib/jobs/states.ts` |
| Time in each state | 10–15 minutes for automated states, 60 minutes for approvals, 5 minutes for publishing | `lib/jobs/states.ts` |
| Agent turns and tokens per run | Bounded per loop | `lib/agent/loop.ts` |
| Executor writes | 100k characters per file, 15 files, 8 check runs | `lib/agent/executor.ts` |
| Job sprite | 4 GB RAM, 2 CPUs, 3.5 GB memory limit, `no_new_privs` | `lib/sprites/sandbox.ts` |
| Published change | 1 MB per file, 8 MB in total, regular files only | `lib/publish/bundle.ts` |

## Failure and recovery

| Guardrail | Where | Tests |
| --- | --- | --- |
| **Timeouts are failures.** A state that passes its deadline fails with reason `timeout` and an event in the job history. Agent loops stop as soon as their job leaves its state. | `lib/jobs/store.ts`, `lib/jobs/runner.ts` | `tests/jobs.test.ts` |
| **Readable error reasons.** Model API errors are recorded as `agent_error` with the provider, the status and a hint. A lost sprite connection is recorded as `sprite_error`. | `lib/jobs/errors.ts` | `tests/guardrails.test.ts` |
| **Failed jobs keep their evidence.** The plan, diff, check results, review and events stay on the job. A failed job can never move to publishing unless it is a failed publish with an approved, saved bundle. | `lib/jobs/states.ts`, `lib/jobs/store.ts` | `tests/guardrails.test.ts`, `tests/publish.test.ts` |
| **Restart recovery.** On server start, the active job is handled by state: queued, provisioning, planning and publishing resume, because they are safe to repeat; editing and testing fail as `interrupted`, keeping their evidence, and are never continued from a half-changed workspace; human gates are left as they are. Sprites of this instance's finished jobs are deleted. Sprites this instance's database does not know are left alone. | `instrumentation.ts`, `lib/jobs/recovery.ts` | `tests/guardrails.test.ts` |
| **Sprite cleanup.** A job's sprite is deleted when the job ends, and a job sprite settles after its policies are applied before any command runs. | `lib/jobs/runner.ts`, `lib/sprites/sandbox.ts` | `tests/sandbox.test.ts` |
