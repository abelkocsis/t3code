import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/factory" ||
    pathname === "/pull-requests"
  );
}

let mainAppHref: string | null = null;
const listeners = new Set<() => void>();

function setMainAppHref(href: string) {
  if (mainAppHref === href) return;
  mainAppHref = href;
  for (const listener of listeners) listener();
}

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null) setMainAppHref(href);
  }, [href]);
  return null;
}

/**
 * Whether a Back button has somewhere to go. An app that opened straight on a
 * utility page has no main-app location yet, so the sidebar keeps its usual
 * utility icons instead of a button that leads to an empty draft.
 */
export function useHasMainAppLocation(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => mainAppHref !== null,
    () => false,
  );
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}
