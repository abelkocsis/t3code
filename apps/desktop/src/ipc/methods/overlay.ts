import { DesktopOverlayActionSchema, DesktopOverlayStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
        runFork(
          Effect.gen(function* () {
            // Opening a thread has to bring the app forward. The renderer can
            // navigate, but it cannot raise its own window, so a click used to
            // change the route behind whatever the user was actually looking at.
            if (action.value.kind === "open-thread" || action.value.kind === "open-settings") {
              const window = yield* electronWindow.currentMainOrFirst;
              if (Option.isSome(window)) {
                yield* electronWindow.reveal(window.value);
              }
            }
            yield* electronWindow.sendAll(IpcChannels.OVERLAY_ACTION_FORWARD_CHANNEL, action.value);
          }),
        );
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
