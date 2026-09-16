import { ProviderDriverKind, type UsageLimitsReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SCHEDULE_FALLBACK_DELAY_MS,
  defaultScheduleDueAt,
  fromDateTimeLocalValue,
  nextUsageLimitResetAt,
  toDateTimeLocalValue,
} from "./composerScheduleTime";

const NOW = Date.parse("2026-09-15T10:00:00.000Z");

function report(
  windows: ReadonlyArray<{ id: string; kind: "session" | "weekly"; resetsAt?: string }>,
): UsageLimitsReport {
  return {
    createdAt: new Date(NOW).toISOString(),
    accounts: [
      {
        id: "claude",
        driver: ProviderDriverKind.make("claude"),
        label: "Claude",
        limits: {
          checkedAt: new Date(NOW).toISOString(),
          windows: windows.map((window) => ({
            id: window.id,
            kind: window.kind,
            label: window.id,
            usedPercent: 100,
            ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
          })),
        },
      },
    ],
    notices: [],
  };
}

describe("nextUsageLimitResetAt", () => {
  it("prefers the soonest session window", () => {
    const result = nextUsageLimitResetAt(
      report([
        { id: "seven_day", kind: "weekly", resetsAt: "2026-09-15T11:00:00.000Z" },
        { id: "five_hour", kind: "session", resetsAt: "2026-09-15T13:00:00.000Z" },
      ]),
      NOW,
    );
    expect(result).toBe("2026-09-15T13:00:00.000Z");
  });

  it("falls back to a longer window when no session window reports a reset", () => {
    const result = nextUsageLimitResetAt(
      report([{ id: "seven_day", kind: "weekly", resetsAt: "2026-09-18T11:00:00.000Z" }]),
      NOW,
    );
    expect(result).toBe("2026-09-18T11:00:00.000Z");
  });

  it("ignores resets that have already passed", () => {
    const result = nextUsageLimitResetAt(
      report([{ id: "five_hour", kind: "session", resetsAt: "2026-09-15T09:00:00.000Z" }]),
      NOW,
    );
    expect(result).toBeNull();
  });
});

describe("defaultScheduleDueAt", () => {
  it("uses the quota reset when one is known", () => {
    const result = defaultScheduleDueAt(
      report([{ id: "five_hour", kind: "session", resetsAt: "2026-09-15T13:00:00.000Z" }]),
      NOW,
    );
    expect(result).toBe("2026-09-15T13:00:00.000Z");
  });

  it("hops ahead when no reset is known", () => {
    expect(defaultScheduleDueAt(null, NOW)).toBe(
      new Date(NOW + SCHEDULE_FALLBACK_DELAY_MS).toISOString(),
    );
  });
});

describe("datetime-local conversion", () => {
  it("round-trips a future local time", () => {
    const iso = new Date(NOW + 3 * 60 * 60 * 1_000).toISOString();
    expect(fromDateTimeLocalValue(toDateTimeLocalValue(iso), NOW)).toBe(
      new Date(Math.floor((NOW + 3 * 60 * 60 * 1_000) / 60_000) * 60_000).toISOString(),
    );
  });

  it("rejects a time that is not in the future", () => {
    expect(
      fromDateTimeLocalValue(toDateTimeLocalValue(new Date(NOW).toISOString()), NOW),
    ).toBeNull();
    expect(fromDateTimeLocalValue("", NOW)).toBeNull();
    expect(fromDateTimeLocalValue("not-a-time", NOW)).toBeNull();
  });
});
