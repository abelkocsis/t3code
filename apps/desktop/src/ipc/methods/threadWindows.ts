import { DesktopThreadWindowTargetSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const listThreadWindows = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.THREAD_WINDOW_LIST_CHANNEL,
  result: Schema.Array(DesktopThreadWindowTargetSchema),
  handler: Effect.fn("desktop.ipc.threadWindows.list")(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    return yield* desktopWindow.threadWindowTargets;
  }),
});

export const openThreadWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.THREAD_WINDOW_OPEN_CHANNEL,
  payload: DesktopThreadWindowTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.threadWindows.open")(function* (target) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.openThreadWindow(target);
  }),
});

export const popBackThreadWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.THREAD_WINDOW_POP_BACK_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.threadWindows.popBack")(function* (_input, event) {
    if (event === undefined) return;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.popBackThreadWindow(event.sender.id);
  }),
});

// Only app routes cross: the main window navigates its own router to the path.
const AppRouteHref = Schema.String.check(Schema.isStartsWith("/"));

export const showInMainWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_IN_MAIN_WINDOW_CHANNEL,
  payload: AppRouteHref,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.threadWindows.showInMain")(function* (href) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.showRouteInMain(href);
  }),
});
