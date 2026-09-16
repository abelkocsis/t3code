import { describe, expect, it } from "@effect/vitest";

import { addDays, standupDayWindow, toStandupDay, zonedDayStartMs } from "./standupDays.ts";

describe("zonedDayStartMs", () => {
  it("resolves midnight in a zone ahead of UTC", () => {
    // Budapest is UTC+2 in September, so the day starts at 22:00 UTC the day before.
    expect(zonedDayStartMs("2026-09-15", "Europe/Budapest")).toBe(
      Date.parse("2026-09-14T22:00:00.000Z"),
    );
  });

  it("resolves midnight in a zone behind UTC", () => {
    expect(zonedDayStartMs("2026-09-15", "America/New_York")).toBe(
      Date.parse("2026-09-15T04:00:00.000Z"),
    );
  });

  it("falls back to UTC for a zone the runtime rejects", () => {
    expect(zonedDayStartMs("2026-09-15", "Not/AZone")).toBe(Date.parse("2026-09-15T00:00:00.000Z"));
  });
});

describe("standupDayWindow", () => {
  it("covers exactly one calendar day", () => {
    const window = standupDayWindow("2026-09-15", "Europe/Budapest");
    expect(window.endMs - window.startMs).toBe(86_400_000);
  });

  it("keeps the day whole across the autumn daylight-saving change", () => {
    // Budapest gains an hour on 2026-10-25, so that local day lasts 25 hours.
    const window = standupDayWindow("2026-10-25", "Europe/Budapest");
    expect(window.endMs - window.startMs).toBe(25 * 3_600_000);
  });

  it("keeps the day whole across the spring daylight-saving change", () => {
    // Budapest loses an hour on 2026-03-29.
    const window = standupDayWindow("2026-03-29", "Europe/Budapest");
    expect(window.endMs - window.startMs).toBe(23 * 3_600_000);
  });
});

describe("toStandupDay", () => {
  it("puts a late-evening instant on the local day, not the UTC day", () => {
    const lateEvening = Date.parse("2026-09-15T22:30:00.000Z");
    expect(toStandupDay(lateEvening, "Europe/Budapest")).toBe("2026-09-16");
    expect(toStandupDay(lateEvening, "UTC")).toBe("2026-09-15");
  });

  it("round-trips the start of a window", () => {
    const window = standupDayWindow("2026-09-15", "Europe/Budapest");
    expect(toStandupDay(window.startMs, "Europe/Budapest")).toBe("2026-09-15");
    expect(toStandupDay(window.endMs - 1, "Europe/Budapest")).toBe("2026-09-15");
  });
});

describe("addDays", () => {
  it("steps forward and back across a month boundary", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
  });
});
