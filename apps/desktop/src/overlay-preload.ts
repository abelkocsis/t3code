// @effect-diagnostics globalDate:off - This isolated Electron preload does not run inside an Effect runtime.
import type { DesktopOverlayAction, DesktopOverlayState } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import { OVERLAY_ACTION_CHANNEL, OVERLAY_RENDER_CHANNEL } from "./ipc/channels.ts";

contextBridge.exposeInMainWorld("t3Overlay", {
  onState: (listener: (state: DesktopOverlayState) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as DesktopOverlayState);
    };
    ipcRenderer.on(OVERLAY_RENDER_CHANNEL, wrappedListener);
    return () => ipcRenderer.removeListener(OVERLAY_RENDER_CHANNEL, wrappedListener);
  },
  send: (action: DesktopOverlayAction) => {
    ipcRenderer.send(OVERLAY_ACTION_CHANNEL, action);
  },
});
