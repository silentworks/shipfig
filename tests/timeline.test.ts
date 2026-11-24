import { describe, expect, it } from "vitest";
import type { JobState } from "@/lib/jobs/states";
import type { JobEvent } from "@/lib/jobs/store";
import { formatDuration, jobTimeline } from "@/lib/jobs/timeline";

let id = 0;
function t(from: JobState | null, to: JobState, second: number): JobEvent {
  return { id: ++id, jobId: "j", at: new Date(Date.UTC(2026, 10, 24, 12, 0, second)).toISOString(), kind: "transition", fromState: from, toState: to, message: "", data: null };
}
const status = (state: JobState, events: JobEvent[]) => jobTimeline({ state }, events).map((s) => `${s.key}:${s.status}`);

const toPublish = [
  t(null, "queued", 0),
  t("queued", "provisioning", 1),
  t("provisioning", "planning", 10),
  t("planning", "awaiting_plan_approval", 30),
  t("awaiting_plan_approval", "editing", 40),
  t("editing", "testing", 50),
  t("testing", "editing", 55),
  t("editing", "testing", 58),
  t("testing", "awaiting_publish_approval", 59),
];

describe("jobTimeline", () => {
  it("marks steps from recorded transitions, waiting at a human gate, with real times and repairs", () => {
    const steps = jobTimeline({ state: "awaiting_publish_approval" }, toPublish);
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done", "done", "waiting", "upcoming"]);
    const workspace = steps.find((s) => s.key === "workspace")!;
    expect([workspace.startedAt, workspace.endedAt]).toEqual(["2026-11-24T12:00:01.000Z", "2026-11-24T12:00:10.000Z"]);
    expect(steps.find((s) => s.key === "edit")!.note).toBe("1 repair attempt");
    expect(steps.find((s) => s.key === "publish")!.startedAt).toBeNull();
  });

  it("completes every step once published", () => {
    const events = [...toPublish, t("awaiting_publish_approval", "publishing", 70), t("publishing", "completed", 75)];
    expect(jobTimeline({ state: "completed" }, events).every((s) => s.status === "done")).toBe(true);
  });

  it("shows where a job failed or was canceled", () => {
    expect(status("failed", [t(null, "queued", 0), t("queued", "provisioning", 1), t("provisioning", "failed", 5)])).toEqual([
      "queued:done",
      "workspace:failed",
      "plan:upcoming",
      "plan_approval:upcoming",
      "edit:upcoming",
      "checks:upcoming",
      "publish_approval:upcoming",
      "publish:upcoming",
    ]);
    const canceled = jobTimeline({ state: "canceled" }, [...toPublish.slice(0, 4), t("awaiting_plan_approval", "canceled", 35)]);
    expect(canceled.find((s) => s.key === "plan_approval")).toMatchObject({ status: "canceled", endedAt: "2026-11-24T12:00:35.000Z" });
  });

  it("restarts the timeline for a retry and resumes at publishing for a publish retry", () => {
    const retried = [t(null, "queued", 0), t("queued", "provisioning", 1), t("provisioning", "failed", 2), t("failed", "queued", 20), t("queued", "provisioning", 21)];
    expect(status("provisioning", retried).slice(0, 2)).toEqual(["queued:done", "workspace:current"]);
    expect(jobTimeline({ state: "provisioning" }, retried)[1].startedAt).toBe("2026-11-24T12:00:21.000Z");

    const resumed = [...toPublish, t("awaiting_publish_approval", "publishing", 60), t("publishing", "failed", 61), t("failed", "publishing", 90)];
    expect(status("publishing", resumed).slice(-2)).toEqual(["publish_approval:done", "publish:current"]);
  });

  it("formats durations", () => {
    expect([formatDuration(450), formatDuration(9_400), formatDuration(125_000), formatDuration(3_725_000)]).toEqual(["450ms", "9s", "2m 5s", "1h 2m"]);
  });
});
