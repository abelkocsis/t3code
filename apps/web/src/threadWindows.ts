import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  DesktopThreadWindowTarget,
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { StateStorage } from "./lib/storage";

/**
 * Desktop thread windows: one thread in its own window, without the sidebar.
 *
 * The main window is the only window that saves client state. A thread window
 * reads saved state when it starts, and sends its own thread's changes to the
 * main window through `postToMainWindow`.
 */

const bridge = typeof window !== "undefined" ? window.desktopBridge?.threadWindows : undefined;

function toThreadRef(target: DesktopThreadWindowTarget): ScopedThreadRef {
  return scopeThreadRef(target.environmentId as EnvironmentId, target.threadId as ThreadId);
}

/** The thread this window shows, or null in the main window and on the web. */
export const threadWindowRef: ScopedThreadRef | null = (() => {
  const target = bridge?.current() ?? null;
  return target === null ? null : toThreadRef(target);
})();

export const isThreadWindow = threadWindowRef !== null;

const mainWindowBridge = isThreadWindow ? undefined : bridge;

/** True in the desktop main window, which can open threads in their own windows. */
export const canOpenThreadWindows = mainWindowBridge !== undefined;

let poppedOutThreadKeys: ReadonlySet<string> = new Set(
  mainWindowBridge?.list().map((target) => scopedThreadKey(toThreadRef(target))) ?? [],
);
const poppedOutListeners = new Set<() => void>();

mainWindowBridge?.onChange((targets) => {
  poppedOutThreadKeys = new Set(targets.map((target) => scopedThreadKey(toThreadRef(target))));
  for (const listener of poppedOutListeners) listener();
});

function subscribePoppedOutThreads(listener: () => void): () => void {
  poppedOutListeners.add(listener);
  return () => poppedOutListeners.delete(listener);
}

/** True when the thread has its own window, so the main window must not show it. */
export function isThreadPoppedOut(threadRef: ScopedThreadRef): boolean {
  return poppedOutThreadKeys.has(scopedThreadKey(threadRef));
}

export function usePoppedOutThreadKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribePoppedOutThreads, () => poppedOutThreadKeys);
}

/** Focuses the thread's own window, creating it when the thread has none. */
export function focusThreadWindow(threadRef: ScopedThreadRef): void {
  void bridge?.open({ environmentId: threadRef.environmentId, threadId: threadRef.threadId });
}

/** Closes this thread window and shows its thread in the main window. */
export function popBackThreadWindow(): void {
  void bridge?.popBack();
}

/** Shows an app route in the main window. */
export function showInMainWindow(href: string): void {
  void bridge?.showInMain(href);
}

/** Runs in the main window when another window asks it to show a route. */
export function onShowInMainWindow(listener: (href: string) => void): () => void {
  return mainWindowBridge?.onShowInMain(listener) ?? (() => {});
}

/** Saved state as this window may use it: a thread window reads it, but never writes it. */
export function windowStateStorage(storage: StateStorage): StateStorage {
  if (!isThreadWindow) return storage;
  return { getItem: (name) => storage.getItem(name), setItem: () => {}, removeItem: () => {} };
}

export type ThreadWindowMessage =
  | {
      readonly kind: "composer-draft";
      readonly threadKey: string;
      /** The saved form of the draft, or null when the composer is empty. */
      readonly draft: unknown;
    }
  | {
      readonly kind: "thread-visits";
      /** Visit times that changed, by thread. Null removes the visit. */
      readonly visits: Readonly<Record<string, string | null>>;
    };

const CHANNEL_NAME = "t3code:thread-windows";

const channel =
  bridge !== undefined && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

/** Sends a change from a thread window to the main window, which saves it. */
export function postToMainWindow(message: ThreadWindowMessage): void {
  if (!isThreadWindow) return;
  // A BroadcastChannel reaches only same-origin windows; it takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  channel?.postMessage(message);
}

/** Runs in the main window for every change a thread window sends. */
export function onThreadWindowMessage(
  listener: (message: ThreadWindowMessage) => void,
): () => void {
  if (!canOpenThreadWindows || channel === null) return () => {};
  const handle = (event: MessageEvent<ThreadWindowMessage>) => listener(event.data);
  channel.addEventListener("message", handle);
  return () => channel.removeEventListener("message", handle);
}
