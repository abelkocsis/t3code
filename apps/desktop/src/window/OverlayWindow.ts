// @effect-diagnostics globalTimers:off -- Electron emits "moved" outside any Effect runtime; the drag settles on a plain timer.
import type { DesktopOverlayState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import { BrowserWindow, screen } from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import {
  buildOverlayDataUrl,
  clampOverlayHeight,
  clampOverlayWidth,
  estimateOverlayHeight,
  OVERLAY_INITIAL_HEIGHT,
  OVERLAY_WIDTH,
} from "./OverlayWindowHtml.ts";

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
/** How long a drag must rest before its position is written to settings. */
const MOVE_PERSIST_DELAY_MS = 400;

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const windowRef = yield* Ref.make<BrowserWindow | null>(null);
  // The renderer pushes state on every change, so two syncs can overlap. Without
  // a mutex both see no window and both create one: the second wins the ref and
  // the first is orphaned on screen, which is why the overlay came and went.
  const syncSemaphore = yield* Semaphore.make(1);
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
            height: OVERLAY_INITIAL_HEIGHT,
            x: position.x,
            y: position.y,
            title: "T3 Code overlay",
            show: false,
            frame: false,
            transparent: true,
            // macOS draws the shadow around the whole window rectangle, not the
            // visible content, so a hugged pill inside a wider window trailed a
            // dark smear. The panel's own border carries the edge instead.
            hasShadow: false,
            alwaysOnTop: true,
            autoHideMenuBar: true,
            // Never takes key status. As a focusable macOS panel it stole key
            // from the main window, whose renderer then reported itself
            // unfocused — so the overlay kept showing while the user was
            // looking straight at T3 Code. A non-focusable window still
            // receives clicks.
            focusable: false,
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
          // The page measures its own content and asks for a height, so a
          // single row never gets a scrollbar and a long list never gets cut.
          window.webContents.ipc.on(IpcChannels.OVERLAY_HEIGHT_CHANNEL, (_event, size) => {
            if (typeof size !== "object" || size === null || window.isDestroyed()) return;
            const { width, height } = size as { width: unknown; height: unknown };
            if (typeof width !== "number" || typeof height !== "number") return;
            const nextWidth = clampOverlayWidth(width);
            const nextHeight = clampOverlayHeight(height);
            const bounds = window.getBounds();
            if (bounds.width === nextWidth && bounds.height === nextHeight) return;
            // Anchor the right edge: the overlay sits in a corner, so growing
            // from the left keeps it where the user put it.
            window.setBounds({
              x: bounds.x + (bounds.width - nextWidth),
              y: bounds.y,
              width: nextWidth,
              height: nextHeight,
            });
          });
          // The position belongs in client settings, which only the main
          // renderer can write, so the move is forwarded rather than stored
          // here. "moved" fires for every pixel of a drag, so the write waits
          // until the drag settles: one settings write per move, not hundreds.
          let movedTimer: NodeJS.Timeout | null = null;
          window.on("moved", () => {
            if (movedTimer !== null) clearTimeout(movedTimer);
            movedTimer = setTimeout(() => {
              movedTimer = null;
              if (window.isDestroyed()) return;
              const [x, y] = window.getPosition();
              runFork(electronWindow.sendAll(IpcChannels.OVERLAY_MOVED_CHANNEL, { x, y }));
            }, MOVE_PERSIST_DELAY_MS);
          });
          window.on("closed", () => {
            if (movedTimer !== null) clearTimeout(movedTimer);
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
        // The estimate only seeds the very first show, so a lost measurement
        // still leaves a usable window. After that the page owns the size:
        // re-forcing it here stretched the window back to full width behind a
        // hugged pill, and the page would not re-report because its own
        // measurement had not changed.
        if (!window.isVisible()) {
          const estimate = estimateOverlayHeight(state.mode === "pill" ? 0 : state.items.length);
          window.setSize(OVERLAY_WIDTH, estimate, false);
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

  const syncUnsafe = (state: DesktopOverlayState) =>
    Effect.gen(function* () {
      if (state.mode === "hidden") {
        // Hide rather than destroy: the overlay hides every time the user looks
        // at T3 Code, and rebuilding the window on every focus change made it
        // slow to come back and easy to lose.
        const open = yield* readWindow;
        if (open !== null && open.isVisible()) {
          yield* Effect.try({
            try: () => {
              open.hide();
            },
            catch: (cause) => new OverlayWindowError({ operation: "update", cause }),
          });
        }
        yield* powerSaveBlocker.hold(false);
        return;
      }
      const existing = yield* readWindow;
      const window = existing ?? (yield* create(state.position));
      // No waiting for the load here. `create` already awaits loadURL, which
      // resolves on did-finish-load, so the page is ready. An extra
      // `once("did-finish-load")` waits for an event that has already fired and
      // never resumes, and under the sync permit that deadlocks every later
      // update — the overlay stops appearing at all.
      yield* applyState(window, state);
      yield* powerSaveBlocker.hold(state.keepAwake);
    }).pipe(Effect.catchTag("OverlayWindowError", logAndContinue));

  const sync: OverlayWindowServices["sync"] = (state) =>
    Semaphore.withPermit(syncSemaphore)(syncUnsafe(state));

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
