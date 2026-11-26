"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { signIn, signUp } from "@/lib/auth-client";
import { Button, ErrorNotice } from "./ui";
import { LogoMark } from "./logo";

function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function formatAuthError(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case "account_not_linked":
      return "An account with this email already exists. Sign in with your password first, then connect GitHub in Settings.";
    case "access_denied":
      return "GitHub sign-in was canceled.";
    default:
      return `Authentication failed (${code.replace(/_/g, " ")}).`;
  }
}

export function AuthForm({ mode, githubEnabled }: { mode: "sign-in" | "sign-up"; githubEnabled: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));
  const urlError = formatAuthError(searchParams.get("error"));

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visibleError = error ?? urlError;

  const isSignUp = mode === "sign-up";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = isSignUp
        ? await signUp.email({
            name: name.trim(),
            email: email.trim(),
            password,
            callbackURL: nextPath,
          })
        : await signIn.email({
            email: email.trim(),
            password,
            callbackURL: nextPath,
          });

      if (result.error) {
        setError(result.error.message || (isSignUp ? "Could not create account" : "Invalid email or password"));
        return;
      }

      router.push(nextPath);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleGitHub() {
    setError(null);
    setBusy(true);
    try {
      const result = await signIn.social({
        provider: "github",
        callbackURL: nextPath,
        errorCallbackURL: "/sign-in",
      });
      if (result?.error) {
        setError(result.error.message || "GitHub sign-in failed");
        setBusy(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-1 flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200/80 bg-white p-6 shadow-xs dark:border-zinc-800/80 dark:bg-zinc-950">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark className="mb-3 h-10 w-10" />
          <h1 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {isSignUp ? "Create your Shipfig account" : "Sign in to Shipfig"}
          </h1>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {isSignUp
              ? "Approvals and pull requests will be attributed to your account."
              : "Review plans, inspect diffs, and approve draft pull requests."}
          </p>
        </div>

        {visibleError && (
          <div className="mb-4">
            <ErrorNotice message={visibleError} />
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          {isSignUp && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Name</span>
              <input
                type="text"
                name="name"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={busy}
                placeholder="Ada Lovelace"
                className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-600"
              />
            </label>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Email</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              placeholder="you@example.com"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-600"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Password</span>
            <input
              type="password"
              name="password"
              autoComplete={isSignUp ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              placeholder="••••••••"
              className="h-9 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-600"
            />
          </label>

          <Button type="submit" disabled={busy} className="mt-1 h-9 w-full">
            {busy ? (isSignUp ? "Creating account…" : "Signing in…") : isSignUp ? "Create account" : "Sign in"}
          </Button>
        </form>

        {githubEnabled && (
          <>
            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              <span className="text-[11px] uppercase tracking-wider text-zinc-400">or</span>
              <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <Button variant="secondary" onClick={handleGitHub} disabled={busy} className="h-9 w-full">
              Continue with GitHub
            </Button>
          </>
        )}

        <p className="mt-5 text-center text-xs text-zinc-500 dark:text-zinc-400">
          {isSignUp ? (
            <>
              Already have an account?{" "}
              <Link
                href={nextPath !== "/" ? `/sign-in?next=${encodeURIComponent(nextPath)}` : "/sign-in"}
                className="font-medium text-zinc-900 underline underline-offset-2 hover:opacity-80 dark:text-zinc-100"
              >
                Sign in
              </Link>
            </>
          ) : (
            <>
              Need an account?{" "}
              <Link
                href={nextPath !== "/" ? `/sign-up?next=${encodeURIComponent(nextPath)}` : "/sign-up"}
                className="font-medium text-zinc-900 underline underline-offset-2 hover:opacity-80 dark:text-zinc-100"
              >
                Sign up
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
