import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  detectPhaseChanges,
  isThreadAttentionUnseen,
  resolveThreadAttention,
  type ThreadPhaseMap,
} from "@t3tools/client-runtime/state/thread-attention";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveThreadAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { useEffect, useEffectEvent, useRef } from "react";

import { buildThreadRouteParams } from "../threadRoutes";
import { useProjects, useThreadShells } from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";
import {
  buildThreadNotifications,
  type NotificationSettings,
  type NotifiableThread,
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
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const appFocused = useWindowFocused();
  const settings = useClientSettings(selectNotificationSettings);
  // Phases as of the last snapshot. A thread absent from this map is one we
  // have never seen, and its phase is recorded silently: the first snapshot
  // after launch is history, not news.
  const phasesRef = useRef<ThreadPhaseMap>(new Map());

  const syncNotifications = useEffectEvent(() => {
    const projectTitleByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    );
    const inputs = threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      phase: resolveThreadAwarenessPhase(thread),
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
    const notifications = buildThreadNotifications({
      changes: changes.flatMap((change) => {
        const thread = threadByKey.get(change.key);
        return thread === undefined ? [] : [{ thread, phase: change.phase }];
      }),
      settings,
      appFocused,
    });
    for (const notification of notifications) {
      void window.desktopBridge?.showThreadNotification?.(notification);
    }

    // The badge counts what the user has not looked at, which is the same set
    // a future overlay window lists. A thread they opened and chose to come
    // back to stays visible in the sidebar, but stops adding to the count.
    const unseenCount = threads.reduce((count, thread) => {
      const attention = resolveThreadAttention(thread);
      if (attention === null) return count;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return isThreadAttentionUnseen({ attention, lastVisitedAt: threadLastVisitedAtById[key] })
        ? count + 1
        : count;
    }, 0);
    void window.desktopBridge?.setAttentionBadgeCount?.(unseenCount);
  });

  useEffect(() => {
    syncNotifications();
  }, [threads, projects, threadLastVisitedAtById, settings, appFocused]);

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
