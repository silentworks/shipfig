import { Suspense } from "react";
import { IssuePicker } from "@/app/_components/issue-picker";
import { Loading } from "@/app/_components/ui";

export default function Home() {
  return (
    <>
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Pick an issue</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Shipfig plans a fix, runs it in an isolated Sprite, verifies it, and opens a draft PR only after you approve.
        </p>
      </div>
      <Suspense fallback={<Loading label="Loading" />}>
        <IssuePicker />
      </Suspense>
    </>
  );
}
