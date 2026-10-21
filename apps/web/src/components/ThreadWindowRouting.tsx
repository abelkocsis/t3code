import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  canOpenThreadWindows,
  focusThreadWindow,
  onShowInMainWindow,
  showInMainWindow,
  threadWindowRef,
  usePoppedOutThreadKeys,
} from "../threadWindows";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";

// Routes that belong to the window itself: pairing and onboarding never move.
const WINDOW_LOCAL_PATHS = new Set(["/pair", "/connect", "/welcome"]);

/**
 * Keeps each thread in one window. The main window never shows a thread that
 * has its own window, and a thread window shows only its thread: any other
 * route opens in the main window.
 */
export function ThreadWindowRouting() {
  if (threadWindowRef !== null) return <ThreadWindowRouteLock threadRef={threadWindowRef} />;
  if (canOpenThreadWindows) return <MainWindowThreadRouting />;
  return null;
}

function ThreadWindowRouteLock({ threadRef }: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const location = useLocation();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const onOwnThread =
    routeThreadRef !== null && scopedThreadKey(routeThreadRef) === scopedThreadKey(threadRef);

  useEffect(() => {
    if (onOwnThread || WINDOW_LOCAL_PATHS.has(location.pathname)) return;
    showInMainWindow(location.href);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
    });
  }, [location.href, location.pathname, navigate, onOwnThread, threadRef]);

  return null;
}

function MainWindowThreadRouting() {
  const navigate = useNavigate();
  const router = useRouter();
  const poppedOutThreadKeys = usePoppedOutThreadKeys();
  const routeThreadKey = useParams({
    strict: false,
    select: (params) => {
      const threadRef = resolveThreadRouteRef(params);
      return threadRef === null ? null : scopedThreadKey(threadRef);
    },
  });
  const poppedOutRouteThreadKey =
    routeThreadKey !== null && poppedOutThreadKeys.has(routeThreadKey) ? routeThreadKey : null;

  useEffect(() => onShowInMainWindow((href) => void navigate({ href })), [navigate]);

  // Every way into a thread (sidebar, palette, notifications, links) lands on
  // its route, so the route is where a popped-out thread turns into a focus.
  useEffect(() => {
    const threadRef =
      poppedOutRouteThreadKey === null ? null : parseScopedThreadKey(poppedOutRouteThreadKey);
    if (threadRef === null) return;
    focusThreadWindow(threadRef);
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, poppedOutRouteThreadKey, router]);

  return null;
}
