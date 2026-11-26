import { connection } from "next/server";
import { authenticateRequest, deniedResponse, guardAction } from "@/lib/auth";
import { getViewer } from "@/lib/github/connector";
import {
  createUserGitHubRequest,
  disconnectUserGitHubAccount,
  getUserGitHubAccount,
  hasOtherAuthMethod,
} from "@/lib/github/user-client";
import { clearUserSelectedRepos } from "@/lib/github/user-repos";
import { manageOnGitHubUrl } from "@/app/api/github/repositories/route";
import { errorResponse, jsonError } from "@/lib/http";
import { GatewayError } from "@/lib/sprites/gateway";

export interface GitHubConnectionStatus {
  mode: "user" | "operator";
  oauthConfigured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  canDisconnect: boolean;
  manageOnGitHubUrl: string;
  github: {
    login: string;
    url: string;
    scope: string | null;
  } | null;
}

/** Report the signed-in user's GitHub connection status without ever exposing tokens. */
export async function GET(request: Request) {
  await connection();
  const authResult = await authenticateRequest(request.headers);
  if (!authResult.ok) return deniedResponse(authResult);

  const oauthConfigured = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  const manageUrl = manageOnGitHubUrl();
  const identity = authResult.identity ?? { kind: "operator" as const, name: "operator" };

  if (identity.kind === "operator" || !identity.userId) {
    const status: GitHubConnectionStatus = {
      mode: "operator",
      oauthConfigured,
      connected: true,
      needsReconnect: false,
      canDisconnect: false,
      manageOnGitHubUrl: manageUrl,
      github: null,
    };
    return Response.json(status);
  }

  try {
    const [linked, canDisconnect] = await Promise.all([
      getUserGitHubAccount(identity.userId),
      hasOtherAuthMethod(identity.userId),
    ]);

    if (!linked?.accessToken) {
      const status: GitHubConnectionStatus = {
        mode: "user",
        oauthConfigured,
        connected: false,
        needsReconnect: false,
        canDisconnect: false,
        manageOnGitHubUrl: manageUrl,
        github: null,
      };
      return Response.json(status);
    }

    try {
      const viewer = await getViewer(createUserGitHubRequest(linked.accessToken));
      const status: GitHubConnectionStatus = {
        mode: "user",
        oauthConfigured,
        connected: true,
        needsReconnect: false,
        canDisconnect,
        manageOnGitHubUrl: manageUrl,
        github: { login: viewer.login, url: viewer.url, scope: linked.scope },
      };
      return Response.json(status);
    } catch (error) {
      if (error instanceof GatewayError && error.kind === "unauthorized") {
        const status: GitHubConnectionStatus = {
          mode: "user",
          oauthConfigured,
          connected: false,
          needsReconnect: true,
          canDisconnect,
          manageOnGitHubUrl: manageUrl,
          github: null,
        };
        return Response.json(status);
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}

/** Disconnect the signed-in user's linked GitHub account. */
export async function DELETE(request: Request) {
  const guard = await guardAction(request);
  if (!guard.ok) return guard.response;

  if (guard.identity.kind !== "user" || !guard.identity.userId) {
    return jsonError(400, "invalid_input", "Only user accounts can disconnect a linked GitHub account");
  }

  try {
    const otherAuth = await hasOtherAuthMethod(guard.identity.userId);
    if (!otherAuth) {
      return jsonError(
        409,
        "cannot_disconnect",
        "GitHub is your only sign-in method. Keep it connected so you do not lose access to your account.",
      );
    }
    const disconnected = await disconnectUserGitHubAccount(guard.identity.userId);
    await clearUserSelectedRepos(guard.identity.userId);
    return Response.json({ disconnected });
  } catch (error) {
    return errorResponse(error);
  }
}
