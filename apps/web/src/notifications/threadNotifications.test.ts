import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadNotification,
  buildThreadNotifications,
  type NotificationSettings,
  shouldNotifyNow,
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

describe("buildThreadNotifications", () => {
  it("announces only the phases that ask something of the user", () => {
    const notifications = buildThreadNotifications({
      changes: [
        { thread: THREAD, phase: "running" },
        { thread: { ...THREAD, threadId: "thread-2" }, phase: "completed" },
        { thread: { ...THREAD, threadId: "thread-3" }, phase: null },
      ],
      settings: SETTINGS,
      appFocused: false,
    });
    expect(notifications.map((notification) => notification.threadId)).toEqual(["thread-2"]);
  });

  it("announces nothing while the trigger forbids it, however many changes arrive", () => {
    expect(
      buildThreadNotifications({
        changes: [{ thread: THREAD, phase: "failed" }],
        settings: SETTINGS,
        appFocused: true,
      }),
    ).toEqual([]);
  });

  it("announces every qualifying change in one batch", () => {
    const notifications = buildThreadNotifications({
      changes: [
        { thread: THREAD, phase: "waiting_for_approval" },
        { thread: { ...THREAD, threadId: "thread-2" }, phase: "failed" },
      ],
      settings: SETTINGS,
      appFocused: false,
    });
    expect(notifications.map((notification) => notification.title)).toEqual([
      "Approval needed",
      "Agent failed",
    ]);
  });
});
