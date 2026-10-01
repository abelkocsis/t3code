import { useCallback, useEffect, useRef } from "react";

/**
 * Publishes how much room the floating titlebar controls take on the right,
 * as `--workspace-controls-inset` on the document.
 *
 * The cluster is fixed to the viewport, so anything sharing that row — the
 * right panel's tab strip — has to keep clear of it. Measuring beats a fixed
 * padding, which silently became too small every time a control was added.
 */
export function useTitlebarControlsInset(): (node: HTMLElement | null) => void {
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      document.documentElement.style.removeProperty("--workspace-controls-inset");
    },
    [],
  );

  return useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (node === null) {
      document.documentElement.style.removeProperty("--workspace-controls-inset");
      return;
    }
    const publish = () => {
      const rect = node.getBoundingClientRect();
      // From the cluster's left edge to the viewport edge, so the gap the
      // cluster is anchored by counts too.
      const inset = Math.max(0, Math.round(window.innerWidth - rect.left));
      document.documentElement.style.setProperty("--workspace-controls-inset", `${inset}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    observerRef.current = observer;
  }, []);
}
