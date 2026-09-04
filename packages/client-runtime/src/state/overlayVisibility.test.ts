// @effect-diagnostics globalDate:off -- Hide choices land on local calendar boundaries.
import { describe, expect, it } from "vite-plus/test";

import {
  isOverlayHiddenNow,
  type OverlayItem,
  resolveOverlayHideChoices,
  resolveOverlayHideUntil,
  resolveOverlayState,
  type OverlayVisibilityInput,
} from "./overlayVisibility.ts";

const NOW = "2026-04-10T12:00:00.000Z";

const ITEM: OverlayItem = {
  environmentId: "env-1",
  threadId: "thread-1",
  threadTitle: "Fix participant reconnect loop",
  projectTitle: "bitsafe-scan",
  phase: "waiting_for_approval",
};

function makeInput(overrides: Partial<OverlayVisibilityInput> = {}): OverlayVisibilityInput {
  return {
    enabled: true,
    hiddenUntil: null,
    now: NOW,
    appFocused: false,
    unseen: [ITEM],
    workingCount: 2,
    showIdlePill: true,
    ...overrides,
  };
}

describe("resolveOverlayState", () => {
  it("lists the unseen threads when there is something to report", () => {
    const state = resolveOverlayState(makeInput());
    expect(state.mode).toBe("full");
    expect(state.items).toEqual([ITEM]);
    expect(state.workingCount).toBe(2);
  });

  it("rests as a pill when nothing is unseen", () => {
    const state = resolveOverlayState(makeInput({ unseen: [] }));
    expect(state.mode).toBe("pill");
    expect(state.workingCount).toBe(2);
  });

  it("stays away entirely when the idle pill is switched off and nothing is unseen", () => {
    const state = resolveOverlayState(makeInput({ unseen: [], showIdlePill: false }));
    expect(state.mode).toBe("hidden");
  });

  it("still reports unseen threads when the idle pill is switched off", () => {
    expect(resolveOverlayState(makeInput({ showIdlePill: false })).mode).toBe("full");
  });

  it("hides while the user looks at T3 Code, however much is waiting", () => {
    expect(resolveOverlayState(makeInput({ appFocused: true })).mode).toBe("hidden");
  });

  it("hides while a temporary hide is in force", () => {
    const state = resolveOverlayState(makeInput({ hiddenUntil: "2026-04-10T13:00:00.000Z" }));
    expect(state.mode).toBe("hidden");
  });

  it("returns once the temporary hide expires", () => {
    const state = resolveOverlayState(makeInput({ hiddenUntil: "2026-04-10T11:00:00.000Z" }));
    expect(state.mode).toBe("full");
  });

  it("hides when the user switched the feature off", () => {
    expect(resolveOverlayState(makeInput({ enabled: false })).mode).toBe("hidden");
  });

  it("carries no content while hidden, so a hidden overlay cannot leak titles", () => {
    const state = resolveOverlayState(makeInput({ enabled: false }));
    expect(state.items).toEqual([]);
    expect(state.workingCount).toBe(0);
  });
});

describe("isOverlayHiddenNow", () => {
  it("treats a corrupt deadline as not hidden rather than hiding for good", () => {
    expect(isOverlayHiddenNow({ hiddenUntil: "not-a-date", now: NOW })).toBe(false);
  });

  it("stops hiding exactly at the deadline", () => {
    expect(isOverlayHiddenNow({ hiddenUntil: NOW, now: NOW })).toBe(false);
  });
});

describe("resolveOverlayHideUntil", () => {
  it("schedules a return one hour out", () => {
    const now = new Date("2026-04-10T12:00:00.000Z");
    expect(resolveOverlayHideUntil("hour", now)).toBe("2026-04-10T13:00:00.000Z");
  });

  it("schedules tomorrow morning on the local calendar", () => {
    const now = new Date(2026, 3, 10, 22, 30);
    const until = resolveOverlayHideUntil("tomorrow", now);
    const parsed = new Date(until!);
    expect(parsed.getDate()).toBe(11);
    expect(parsed.getHours()).toBe(9);
  });

  it("schedules no return for an indefinite hide", () => {
    expect(resolveOverlayHideUntil("indefinitely", new Date(NOW))).toBeNull();
  });
});

describe("resolveOverlayHideChoices", () => {
  it("offers the hour, tomorrow, and indefinite choices in menu order", () => {
    const choices = resolveOverlayHideChoices(new Date(NOW));
    expect(choices.map((choice) => choice.id)).toEqual(["hour", "tomorrow", "indefinitely"]);
  });

  it("labels a clock time for the timed choices only", () => {
    const choices = resolveOverlayHideChoices(new Date(NOW));
    expect(choices[0]?.whenLabel).not.toBeNull();
    expect(choices[2]?.whenLabel).toBeNull();
  });
});
