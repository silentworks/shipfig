import { Suspense } from "react";
import { IssuePicker } from "@/app/_components/issue-picker";
import { Loading } from "@/app/_components/ui";

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="p-6">
          <Loading label="Loading issues" />
        </div>
      }
    >
      <IssuePicker />
    </Suspense>
  );
}
