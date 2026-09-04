import { DesktopOverlayActionSchema, DesktopOverlayStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ipcMain } from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as OverlayWindow from "../../window/OverlayWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setOverlayState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_OVERLAY_STATE_CHANNEL,
  payload: DesktopOverlayStateSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.overlay.setState")(function* (state) {
    const overlayWindow = yield* OverlayWindow.OverlayWindow;
    yield* overlayWindow.sync(state);
  }),
});

const decodeOverlayAction = Schema.decodeUnknownOption(DesktopOverlayActionSchema);

/**
 * Relays what the user did in the overlay to the main renderer.
 *
 * The overlay owns no state: opening a thread, hiding the overlay, and opening
 * settings are all decisions the renderer makes, because it owns the router and
 * the client settings. The main process only carries the message.
 */
export const installOverlayActionForwarding = Effect.fn(
  "desktop.ipc.overlay.installActionForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const runFork = Effect.runForkWith(yield* Effect.context<ElectronWindow.ElectronWindow>());

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const listener = (_event: Electron.IpcMainEvent, payload: unknown) => {
        const action = decodeOverlayAction(payload);
        if (action._tag === "None") return;
        runFork(electronWindow.sendAll(IpcChannels.OVERLAY_ACTION_FORWARD_CHANNEL, action.value));
      };
      ipcMain.on(IpcChannels.OVERLAY_ACTION_CHANNEL, listener);
      return listener;
    }),
    (listener) =>
      Effect.sync(() => {
        ipcMain.removeListener(IpcChannels.OVERLAY_ACTION_CHANNEL, listener);
      }),
  );
});
