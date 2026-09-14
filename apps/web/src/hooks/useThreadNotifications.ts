import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  detectPhaseChanges,
  resolveNotifiableAwarenessPhase,
  type ThreadPhaseMap,
} from "@t3tools/client-runtime/state/thread-attention";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { buildThreadRouteParams } from "../threadRoutes";
import { useProjects, useThreadShells } from "../state/entities";
import { useAttentionThreads } from "./useAttentionThreads";
import { useClientSettings } from "./useSettings";
import {
  type NotificationSettings,
  type NotifiableThread,
  type PendingThreadNotifications,
  reducePendingThreadNotifications,
  takeDueThreadNotifications,
} from "../notifications/threadNotifications";
import { useWindowFocused } from "./useWindowFocused";

/**
 * Desktop notifications and the dock badge.
 *
 * Mounted once at the root. Every client already receives the shell stream, so
 * the phases come from the same `agentAwareness` derivation the relay pushes to
 * the phone; nothing new crosses the wire.
 */
export function useThreadNotifications(): void {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const projects = useProjects();
  // Shared with overlay mode so the badge and the overlay can never disagree.
  const { unseen } = useAttentionThreads();
  const appFocused = useWindowFocused();
  const settings = useClientSettings(selectNotificationSettings);
  // Phases as of the last snapshot. A thread absent from this map is one we
  // have never seen, and its phase is recorded silently: the first snapshot
  // after launch is history, not news.
  const phasesRef = useRef<ThreadPhaseMap>(new Map());
  // Banners waiting out their quiet period, so one burst of phases on a thread
  // announces itself once.
  const pendingRef = useRef<PendingThreadNotifications>(new Map());
  const flushTimerRef = useRef<number | null>(null);
  // Wakes the sync when the quiet period is the only thing left to wait for.
  // A counter rather than a direct call, so the flush reads the focus state of
  // the moment it fires, not the one from when the banner was scheduled.
  const [flushTick, setFlushTick] = useState(0);

  const syncNotifications = useEffectEvent(() => {
    const projectTitleByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    );
    const inputs = threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      phase: resolveNotifiableAwarenessPhase(thread),
      thread: {
        environmentId: thread.environmentId,
        threadId: thread.id,
        threadTitle: thread.title,
        projectTitle: projectTitleByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
      } satisfies NotifiableThread,
    }));

    const { changes, next } = detectPhaseChanges(
      phasesRef.current,
      inputs.map(({ key, phase }) => ({ key, phase })),
    );
    phasesRef.current = next;

    const threadByKey = new Map(inputs.map((input) => [input.key, input.thread]));
    const now = Date.now();
    const pending = reducePendingThreadNotifications({
      pending: pendingRef.current,
      changes: changes.flatMap((change) => {
        const thread = threadByKey.get(change.key);
        return thread === undefined ? [] : [{ thread, phase: change.phase }];
      }),
      now,
    });
    const due = takeDueThreadNotifications({ pending, now, settings, appFocused });
    pendingRef.current = due.pending;
    for (const notification of due.notifications) {
      void window.desktopBridge?.showThreadNotification?.(notification);
    }

    // A banner that nothing follows has no later snapshot to carry it, so the
    // quiet period needs its own wake-up.
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (due.nextDueAt !== null) {
      flushTimerRef.current = window.setTimeout(
        () => {
          flushTimerRef.current = null;
          setFlushTick((tick) => tick + 1);
        },
        Math.max(0, due.nextDueAt - now),
      );
    }

    // The badge counts what the user has not looked at, the same set the
    // overlay lists. A thread they opened and chose to come back to stays
    // visible in the sidebar, but stops adding to the count.
    void window.desktopBridge?.setAttentionBadgeCount?.(unseen.length);
  });

  useEffect(() => {
    syncNotifications();
  }, [threads, projects, unseen, settings, appFocused, flushTick]);

  useEffect(
    () => () => {
      if (flushTimerRef.current === null) return;
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const subscribe = window.desktopBridge?.onThreadNotificationActivated;
    if (subscribe === undefined) return;
    return subscribe((target) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(target.environmentId as EnvironmentId, target.threadId as ThreadId),
        ),
      });
    });
  }, [navigate]);
}

function selectNotificationSettings(settings: {
  readonly desktopNotificationsEnabled: boolean;
  readonly desktopNotificationTrigger: NotificationSettings["desktopNotificationTrigger"];
  readonly notifyOnApproval: boolean;
  readonly notifyOnInput: boolean;
  readonly notifyOnCompletion: boolean;
  readonly notifyOnFailure: boolean;
}): NotificationSettings {
  return {
    desktopNotificationsEnabled: settings.desktopNotificationsEnabled,
    desktopNotificationTrigger: settings.desktopNotificationTrigger,
    notifyOnApproval: settings.notifyOnApproval,
    notifyOnInput: settings.notifyOnInput,
    notifyOnCompletion: settings.notifyOnCompletion,
    notifyOnFailure: settings.notifyOnFailure,
  };
}
