# Sprites & GitHub Connector integration (SIL-527)

This records how Shipfig talks to Fly.io Sprites and GitHub, what the connector
does and does not allow, and the strategy for clone and publish. Sources:
[Sprites connectors docs](https://docs.fly.io/sprites/concepts/connectors),
[connector API: list](https://docs.fly.io/sprites/api/connectors/list-connectors.md),
[connector API: authorize](https://docs.fly.io/sprites/api/connectors/authorize-an-oauth-connector.md),
[`@fly/sprites` SDK](https://github.com/superfly/sprites-js) v0.2.5.

## Architecture

```
Next.js orchestrator (holds SPRITES_TOKEN only)
  │
  ├── Sprites REST API (SDK)          create/exec/delete sprites, manage connector policy
  │
  ├── gateway sprite "shipfig-gateway" (trusted, label shipfig-gateway)
  │     └── curl → https://api.sprites.dev/v1/gateway/github/<conn_id>/<path>
  │            gateway injects the GitHub OAuth token → api.github.com
  │
  └── job sprites "shipfig-job-<id>" (untrusted code; NO connector access)
        └── anonymous HTTPS clone of the public demo repo
```

Key facts from the docs:

- **The gateway only accepts calls from inside a running Sprite.** It identifies
  the caller from Fly.io's request signature. No `Authorization` header is sent.
  The orchestrator cannot call it directly with `SPRITES_TOKEN`, so every GitHub
  call is a `curl` executed in the gateway sprite (`lib/sprites/gateway.ts`).
- **The raw GitHub token never reaches any sprite.** It stays in Fly.io's control
  plane, encrypted at rest. The spike checks that both sprites' `env` contain no
  GitHub token.
- **Deny by default.** A connector with no access policy refuses every sprite.

## Access policy

Policy fields: `allow_all`, `name_prefix`, `sprite_labels` (all must match),
`allowed_endpoints`, `blocked_endpoints`. Endpoint patterns are exact paths or
trailing-`*` prefixes. Block rules are checked first. **Policies are not
method-scoped.** In the dashboard you can only edit the prefix, labels and
allow-all. Endpoint lists are API-only, which `npm run connector -- apply-policy` handles.

Shipfig applies (`recommendedGitHubPolicy`):

```json
{
  "allow_all": false,
  "name_prefix": "shipfig-gateway",
  "sprite_labels": ["shipfig-gateway"],
  "allowed_endpoints": ["/user", "/user/repos", "/repos/*"]
}
```

`/repos/*` would also allow `DELETE /repos/{o}/{r}` at the gateway level, so
Shipfig adds a second, method-aware allowlist in code
(`assertAllowedGitHubRoute`). That list has GETs for repos, issues, README and
refs, and POSTs only for the git database and draft PR endpoints. It has no
DELETE, merge, hooks, keys, collaborators, secrets or settings. Untrusted code
never runs on the gateway sprite, so the code allowlist cannot be bypassed from
a job.

Job sprites get neither the label nor the name prefix, so the connector denies
them. The spike checks this with a throwaway sprite and expects a 401 or 403.

## OAuth scopes

Scopes are chosen at authorization time with
`GET /v1/oauth/github/authorize?scopes=...` (or added later with `add_scopes`).
The docs give no default set. Shipfig needs:

| Need | Scope |
| --- | --- |
| Read issues and repos (public demo repo) | `public_repo` (or none for reads of public data) |
| Create blobs, trees, commits, refs and draft PRs on a public repo | `public_repo` |
| Private repos (post-MVP) | `repo` |

Recommendation: authorize with `public_repo` only for the MVP.

## Clone strategy

The docs do not describe git transport through the gateway. It is documented
only for HTTP API forwarding. We **do not assume** `git clone` or `git push`
gets gateway credentials. The spike probes `git ls-remote` against the gateway
URL and reports the result.

MVP: job sprites clone the **public** demo repo anonymously over HTTPS
(`https://github.com/<owner>/<repo>.git`). They need no credentials at all.
Private repos stay out of scope.

## Publishing strategy (input to SIL-534)

Use the GitHub **Git database REST API** through the gateway, never `git push`:

1. `GET /repos/{o}/{r}/git/ref/heads/{base}` → base commit SHA
2. `GET /repos/{o}/{r}/git/commits/{sha}` → base tree SHA
3. `POST /repos/{o}/{r}/git/blobs` per changed file (content taken from the
   approved diff, read out of the job sprite by the orchestrator)
4. `POST /repos/{o}/{r}/git/trees` (with `base_tree`)
5. `POST /repos/{o}/{r}/git/commits`
6. `POST /repos/{o}/{r}/git/refs` → `refs/heads/shipfig/issue-<n>-<slug>`
7. `POST /repos/{o}/{r}/pulls` with `draft: true`, body referencing `#<n>`

All of these are under `/repos/*` in the connector policy and in the code
allowlist. **Blocker to verify with a live connector:** the OAuth token must have
`public_repo`, and the authorizing account must have push access to the demo
repo. The spike prints `canPush` for the repo. If `canPush=false` or the POSTs
return 403, the fallback is a fork-based PR or a fine-grained token via an
`api_key` connector, and this is recorded as a blocker.

## Running the spike

```bash
cp .env.example .env.local   # fill SPRITES_TOKEN; add a GitHub connector in the Sprites dashboard
npm run connector -- list    # copy the id (first column) into SHIPFIG_GITHUB_CONNECTION_ID
npm run connector -- apply-policy
npm run spike -- <owner>/<public-repo> <issue-number>
```

The spike prints a PASS, FAIL or INFO line for each of these:

1. env validation and connector metadata
2. sprite creation and command execution from TypeScript
3. a non-gateway sprite being denied by the policy
4. an authenticated issue fetch through the gateway sprite
5. no token in either sprite's environment
6. a git-transport probe
7. cleanup of the throwaway sprite

## Gaps and risks

- **Gateway error bodies.** The docs list 401 for a missing sprite identity, 403
  when no policy admits the sprite, and 403 when an endpoint is not allowed.
  Shipfig maps these to `GatewayError` kinds. GitHub's own 403 and 404 responses
  pass through unchanged.
- **Gateway sprite egress.** Network policy semantics are not yet verified, so
  egress is not locked down. Leave this to SIL-536.
- **Request bodies.** These are written to a temp file in the gateway sprite and
  sent with `--data-binary @file`. This avoids argv size limits (128 KiB per
  argument) and keeps the body out of process listings.
