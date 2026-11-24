import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAction, checkOperator, guardAction, presentedToken } from "@/lib/auth";
import { openDatabase } from "@/lib/jobs/db";
import { classifyStageError, tidyMessage } from "@/lib/jobs/errors";
import { recoverJobs } from "@/lib/jobs/recovery";
import { JobStore } from "@/lib/jobs/store";

const TOKEN = "s3cret-operator-token-123";
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const headers = (h: Record<string, string>) => new Headers(h);
const URL_ = new URL("https://shipfig.example/api/jobs");

describe("operator auth", () => {
  const env = { token: TOKEN, production: true };

  it("accepts the token as Basic (any username) or Bearer, and nothing else", () => {
    expect(checkOperator(headers({ authorization: basic("operator", TOKEN) }), env)).toEqual({ ok: true });
    expect(checkOperator(headers({ authorization: `Bearer ${TOKEN}` }), env)).toEqual({ ok: true });
    expect(checkOperator(headers({ authorization: basic("operator", "wrong") }), env)).toMatchObject({ ok: false, status: 401, challenge: true });
    expect(checkOperator(headers({}), env)).toMatchObject({ ok: false, status: 401 });
    expect(presentedToken("Basic !!!not-base64")).toBeNull();
  });

  it("refuses to serve production without a (long enough) token, and is open only in local development", () => {
    expect(checkOperator(headers({}), { token: undefined, production: true })).toMatchObject({ ok: false, status: 503 });
    expect(checkOperator(headers({ authorization: "Bearer short" }), { token: "short", production: true })).toMatchObject({ ok: false, status: 503 });
    expect(checkOperator(headers({}), { token: undefined, production: false })).toEqual({ ok: true });
  });
});

describe("state-changing requests", () => {
  it("need the action header and must be same-origin", () => {
    expect(checkAction("GET", headers({}), URL_)).toEqual({ ok: true });
    expect(checkAction("POST", headers({}), URL_)).toMatchObject({ ok: false, status: 403 });
    expect(checkAction("POST", headers({ "x-shipfig-action": "1", "sec-fetch-site": "same-origin", origin: "https://shipfig.example" }), URL_)).toEqual({ ok: true });
    // A form or fetch from another site, even with the header.
    expect(checkAction("POST", headers({ "x-shipfig-action": "1", "sec-fetch-site": "cross-site" }), URL_)).toMatchObject({ ok: false, status: 403 });
    expect(checkAction("POST", headers({ "x-shipfig-action": "1", origin: "https://evil.example" }), URL_)).toMatchObject({ ok: false, status: 403 });
    // Behind Fly's proxy the request URL is internal; the forwarded host is what the browser used.
    expect(checkAction("POST", headers({ "x-shipfig-action": "1", origin: "https://shipfig.fly.dev", "x-forwarded-host": "shipfig.fly.dev" }), new URL("http://0.0.0.0:3000/api/jobs"))).toEqual({ ok: true });
  });

  it("route handlers reject unauthorized publication themselves (defence in depth)", async () => {
    vi.stubEnv("SHIPFIG_OPERATOR_TOKEN", TOKEN);
    try {
      const anonymous = guardAction(new Request("https://shipfig.example/api/jobs/abc/publish", { method: "POST", headers: { "x-shipfig-action": "1" } }));
      expect(anonymous?.status).toBe(401);
      expect(anonymous?.headers.get("www-authenticate")).toMatch(/^Basic/);
      const noHeader = guardAction(new Request("https://shipfig.example/api/jobs/abc/publish", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }));
      expect(noHeader?.status).toBe(403);
      expect(guardAction(new Request("https://shipfig.example/api/jobs/abc/publish", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-shipfig-action": "1" } }))).toBeNull();
    } finally {
      vi.unstubAllEnvs();
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
