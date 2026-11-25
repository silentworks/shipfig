import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateRequest,
  checkAction,
  checkOperator,
  formatApprover,
  guardAction,
  presentedToken,
  type SessionLookup,
} from "@/lib/auth";
import { openDatabase } from "@/lib/jobs/db";
import { classifyStageError, tidyMessage } from "@/lib/jobs/errors";
import { recoverJobs } from "@/lib/jobs/recovery";
import { JobStore } from "@/lib/jobs/store";
import { handleProxy } from "@/proxy";

const TOKEN = "s3cret-operator-token-123";
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const headers = (h: Record<string, string>) => new Headers(h);
const URL_ = new URL("https://shipfig.example/api/jobs");

const ALICE = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };
const withSession: SessionLookup = async () => ({ user: ALICE });
const noSession: SessionLookup = async () => null;

describe("authentication (Better Auth session + optional operator token)", () => {
  const env = { token: TOKEN, production: true };

  it("accepts the operator token as Basic (any username) or Bearer, and rejects invalid or short tokens", () => {
    expect(checkOperator(headers({ authorization: basic("operator", TOKEN) }), env)).toMatchObject({
      ok: true,
      identity: { kind: "operator", name: "operator" },
    });
    expect(checkOperator(headers({ authorization: `Bearer ${TOKEN}` }), env)).toMatchObject({
      ok: true,
      identity: { kind: "operator", name: "operator" },
    });
    expect(checkOperator(headers({ authorization: basic("operator", "wrong") }), env)).toMatchObject({
      ok: false,
      status: 401,
      challenge: true,
    });
    expect(checkOperator(headers({}), env)).toMatchObject({ ok: false, status: 401 });
    expect(checkOperator(headers({ authorization: "Bearer short" }), { token: "short", production: true })).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(presentedToken("Basic !!!not-base64")).toBeNull();
  });

  it("authenticates Better Auth sessions and rejects unauthenticated requests", async () => {
    const authed = await authenticateRequest(headers({}), { env: { token: undefined, production: false }, getSession: withSession });
    expect(authed).toEqual({
      ok: true,
      identity: { kind: "user", userId: ALICE.id, name: ALICE.name, email: ALICE.email },
    });

    const unauthed = await authenticateRequest(headers({}), { env: { token: undefined, production: false }, getSession: noSession });
    expect(unauthed).toMatchObject({ ok: false, status: 401, code: "unauthorized" });
  });

  it("redirects unauthenticated page requests to /sign-in and returns 401 for API requests", async () => {
    const pageReq = new NextRequest("https://shipfig.example/jobs/abc123?tab=diff");
    const pageRes = await handleProxy(pageReq, { env: { token: undefined, production: false }, getSession: noSession });
    expect(pageRes.status).toBe(307);
    expect(pageRes.headers.get("location")).toBe("https://shipfig.example/sign-in?next=%2Fjobs%2Fabc123%3Ftab%3Ddiff");

    const apiReq = new NextRequest("https://shipfig.example/api/jobs");
    const apiRes = await handleProxy(apiReq, { env: { token: undefined, production: false }, getSession: noSession });
    expect(apiRes.status).toBe(401);

    // Public endpoints stay open without authentication or action headers.
    const healthRes = await handleProxy(new NextRequest("https://shipfig.example/api/health"), {
      env: { token: undefined, production: true },
      getSession: noSession,
    });
    expect(healthRes.status).toBe(200);

    const authPostRes = await handleProxy(new NextRequest("https://shipfig.example/api/auth/sign-in/email", { method: "POST" }), {
      env: { token: undefined, production: true },
      getSession: noSession,
    });
    expect(authPostRes.status).toBe(200);

    // Signed-in users hitting /sign-in are redirected to /.
    const signedInSignInRes = await handleProxy(new NextRequest("https://shipfig.example/sign-in"), {
      env: { token: undefined, production: false },
      getSession: withSession,
    });
    expect(signedInSignInRes.status).toBe(307);
    expect(signedInSignInRes.headers.get("location")).toBe("https://shipfig.example/");
  });
});

