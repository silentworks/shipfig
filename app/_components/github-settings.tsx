"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GitHubConnectionStatus } from "@/app/api/github/connection/route";
import type { Repo } from "@/lib/github/schemas";
import { fetchJson, useResource } from "./api";
import { GitHubConnectButton } from "./github-connect-button";
import { Button, CollapsiblePanel, ErrorNotice, Loading, Panel, StatusBadge } from "./ui";

interface RepoListing {
  repos: Repo[];
  excluded: { fullName: string; reason: string }[];
}

export function GitHubSettings() {
  const router = useRouter();
  const status = useResource<GitHubConnectionStatus>("/api/github/connection");
  const repos = useResource<RepoListing>(status.status === "ok" && status.data.connected ? "/api/repos" : null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  async function handleDisconnect() {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await fetchJson("/api/github/connection", { method: "DELETE" });
      status.reload();
      router.refresh();
    } catch (e) {
      setDisconnectError(e instanceof Error ? e.message : "Could not disconnect GitHub.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">Settings</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Connect your GitHub account to pull repositories and create Shipfig jobs.
        </p>
      </div>

      <Panel
        title="GitHub account"
        actions={
          status.status === "ok" ? (
            status.data.connected ? (
              <StatusBadge tone="completed">Connected</StatusBadge>
            ) : status.data.needsReconnect ? (
              <StatusBadge tone="waiting">Reconnect needed</StatusBadge>
            ) : (
              <StatusBadge tone="neutral">Not connected</StatusBadge>
            )
          ) : null
        }
      >
        {status.status === "loading" && <Loading label="Checking GitHub connection" />}
        {status.status === "error" && <ErrorNotice message={status.error.message} onRetry={status.reload} />}

        {status.status === "ok" && (
          <div className="flex flex-col gap-4">
            {disconnectError && <ErrorNotice message={disconnectError} />}

            {status.data.mode === "operator" ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Authenticated via operator token. Repository access is provided through the configured Sprites GitHub connector.
              </p>
            ) : status.data.connected && status.data.github ? (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    Connected as{" "}
                    <a
                      href={status.data.github.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-600 hover:underline dark:text-sky-400"
                    >
                      @{status.data.github.login} ↗
                    </a>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    Shipfig pulls public, non-archived repositories from your GitHub account and only opens draft PRs after your approval.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {status.data.oauthConfigured && (
                    <GitHubConnectButton callbackURL="/settings" label="Reconnect" variant="secondary" size="sm" />
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleDisconnect}
                    disabled={disconnecting || !status.data.canDisconnect}
                    title={
                      status.data.canDisconnect
                        ? "Disconnect GitHub from your account"
                        : "GitHub is your only sign-in method and cannot be disconnected"
                    }
                  >
                    {disconnecting ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {status.data.needsReconnect
                    ? "Your GitHub authorization expired or was revoked. Reconnect GitHub to continue pulling repositories and opening draft pull requests."
                    : "Link your GitHub account to pull repositories you have access to and run Shipfig on their open issues."}
                </p>
                {status.data.oauthConfigured ? (
                  <GitHubConnectButton
                    callbackURL="/settings"
                    label={status.data.needsReconnect ? "Reconnect GitHub" : "Connect GitHub"}
                  />
                ) : (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                    GitHub OAuth is not configured on this server yet. Set <code className="font-mono">GITHUB_CLIENT_ID</code> and{" "}
                    <code className="font-mono">GITHUB_CLIENT_SECRET</code> to enable GitHub account linking.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Panel>

      {status.status === "ok" && status.data.connected && (
        <Panel
          title="Available repositories"
          actions={
            repos.status === "ok" ? (
              <span className="text-xs text-zinc-400">{repos.data.repos.length} eligible</span>
            ) : null
          }
        >
          {repos.status === "loading" && <Loading label="Loading repositories" />}
          {repos.status === "error" && <ErrorNotice message={repos.error.message} onRetry={repos.reload} />}
          {repos.status === "ok" && repos.data.repos.length === 0 && (
            <p className="text-sm text-zinc-500">
              No eligible repositories found. Shipfig currently supports public, non-archived repositories.
            </p>
          )}
          {repos.status === "ok" && repos.data.repos.length > 0 && (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {repos.data.repos.map((r) => (
                <li key={r.fullName} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-100">{r.fullName}</span>
                  <Link
                    href={`/?repo=${encodeURIComponent(r.fullName)}`}
                    className="shrink-0 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
                  >
                    Browse issues →
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {repos.status === "ok" && repos.data.excluded.length > 0 && (
            <div className="mt-4">
              <CollapsiblePanel
                title="Excluded repositories"
                summary={`${repos.data.excluded.length} not eligible`}
                defaultOpen={false}
              >
                <ul className="flex flex-col gap-1.5 text-xs text-zinc-500">
                  {repos.data.excluded.map((r) => (
                    <li key={r.fullName} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-zinc-700 dark:text-zinc-300">{r.fullName}</span>
                      <span>{r.reason}</span>
                    </li>
                  ))}
                </ul>
              </CollapsiblePanel>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
