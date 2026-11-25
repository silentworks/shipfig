import { Suspense } from "react";
import { GitHubSettings } from "@/app/_components/github-settings";
import { Loading } from "@/app/_components/ui";

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          <Loading label="Loading settings" />
        </div>
      }
    >
      <GitHubSettings />
    </Suspense>
  );
}