describe("state-changing requests", () => {
  it("need the action header and must be same-origin", () => {
    expect(checkAction("GET", headers({}), URL_)).toEqual({ ok: true });
    expect(checkAction("POST", headers({}), URL_)).toMatchObject({ ok: false, status: 403 });
    expect(
      checkAction("POST", headers({ "x-shipfig-action": "1", "sec-fetch-site": "same-origin", origin: "https://shipfig.example" }), URL_),
    ).toEqual({ ok: true });
    // A form or fetch from another site, even with the header.
    expect(checkAction("POST", headers({ "x-shipfig-action": "1", "sec-fetch-site": "cross-site" }), URL_)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(checkAction("POST", headers({ "x-shipfig-action": "1", origin: "https://evil.example" }), URL_)).toMatchObject({
      ok: false,
      status: 403,
    });
    // Behind Fly's proxy the request URL is internal; the forwarded host is what the browser used.
    expect(
      checkAction(
        "POST",
        headers({ "x-shipfig-action": "1", origin: "https://shipfig.fly.dev", "x-forwarded-host": "shipfig.fly.dev" }),
        new URL("http://0.0.0.0:3000/api/jobs"),
      ),
    ).toEqual({ ok: true });
  });

  it("route handlers reject unauthorized publication and attribute approvals to the signed-in user", async () => {
    const anonymous = await guardAction(
      new Request("https://shipfig.example/api/jobs/abc/publish", { method: "POST", headers: { "x-shipfig-action": "1" } }),
      { env: { token: TOKEN, production: true }, getSession: noSession },
    );
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.response.status).toBe(401);

    const noHeader = await guardAction(
      new Request("https://shipfig.example/api/jobs/abc/publish", { method: "POST" }),
      { env: { token: undefined, production: false }, getSession: withSession },
    );
    expect(noHeader.ok).toBe(false);
    if (!noHeader.ok) expect(noHeader.response.status).toBe(403);

    const allowed = await guardAction(
      new Request("https://shipfig.example/api/jobs/abc/publish", { method: "POST", headers: { "x-shipfig-action": "1" } }),
      { env: { token: undefined, production: false }, getSession: withSession },
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(formatApprover(allowed.identity)).toBe("Ada Lovelace (ada@example.com)");

      // Verify attribution persists on plan and publish approvals in JobStore.
      const store = new JobStore(openDatabase(":memory:"));
      const job = store.create({ owner: "acme", repo: "web", issueNumber: 1, issueTitle: "t", issueUrl: "u" });
      store.transition(job.id, "provisioning");
      store.transition(job.id, "planning");
      const awaitingPlan = store.transition(job.id, "awaiting_plan_approval", {
        patch: { plan: { plan: { summary: "Fix bug", needsClarification: false } } },
      });
      const approvedPlan = store.approvePlan(job.id, awaitingPlan.version, formatApprover(allowed.identity));
      expect(approvedPlan.planApprovedBy).toBe("Ada Lovelace (ada@example.com)");
    }

    const operatorAllowed = await guardAction(
      new Request("https://shipfig.example/api/jobs/abc/publish", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "x-shipfig-action": "1" },
      }),
      { env: { token: TOKEN, production: true }, getSession: noSession },
    );
    expect(operatorAllowed.ok).toBe(true);
    if (operatorAllowed.ok) {
      expect(formatApprover(operatorAllowed.identity)).toBe("operator");
    }
  });
});

describe("failure messages", () => {
  it("classifies model provider errors with a hint", () => {
    const error = new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers());
    expect(classifyStageError(error)).toMatchObject({ reason: "agent_error", message: expect.stringMatching(/^Anthropic API error \(429\).*retry later/) });
  });

  it("classifies lost sprite connections and drops noisy query strings", () => {
    const { reason, message } = classifyStageError(new Error("WebSocket error: TypeError (url: wss://api.sprites.dev/v1/sprites/x/exec?cmd=git&env=CI%3Dtrue)"));
    expect(reason).toBe("sprite_error");
    expect(message).toContain("wss://api.sprites.dev/v1/sprites/x/exec?…");
    expect(message).not.toContain("env=");
  });

  it("redacts and caps everything else", () => {
    expect(tidyMessage("token ghp_" + "a".repeat(36))).toBe("token [REDACTED]");
    expect(tidyMessage("x".repeat(2000)).length).toBe(600);
  });
});

describe("startup recovery", () => {
  let store: JobStore;
  const deps = (sprites: string[] = []) => ({
    store,
    kick: vi.fn(),
    listJobSprites: vi.fn(async () => sprites),
    destroySprite: vi.fn(async () => true),
    log: vi.fn(),
  });
  const create = () => store.create({ owner: "acme", repo: "web", issueNumber: 1, issueTitle: "t", issueUrl: "u" });
  const advance = (id: string, ...states: Parameters<JobStore["transition"]>[1][]) => {
    for (const s of states) store.transition(id, s, s === "editing" ? { patch: { planApprovedAt: new Date().toISOString() } } : {});
  };

  beforeEach(() => {
    store = new JobStore(openDatabase(":memory:"));
  });

  it("resumes safe stages", async () => {
    const job = create();
    advance(job.id, "provisioning", "planning");
    const d = deps();
    const report = await recoverJobs(d);
    expect(report.resumed).toEqual([job.id]);
    expect(d.kick).toHaveBeenCalledWith(job.id);
    expect(store.get(job.id).state).toBe("planning");
  });

  it("stops a job interrupted mid-edit, keeping its evidence, and never resumes it into publishing", async () => {
    const job = create();
    advance(job.id, "provisioning", "planning", "awaiting_plan_approval", "editing");
    const report = await recoverJobs(deps());
    expect(report.interrupted).toEqual([job.id]);
    expect(store.get(job.id)).toMatchObject({ state: "failed", failureReason: "interrupted" });
    expect(() => store.transition(job.id, "publishing")).toThrow(/Only a failed publish/);
  });

  it("leaves human gates alone", async () => {
    const job = create();
    advance(job.id, "provisioning", "planning", "awaiting_plan_approval");
    const report = await recoverJobs(deps());
    expect(report).toEqual({ resumed: [], interrupted: [], deletedSprites: [] });
    expect(store.get(job.id).state).toBe("awaiting_plan_approval");
  });

  it("deletes sprites of this instance's finished jobs only", async () => {
    const done = create();
    store.cancel(done.id);
    const active = create();
    const d = deps([`shipfig-job-${done.id}`, `shipfig-job-${active.id}`, "shipfig-job-0000000000ff", "shipfig-gateway"]);
    const report = await recoverJobs(d);
    expect(report.deletedSprites).toEqual([`shipfig-job-${done.id}`]);
    expect(d.destroySprite).toHaveBeenCalledTimes(1);
  });
});
