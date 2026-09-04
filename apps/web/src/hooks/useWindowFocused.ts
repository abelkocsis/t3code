import { useEffect, useState } from "react";

function readFocused(): boolean {
  return document.hasFocus() && document.visibilityState === "visible";
}

/**
 * Whether the user is looking at this window right now.
 *
 * Both halves matter: `hasFocus` misses a window that is focused but hidden
 * behind a full-screen app on another Space, and `visibilityState` misses a
 * visible window sitting behind the one the user actually types in.
 */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(readFocused);

  useEffect(() => {
    const sync = () => {
      setFocused(readFocused());
    };
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return focused;
}
