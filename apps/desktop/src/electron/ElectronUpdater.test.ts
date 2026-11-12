import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { make } from "./ElectronUpdater.ts";

const electron = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.7-bitsafe.3",
    getAppPath: () => "/Applications/T3 Code (Beta).app/Contents/Resources/app.asar",
    relaunch: electron.relaunch,
    quit: electron.quit,
  },
}));
vi.mock("electron-updater", () => ({
  autoUpdater: {
    checkForUpdates: electron.checkForUpdates,
    downloadUpdate: electron.downloadUpdate,
    quitAndInstall: electron.quitAndInstall,
    channel: "latest",
  },
}));

it.effect("checks and downloads through Homebrew without offering a GitHub-only release", () => {
  vi.clearAllMocks();
  const outputs = [
    "",
    JSON.stringify({ casks: [{ version: "0.1.7-bitsafe.3" }] }),
    "",
    JSON.stringify({ casks: [{ version: "0.1.7-bitsafe.4" }] }),
    "",
  ];
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(outputs.shift() ?? "")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  return Effect.gen(function* () {
    const updater = yield* make;
    const available = vi.fn();
    const unavailable = vi.fn();
    const downloaded = vi.fn();
    yield* updater.on("update-available", available);
    yield* updater.on("update-not-available", unavailable);
    yield* updater.on("update-downloaded", downloaded);
    yield* updater.checkForUpdates;
    expect(unavailable).toHaveBeenCalledOnce();
    expect(available).not.toHaveBeenCalled();
    yield* updater.checkForUpdates;
    expect(available).toHaveBeenCalledWith({ version: "0.1.7-bitsafe.4" });
    yield* updater.downloadUpdate;
    expect(downloaded).toHaveBeenCalledWith({ version: "0.1.7-bitsafe.4" });
    expect(electron.checkForUpdates).not.toHaveBeenCalled();
    expect(electron.downloadUpdate).not.toHaveBeenCalled();
  }).pipe(
    Effect.scoped,
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
  );
});
