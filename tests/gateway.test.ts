import { describe, expect, it } from "vitest";
import { GatewayError, assertAllowedGitHubRoute, buildCurlArgs, parseCurlOutput } from "@/lib/sprites/gateway";
import { recommendedGitHubPolicy } from "@/lib/sprites/connections";

describe("assertAllowedGitHubRoute", () => {
  it.each([
    ["GET", "/user"],
    ["GET", "/user/repos"],
    ["GET", "/repos/acme/web"],
    ["GET", "/repos/acme/web/issues"],
    ["GET", "/repos/acme/web/issues/42"],
    ["POST", "/repos/acme/web/git/blobs"],
    ["POST", "/repos/acme/web/pulls"],
  ] as const)("allows %s %s", (method, path) => {
    expect(() => assertAllowedGitHubRoute(method, path)).not.toThrow();
  });

  it.each([
    ["GET", "/repos/acme/web/hooks"],
    ["POST", "/repos/acme/web/issues/42"],
    ["PATCH", "/repos/acme/web"],
    ["GET", "/repos/acme/../web/issues"],
    ["GET", "/repos/acme/web/issues/42?x=1"],
    ["GET", "/repos/acme/web/issues/abc"],
    ["GET", "/repos/acme/%2e%2e/issues"],
    ["GET", "repos/acme/web"],
    ["GET", "/repos/acme/web/issues/42 --output /etc/passwd"],
  ] as const)("rejects %s %s", (method, path) => {
    expect(() => assertAllowedGitHubRoute(method, path)).toThrow();
  });
});

describe("buildCurlArgs", () => {
  it("terminates options before the URL and passes bodies by file", () => {
    const args = buildCurlArgs({
      method: "POST",
      url: "https://api.sprites.dev/v1/gateway/github/conn_x/repos/a/b/pulls",
      bodyFile: "/tmp/body.json",
      timeoutSeconds: 30,
    });
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("https://api.sprites.dev/v1/gateway/github/conn_x/repos/a/b/pulls");
    expect(args).toContain("@/tmp/body.json");
    expect(args).not.toContain("Authorization");
    expect(args.join(" ")).not.toMatch(/authorization/i);
  });
});

describe("parseCurlOutput", () => {
  it("splits body and status", () => {
    expect(parseCurlOutput('{"a":1}\n__SHIPFIG_HTTP_STATUS__:200')).toEqual({ status: 200, text: '{"a":1}' });
  });

  it("uses the last marker even if the body contains one", () => {
    const out = 'x\n__SHIPFIG_HTTP_STATUS__:999 inside\n__SHIPFIG_HTTP_STATUS__:404';
    expect(parseCurlOutput(out).status).toBe(404);
  });

  it("rejects output without a status", () => {
    expect(() => parseCurlOutput("{}")).toThrow(GatewayError);
  });
});

describe("recommendedGitHubPolicy", () => {
  it("is deny-by-default and scoped to the gateway sprite", () => {
    const policy = recommendedGitHubPolicy("shipfig-gateway");
    expect(policy.allow_all).toBe(false);
    expect(policy.name_prefix).toBe("shipfig-gateway");
    expect(policy.sprite_labels).toEqual(["shipfig-gateway"]);
    expect(policy.allowed_endpoints).not.toContain("/*");
  });
});
