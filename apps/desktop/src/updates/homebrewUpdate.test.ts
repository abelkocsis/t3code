import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { installHomebrewUpdate } from "./homebrewUpdate.ts";

it.effect("rejects a tap that has not installed the offered version", () => {
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode("0.1.1-bitsafe.6\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  return Effect.gen(function* () {
    const result = yield* installHomebrewUpdate(
      "/Applications/T3 Code.app",
      "0.1.7-bitsafe.1",
      "arm64",
    ).pipe(Effect.flip);
    expect(String(result)).toContain("The tap may still need its release update");
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
});
