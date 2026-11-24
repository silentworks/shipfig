import { describe, expect, it } from "vitest";
import { EnvError, parseServerEnv } from "@/lib/env";
import { redact, truncate } from "@/lib/redact";
import { branchNameSchema, issueNumberSchema, parseRepoSlug, pathSegment, repoRefSchema, spriteNameSchema } from "@/lib/validation";

describe("redact", () => {
  it.each([
    "ghp_" + "a".repeat(36),
    "gho_" + "B".repeat(36),
    "github_pat_" + "c".repeat(40),
    "sk-proj-" + "d".repeat(40),
    "Bearer " + "e".repeat(40),
  ])("removes %s", (secret) => {
    const out = redact(`token is ${secret} ok`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts credentials in URLs but keeps the host", () => {
    expect(redact("cloning https://x-access-token:abcd1234@github.com/a/b")).toBe("cloning https://[REDACTED]@github.com/a/b");
  });

  it("redacts secret-looking env assignments", () => {
    expect(redact("SPRITES_TOKEN=abc123xyz")).toBe("SPRITES_TOKEN=[REDACTED]");
    expect(redact('GITHUB_TOKEN: "abc123xyz"')).toBe("GITHUB_TOKEN: [REDACTED]");
  });

  it("redacts explicit secrets", () => {
    expect(redact("value=supersecretvalue", ["supersecretvalue"])).toBe("value=[REDACTED]");
  });

  it("leaves normal text alone", () => {
    expect(redact("npm test exited with code 0")).toBe("npm test exited with code 0");
  });

  it("truncates long output", () => {
    const out = truncate("x".repeat(1000), 200);
    expect(out.length).toBeLessThan(260);
    expect(out).toContain("truncated");
  });
});

describe("validation", () => {
  it("accepts valid repos and rejects injection attempts", () => {
    expect(parseRepoSlug("vercel/next.js")).toEqual({ owner: "vercel", repo: "next.js" });
    for (const bad of ["a/..", "-a/b", "a/b c", "a/b;rm", "a/b/c", "a", "a/b.git", "a--/b"]) {
      expect(() => parseRepoSlug(bad), bad).toThrow();
    }
    expect(repoRefSchema.safeParse({ owner: "a".repeat(40), repo: "b" }).success).toBe(false);
  });

  it("validates issue numbers", () => {
    expect(issueNumberSchema.parse("12")).toBe(12);
    for (const bad of ["0", "-1", "1.5", "abc", "1e40"]) expect(issueNumberSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("validates branch names", () => {
    expect(branchNameSchema.safeParse("shipfig/issue-12-fix").success).toBe(true);
    for (const bad of ["-x", "a..b", "a/", "a.lock", "a b", "a@{1}", "--force"]) {
      expect(branchNameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("validates sprite names and path segments", () => {
    expect(spriteNameSchema.safeParse("shipfig-job-abc").success).toBe(true);
    expect(spriteNameSchema.safeParse("Shipfig_Job").success).toBe(false);
    expect(() => pathSegment("..")).toThrow();
    expect(() => pathSegment("a/b")).toThrow();
    expect(pathSegment(42)).toBe("42");
  });
});

describe("parseServerEnv", () => {
  it("fails clearly when required secrets are missing", () => {
    try {
      parseServerEnv({});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const message = (error as Error).message;
      expect(message).toContain("SPRITES_TOKEN");
      expect(message).toContain("SHIPFIG_GITHUB_CONNECTION_ID");
    }
  });

  it("parses a valid configuration", () => {
    const env = parseServerEnv({
      SPRITES_TOKEN: "tok",
      SHIPFIG_GITHUB_CONNECTION_ID: "conn_abc123",
      SHIPFIG_ALLOWED_REPOS: "Acme/Web, acme/api",
    });
    expect(env.SHIPFIG_GATEWAY_SPRITE).toBe("shipfig-gateway");
    expect(env.SPRITES_API_URL).toBe("https://api.sprites.dev");
    expect(env.SHIPFIG_ALLOWED_REPOS).toEqual(["acme/web", "acme/api"]);
  });

  it("rejects malformed allowlist entries", () => {
    expect(() =>
      parseServerEnv({ SPRITES_TOKEN: "t", SHIPFIG_GITHUB_CONNECTION_ID: "conn_a", SHIPFIG_ALLOWED_REPOS: "not-a-repo" }),
    ).toThrow(/SHIPFIG_ALLOWED_REPOS/);
  });
});
