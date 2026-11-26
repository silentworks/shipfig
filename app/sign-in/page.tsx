import { connection } from "next/server";
import { Suspense } from "react";
import { AuthForm } from "@/app/_components/auth-form";

async function SignInContent() {
  await connection();
  const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  return <AuthForm mode="sign-in" githubEnabled={githubEnabled} />;
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen flex-1 items-center justify-center text-xs text-zinc-500">Loading…</div>}>
      <SignInContent />
    </Suspense>
  );
}
