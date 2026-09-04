import type { DesktopOverlayState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { BrowserWindow, screen } from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import { buildOverlayDataUrl, overlayHeightForItems, OVERLAY_WIDTH } from "./OverlayWindowHtml.ts";

export class OverlayWindowError extends Schema.TaggedErrorClass<OverlayWindowError>()(
  "OverlayWindowError",
  {
    operation: Schema.Literals(["create", "update", "close"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The overlay window failed to ${this.operation}.`;
  }
}

export interface OverlayWindowServices {
  readonly sync: (state: DesktopOverlayState) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  /** The live window, for tests and for the action forwarder. */
  readonly current: Effect.Effect<BrowserWindow | null>;
}

/**
 * The always-on-top overlay window.
 *
 * The renderer decides everything about what to show; this service only obeys.
 * It creates the window on the first visible state, resizes it to fit the rows,
 * and destroys it when the state goes hidden, so a hidden overlay costs nothing.
 */
export class OverlayWindow extends Context.Service<OverlayWindow, OverlayWindowServices>()(
  "@t3tools/desktop/window/OverlayWindow",
) {}

/** Top-right of the work area, inset by a comfortable margin. */
export function defaultOverlayPosition(input: {
  readonly workArea: { readonly x: number; readonly y: number; readonly width: number };
  readonly margin: number;
}): { readonly x: number; readonly y: number } {
  return {
    x: input.workArea.x + input.workArea.width - OVERLAY_WIDTH - input.margin,
    y: input.workArea.y + input.margin,
  };
}

const DEFAULT_MARGIN = 24;

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const windowRef = yield* Ref.make<BrowserWindow | null>(null);
  const preloadPath = environment.path.join(environment.dirname, "overlay-preload.cjs");
  const runFork = Effect.runForkWith(yield* Effect.context<ElectronWindow.ElectronWindow>());

  const logAndContinue = (error: OverlayWindowError) =>
    Effect.logWarning(error.message, { cause: error.cause });

  const readWindow = Ref.get(windowRef).pipe(
    Effect.map((window) => (window !== null && !window.isDestroyed() ? window : null)),
  );

  const destroy = Effect.gen(function* () {
    const window = yield* Ref.getAndSet(windowRef, null);
    if (window === null || window.isDestroyed()) return;
    yield* Effect.try({
      try: () => {
        window.destroy();
      },
      catch: (cause) => new OverlayWindowError({ operation: "close", cause }),
    });
  });

  const create = (saved: DesktopOverlayState["position"]) =>
    Effect.gen(function* () {
      const position = yield* Effect.try({
        try: () =>
          saved ??
          defaultOverlayPosition({
            workArea: screen.getPrimaryDisplay().workArea,
            margin: DEFAULT_MARGIN,
          }),
        catch: (cause) => new OverlayWindowError({ operation: "create", cause }),
      });
      const window = yield* Effect.try({
        try: () =>
          new BrowserWindow({
            width: OVERLAY_WIDTH,
            height: overlayHeightForItems(0),
            x: position.x,
            y: position.y,
            title: "T3 Code overlay",
            show: false,
            frame: false,
            transparent: true,
            hasShadow: true,
            alwaysOnTop: true,
            autoHideMenuBar: true,
            focusable: true,
            fullscreenable: false,
            maximizable: false,
            minimizable: false,
            resizable: false,
            skipTaskbar: true,
            // The dock badge and the notification banners already announce the
            // app; a second taskbar entry for a 340px panel is noise.
            ...(environment.platform === "darwin" ? { type: "panel" as const } : {}),
            webPreferences: {
              preload: preloadPath,
              backgroundThrottling: false,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          }),
        catch: (cause) => new OverlayWindowError({ operation: "create", cause }),
      });

      yield* Effect.try({
        try: () => {
          window.setAlwaysOnTop(true, environment.platform === "darwin" ? "floating" : "normal");
          if (environment.platform === "darwin") {
            window.setVisibleOnAllWorkspaces(true, {
              visibleOnFullScreen: true,
              // Without this Electron turns the whole app into a UIElement
              // process, which removes T3 Code from the Dock entirely.
              skipTransformProcessType: true,
            });
          }
          // The position belongs in client settings, which only the main
          // renderer can write, so the move is forwarded rather than stored here.
          window.on("moved", () => {
            const [x, y] = window.getPosition();
            runFork(electronWindow.sendAll(IpcChannels.OVERLAY_MOVED_CHANNEL, { x, y }));
          });
          window.on("closed", () => {
            runFork(Ref.set(windowRef, null));
          });
        },
        catch: (cause) => new OverlayWindowError({ operation: "create", cause }),
      });

      yield* Effect.tryPromise({
        try: () => window.loadURL(buildOverlayDataUrl()),
        catch: (cause) => new OverlayWindowError({ operation: "create", cause }),
      });
      yield* Ref.set(windowRef, window);
      return window;
    });

  const applyState = (window: BrowserWindow, state: DesktopOverlayState) =>
    Effect.try({
      try: () => {
        const height =
          state.mode === "pill"
            ? overlayHeightForItems(0)
            : overlayHeightForItems(state.items.length);
        const [width, currentHeight] = window.getSize();
        if (width !== OVERLAY_WIDTH || currentHeight !== height) {
          window.setSize(OVERLAY_WIDTH, height, false);
        }
        window.webContents.send(IpcChannels.OVERLAY_RENDER_CHANNEL, state);
        if (!window.isVisible()) {
          // showInactive keeps focus where the user is working. An overlay that
          // stole focus would interrupt the very work it reports on.
          window.showInactive();
        }
      },
      catch: (cause) => new OverlayWindowError({ operation: "update", cause }),
    });

  const sync: OverlayWindowServices["sync"] = (state) =>
    Effect.gen(function* () {
      if (state.mode === "hidden") {
        yield* destroy;
        yield* powerSaveBlocker.hold(false);
        return;
      }
      const existing = yield* readWindow;
      const window = existing ?? (yield* create(state.position));
      // The page only renders once its script is running; a state pushed into a
      // still-loading window is lost, so wait for the first load to settle.
      if (window.webContents.isLoading()) {
        yield* Effect.callback<void>((resume) => {
          window.webContents.once("did-finish-load", () => {
            resume(Effect.void);
          });
        });
      }
      yield* applyState(window, state);
      yield* powerSaveBlocker.hold(state.keepAwake);
    }).pipe(Effect.catchTag("OverlayWindowError", logAndContinue));

  return OverlayWindow.of({
    sync,
    close: destroy.pipe(
      Effect.catchTag("OverlayWindowError", logAndContinue),
      Effect.andThen(powerSaveBlocker.hold(false)),
    ),
    current: readWindow,
  });
});

export const layer = Layer.effect(OverlayWindow, make).pipe(
  Layer.provideMerge(ElectronPowerSaveBlocker.layer),
);
