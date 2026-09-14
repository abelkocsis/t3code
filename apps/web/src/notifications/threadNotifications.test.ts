import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadNotification,
  NOTIFICATION_QUIET_PERIOD_MS,
  type NotificationSettings,
  type PendingThreadNotifications,
  pendingNotificationKey,
  type PhaseChangeNotificationInput,
  reducePendingThreadNotifications,
  shouldNotifyNow,
  takeDueThreadNotifications,
} from "./threadNotifications.ts";

const SETTINGS: NotificationSettings = {
  desktopNotificationsEnabled: true,
  desktopNotificationTrigger: "unfocused",
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

const THREAD = {
  environmentId: "env-1",
  threadId: "thread-1",
  threadTitle: "Fix participant reconnect loop",
  projectTitle: "bitsafe-scan",
};

describe("shouldNotifyNow", () => {
  it("stays quiet while the app has focus on the default trigger", () => {
    expect(shouldNotifyNow({ settings: SETTINGS, appFocused: true })).toBe(false);
  });

  it("notifies once the app loses focus", () => {
    expect(shouldNotifyNow({ settings: SETTINGS, appFocused: false })).toBe(true);
  });

  it("notifies through focus when the trigger is always", () => {
    const settings = { ...SETTINGS, desktopNotificationTrigger: "always" } as const;
    expect(shouldNotifyNow({ settings, appFocused: true })).toBe(true);
  });

  it("stays quiet on never, focused or not", () => {
    const settings = { ...SETTINGS, desktopNotificationTrigger: "never" } as const;
    expect(shouldNotifyNow({ settings, appFocused: false })).toBe(false);
  });

  it("stays quiet when notifications are switched off, whatever the trigger says", () => {
    const settings = {
      ...SETTINGS,
      desktopNotificationsEnabled: false,
      desktopNotificationTrigger: "always",
    } as const;
    expect(shouldNotifyNow({ settings, appFocused: false })).toBe(false);
  });
});

describe("buildThreadNotification", () => {
  it("uses the shared awareness headline as the title and the thread as the body", () => {
    expect(
      buildThreadNotification({
        thread: THREAD,
        phase: "waiting_for_approval",
        settings: SETTINGS,
      }),
    ).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
      title: "Approval needed",
      body: "Fix participant reconnect loop",
      subtitle: "bitsafe-scan",
    });
  });

  it("omits the subtitle when the project is unknown", () => {
    const notification = buildThreadNotification({
      thread: { ...THREAD, projectTitle: null },
      phase: "completed",
      settings: SETTINGS,
    });
    expect(notification).not.toHaveProperty("subtitle");
    expect(notification?.title).toBe("Agent finished");
  });

  it("returns nothing for a phase the user switched off", () => {
    expect(
      buildThreadNotification({
        thread: THREAD,
        phase: "completed",
        settings: { ...SETTINGS, notifyOnCompletion: false },
      }),
    ).toBeNull();
  });
});

