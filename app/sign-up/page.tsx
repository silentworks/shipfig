import { connection } from "next/server";
import { Suspense } from "react";
import { AuthForm } from "@/app/_components/auth-form";

async function SignUpContent() {
  await connection();
  const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  return <AuthForm mode="sign-up" githubEnabled={githubEnabled} />;
}

export default function SignUpPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen flex-1 items-center justify-center text-xs text-zinc-500">Loading…</div>}>
      <SignUpContent />
    </Suspense>
  );
}
