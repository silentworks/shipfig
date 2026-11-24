import { Suspense } from "react";
import { JobStatus } from "@/app/_components/job-status";
import { Loading } from "@/app/_components/ui";

export default function JobPage({ params }: PageProps<"/jobs/[id]">) {
  return (
    <Suspense fallback={<Loading label="Loading job" />}>
      {params.then(({ id }) => (
        <JobStatus id={id} />
      ))}
    </Suspense>
  );
}
