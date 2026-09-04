import { useNavigate } from "@tanstack/react-router";
import {
  resolveOverlayHideUntil,
  resolveOverlayState,
} from "@t3tools/client-runtime/state/overlay-visibility";
import type {
  DesktopOverlayAction,
  DesktopOverlayState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo } from "react";

import { buildThreadRouteParams } from "../threadRoutes";
import { attentionItemLabel, useAttentionThreads } from "./useAttentionThreads";
import { useNowMinute } from "./useNowMinute";
import { useClientSettings, useUpdateClientSettings } from "./useSettings";
import { useWindowFocused } from "./useWindowFocused";

/**
 * Overlay mode: a small always-on-top window listing what the user has not
 * seen.
 *
 * The renderer decides everything and pushes a finished payload; the overlay
 * window itself holds no state and opens no connection of its own. Mounted once
 * at the root, next to the notification hook it shares its source with.
 */
export function useOverlayMode(): void {
  const navigate = useNavigate();
  const { unseen, workingCount } = useAttentionThreads();
  const appFocused = useWindowFocused();
  const updateSettings = useUpdateClientSettings();
  // A temporary hide expires on the clock, not on a thread event, so the
  // minute tick is what brings the overlay back when nothing else happens.
  const nowMinute = useNowMinute();
  const enabled = useClientSettings((settings) => settings.overlayModeEnabled);
  const hiddenUntil = useClientSettings((settings) => settings.overlayHiddenUntil);
  const keepAwake = useClientSettings((settings) => settings.overlayKeepAwake);
  const position = useClientSettings((settings) => settings.overlayPosition);

  const state = useMemo<DesktopOverlayState>(() => {
    const resolved = resolveOverlayState({
      enabled,
      hiddenUntil,
      now: new Date(`${nowMinute}:00.000Z`).toISOString(),
      appFocused,
      unseen,
      workingCount,
    });
    return {
      mode: resolved.mode,
      items: resolved.items.map((item) => ({
        environmentId: item.environmentId,
        threadId: item.threadId,
        threadTitle: item.threadTitle,
        projectTitle: item.projectTitle,
        phase: item.phase,
        phaseLabel: attentionItemLabel(item),
      })),
      workingCount: resolved.workingCount,
      keepAwake,
      position,
    };
  }, [appFocused, enabled, hiddenUntil, keepAwake, nowMinute, position, unseen, workingCount]);

  useEffect(() => {
    void window.desktopBridge?.setOverlayState?.(state);
  }, [state]);

  const handleAction = useEffectEvent((action: DesktopOverlayAction) => {
    if (action.kind === "open-thread") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: action.environmentId as EnvironmentId,
          threadId: action.threadId as ThreadId,
        }),
      });
      return;
    }
    if (action.kind === "open-settings") {
      void navigate({ to: "/settings/notifications" });
      return;
    }
    const until = resolveOverlayHideUntil(action.duration, new Date());
    // "Until I turn it back on" is the switch, not a deadline. Everything else
    // schedules a return, so hiding for an hour can never become permanent.
    updateSettings(
      until === null
        ? { overlayModeEnabled: false, overlayHiddenUntil: null }
        : { overlayHiddenUntil: until },
    );
  });

  useEffect(() => {
    const subscribe = window.desktopBridge?.onOverlayAction;
    if (subscribe === undefined) return;
    return subscribe((action) => handleAction(action));
  }, []);

  const handleMoved = useEffectEvent((next: { x: number; y: number }) => {
    updateSettings({ overlayPosition: next });
  });

  useEffect(() => {
    const subscribe = window.desktopBridge?.onOverlayMoved;
    if (subscribe === undefined) return;
    return subscribe((next) => handleMoved(next));
  }, []);
}
