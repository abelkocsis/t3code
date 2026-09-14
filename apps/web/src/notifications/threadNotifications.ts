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
 * How long a thread's banner waits for a following phase change to replace it.
 */
export const NOTIFICATION_QUIET_PERIOD_MS = 3_000;

export interface PendingThreadNotification {
  readonly thread: NotifiableThread;
  readonly phase: AttentionPhase;
  /** Epoch milliseconds the banner may fire. */
  readonly dueAt: number;
}

export type PendingThreadNotifications = ReadonlyMap<string, PendingThreadNotification>;

/** Key for one thread's pending banner. Two environments never collide. */
export function pendingNotificationKey(thread: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return `${thread.environmentId}:${thread.threadId}`;
}

/**
 * The pending banners after a batch of phase changes.
 *
 * One burst of phases must produce one banner. A monitor run that settles and
 * then asks a question crosses `completed` before `waiting_for_input`, and
 * only the phase the thread lands in is news, so a later change replaces the
 * pending banner and restarts the wait. A change back to a working phase
 * cancels the banner outright: the agent carried on by itself.
 */
export function reducePendingThreadNotifications(input: {
  readonly pending: PendingThreadNotifications;
  readonly changes: readonly PhaseChangeNotificationInput[];
  readonly now: number;
}): PendingThreadNotifications {
  if (input.changes.length === 0) return input.pending;
  const next = new Map(input.pending);
  for (const change of input.changes) {
    const key = pendingNotificationKey(change.thread);
    if (!isAttentionPhase(change.phase)) {
      next.delete(key);
      continue;
    }
    next.set(key, {
      thread: change.thread,
      phase: change.phase,
      dueAt: input.now + NOTIFICATION_QUIET_PERIOD_MS,
    });
  }
  return next;
}

export interface DueThreadNotifications {
  readonly notifications: readonly DesktopThreadNotification[];
  readonly pending: PendingThreadNotifications;
  /** Epoch milliseconds the next banner is due, or null when nothing waits. */
  readonly nextDueAt: number | null;
}

/**
 * The banners whose quiet period has passed, and the ones that still wait.
 *
 * The focus check runs here rather than when the phase changed. A user who
 * came back to T3 Code during the wait already reads the same news in the
 * sidebar, so the banner drops instead of arriving late. A phase the user
 * switched off drops the same way.
 */
export function takeDueThreadNotifications(input: {
  readonly pending: PendingThreadNotifications;
  readonly now: number;
  readonly settings: NotificationSettings;
  readonly appFocused: boolean;
}): DueThreadNotifications {
  const allowed = shouldNotifyNow({ settings: input.settings, appFocused: input.appFocused });
  const notifications: DesktopThreadNotification[] = [];
  const pending = new Map<string, PendingThreadNotification>();
  let nextDueAt: number | null = null;
  for (const [key, entry] of input.pending) {
    if (entry.dueAt > input.now) {
      pending.set(key, entry);
      nextDueAt = nextDueAt === null ? entry.dueAt : Math.min(nextDueAt, entry.dueAt);
      continue;
    }
    if (!allowed) continue;
    const notification = buildThreadNotification({
      thread: entry.thread,
      phase: entry.phase,
      settings: input.settings,
    });
    if (notification !== null) notifications.push(notification);
  }
  return { notifications, pending, nextDueAt };
}
