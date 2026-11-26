import { Suspense } from "react";
import { AuthForm } from "@/app/_components/auth-form";

export default function SignInPage() {
  const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  return (
    <Suspense fallback={<div className="flex min-h-screen flex-1 items-center justify-center text-xs text-zinc-500">Loading…</div>}>
      <AuthForm mode="sign-in" githubEnabled={githubEnabled} />
    </Suspense>
  );
}
