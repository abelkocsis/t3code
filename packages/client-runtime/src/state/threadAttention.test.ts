import { describe, expect, it } from "vite-plus/test";

import {
  type AttentionThreadInput,
  isThreadAttentionDismissed,
  isThreadAttentionUnseen,
  resolveThreadAttention,
} from "./threadAttention.ts";

const NOW = Date.parse("2026-04-10T12:00:00.000Z");
const EARLIER = "2026-04-10T11:00:00.000Z";
const LATER = "2026-04-10T11:30:00.000Z";

function makeThread(overrides: Partial<AttentionThreadInput> = {}): AttentionThreadInput {
  return {
    status: "ready",
    latestRun: { status: "completed", completedAt: LATER },
    updatedAt: LATER,
    settledOverride: null,
    snoozedUntil: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("resolveThreadAttention", () => {
  it("stamps a finished run with its completion time", () => {
    expect(resolveThreadAttention(makeThread(), NOW)).toEqual({ phase: "completed", at: LATER });
  });

  it("maps the blocking statuses onto their phases, stamped by the thread's own clock", () => {
    expect(resolveThreadAttention(makeThread({ status: "approval" }), NOW)).toEqual({
      phase: "waiting_for_approval",
      at: LATER,
    });
    expect(resolveThreadAttention(makeThread({ status: "input" }), NOW)).toEqual({
      phase: "waiting_for_input",
      at: LATER,
    });
  });

  it("reads a usage limit as a failure", () => {
    expect(
      resolveThreadAttention(
        makeThread({ status: "limited", latestRun: { status: "failed", completedAt: EARLIER } }),
        NOW,
      ),
    ).toEqual({ phase: "failed", at: EARLIER });
  });

  it("asks nothing while the agent works or waits on another thread", () => {
    expect(resolveThreadAttention(makeThread({ status: "working" }), NOW)).toBeNull();
    expect(resolveThreadAttention(makeThread({ status: "waiting" }), NOW)).toBeNull();
  });

  it("asks nothing of a thread with no finished run", () => {
    expect(resolveThreadAttention(makeThread({ latestRun: null }), NOW)).toBeNull();
    expect(
      resolveThreadAttention(
        makeThread({ latestRun: { status: "interrupted", completedAt: LATER } }),
        NOW,
      ),
    ).toBeNull();
  });

  it("never asks for a settled, snoozed, or archived thread", () => {
    expect(resolveThreadAttention(makeThread({ settledOverride: "settled" }), NOW)).toBeNull();
    expect(
      resolveThreadAttention(makeThread({ snoozedUntil: "2026-04-11T09:00:00.000Z" }), NOW),
    ).toBeNull();
    expect(resolveThreadAttention(makeThread({ archivedAt: EARLIER }), NOW)).toBeNull();
  });

  it("asks again once a snooze has passed", () => {
    expect(resolveThreadAttention(makeThread({ snoozedUntil: EARLIER }), NOW)).not.toBeNull();
  });
});

describe("isThreadAttentionUnseen", () => {
  const completed = { phase: "completed" as const, at: LATER };

  it("is unseen when the phase arrived after the last visit", () => {
    expect(isThreadAttentionUnseen({ attention: completed, lastVisitedAt: EARLIER })).toBe(true);
  });

  it("is seen once the user has visited since", () => {
    expect(isThreadAttentionUnseen({ attention: completed, lastVisitedAt: LATER })).toBe(false);
  });

  it("treats a finished run on a never-visited thread as seen, like the sidebar", () => {
    expect(isThreadAttentionUnseen({ attention: completed, lastVisitedAt: null })).toBe(false);
    expect(isThreadAttentionUnseen({ attention: completed, lastVisitedAt: undefined })).toBe(false);
  });

  it("still raises a question or failure on a never-visited thread", () => {
    expect(
      isThreadAttentionUnseen({
        attention: { phase: "waiting_for_input", at: LATER },
        lastVisitedAt: null,
      }),
    ).toBe(true);
    expect(
      isThreadAttentionUnseen({ attention: { phase: "failed", at: LATER }, lastVisitedAt: null }),
    ).toBe(true);
  });
});

describe("isThreadAttentionDismissed", () => {
  it("hides the phase the dismissal stamped", () => {
    expect(
      isThreadAttentionDismissed({
        attention: { phase: "completed", at: LATER },
        dismissedAt: LATER,
      }),
    ).toBe(true);
  });

  it("raises the row again for newer work", () => {
    expect(
      isThreadAttentionDismissed({
        attention: { phase: "completed", at: LATER },
        dismissedAt: EARLIER,
      }),
    ).toBe(false);
  });

  it("is not dismissed without a stamp", () => {
    expect(
      isThreadAttentionDismissed({
        attention: { phase: "completed", at: LATER },
        dismissedAt: null,
      }),
    ).toBe(false);
  });
});
