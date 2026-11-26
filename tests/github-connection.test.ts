import { describe, expect, it, vi } from "vitest";
import { listAllowedRepos } from "@/lib/github/connector";
import {
  type GitHubRequestFn,
  GitHubNotConnectedError,
  createUserGitHubRequest,
  resolveGitHubRequest,
  resolveJobGitHubRequest,
} from "@/lib/github/user-client";
import { combineAllowlists, normalizeRepoSelection } from "@/lib/github/user-repos";
import { errorResponse } from "@/lib/http";
import { openDatabase } from "@/lib/jobs/db";
import { JobStore } from "@/lib/jobs/store";
import { GatewayError } from "@/lib/sprites/gateway";

describe("user GitHub REST client (SIL-543)", () => {
  it("enforces Shipfig's route allowlist and sends proper GitHub headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ login: "octocat", html_url: "https://github.com/octocat" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const gh = createUserGitHubRequest("gho_secret_token_1234567890", { fetchImpl: fetchMock });
    const res = await gh("/user");
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ login: "octocat", html_url: "https://github.com/octocat" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/user");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer gho_secret_token_1234567890");
    expect((init?.headers as Record<string, string>)["X-GitHub-Api-Version"]).toBe("2022-11-28");

    // Disallowed routes (e.g. repo settings, secrets, hooks) are rejected before fetch is called.
    await expect(gh("/repos/octocat/hello/hooks")).rejects.toThrow(GatewayError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 401/403/404/429 to GatewayError and redacts tokens from error messages", async () => {
    const token = "gho_supersecretvalue999";

    const fetch401 = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: `Bad credentials for ${token}` }), { status: 401 }),
    );
    const gh401 = createUserGitHubRequest(token, { fetchImpl: fetch401 });
    await expect(gh401("/user")).rejects.toSatisfy((err: unknown) => {
      return err instanceof GatewayError && err.kind === "unauthorized" && !err.message.includes(token);
    });

    const fetch404 = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    const gh404 = createUserGitHubRequest(token, { fetchImpl: fetch404 });
    await expect(gh404("/repos/octocat/missing")).rejects.toSatisfy(
      (err: unknown) => err instanceof GatewayError && err.kind === "not_found",
    );

    const fetch429 = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 429 }),
    );
    const gh429 = createUserGitHubRequest(token, { fetchImpl: fetch429 });
    await expect(gh429("/user/repos")).rejects.toSatisfy(
      (err: unknown) => err instanceof GatewayError && err.kind === "rate_limited",
    );

    const fetchBoom = vi.fn<typeof fetch>().mockRejectedValue(new Error(`network error with ${token}`));
    const ghBoom = createUserGitHubRequest(token, { fetchImpl: fetchBoom });
    await expect(ghBoom("/user")).rejects.toSatisfy(
      (err: unknown) => err instanceof GatewayError && err.kind === "transport" && !err.message.includes(token),
    );
  });

  it("scopes signed-in users to their linked GitHub account and never falls back to the gateway", async () => {
    const gatewayRequest = vi.fn();
    const createClient = vi.fn().mockReturnValue(vi.fn());

    // Unlinked user → throws GitHubNotConnectedError (HTTP 412).
    await expect(
      resolveGitHubRequest(
        { kind: "user", userId: "user_1", name: "Ada", email: "ada@example.com" },
        { getAccount: async () => null, gatewayRequest, createClient },
      ),
    ).rejects.toThrow(GitHubNotConnectedError);
    expect(gatewayRequest).not.toHaveBeenCalled();

    // Linked user → uses their own token.
    await resolveGitHubRequest(
      { kind: "user", userId: "user_1", name: "Ada", email: "ada@example.com" },
      {
        getAccount: async () => ({ id: "acc_1", accountId: "42", accessToken: "gho_user_tok", scope: "public_repo" }),
        gatewayRequest,
        createClient,
      },
    );
    expect(createClient).toHaveBeenCalledWith("gho_user_tok");
    expect(gatewayRequest).not.toHaveBeenCalled();

    // Headless operator → uses gateway.
    const opClient = await resolveGitHubRequest({ kind: "operator", name: "operator" }, { gatewayRequest, createClient });
    expect(opClient).toBe(gatewayRequest);
  });

  it("resolves background job GitHub client by createdByUserId", async () => {
    const gatewayRequest = vi.fn();
    const userClient = vi.fn();
    const createClient = vi.fn().mockReturnValue(userClient);

    const forOperatorJob = await resolveJobGitHubRequest(null, { gatewayRequest, createClient });
    expect(forOperatorJob).toBe(gatewayRequest);

    const forUserJob = await resolveJobGitHubRequest("user_9", {
      getAccount: async () => ({ id: "acc_9", accountId: "99", accessToken: "gho_9", scope: "public_repo" }),
      gatewayRequest,
      createClient,
    });
    expect(forUserJob).toBe(userClient);

    await expect(
      resolveJobGitHubRequest("user_9", { getAccount: async () => null, gatewayRequest, createClient }),
    ).rejects.toThrow(GitHubNotConnectedError);
  });

  it("maps GitHubNotConnectedError to HTTP 412 github_not_connected", async () => {
    const res = errorResponse(new GitHubNotConnectedError());
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("github_not_connected");
  });

  it("persists createdByUserId on jobs in the SQLite store", () => {
    const store = new JobStore(openDatabase(":memory:"));
    const job = store.create({
      owner: "octocat",
      repo: "hello-world",
      issueNumber: 7,
      issueTitle: "Fix greeting",
      issueUrl: "https://github.com/octocat/hello-world/issues/7",
      createdByUserId: "user_42",
    });
    expect(job.createdByUserId).toBe("user_42");
    expect(store.get(job.id).createdByUserId).toBe("user_42");
  });

  it("normalizes and intersects user repository selections with server allowlists", () => {
    expect(normalizeRepoSelection(["OctoCat/Hello", "octocat/hello", "acme/app"])).toEqual(["acme/app", "octocat/hello"]);
    expect(() => normalizeRepoSelection(["not-a-repo"])).toThrow();

    // Empty user selection keeps server allowlist as-is.
    expect(combineAllowlists(["acme/one", "acme/two"], [])).toEqual(["acme/one", "acme/two"]);
    // Empty server allowlist uses user selection.
    expect(combineAllowlists([], ["acme/one"])).toEqual(["acme/one"]);
    // Both set -> intersection (user can narrow, never widen).
    expect(combineAllowlists(["acme/one", "acme/two"], ["acme/two", "other/evil"])).toEqual(["acme/two"]);
  });

  it("uses GitHub App installations when available and falls back to /user/repos for OAuth tokens", async () => {
    const sampleRepo = (name: string) => ({
      id: 1,
      name,
      full_name: `octocat/${name}`,
      owner: { login: "octocat" },
      private: false,
      archived: false,
      default_branch: "main",
      html_url: `https://github.com/octocat/${name}`,
      clone_url: `https://github.com/octocat/${name}.git`,
      description: null,
      open_issues_count: 1,
    });

    // GitHub App token: /user/installations returns 1 installation with only selected repos.
    const appReq = vi.fn(async (path: string) => {
      if (path === "/user/installations") return { status: 200, data: { installations: [{ id: 77 }] } };
      if (path === "/user/installations/77/repositories") {
        return { status: 200, data: { repositories: [sampleRepo("alpha"), sampleRepo("beta")] } };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const appListing = await listAllowedRepos(appReq as unknown as GitHubRequestFn, {
      userSelectedRepos: ["octocat/beta"],
      useAppInstallations: true,
    });
    expect(appListing.source).toBe("installations");
    expect(appListing.repos.map((r) => r.fullName)).toEqual(["octocat/beta"]);

    // Classic OAuth token: /user/installations returns 403, gracefully falls back to /user/repos.
    const oauthReq = vi.fn(async (path: string) => {
      if (path === "/user/installations") throw new GatewayError("Forbidden", "forbidden", 403);
      if (path === "/user/repos") return { status: 200, data: [sampleRepo("gamma")] };
      throw new Error(`Unexpected path: ${path}`);
    });

    const oauthListing = await listAllowedRepos(oauthReq as unknown as GitHubRequestFn, { useAppInstallations: true });
    expect(oauthListing.source).toBe("oauth");
    expect(oauthListing.repos.map((r) => r.fullName)).toEqual(["octocat/gamma"]);
  });
});
