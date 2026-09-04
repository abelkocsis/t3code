import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export interface ElectronNotificationRequest {
  readonly title: string;
  readonly body: string;
  readonly subtitle?: string | undefined;
  /** Runs when the user clicks the banner. */
  readonly onClick: () => void;
}

export class ElectronNotifierError extends Schema.TaggedErrorClass<ElectronNotifierError>()(
  "ElectronNotifierError",
  {
    operation: Schema.Literals(["show", "setBadgeCount"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The desktop notifier failed to ${this.operation}.`;
  }
}

/**
 * The OS notification surface: banners and the dock badge.
 *
 * Both are best-effort, so the service swallows its own failures and logs them.
 * A user who denied notification permission, or a platform with no dock, must
 * never fail a renderer request — the sidebar still carries the same
 * information, so a warning in the log is the whole remedy.
 */
export class ElectronNotifier extends Context.Service<
  ElectronNotifier,
  {
    readonly isSupported: Effect.Effect<boolean>;
    readonly show: (request: ElectronNotificationRequest) => Effect.Effect<void>;
    /** Zero clears the badge. */
    readonly setBadgeCount: (count: number) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronNotifier") {}

const logAndContinue = (error: ElectronNotifierError) =>
  Effect.logWarning(error.message, { cause: error.cause });

export const make = ElectronNotifier.of({
  isSupported: Effect.sync(() => Electron.Notification.isSupported()),
  show: (request) =>
    Effect.try({
      try: () => {
        if (!Electron.Notification.isSupported()) return;
        const notification = new Electron.Notification({
          title: request.title,
          body: request.body,
          ...(request.subtitle === undefined ? {} : { subtitle: request.subtitle }),
        });
        notification.on("click", request.onClick);
        notification.show();
      },
      catch: (cause) => new ElectronNotifierError({ operation: "show", cause }),
    }).pipe(Effect.catchTag("ElectronNotifierError", logAndContinue)),
  setBadgeCount: (count) =>
    Effect.try({
      try: () => {
        Electron.app.setBadgeCount(Math.max(0, Math.trunc(count)));
      },
      catch: (cause) => new ElectronNotifierError({ operation: "setBadgeCount", cause }),
    }).pipe(Effect.catchTag("ElectronNotifierError", logAndContinue)),
});

export const layer = Layer.succeed(ElectronNotifier, make);
