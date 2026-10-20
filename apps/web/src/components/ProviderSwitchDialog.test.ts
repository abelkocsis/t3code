import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { latestProviderSwitchLink } from "./ProviderSwitchDialog";

const activity = (
  kind: string,
  payload: unknown,
  createdAt: string,
): OrchestrationThreadActivity => ({
  id: EventId.make(`${kind}:${createdAt}`),
  tone: "info",
  kind,
  summary: kind,
  payload,
  turnId: null,
  createdAt,
});

describe("latestProviderSwitchLink", () => {
  it("follows the newest switch when a thread was continued and then continued again", () => {
    expect(
      latestProviderSwitchLink([
        activity(
          "thread.provider-switch.continued-from",
          { threadId: "thread-a", provider: "Claude" },
          "2026-01-01T00:00:00.000Z",
        ),
        activity("tool.completed", { path: "README.md" }, "2026-01-01T00:01:00.000Z"),
        activity(
          "thread.provider-switch.continued-in",
          { threadId: "thread-c", provider: "Claude" },
          "2026-01-01T00:02:00.000Z",
        ),
      ]),
    ).toEqual({ direction: "in", threadId: "thread-c", provider: "Claude" });
  });

  it("ignores a switch row without a thread to open", () => {
    expect(
      latestProviderSwitchLink([
        activity("thread.provider-switch.continued-in", null, "2026-01-01T00:00:00.000Z"),
      ]),
    ).toBeNull();
  });
});
