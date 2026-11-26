"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { GitHubConnectionStatus } from "@/app/api/github/connection/route";
import type { Repo } from "@/lib/github/schemas";
import { fetchJson, useResource } from "./api";
import { GitHubConnectButton } from "./github-connect-button";
import { Button, CollapsiblePanel, ErrorNotice, Loading, Panel, StatusBadge } from "./ui";

interface RepositoriesResponse {
  repos: Repo[];
  excluded: { fullName: string; reason: string }[];
  source: "installations" | "oauth" | "allowlist";
  selected: string[];
  manageOnGitHubUrl: string;
}

export function GitHubSettings() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reconnected = searchParams.get("reconnected") === "1";

  const status = useResource<GitHubConnectionStatus>("/api/github/connection");
  const reposRes = useResource<RepositoriesResponse>(
    status.status === "ok" && status.data.connected ? "/api/github/repositories" : null,
  );

  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [draftSelection, setDraftSelection] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState(false);

  const savedSelection = useMemo(
    () => (reposRes.status === "ok" ? reposRes.data.selected : []),
    [reposRes],
  );
  const activeSelection = draftSelection ?? savedSelection;
  const selectedSet = useMemo(() => new Set(activeSelection.map((s) => s.toLowerCase())), [activeSelection]);

  const isDirty = useMemo(() => {
    if (draftSelection === null) return false;
    if (draftSelection.length !== savedSelection.length) return true;
    const a = [...draftSelection].sort();
    const b = [...savedSelection].sort();
    return a.some((v, i) => v !== b[i]);
  }, [draftSelection, savedSelection]);

  const filteredRepos = useMemo(() => {
    if (reposRes.status !== "ok") return [];
    const q = filter.trim().toLowerCase();
    if (!q) return reposRes.data.repos;
    return reposRes.data.repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [reposRes, filter]);

  function toggleRepo(fullName: string) {
    const slug = fullName.toLowerCase();
    setSavedBanner(false);
    setSaveError(null);
    const next = new Set(selectedSet);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    setDraftSelection(Array.from(next).sort());
  }

  function selectAllVisible() {
    if (reposRes.status !== "ok") return;
    setSavedBanner(false);
    setSaveError(null);
    const next = new Set(selectedSet);
    for (const r of filteredRepos) next.add(r.fullName.toLowerCase());
    setDraftSelection(Array.from(next).sort());
  }

  function clearSelection() {
    setSavedBanner(false);
    setSaveError(null);
    setDraftSelection([]);
  }

  async function saveSelection() {
    setSaving(true);
    setSaveError(null);
    setSavedBanner(false);
    try {
      const { selected } = await fetchJson<{ selected: string[] }>("/api/github/repositories", {
        method: "PUT",
        body: JSON.stringify({ repos: activeSelection }),
      });
      setDraftSelection(null);
      setSavedBanner(true);
      reposRes.reload();
      window.dispatchEvent(new Event("shipfig:repos-changed"));
      router.refresh();
      void selected;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save repository selection.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      await fetchJson("/api/github/connection", { method: "DELETE" });
      setDraftSelection(null);
      status.reload();
      window.dispatchEvent(new Event("shipfig:repos-changed"));
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
          Connect your GitHub account and choose which repositories Shipfig pulls in.
        </p>
      </div>

      {reconnected && (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-900 dark:text-emerald-200"
        >
          GitHub reconnected. Review which repositories Shipfig should pull in below.
        </div>
      )}

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
                    Manage which repositories GitHub shares with the app, or choose a subset below.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={status.data.manageOnGitHubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-7 items-center rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-50 dark:border-zinc-700/80 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
                  >
                    Manage on GitHub ↗
                  </a>
                  {status.data.oauthConfigured && (
                    <GitHubConnectButton
                      callbackURL="/settings?reconnected=1"
                      label="Reconnect"
                      variant="secondary"
                      size="sm"
                    />
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
                    callbackURL="/settings?reconnected=1"
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
          title="Repositories in Shipfig"
          description={
            activeSelection.length > 0
              ? `Only the ${activeSelection.length} selected ${activeSelection.length === 1 ? "repository" : "repositories"} will appear in Shipfig.`
              : "No specific repositories checked — all eligible repositories from your GitHub connection are pulled in."
          }
          actions={
            <div className="flex items-center gap-2">
              {reposRes.status === "ok" && (
                <span className="text-xs text-zinc-400">
                  {reposRes.data.source === "installations" ? "GitHub App" : "GitHub"} · {reposRes.data.repos.length} eligible
                </span>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraftSelection(null);
                  setSavedBanner(false);
                  reposRes.reload();
                }}
              >
                Refresh
              </Button>
            </div>
          }
        >
          {reposRes.status === "loading" && <Loading label="Loading repositories" />}
          {reposRes.status === "error" && <ErrorNotice message={reposRes.error.message} onRetry={reposRes.reload} />}

          {reposRes.status === "ok" && (
            <div className="flex flex-col gap-3">
              {saveError && <ErrorNotice message={saveError} />}
              {savedBanner && (
                <p role="status" className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  Repository selection saved. Your sidebar and Issues list have been updated.
                </p>
              )}

              {reposRes.data.repos.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  No eligible repositories found. Shipfig currently supports public, non-archived repositories. If you installed the GitHub App on specific repositories, click{" "}
                  <a
                    href={reposRes.data.manageOnGitHubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-sky-600 hover:underline dark:text-sky-400"
                  >
                    Manage on GitHub ↗
                  </a>{" "}
                  and then press Refresh.
                </p>
              ) : (
                <>
                  {status.data.mode === "user" && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <input
                        type="search"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter repositories…"
                        aria-label="Filter repositories"
                        className="h-8 w-full max-w-xs rounded-md border border-zinc-200/80 bg-transparent px-2.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:text-zinc-100"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={selectAllVisible}>
                          Select all
                        </Button>
                        {activeSelection.length > 0 && (
                          <Button variant="ghost" size="sm" onClick={clearSelection}>
                            Use all eligible
                          </Button>
                        )}
                        <Button size="sm" onClick={saveSelection} disabled={!isDirty || saving}>
                          {saving ? "Saving…" : "Save selection"}
                        </Button>
                      </div>
                    </div>
                  )}

                  <ul className="max-h-96 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200/80 dark:divide-zinc-900 dark:border-zinc-800/80">
                    {filteredRepos.map((r) => {
                      const slug = r.fullName.toLowerCase();
                      const checked = selectedSet.has(slug);
                      return (
                        <li
                          key={r.fullName}
                          className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-zinc-50/70 dark:hover:bg-zinc-900/50"
                        >
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                            {status.data.mode === "user" && (
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleRepo(r.fullName)}
                                className="h-3.5 w-3.5 rounded border-zinc-300 accent-zinc-900 dark:border-zinc-700 dark:accent-zinc-100"
                              />
                            )}
                            <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{r.fullName}</span>
                          </label>
                          <Link
                            href={`/?repo=${encodeURIComponent(r.fullName)}`}
                            className="shrink-0 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
                          >
                            Issues →
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              {reposRes.data.excluded.length > 0 && (
                <div className="mt-1">
                  <CollapsiblePanel
                    title="Excluded repositories"
                    summary={`${reposRes.data.excluded.length} not eligible`}
                    defaultOpen={false}
                  >
                    <ul className="flex flex-col gap-1.5 text-xs text-zinc-500">
                      {reposRes.data.excluded.map((r) => (
                        <li key={r.fullName} className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-zinc-700 dark:text-zinc-300">{r.fullName}</span>
                          <span>{r.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </CollapsiblePanel>
                </div>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
