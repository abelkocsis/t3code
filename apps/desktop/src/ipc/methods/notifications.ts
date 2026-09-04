import { DesktopThreadNotificationSchema, NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronNotifier from "../../electron/ElectronNotifier.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showThreadNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_THREAD_NOTIFICATION_CHANNEL,
  payload: DesktopThreadNotificationSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.showThreadNotification")(function* (notification) {
    const notifier = yield* ElectronNotifier.ElectronNotifier;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    // The click arrives on Electron's event loop, outside any fiber, so the
    // handler carries this method's services with it.
    const runFork = Effect.runForkWith(yield* Effect.context<ElectronWindow.ElectronWindow>());
    yield* notifier.show({
      title: notification.title,
      body: notification.body,
      ...(notification.subtitle === undefined ? {} : { subtitle: notification.subtitle }),
      onClick: () => {
        const reveal = Effect.gen(function* () {
          const window = yield* electronWindow.currentMainOrFirst;
          if (Option.isSome(window)) {
            yield* electronWindow.reveal(window.value);
          }
          yield* electronWindow.sendAll(IpcChannels.THREAD_NOTIFICATION_ACTIVATED_CHANNEL, {
            environmentId: notification.environmentId,
            threadId: notification.threadId,
          });
        });
        runFork(reveal);
      },
    });
  }),
});

export const setAttentionBadgeCount = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_ATTENTION_BADGE_COUNT_CHANNEL,
  payload: NonNegativeInt,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.setAttentionBadgeCount")(function* (count) {
    const notifier = yield* ElectronNotifier.ElectronNotifier;
    yield* notifier.setBadgeCount(count);
  }),
});
