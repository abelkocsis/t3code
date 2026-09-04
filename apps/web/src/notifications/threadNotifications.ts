import type { DesktopThreadNotification } from "@t3tools/contracts";
import {
  type AttentionNotificationPreferences,
  type AttentionPhase,
  isAttentionPhase,
  isPhaseNotifiable,
} from "@t3tools/client-runtime/state/thread-attention";
import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { headlineForPhase } from "@t3tools/shared/agentAwareness";

export type NotificationTrigger = "unfocused" | "always" | "never";

export interface NotificationSettings extends AttentionNotificationPreferences {
  readonly desktopNotificationsEnabled: boolean;
  readonly desktopNotificationTrigger: NotificationTrigger;
}

/**
 * Whether a banner may appear at all right now.
 *
 * "unfocused" is about the whole app, not the selected thread: a user looking
 * at T3 Code can already see the sidebar light up, and a banner over the app
 * you are using is the complaint every notification feature earns first.
 */
export function shouldNotifyNow(input: {
  readonly settings: NotificationSettings;
  readonly appFocused: boolean;
}): boolean {
  if (!input.settings.desktopNotificationsEnabled) return false;
  switch (input.settings.desktopNotificationTrigger) {
    case "never":
      return false;
    case "always":
      return true;
    case "unfocused":
      return !input.appFocused;
  }
}

export interface NotifiableThread {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectTitle: string | null;
}

/**
 * The banner for one phase change, or null when the phase is not one the user
 * asked to hear about. The title repeats the shared awareness headline, so the
 * Mac and the iPhone announce the same change with the same words.
 */
export function buildThreadNotification(input: {
  readonly thread: NotifiableThread;
  readonly phase: AttentionPhase;
  readonly settings: AttentionNotificationPreferences;
}): DesktopThreadNotification | null {
  if (!isPhaseNotifiable(input.phase, input.settings)) return null;
  return {
    environmentId: input.thread.environmentId,
    threadId: input.thread.threadId,
    title: headlineForPhase(input.phase),
    body: input.thread.threadTitle,
    ...(input.thread.projectTitle === null ? {} : { subtitle: input.thread.projectTitle }),
  };
}

export interface PhaseChangeNotificationInput {
  readonly thread: NotifiableThread;
  readonly phase: AgentAwarenessPhase | null;
}

/**
 * The banners for a batch of phase changes.
 *
 * Changes into a non-attention phase (a thread that starts running again) are
 * real transitions worth recording, but nothing to announce, so they drop out
 * here rather than in the detector.
 */
export function buildThreadNotifications(input: {
  readonly changes: readonly PhaseChangeNotificationInput[];
  readonly settings: NotificationSettings;
  readonly appFocused: boolean;
}): readonly DesktopThreadNotification[] {
  if (!shouldNotifyNow({ settings: input.settings, appFocused: input.appFocused })) return [];
  return input.changes.flatMap((change) => {
    if (!isAttentionPhase(change.phase)) return [];
    const notification = buildThreadNotification({
      thread: change.thread,
      phase: change.phase,
      settings: input.settings,
    });
    return notification === null ? [] : [notification];
  });
}