describe("the notification quiet period", () => {
  const NOW = 1_000_000;
  const THREAD_2 = { ...THREAD, threadId: "thread-2" };

  function pendingAfter(
    changes: readonly PhaseChangeNotificationInput[],
    at = NOW,
  ): PendingThreadNotifications {
    return changes.reduce<PendingThreadNotifications>(
      (pending, change) =>
        reducePendingThreadNotifications({ pending, changes: [change], now: at }),
      new Map(),
    );
  }

  it("announces the phase a burst lands in, not the ones it crossed", () => {
    const pending = pendingAfter([
      { thread: THREAD, phase: "completed" },
      { thread: THREAD, phase: "waiting_for_input" },
    ]);
    const due = takeDueThreadNotifications({
      pending,
      now: NOW + NOTIFICATION_QUIET_PERIOD_MS,
      settings: SETTINGS,
      appFocused: false,
    });
    expect(due.notifications.map((notification) => notification.title)).toEqual([
      "Waiting for input",
    ]);
  });

  it("holds a banner until its quiet period passes", () => {
    const pending = pendingAfter([{ thread: THREAD, phase: "completed" }]);
    const due = takeDueThreadNotifications({
      pending,
      now: NOW + NOTIFICATION_QUIET_PERIOD_MS - 1,
      settings: SETTINGS,
      appFocused: false,
    });
    expect(due.notifications).toEqual([]);
    expect(due.nextDueAt).toBe(NOW + NOTIFICATION_QUIET_PERIOD_MS);
    expect(due.pending.size).toBe(1);
  });

  it("announces a finish that nothing follows", () => {
    const pending = pendingAfter([{ thread: THREAD, phase: "completed" }]);
    const due = takeDueThreadNotifications({
      pending,
      now: NOW + NOTIFICATION_QUIET_PERIOD_MS,
      settings: SETTINGS,
      appFocused: false,
    });
    expect(due.notifications.map((notification) => notification.title)).toEqual(["Agent finished"]);
    expect(due.pending.size).toBe(0);
    expect(due.nextDueAt).toBeNull();
  });

  it("cancels the banner when the agent carries on by itself", () => {
    const pending = pendingAfter([
      { thread: THREAD, phase: "completed" },
      { thread: THREAD, phase: "running" },
    ]);
    expect(pending.has(pendingNotificationKey(THREAD))).toBe(false);
  });

  it("restarts the wait on the replacing phase", () => {
    const first = reducePendingThreadNotifications({
      pending: new Map(),
      changes: [{ thread: THREAD, phase: "completed" }],
      now: NOW,
    });
    const second = reducePendingThreadNotifications({
      pending: first,
      changes: [{ thread: THREAD, phase: "waiting_for_approval" }],
      now: NOW + 2_000,
    });
    expect(second.get(pendingNotificationKey(THREAD))?.dueAt).toBe(
      NOW + 2_000 + NOTIFICATION_QUIET_PERIOD_MS,
    );
  });

  it("keeps each thread's burst separate", () => {
    const pending = pendingAfter([
      { thread: THREAD, phase: "completed" },
      { thread: THREAD_2, phase: "failed" },
    ]);
    const due = takeDueThreadNotifications({
      pending,
      now: NOW + NOTIFICATION_QUIET_PERIOD_MS,
      settings: SETTINGS,
      appFocused: false,
    });
    expect(due.notifications.map((notification) => notification.threadId)).toEqual([
      "thread-1",
      "thread-2",
    ]);
  });

  it("drops a due banner when the user came back to the app", () => {
    const pending = pendingAfter([{ thread: THREAD, phase: "completed" }]);
    const due = takeDueThreadNotifications({
      pending,
      now: NOW + NOTIFICATION_QUIET_PERIOD_MS,
      settings: SETTINGS,
      appFocused: true,
    });
    expect(due.notifications).toEqual([]);
    expect(due.pending.size).toBe(0);
  });

  it("drops a due banner for a phase the user switched off", () => {
    const pending = pendingAfter([{ thread: THREAD, phase: "completed" }]);
    const due = takeDueThreadNotifications({
      pending,
      now: NOW + NOTIFICATION_QUIET_PERIOD_MS,
      settings: { ...SETTINGS, notifyOnCompletion: false },
      appFocused: false,
    });
    expect(due.notifications).toEqual([]);
  });

  it("announces the landing phase even when the crossed one is switched off", () => {
    const pending = pendingAfter([
      { thread: THREAD, phase: "completed" },
      { thread: THREAD, phase: "waiting_for_approval" },
    ]);
    const due = takeDueThreadNotifications({
      pending,
      now: NOW + NOTIFICATION_QUIET_PERIOD_MS,
      settings: { ...SETTINGS, notifyOnCompletion: false },
      appFocused: false,
    });
    expect(due.notifications.map((notification) => notification.title)).toEqual([
      "Approval needed",
    ]);
  });
});
